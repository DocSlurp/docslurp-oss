import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { recordPageBaseFee } from "../db/page-base-fee.js";
import { Store } from "../db/store.js";
import type { UsageEvent } from "../models.js";
import { isCostCapExceeded, runSpentCents } from "../pipeline/checkpoints.js";
import { WorkflowState, type Stage } from "../pipeline/pipeline.js";
import { createStageExecution } from "../pipeline/stage-execution.js";
import { applyRemainingMigrations, createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * The run cost cap (pipeline.maxCostCents) is checked against one figure:
 * workspace_runs.spent_cents (every billed usage event of the run, kept by a
 * usage_events trigger) plus the ledger's still-buffered billable events.
 * It must equal the ledger total users see as billed spend, across shards,
 * retried stages, duplicate event inserts and every event kind.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const config = { workerDocConcurrency: 2, workerAdaptiveTuning: false } as Config;
const DOCS = ["d-1", "d-2", "d-3", "d-4"];
const pipeline = (maxCostCents: number | null) => JSON.stringify({ ...defaultPipelineFeatures, maxCostCents });

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000);
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('r1', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'vision-extract', '${pipeline(null)}', 4, 8),
             ('r2', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'embed', '${pipeline(5)}', 4, 8);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count) values
      ${DOCS.map((id) => `('${id}', 'o1', 'u1', 'w', 'r1', '${id}.pdf', 'application/pdf', 'raw/${id}', 'processing', 2)`).join(", ")},
      ${DOCS.map((id) => `('r2-${id}', 'o1', 'u1', 'w', 'r2', '${id}.pdf', 'application/pdf', 'raw/${id}', 'processing', 2)`).join(", ")};
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, {
    poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 },
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterEach(() => {
});

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

async function scalar(query: string): Promise<number> {
  const { rows } = await db.query<{ v: string }>(query);
  return Number(rows[0]?.v ?? 0);
}
const spentCents = (runId: string) => scalar(`select spent_cents::text as v from workspace_runs where id = '${runId}'`);
const billedLedgerCents = (runId: string) =>
  scalar(`select coalesce(sum(cost_cents), 0)::text as v from usage_attribution where run_id = '${runId}'`);

const runtime = (attempt = 1, documentIds?: string[]) => ({
  signal: new AbortController().signal,
  heartbeat: () => undefined,
  attempt,
  progressFromProcessCpu: false,
  ...(documentIds ? { documentIds } : {}),
});
const input = (runId: string, stageName: string) => ({ stageName, runId, totalStages: 3, artifacts: {} });

describe("run cost cap figure", () => {
  it("equals the billed ledger total across every event kind, shards, a retried stage and duplicate inserts", { timeout: 60_000 }, async () => {
    let failOnce = true;
    let replayed: UsageEvent | null = null;
    const stages: Stage[] = [
      {
        name: "vision-extract",
        async run(state) {
          for (const document of state.documents) {
            state.usageLedger.record({ provider: "openrouter", model: "google/gemini-3.1-flash-lite", metric: "page-analysis",
              inputTokens: 1_150, outputTokens: 520, metadata: { documentId: document.id, pageNumber: 1 } });
            await store.updateProgress(state);
          }
        },
      },
      {
        name: "embed",
        async run(state) {
          for (const document of state.documents) {
            state.usageLedger.record({ provider: "openrouter", model: "qwen/qwen3.5-flash-02-23", metric: "contextual-chunk-preamble",
              inputTokens: 2_100, outputTokens: 96, metadata: { documentId: document.id } });
            state.usageLedger.record({ provider: "openai", model: "text-embedding-3-small", metric: "embedding-tokens",
              inputTokens: 6_700, logOutputTokens: false, metadata: { documentId: document.id } });
            // Worker compute never bills customers, even when an event claims to be billable.
            state.usageLedger.enqueue({ provider: "local-compute", model: "w", metric: "parser-process", amount: 0.3, unit: "cent",
              costCents: 0.3, metadata: { billable: true, costRollup: "authoritative", effectiveCostCents: 0.1 } });
            state.usageLedger.enqueue({ provider: "local-compute", model: "w", metric: "parser-process", amount: 0.2, unit: "cent",
              costCents: 0.2, metadata: { billable: false, costRollup: "authoritative", effectiveCostCents: 0.2 } });
            await store.updateProgress(state);
          }
        },
      },
      {
        name: "document-summary",
        async run(state) {
          const event = state.usageLedger.record({ provider: "openrouter", model: "qwen/qwen3.5-flash-02-23", metric: "document-summary",
            inputTokens: 4_000, outputTokens: 300 });
          await store.updateProgress(state);
          if (failOnce) {
            failOnce = false;
            replayed = event;
            throw new Error("provider returned 500");
          }
          // A duplicate of an event a failed attempt already persisted inserts nothing.
          if (replayed) state.usageLedger.enqueue(replayed);
        },
      },
    ];
    const execution = createStageExecution({ store, config, stages });
    await execution.runStage(input("r1", "vision-extract"), runtime());
    for (const shard of [["d-1", "d-2"], ["d-3", "d-4"]]) await execution.runStage(input("r1", "embed"), runtime(1, shard));
    await expect(execution.runStage(input("r1", "document-summary"), runtime(1))).rejects.toThrow("provider returned 500");
    await execution.runStage(input("r1", "document-summary"), runtime(2));
    await recordPageBaseFee((store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql,
      WorkflowState.create(await store.loadRun("r1"), []));
    // A retried fee is idempotent too.
    await recordPageBaseFee((store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql,
      WorkflowState.create(await store.loadRun("r1"), []));

    const billed = await billedLedgerCents("r1");
    const metrics = await db.query<{ metric: string }>("select distinct metric from usage_events where run_id = 'r1' order by 1");
    expect(metrics.rows.map((row) => row.metric)).toEqual([
      "contextual-chunk-preamble", "document-summary", "embedding-tokens", "ingest-page-fast", "ingest-page-rich", "page-analysis", "parser-process", "worker-stage",
    ]);
    expect(await scalar("select count(*)::text as v from usage_events where run_id = 'r1' and metric = 'ingest-page-fast'")).toBe(1);
    expect(await scalar("select (count(*) - count(distinct id))::text as v from usage_events where run_id = 'r1'")).toBe(0);
    // Only price-card units bill: one Rich page per vision-read document (0.25 each) plus Fast pages.
    expect(await scalar("select coalesce(sum(cost_cents), 0)::text as v from usage_events where run_id = 'r1' and metric not like 'ingest-page-%'")).toBe(0);
    expect(billed).toBeGreaterThanOrEqual(4 * 0.25 - 1e-9);
    expect(await spentCents("r1")).toBeCloseTo(billed, 9);

    // A fresh activity checks the cap against exactly that total.
    const state = WorkflowState.create(await store.loadRun("r1"), []);
    expect(runSpentCents(state)).toBeCloseTo(billed, 9);
    state.run.pipeline.maxCostCents = billed;
    expect(isCostCapExceeded(state)).toBe(true);
    state.run.pipeline.maxCostCents = billed + 1e-6;
    expect(isCostCapExceeded(state)).toBe(false);
    // Unflushed billable spend counts immediately; unbilled estimates never do.
    state.usageLedger.enqueue({ provider: "local-compute", model: "w", metric: "worker-stage", amount: 5, unit: "cent",
      costCents: 5, metadata: { billable: false } });
    expect(isCostCapExceeded(state)).toBe(false);
    state.usageLedger.enqueue({ provider: "docslurp", model: "x", metric: "ingest-page-fast", amount: 1, unit: "page", costCents: 1e-6,
      metadata: { billable: true, unitCharge: true } });
    expect(isCostCapExceeded(state)).toBe(true);
  });

  it("stops parallel shards at the cap, overshooting by no more than the work in flight", { timeout: 60_000 }, async () => {
    const cap = 5;
    const unit = 0.4;
    let stopped = 0;
    const stages: Stage[] = [{
      name: "embed",
      async run(state) {
        for (let round = 0; round < 50; round++) {
          // The embed stage's gate: no new billable batch once the cap is reached.
          if (isCostCapExceeded(state)) {
            stopped++;
            return;
          }
          state.usageLedger.enqueue({ provider: "docslurp", model: "batch", metric: "ingest-page-rich", amount: 1, unit: "page",
            costCents: unit, metadata: { documentId: state.documents[0]?.id, billable: true, unitCharge: true } });
          await store.updateProgress(state);
        }
      },
    }];
    const execution = createStageExecution({ store, config, stages });
    const shards = [["r2-d-1", "r2-d-2"], ["r2-d-3", "r2-d-4"]];
    await Promise.all(shards.map((shard) => execution.runStage(input("r2", "embed"), runtime(1, shard))));

    const spent = await spentCents("r2");
    expect(stopped).toBe(shards.length);
    expect(spent).toBeCloseTo(await billedLedgerCents("r2"), 9);
    expect(spent).toBeGreaterThanOrEqual(cap);
    // Each shard may have one batch in flight when another's checkpoint crosses the cap.
    expect(spent).toBeLessThan(cap + shards.length * unit + 1e-9);
  });

  it("ignores the deprecated run-row counters", async () => {
    await db.exec(`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, input_cost_cents, output_cost_cents)
      values ('r-old', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'embed', '${pipeline(10)}', 40, 40)`);
    const state = WorkflowState.create(await store.loadRun("r-old"), []);
    expect(state.run.spentCents).toBe(0);
    expect(isCostCapExceeded(state)).toBe(false);
  });
});

describe("migration 0056 backfill", () => {
  it("backfills spent_cents from usage_attribution and counts later inserts once", { timeout: 60_000 }, async () => {
    const old = await createMigratedDatabase({ stopBefore: "run_spent_cents" });
    try {
      await old.exec(`
        insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
        insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
        insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
        insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, input_cost_cents)
          values ('a', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'completed', '{}', 1.5),
                 ('b', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'embed', '{}', 0);
        insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, workspace_id, org_id) values
          ('e1', 'u1', 'a', 'openrouter', 'm', 'page-analysis', 1, 'request', 0.25, 'w', 'o1'),
          ('e2', 'u1', 'a', 'local-compute', 'w', 'worker-stage', 1, 'cent', 0.75, 'w', 'o1'),
          ('e3', 'u1', 'a', 'local-compute', 'w', 'worker-stage', 1, 'cent', 0, 'w', 'o1');
      `);
      await applyRemainingMigrations(old, "run_spent_cents");
      const spent = async (id: string) => Number((await old.query<{ v: string }>(`select spent_cents::text as v from workspace_runs where id = '${id}'`)).rows[0]!.v);
      expect(await spent("a")).toBe(1);
      expect(await spent("b")).toBe(0);
      await old.exec(`
        insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents) values
          ('e4', 'u1', 'b', 'openrouter', 'm', 'x', 1, 'request', 0.5),
          ('e5', 'u1', 'a', 'openrouter', 'm', 'x', 1, 'request', 0.125),
          ('e6', 'u1', null, 'openrouter', 'm', 'search', 1, 'request', 9)
        on conflict (id) do nothing;
        insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents) values
          ('e4', 'u1', 'b', 'openrouter', 'm', 'x', 1, 'request', 0.5)
        on conflict (id) do nothing;
      `);
      expect(await spent("a")).toBe(1.125);
      expect(await spent("b")).toBe(0.5);
    } finally {
      await old.close();
    }
  });
});
