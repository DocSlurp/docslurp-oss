import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { Store } from "../db/store.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { createStageExecution } from "../pipeline/stage-execution.js";
import type { UsageSummary } from "../temporal/shared.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * One run's spend must agree everywhere. The time-to-searchable baseline found
 * a 10-document batch whose Temporal usage summary showed 0.74 ¢ (worker-stage
 * compute only) while usage_events held 0.94 ¢: activities summed the
 * ledger's pending buffer, which mid-stage checkpoints had already drained of
 * the preamble and embedding events. This drives real Stage Execution against
 * a migrated database with embedding, vision, preamble, fee, compute and
 * unbilled events, document shards, mid-stage checkpoints and a retried stage.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const config = { workerDocConcurrency: 2, workerAdaptiveTuning: false } as Config;
const DOCS = ["d-1", "d-2", "d-3", "d-4"];

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000);
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('r1', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'vision-extract', '${JSON.stringify(defaultPipelineFeatures)}', 4, 8);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count) values
      ${DOCS.map((id) => `('${id}', 'o1', 'u1', 'w', 'r1', '${id}.pdf', 'application/pdf', 'raw/${id}', 'processing', 2)`).join(", ")};
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, {
    poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 },
  });
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

function ai(state: WorkflowState, metric: string, model: string, inputTokens: number, outputTokens: number, documentId?: string) {
  state.usageLedger.record({
    provider: "openrouter", model, metric, inputTokens, outputTokens,
    metadata: documentId ? { documentId } : {},
  });
}

const runtime = (attempt = 1, documentIds?: string[]) => ({
  signal: new AbortController().signal,
  heartbeat: () => undefined,
  attempt,
  progressFromProcessCpu: false,
  ...(documentIds ? { documentIds } : {}),
});

const input = (stageName: string) => ({ stageName, runId: "r1", totalStages: 3, artifacts: {} });

async function persistedCents(where = "true"): Promise<number> {
  const { rows } = await db.query<{ cents: string }>(
    `select coalesce(sum(cost_cents), 0)::text as cents from usage_attribution where run_id = 'r1' and ${where}`);
  return Number(rows[0]!.cents);
}

describe("run cost reconciliation", () => {
  it("reports the spend usage_attribution holds from every activity, across shards, checkpoints and a retry", { timeout: 60_000 }, async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let failSummaryOnce = true;
    const stages: Stage[] = [
      {
        name: "vision-extract",
        async run(state) {
          for (const document of state.documents) {
            ai(state, "page-analysis", "google/gemini-3.1-flash-lite", 1_150, 520, document.id);
            // Checkpoint per document, as long stages do: flushes the buffer mid-stage.
            await store.updateProgress(state);
          }
          state.usageLedger.enqueue({
            provider: "docslurp", model: "page-base-fee", metric: "page-base-fee", amount: 8, unit: "page",
            costCents: 0.4, metadata: {},
          });
        },
      },
      {
        name: "embed",
        async run(state) {
          for (const document of state.documents) {
            ai(state, "contextual-chunk-preamble", "qwen/qwen3.5-flash-02-23", 2_100, 96, document.id);
            await store.updateProgress(state);
            state.usageLedger.record({ provider: "openai", model: "text-embedding-3-small", metric: "embedding-tokens",
              inputTokens: 6_700, logOutputTokens: false, metadata: { documentId: document.id } });
            // Unbilled work is persisted at 0 ¢ and must be reported at 0 ¢.
            state.usageLedger.enqueue({ provider: "local-compute", model: "dev", metric: "parser-process", amount: 0.2,
              unit: "cent", costCents: 0.2, metadata: { billable: false } });
          }
        },
      },
      {
        name: "document-summary",
        async run(state) {
          ai(state, "document-summary", "qwen/qwen3.5-flash-02-23", 4_000, 300);
          await store.updateProgress(state);
          if (failSummaryOnce) {
            failSummaryOnce = false;
            throw new Error("provider returned 500");
          }
        },
      },
    ];
    const execution = createStageExecution({ store, config, stages });
    const tallies: UsageSummary[] = [];

    tallies.push((await execution.runStage(input("vision-extract"), runtime())).usage);
    // Two shards, then the unsharded pass (a no-op over checkpointed documents in production).
    for (const shard of [["d-1", "d-2"], ["d-3", "d-4"]]) {
      tallies.push((await execution.runStage(input("embed"), runtime(1, shard))).usage);
    }
    // A retried stage (group): attempt 1 checkpoints spend, then fails.
    await expect(execution.runStage(input("document-summary"), runtime(1))).rejects.toThrow("provider returned 500");
    const failedAttemptCents = await persistedCents("metric = 'document-summary'");
    expect(failedAttemptCents).toBeGreaterThan(0);
    tallies.push((await execution.runStage(input("document-summary"), runtime(2))).usage);

    const total = await persistedCents();
    const kinds = await db.query<{ metric: string }>("select distinct metric from usage_attribution where run_id = 'r1' order by 1");
    expect(kinds.rows.map((row) => row.metric)).toEqual([
      "contextual-chunk-preamble", "document-summary", "embedding-tokens", "page-analysis", "page-base-fee",
      "parser-process", "worker-stage",
    ]);
    expect(await persistedCents("metric = 'parser-process'")).toBe(0);

    // Every completed activity reports exactly what it persisted, so the
    // workflow tally misses only the failed attempt (it never returned).
    const tally = tallies.reduce((sum, usage) => sum + usage.costCents, 0);
    expect(tally).toBeCloseTo(total - failedAttemptCents, 9);
    // The preamble spend that the pending-buffer summary used to drop.
    expect(tallies[1]!.costCents + tallies[2]!.costCents)
      .toBeCloseTo(await persistedCents("metric in ('contextual-chunk-preamble', 'embedding-tokens', 'parser-process') or (metric = 'worker-stage' and metadata->>'stage' = 'embed')"), 9);

    // Retried checkpoints insert each event once.
    const { rows: [dupes] } = await db.query<{ n: number }>(
      "select count(*)::int - count(distinct id)::int as n from usage_events where run_id = 'r1'");
    expect(dupes!.n).toBe(0);
  });
});
