import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { CREDIT_RATE_CARD } from "@docslurp/shared";

import { createUsageLedger, recordUsageEvent } from "../lib/ai-usage.js";
import {
  orgUsageTotals,
  workspaceUsageTotals,
} from "../services/usage-attribution.js";
import type { SqlClient } from "../db.js";

// Rollback-only check against a real local Postgres. Runs inside a throwaway
// schema so it never touches application tables. Skipped without a local DB.
const databaseUrl = process.env.USAGE_ATTRIBUTION_DATABASE_URL ?? "";
const isLocal =
  databaseUrl !== "" && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname);

class Rollback extends Error {}

/** The usage_attribution view exactly as its migration creates it. */
function attributionView(): string {
  const dir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
  const file = readdirSync(dir).find((name) => /^\d+_usage_attribution_view\.sql$/.test(name));
  if (!file) throw new Error("usage_attribution view migration not found");
  return readFileSync(join(dir, file), "utf8").replaceAll("--> statement-breakpoint", "");
}

async function withSchema(run: (tx: SqlClient) => Promise<void>): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      const schema = `usage_attr_${randomUUID().replaceAll("-", "")}`;
      await tx.unsafe(`create schema ${schema}; set local search_path to ${schema}`);
      await tx.unsafe(`
        create table workspaces (id text primary key, org_id text not null);
        create table workspace_runs (id text primary key, workspace_id text not null, org_id text not null);
        create table search_sessions (id text primary key, metadata jsonb not null default '{}');
        create table usage_events (
          id text primary key,
          user_id text,
          run_id text,
          document_id text,
          provider text not null default 'openrouter',
          model text,
          metric text not null default 'llm',
          amount numeric not null default 0,
          unit text not null default 'token',
          input_tokens integer not null default 0,
          output_tokens integer not null default 0,
          cost_cents numeric(24,12) not null default 0,
          metadata jsonb not null default '{}',
          created_at timestamptz not null default now(),
          org_id text,
          workspace_id text,
          api_key_id text
        );
        ${attributionView()}
        create function enqueue_org_credit_debit(text, numeric, text, text, text, text, jsonb)
          returns void language sql as 'select null::void';
        insert into workspaces values ('ws-a', 'org-1'), ('ws-b', 'org-1'), ('ws-c', 'org-2');
        insert into workspace_runs values ('run-a', 'ws-a', 'org-1');
        -- legacy double-encoded session metadata
        insert into search_sessions values ('sess-b', to_jsonb('{"workspaceId":"ws-b"}'::text));
        -- Rows as the writers stamp them (migration 0042 tenant columns).
        insert into usage_events (id, run_id, input_tokens, output_tokens, cost_cents, metadata, org_id, workspace_id) values
          ('ingest', 'run-a', 100, 0, 10, '{"runId":"run-a"}', 'org-1', 'ws-a'),
          ('search-ws', null, 40, 10, 4, '{"workspaceId":"ws-a"}', 'org-1', 'ws-a'),
          ('search-session', null, 20, 0, 2, '{"sessionId":"sess-b"}', 'org-1', 'ws-b'),
          ('aggregate', null, 60, 0, 6, '{"workspaceIds":["ws-a","ws-b","ws-c"]}', 'org-1', null),
          ('org-only', null, 5, 0, 1, '{"orgId":"org-2"}', 'org-2', null);
        insert into usage_events (id, run_id, cost_cents, metadata, created_at, org_id, workspace_id) values
          ('last-year', 'run-a', 1000, '{"runId":"run-a"}', now() - interval '400 days', 'org-1', 'ws-a');
      `);
      await run(tx as unknown as SqlClient);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end();
  }
}

describe.skipIf(!isLocal)("usage attribution (local Postgres)", () => {
  it("attributes chat and search spend written through the ledger to its org", async () => {
    await withSchema(async (tx) => {
      const before = await orgUsageTotals("org-2", "month", tx);
      // Chat answer: one event written straight through the ledger.
      await recordUsageEvent({
        client: tx,
        userId: "user-1",
        scope: { workspaceId: "ws-c", orgId: "org-2" },
        usage: {
          provider: "openrouter",
          model: "chat-model",
          metric: "workspace-chat",
          inputTokens: 30,
          outputTokens: 10,
          costCents: 3,
        },
      });
      // Search Session: buffered strategy usage flushed with the session scope.
      const session = createUsageLedger({});
      session.record({
        provider: "openrouter",
        model: "search-model",
        metric: "query-rewrite",
        inputTokens: 8,
        outputTokens: 2,
        costCents: 1,
      });
      const batch = await session.flushWithin(tx, {
        userId: "user-1",
        scope: { sessionId: "sess-c", workspaceId: "ws-c", orgId: "org-2" },
      });
      batch.commit();

      const after = await orgUsageTotals("org-2", "month", tx);
      // Recorded costs carry the rate card's AI markup.
      const markup = 1 + CREDIT_RATE_CARD.aiMarkupPercent / 100;
      expect(after.costCents - before.costCents).toBeCloseTo(4 * markup);
      expect(after.tokens - before.tokens).toBe(50);
      expect(after.eventCount - before.eventCount).toBe(2);
      // ws-c had 2 (a third of the aggregate) before.
      expect((await workspaceUsageTotals("ws-c", "month", tx)).costCents).toBeCloseTo(2 + 4 * markup);
      // Org-only spend (no workspace) still reaches the org via its stamped orgId.
      await recordUsageEvent({
        client: tx,
        userId: "user-1",
        scope: { orgId: "org-2" },
        usage: { provider: "openrouter", model: "m", metric: "org-task", inputTokens: 1, costCents: 2 },
      });
      expect((await orgUsageTotals("org-2", "month", tx)).costCents).toBeCloseTo(after.costCents + 2 * markup);
      expect((await orgUsageTotals("org-1", "month", tx)).costCents).toBeCloseTo(20);
    });
  });

  it("counts run-linked, search, session, and split aggregate spend per workspace", async () => {
    await withSchema(async (tx) => {
      // ingest 10 + search 4 + aggregate 6/3
      expect((await workspaceUsageTotals("ws-a", "month", tx)).costCents).toBeCloseTo(16);
      // session-attributed 2 + aggregate 6/3
      expect((await workspaceUsageTotals("ws-b", "month", tx)).costCents).toBeCloseTo(4);
      expect((await workspaceUsageTotals("ws-c", "month", tx)).costCents).toBeCloseTo(2);
    });
  });

  it("rolls run-less spend into org totals without double counting split events", async () => {
    await withSchema(async (tx) => {
      const org1 = await orgUsageTotals("org-1", "month", tx);
      // 10 + 4 + 2 + 4 (two thirds of aggregate)
      expect(org1.costCents).toBeCloseTo(20);
      expect(org1.eventCount).toBe(4);
      const org2 = await orgUsageTotals("org-2", "month", tx);
      // 2 (one third of aggregate) + 1 org-only
      expect(org2.costCents).toBeCloseTo(3);
      expect(org2.tokens).toBe(25);
    });
  });

  it("respects the window", async () => {
    await withSchema(async (tx) => {
      expect((await orgUsageTotals("org-1", null, tx)).costCents).toBeCloseTo(1020);
    });
  });
});
