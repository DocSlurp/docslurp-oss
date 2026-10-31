import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { BILLABLE_UNIT_METRICS } from "@docslurp/shared";

import { createUsageLedger, recordUnitCharge, recordUsageEvent } from "../lib/ai-usage.js";
import {
  attributedUsage,
  orgUsageTotals,
  workspaceUsageTotals,
} from "../services/usage-attribution.js";
import type { SqlClient } from "../db.js";

// Rollback-only check against a real, fully migrated local Postgres (the
// usage_attribution view, tenant columns, run spend trigger and credit debit
// queue exactly as the migrations create them). Every test seeds uniquely
// named tenants inside one transaction and rolls it back. Skipped without a
// local DB.
const databaseUrl = process.env.USAGE_ATTRIBUTION_DATABASE_URL ?? "";
const isLocal =
  databaseUrl !== "" && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname);

class Rollback extends Error {}

interface Ids {
  user: string;
  org1: string;
  org2: string;
  wsA: string;
  wsB: string;
  wsC: string;
  run: string;
  session: string;
}

async function withSeed(run: (tx: SqlClient, ids: Ids) => Promise<void>): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const ids: Ids = {
    user: `ua-user-${suffix}`,
    org1: `ua-org1-${suffix}`,
    org2: `ua-org2-${suffix}`,
    wsA: `ua-ws-a-${suffix}`,
    wsB: `ua-ws-b-${suffix}`,
    wsC: `ua-ws-c-${suffix}`,
    run: `ua-run-a-${suffix}`,
    session: `ua-sess-b-${suffix}`,
  };
  const ev = (name: string) => `ua-${name}-${suffix}`;
  try {
    await client.begin(async (tx) => {
      await tx`insert into "user" (id, name, email) values (${ids.user}, 'Usage Attribution', ${`${ids.user}@example.test`})`;
      await tx`
        insert into organizations (id, name, slug, created_by_user_id) values
          (${ids.org1}, 'Usage Org 1', ${ids.org1}, ${ids.user}),
          (${ids.org2}, 'Usage Org 2', ${ids.org2}, ${ids.user})
      `;
      await tx`
        insert into workspaces (id, org_id, user_id, name) values
          (${ids.wsA}, ${ids.org1}, ${ids.user}, 'A'),
          (${ids.wsB}, ${ids.org1}, ${ids.user}, 'B'),
          (${ids.wsC}, ${ids.org2}, ${ids.user}, 'C')
      `;
      await tx`
        insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage)
        values (${ids.run}, ${ids.org1}, ${ids.user}, ${ids.wsA}, 'bulk-upload', 'completed', 'completed')
      `;
      // Legacy double-encoded session metadata (a JSON string holding JSON).
      await tx`
        insert into search_sessions (id, user_id, query, metadata)
        values (${ids.session}, ${ids.user}, 'q', to_jsonb(${JSON.stringify({ workspaceId: ids.wsB })}::text))
      `;
      // Rows as the writers stamp them (migration 0042 tenant columns).
      const rows: Array<[string, string | null, number, number, number, Record<string, unknown>, string, string | null]> = [
        [ev("ingest"), ids.run, 100, 0, 10, { runId: ids.run }, ids.org1, ids.wsA],
        [ev("search-ws"), null, 40, 10, 4, { workspaceId: ids.wsA }, ids.org1, ids.wsA],
        [ev("search-session"), null, 20, 0, 2, { sessionId: ids.session }, ids.org1, ids.wsB],
        [ev("aggregate"), null, 60, 0, 6, { workspaceIds: [ids.wsA, ids.wsB, ids.wsC] }, ids.org1, null],
        [ev("org-only"), null, 5, 0, 1, { orgId: ids.org2 }, ids.org2, null],
      ];
      for (const [id, runId, input, output, cost, metadata, orgId, workspaceId] of rows) {
        await tx`
          insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, input_tokens, output_tokens, cost_cents, metadata, org_id, workspace_id)
          values (${id}, ${ids.user}, ${runId}, 'openrouter', 'm', 'llm', ${input + output}, 'token', ${input}, ${output}, ${cost},
            ${JSON.stringify(metadata)}::text::jsonb, ${orgId}, ${workspaceId})
        `;
      }
      await tx`
        insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, metadata, created_at, org_id, workspace_id)
        values (${ev("last-year")}, ${ids.user}, ${ids.run}, 'openrouter', 'm', 'llm', 0, 'token', 1000,
          ${JSON.stringify({ runId: ids.run })}::text::jsonb, now() - interval '400 days', ${ids.org1}, ${ids.wsA})
      `;
      await run(tx as unknown as SqlClient, ids);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end();
  }
}

describe.skipIf(!isLocal)("usage attribution (local Postgres)", () => {
  it("attributes chat and search usage written through the ledger to its org and workspace", async () => {
    await withSeed(async (tx, ids) => {
      const before = await orgUsageTotals(ids.org2, "month", tx);
      // Chat answer: one AI event written straight through the ledger.
      await recordUsageEvent({
        client: tx,
        userId: ids.user,
        scope: { workspaceId: ids.wsC, orgId: ids.org2 },
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
        userId: ids.user,
        scope: { sessionId: `ua-sess-c-${ids.user}`, workspaceId: ids.wsC, orgId: ids.org2 },
      });
      batch.commit();

      const after = await orgUsageTotals(ids.org2, "month", tx);
      // AI receipts are internal cost events: customers pay PRICE_CARD units
      // instead, so they debit 0 credits (#100, priceAiUsageEvent) while their
      // tokens and events still count against the org.
      expect(after.costCents - before.costCents).toBeCloseTo(0);
      expect(after.tokens - before.tokens).toBe(50);
      expect(after.eventCount - before.eventCount).toBe(2);
      const aiRows = await tx<{ workspace_id: string | null; org_id: string | null; cost_cents: number; metadata: Record<string, unknown> }[]>`
        select au.workspace_id, au.org_id, au.cost_cents::double precision as cost_cents, au.metadata
        from ${attributedUsage("month", tx)} au
        where au.org_id = ${ids.org2} and au.metric in ('workspace-chat', 'query-rewrite')
        order by au.metric
      `;
      expect(aiRows).toHaveLength(2);
      for (const row of aiRows) {
        expect(row).toMatchObject({ workspace_id: ids.wsC, org_id: ids.org2, cost_cents: 0 });
        expect(row.metadata).toMatchObject({ billable: false, costRole: "provider" });
      }
      // Provider cost is preserved for internal cost reports.
      expect(aiRows.map((row) => row.metadata.providerCostCents)).toEqual([1, 3]);

      // Billable unit charges are the spend that counts and debits credits.
      await recordUnitCharge({
        client: tx,
        userId: ids.user,
        scope: { workspaceId: ids.wsC, orgId: ids.org2 },
        charge: { id: `ua-chat-answer-${ids.user}`, metric: BILLABLE_UNIT_METRICS.chatAnswer, amount: 1, unit: "answer", credits: 4 },
      });
      // ws-c had 2 (a third of the aggregate) before.
      expect((await workspaceUsageTotals(ids.wsC, "month", tx)).costCents).toBeCloseTo(2 + 4);
      // Org-only spend (no workspace) still reaches the org via its stamped orgId.
      await recordUnitCharge({
        client: tx,
        userId: ids.user,
        scope: { orgId: ids.org2 },
        charge: { id: `ua-storage-${ids.user}`, metric: BILLABLE_UNIT_METRICS.storage, amount: 1, unit: "gb-day", credits: 2 },
      });
      expect((await orgUsageTotals(ids.org2, "month", tx)).costCents).toBeCloseTo(after.costCents + 4 + 2);
      expect((await workspaceUsageTotals(ids.wsC, "month", tx)).costCents).toBeCloseTo(2 + 4);
      // Both charges are queued as debits against org-2 only; AI events debit nothing.
      const debits = await tx<{ org_id: string; credits: string }[]>`
        select org_id, credits::text from credit_debits_pending
        where org_id in (${ids.org1}, ${ids.org2}) order by credits
      `;
      expect(debits.map((row) => [row.org_id, Number(row.credits)])).toEqual([[ids.org2, 2], [ids.org2, 4]]);
      // Nothing leaks into the other tenant.
      expect((await orgUsageTotals(ids.org1, "month", tx)).costCents).toBeCloseTo(20);
    });
  });

  it("counts run-linked, search, session, and split aggregate spend per workspace", async () => {
    await withSeed(async (tx, ids) => {
      // ingest 10 + search 4 + aggregate 6/3
      expect((await workspaceUsageTotals(ids.wsA, "month", tx)).costCents).toBeCloseTo(16);
      // session-attributed 2 + aggregate 6/3
      expect((await workspaceUsageTotals(ids.wsB, "month", tx)).costCents).toBeCloseTo(4);
      expect((await workspaceUsageTotals(ids.wsC, "month", tx)).costCents).toBeCloseTo(2);
    });
  });

  it("rolls run-less spend into org totals without double counting split events", async () => {
    await withSeed(async (tx, ids) => {
      const org1 = await orgUsageTotals(ids.org1, "month", tx);
      // 10 + 4 + 2 + 4 (two thirds of aggregate)
      expect(org1.costCents).toBeCloseTo(20);
      expect(org1.eventCount).toBe(4);
      const org2 = await orgUsageTotals(ids.org2, "month", tx);
      // 2 (one third of aggregate) + 1 org-only
      expect(org2.costCents).toBeCloseTo(3);
      expect(org2.tokens).toBe(25);
    });
  });

  it("keeps the run spend counter equal to its attributed spend", async () => {
    await withSeed(async (tx, ids) => {
      const [run] = await tx<{ spent_cents: string }[]>`select spent_cents::text from workspace_runs where id = ${ids.run}`;
      // ingest 10 + last-year 1000, maintained by the usage_events trigger (0056).
      expect(Number(run?.spent_cents)).toBeCloseTo(1010);
    });
  });

  it("respects the window", async () => {
    await withSeed(async (tx, ids) => {
      expect((await orgUsageTotals(ids.org1, null, tx)).costCents).toBeCloseTo(1020);
    });
  });
});
