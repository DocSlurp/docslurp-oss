import { defaultPipelineFeatures } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Worker CPU/RAM are operator-only diagnostics. The worker writes them into heartbeat events (payload.metrics) and stage stats,
 * and every customer-facing read of a run (GET /v1/runs/:id/progress, the realtime snapshot, event polling) is built by
 * getRunProgress, so a non-operator must get none of them, by key, wherever they are nested.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let runs: typeof import("../services/runs.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/temporal.js")>()),
    getPipelineTemporalSnapshot: vi.fn(async () => null),
  }));
  runs = await import("../services/runs.js");
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner')`;
  await sql`insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W')`;
  await sql`
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, processed_documents, pages_total, pages_processed, stats)
    values ('r1', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'extract-markdown', ${sql.json(defaultPipelineFeatures as unknown as postgres.JSONValue)}, 1, 0, 10, 4,
      ${sql.json({ documents: 1, workerId: "machine-91" } as postgres.JSONValue)})
  `;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
    values ('d1', 'o1', 'u1', 'w', 'r1', 'a.pdf', 'application/pdf', 'raw/a', 'processing', 10)`;
  await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, stats)
    values ('r1', 'd1', 'extract-markdown', 'processing', 1, ${sql.json({ pages: 4, cpuSeconds: 3.2, rssBytes: 55555, workerClass: "perf-8x" } as postgres.JSONValue)})`;
  await sql`insert into project_run_events (id, user_id, run_id, event_type, progress, stats, payload) values
    ('hb1', 'u1', 'r1', 'run.progress', ${sql.json({ completedDocumentStages: 1 } as postgres.JSONValue)}, ${sql.json({ pages: 4 } as postgres.JSONValue)},
     ${sql.json({ kind: "heartbeat", metrics: { inputTokens: 5, costCents: 2, rssBytes: 123456789, peakRssBytes: 234567890, cpuUserMs: 910, cpuSystemMs: 80 } } as postgres.JSONValue)})`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

const OPERATOR_ONLY = /rssBytes|peakRssBytes|cpuUserMs|cpuSystemMs|cpuSeconds|workerClass|workerId|perf-8x|machine-91|123456789|234567890|55555/;
const customerView = (snapshot: Awaited<ReturnType<typeof runs.getRunProgress>>) =>
  JSON.stringify({ run: snapshot?.run.stats, stages: snapshot?.stages, events: snapshot?.recentEvents, stats: snapshot?.stats });

describe("getRunProgress operator diagnostics", () => {
  it("gives a customer the cost and page numbers of a heartbeat without the worker's CPU and RAM", async () => {
    const snapshot = await runs.getRunProgress("r1", "u1", { recentEventLimit: 20 });
    expect(snapshot?.recentEvents).toHaveLength(1);
    expect(customerView(snapshot)).not.toMatch(OPERATOR_ONLY);
    expect(snapshot?.recentEvents[0]?.payload).toMatchObject({ kind: "heartbeat", metrics: { inputTokens: 5, costCents: 2 } });
    expect(snapshot?.stages.find((stage) => stage.stage === "extract-markdown")?.stats).toMatchObject({ pages: 4 });
  });

  it("serves the same redacted snapshot to the realtime stream (no recent events) and for an explicit operator: false", async () => {
    expect(customerView(await runs.getRunProgress("r1", "u1", { recentEventLimit: 0, operator: false }))).not.toMatch(OPERATOR_ONLY);
    expect(customerView(await runs.getRunProgress("r1", "u1", { recentEventLimit: 20, operator: false }))).not.toMatch(OPERATOR_ONLY);
  });

  it("keeps them for a platform operator", async () => {
    const view = customerView(await runs.getRunProgress("r1", "u1", { recentEventLimit: 20, operator: true }));
    expect(view).toContain("rssBytes");
    expect(view).toContain("cpuUserMs");
    expect(view).toContain("workerClass");
  });
});
