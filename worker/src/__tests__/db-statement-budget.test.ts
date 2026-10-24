import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { defaultPipelineFeatures } from "@docslurp/shared";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import { Store } from "../db/store.js";
import { completeDocumentPages, emitDocumentPageProgress, runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import type { Stage } from "../pipeline/pipeline.js";
import { createStageExecution } from "../pipeline/stage-execution.js";
import { withWorkerSlot } from "../temporal/activities.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { startPgWireProxy } from "../test/pg-wire-proxy.mjs";

/**
 * Counts the Postgres transactions and statements one document run costs on
 * the hot path (docs/scaling-1000-workers.md, 2026-10-09 load test: ~46 app
 * transactions per page). The run mirrors the load-test pipeline shape: one
 * 10-page document through the twelve stages of that pipeline, each holding an
 * org worker slot, plus run start and completion. Stage bodies are fakes that
 * make the same checkpoint/progress calls as the real stages.
 */
const PAGES = 10;
// getPipelineStageOrder() for the load-test pipeline (markdownExtraction + embed + indexVectors).
const STAGES = ["quarantine", "format-detect", "to-canonical", "format-tooling", "normalize", "pdf-tooling",
  "split-pages", "extract-markdown", "classify-route", "render-images", "embed", "index"];
const config = { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config;

let db: PGlite;
let server: PGLiteSocketServer;
let proxy: Awaited<ReturnType<typeof startPgWireProxy>>;
let url: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 1000000);
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  // Every statement goes through the wire counter. Its 1 ms one-way delay lets back-to-back writes of
  // one burst count as one round trip ("flight") deterministically, whatever the CPU load.
  proxy = await startPgWireProxy({ targetPort: served.port, delayMs: 1 });
  url = `postgres://postgres@127.0.0.1:${proxy.port}/postgres`;
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  await server?.stop();
  await db?.close();
});

type Counter = {
  transactions: number; statements: number; notifies: number; byKind: Map<string, number>;
  // Pending credit debits appended, and statements that debit, lock or write the organizations row.
  pendingDebits: number; orgRowTouches: string[];
};

/** Statements that would serialize an org's checkpoints on its organizations row. */
const ORG_ROW_TOUCH = /debit_org_credits|apply_pending_org_debits|update\s+organizations\b|from\s+organizations\b[^;]*for\s+(no\s+key\s+)?update/;

/** Classifies every statement postgres.js sends: an explicit begin…commit is one transaction, anything else autocommits. */
function instrument(store: Store): Counter {
  const sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  const counter: Counter = { transactions: 0, statements: 0, notifies: 0, byKind: new Map(), pendingDebits: 0, orgRowTouches: [] };
  const inTransaction = new Set<number>();
  (sql.options as unknown as { debug: unknown }).debug = (connection: number, query: string) => {
    const text = query.trim().toLowerCase();
    if (text.startsWith("begin")) {
      inTransaction.add(connection);
      counter.transactions += 1;
      return;
    }
    if (text.startsWith("commit") || text.startsWith("rollback")) {
      inTransaction.delete(connection);
      return;
    }
    counter.statements += 1;
    if (text.includes("enqueue_org_credit_debit")) counter.pendingDebits += 1;
    if (ORG_ROW_TOUCH.test(text.replace(/\s+/g, " "))) counter.orgRowTouches.push(text.replace(/\s+/g, " ").slice(0, 120));
    if (text.includes("pg_notify")) counter.notifies += 1;
    if (!inTransaction.has(connection)) counter.transactions += 1;
    const kind = text.replace(/\s+/g, " ").slice(0, 60);
    counter.byKind.set(kind, (counter.byKind.get(kind) ?? 0) + 1);
  };
  return counter;
}

function documentStage(name: string, body?: Parameters<typeof runDocumentStage>[5]): Stage {
  return {
    name,
    async run(state, signal) {
      await runDocuments(state.documents, 1, async (document) => {
        await runDocumentStage(state, document, name, `${document.id}:${name}`, `${name} ready`,
          body ?? (async () => ({ artifactUri: `s3://b/${document.id}/${name}` })), signal);
      });
    },
  };
}

const stages: Stage[] = [
  ...["quarantine", "format-detect", "to-canonical", "format-tooling", "normalize", "pdf-tooling", "classify-route"]
    .map((name) => documentStage(name)),
  ...["split-pages", "render-images"].map((name): Stage => ({
    name,
    async run(state, signal) {
      for (const document of state.documents) {
        await runDocumentStage(state, document, name, `${document.id}:${name}`, "ready", async () => {
          await state.store!.getCompletedPages(state.run.id, document.id, name);
          await completeDocumentPages(state, document, name, Array.from({ length: PAGES }, (_, i) => i + 1), PAGES, false);
          return { artifactUri: `s3://b/${document.id}/${name}` };
        }, signal);
      }
    },
  })),
  {
    name: "extract-markdown",
    async run(state, signal) {
      for (const document of state.documents) {
        await runDocumentStage(state, document, "extract-markdown", `${document.id}:extract-markdown`, "ready", async () => {
          await emitDocumentPageProgress(state, document, "extract-markdown", 1, PAGES, "processing");
          await state.store!.getCompletedPages(state.run.id, document.id, "extract-markdown");
          await completeDocumentPages(state, document, "extract-markdown", Array.from({ length: PAGES }, (_, i) => i + 1), PAGES);
          return { artifactUri: `s3://b/${document.id}/md` };
        }, signal);
      }
    },
  },
  {
    name: "embed",
    async run(state, signal) {
      for (const document of state.documents) {
        await runDocumentStage(state, document, "embed", `${document.id}:embed`, "ready", async () => {
          state.usageLedger.record({
            provider: "openai", model: "text-embedding-3-small", metric: "embedding-tokens",
            amount: 5_700, unit: "token", inputTokens: 5_700, costCents: 0.0114,
          });
          // Real stages queue performance samples next to usage; both land in one checkpoint.
          state.pendingPerformance.push({ documentId: document.id, scope: "document", stageName: "embed", metric: "embed-ms",
            value: 1_000, unit: "ms", tags: ["document"], metadata: {} });
          await state.store!.updateProgress(state);
          await emitDocumentPageProgress(state, document, "embed", PAGES, PAGES, "processing", { unit: "embedding-batch" });
          await completeDocumentPages(state, document, "embed", Array.from({ length: PAGES }, (_, i) => i + 1), PAGES);
          return { artifactUri: `s3://b/${document.id}/embed` };
        }, signal);
      }
    },
  },
  documentStage("index"),
];

async function seedRun(runId: string): Promise<void> {
  await db.exec(`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('${runId}', 'o1', 'u1', 'w', 'bulk-upload', 'queued', 'queued', '${JSON.stringify(defaultPipelineFeatures)}', 1, ${PAGES});
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('${runId}-doc', 'o1', 'u1', 'w', '${runId}', 'a.pdf', 'application/pdf', 'raw/a.pdf', 'queued', ${PAGES});
  `);
}

async function runOneDocument(store: Store, runId: string): Promise<void> {
  const execution = createStageExecution({ store, stages, config });
  const runtime = { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1, heartbeatIntervalMs: 3_600_000 };
  await execution.startRun({ runId, totalStages: STAGES.length });
  for (const stageName of STAGES) {
    await withWorkerSlot(store, { runId, kind: "stage", enabled: true },
      () => execution.runStage({ stageName, runId, totalStages: STAGES.length, artifacts: {} }, runtime));
  }
  await execution.completeRun({ runId });
}

/**
 * The same stages as one stage-group activity (runPipelineStages): one worker slot, and each stage's
 * completion checkpoint also reads the control state and the next stage's opening reads.
 */
async function runOneDocumentGrouped(store: Store, runId: string): Promise<void> {
  const execution = createStageExecution({ store, stages, config });
  const runtime = { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1, heartbeatIntervalMs: 3_600_000 };
  await execution.startRun({ runId, totalStages: STAGES.length });
  await withWorkerSlot(store, { runId, kind: "stage", enabled: true }, async () => {
    let preloaded: Awaited<ReturnType<typeof execution.runStage>>["preloaded"];
    let controlRequested: boolean | undefined;
    for (const [position, stageName] of STAGES.entries()) {
      // A real group yields when the run is paused; this one keeps going so both variants do the same work.
      if (position > 0) void (controlRequested ?? await store.hasRunControlRequest(runId));
      const output = await execution.runStage({ stageName, runId, totalStages: STAGES.length, artifacts: {} },
        { ...runtime, readControlState: true, preloadRunState: position < STAGES.length - 1, preloaded });
      controlRequested = output.controlRequested;
      preloaded = output.preloaded;
    }
  });
  await execution.completeRun({ runId });
}

/** Statements, transactions and serial round trips one run costs, read through the wire counter. */
async function measureRun(store: Store, run: (store: Store, runId: string) => Promise<void>, runId: string) {
  await seedRun(runId);
  const counter = instrument(store);
  proxy.reset();
  await run(store, runId);
  await store.flushRunEvents();
  const wire = proxy.stats();
  return { counter, wire };
}

// 2026-10-23 (perf/fewer-db-roundtrips), this 10-page run with one activity per stage: 57.0 serial round
// trips and 24.3 statements per page before; 18.1 and 23.1 after (31.3 with only the parameter-type cache).
// Budgets sit ~10% above today's counts: the wire counter splits a burst if the CPU stalls between writes.
const ROUND_TRIPS_PER_PAGE_BUDGET = 20;
const STATEMENTS_PER_PAGE_BUDGET = 24;
// The same stages as one stage group: 14.9 after.
const GROUPED_ROUND_TRIPS_PER_PAGE_BUDGET = 16.5;

describe("database statement budget per page", () => {
  it("one 10-page document run stays within its transaction budget", async () => {
    const store = new Store(url, 60_000, {
      poolMax: 1,
      workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 },
      // Count terminal/checkpoint writes independently of runner speed. A real
      // 500 ms timer makes slower CI machines flush more batches for the same
      // work. Timed delivery is covered by run-event-publisher.test.ts; this
      // window exceeds this test's timeout, so completion owns the flush.
      runEvents: { flushMs: 120_000, maxBuffered: 20_000 },
    });
    try {
      // Warm caches (table existence, historical performance) the way a long-lived worker would.
      await seedRun("run-warm");
      await runOneDocument(store, "run-warm");

      const { counter, wire } = await measureRun(store, runOneDocument, "run-1");
      const perPage = { transactions: counter.transactions / PAGES, statements: counter.statements / PAGES };
      console.log(`[statement-budget] run transactions=${counter.transactions} statements=${counter.statements} notifies=${counter.notifies} ` +
        `perPage=${perPage.transactions.toFixed(1)}/${perPage.statements.toFixed(1)} ` +
        `wire statements=${wire.statements} roundTrips=${wire.flights} roundTripsPerPage=${(wire.flights / PAGES).toFixed(1)}`);
      for (const [kind, count] of [...counter.byKind.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`[statement-budget]   ${String(count).padStart(3)}  ${kind}`);
      }

      // Before (2026-10-09 code): 312 transactions (31.2/page), 342 statements, 78 NOTIFY-bearing commits.
      expect(perPage.transactions).toBeLessThanOrEqual(15);
      // Serial round trips: a pipelined transaction or a statement with cached parameter types is one;
      // sql.begin costs BEGIN, each awaited statement and COMMIT; an uncached statement with parameters is two.
      expect(wire.flights / PAGES).toBeLessThanOrEqual(ROUND_TRIPS_PER_PAGE_BUDGET);
      expect(perPage.statements).toBeLessThanOrEqual(STATEMENTS_PER_PAGE_BUDGET);
      // Includes the byte-limited chunks in the terminal event flush and the
      // terminal webhook-outbox statement, independently of timed delivery.
      expect(counter.notifies).toBeLessThanOrEqual(10);
      // Billing on the hot path only appends pending debits: no statement debits,
      // locks or updates the org's organizations row (it stalled one org at 576 slots).
      expect(counter.pendingDebits).toBeGreaterThan(0);
      expect(counter.orgRowTouches).toEqual([]);

      // The flusher applies them: the balance falls by exactly the run's billable unit charges.
      // (Read through the store's connection: PGlite serves one session.)
      const sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
      const read = async () => {
        const [row] = await sql<{ cost: string; pending: string; balance: string }[]>`
          select
            (select coalesce(sum(cost_cents), 0) from usage_events where run_id in ('run-warm', 'run-1')
              and coalesce(metadata->>'billable', 'true') <> 'false')::text as cost,
            pending_org_debit_credits('o1')::text as pending,
            (select credit_balance_cents from organizations where id = 'o1')::text as balance`;
        return { cost: Number(row!.cost), pending: Number(row!.pending), balance: Number(row!.balance) };
      };
      const before = await read();
      expect(before.pending).toBeGreaterThan(0);
      expect(before.pending).toBeCloseTo(before.cost, 9);
      const flushed = await store.flushPendingCreditDebits();
      expect(flushed.credits).toBeCloseTo(before.pending, 9);
      const after = await read();
      expect(after.pending).toBe(0);
      expect(before.balance - after.balance).toBeCloseTo(before.pending, 9);

      const { rows } = await db.query<{ event_type: string }>(
        "select event_type from workspace_run_events where run_id = 'run-1' order by created_at, id");
      expect(rows.at(-1)?.event_type).toBe("run.completed");
      expect(rows.length).toBeGreaterThan(20);
    } finally {
      await store.close();
    }
  }, 60_000);

  it("a stage group costs fewer round trips than one activity per stage", async () => {
    const store = new Store(url, 60_000, {
      poolMax: 1,
      workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 },
      runEvents: { flushMs: 120_000, maxBuffered: 20_000 },
    });
    try {
      await seedRun("run-warm-2");
      await runOneDocumentGrouped(store, "run-warm-2");
      const single = await measureRun(store, runOneDocument, "run-sep");
      const grouped = await measureRun(store, runOneDocumentGrouped, "run-grp");
      console.log(`[statement-budget] per-stage activities roundTrips=${single.wire.flights} statements=${single.wire.statements}; ` +
        `one group roundTrips=${grouped.wire.flights} statements=${grouped.wire.statements}`);
      for (const [kind, count] of [...grouped.counter.byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        console.log(`[statement-budget] grouped ${String(count).padStart(3)}  ${kind}`);
      }
      expect(grouped.wire.flights).toBeLessThan(single.wire.flights * 0.85);
      expect(grouped.wire.flights / PAGES).toBeLessThanOrEqual(GROUPED_ROUND_TRIPS_PER_PAGE_BUDGET);
      // Same work, same statements (reads moved into the completion checkpoint, not added).
      expect(grouped.wire.statements).toBeLessThanOrEqual(single.wire.statements);
      const { rows } = await db.query<{ event_type: string }>(
        "select event_type from workspace_run_events where run_id = 'run-grp' order by created_at, id");
      expect(rows.at(-1)?.event_type).toBe("run.completed");
    } finally {
      await store.close();
    }
  }, 60_000);

  it("concurrent cold-cache hydrations share one historical-performance query", async () => {
    const store = new Store(url, 60_000, { poolMax: 2, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
    try {
      const counter = instrument(store);
      const hydrate = (store as unknown as { hydrateHistoricalStagePerformance(state: unknown): Promise<void> })
        .hydrateHistoricalStagePerformance.bind(store);
      const states = Array.from({ length: 8 }, (_, i) => ({ run: { id: `cold-${i}`, workspaceId: "w", userId: "u1", stats: {} } }));
      await Promise.all(states.map((state) => hydrate(state)));
      const percentileQueries = [...counter.byKind.entries()]
        .filter(([kind]) => kind.includes("perf.stage_name"))
        .reduce((total, [, count]) => total + count, 0);
      expect(percentileQueries).toBe(1);
      // A warm cache issues none.
      await hydrate({ run: { id: "warm-1", workspaceId: "w", userId: "u1", stats: {} } });
      expect([...counter.byKind.entries()].filter(([kind]) => kind.includes("perf.stage_name")).reduce((t, [, c]) => t + c, 0)).toBe(1);
    } finally {
      await store.close();
    }
  }, 60_000);
});
