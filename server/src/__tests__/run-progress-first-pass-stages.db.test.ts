import { defaultPipelineFeatures, projectRunProgressSnapshotSchema } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Regression: a run that took the first pass records document checkpoints and events under internal stage names
 * (`first-pass:page-count`, `first-pass:figures`) that the public stage enum did not list, so response validation threw
 * and GET /v1/runs/:runId/progress returned 500. Every public read of a run must report them as `first-pass`, and any
 * stage the contract cannot name must degrade to a safe value (logged) instead of failing the response.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let runs: typeof import("../services/runs.js");
let stageLog: typeof import("../lib/public-run-stage.js");
const FIRST_PASS_STAGES = ["first-pass", "first-pass:page-count", "first-pass:figures"] as const;
const UNKNOWN_STAGE = "future-internal-stage";

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
  stageLog = await import("../lib/public-run-stage.js");
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner')`;
  await sql`insert into projects(id, org_id, user_id, name) values ('p', 'o1', 'u1', 'P')`;
  const pipeline = sql.json(defaultPipelineFeatures as unknown as postgres.JSONValue);
  await sql`
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, processed_documents, pages_total, pages_processed)
    values ('fp', 'o1', 'u1', 'p', 'bulk-upload', 'processing', 'extract-markdown', ${pipeline}, 1, 0, 10, 4),
           ('odd', 'o1', 'u1', 'p', 'bulk-upload', 'processing', ${UNKNOWN_STAGE}, ${pipeline}, 1, 0, 10, 0)
  `;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
    values ('d1', 'o1', 'u1', 'p', 'fp', 'a.pdf', 'application/pdf', 'raw/a', 'processing', 10),
           ('d2', 'o1', 'u1', 'p', 'odd', 'b.pdf', 'application/pdf', 'raw/b', 'processing', 10)`;
  for (const [index, stage] of [...FIRST_PASS_STAGES, UNKNOWN_STAGE, "format-detect"].entries()) {
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, stats, updated_at)
      values ('fp', 'd1', ${stage}, 'completed', 1, '{}'::jsonb, now() + ${index} * interval '1 second')`;
    await sql`insert into project_run_events (id, user_id, run_id, document_id, stage_name, event_type, status, message, created_at)
      values (${`e${index}`}, 'u1', 'fp', 'd1', ${stage}, 'document.completed', 'completed', 'document stage completed',
        now() + ${index} * interval '1 second')`;
  }
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

describe("first-pass and unknown run stages on public run reads", () => {
  it("serves the progress snapshot (GET /v1/runs/:runId/progress) with first-pass checkpoints as the public first-pass stage", async () => {
    const snapshot = await runs.getRunProgress("fp", "u1", { recentEventLimit: 20 });
    expect(snapshot).not.toBeNull();
    expect(() => projectRunProgressSnapshotSchema.parse(snapshot)).not.toThrow();
    const stages = snapshot!.stages.map((state) => state.stage);
    expect(stages.filter((stage) => stage === "first-pass")).toHaveLength(FIRST_PASS_STAGES.length);
    expect(stages).toContain("format-detect");
    // A checkpoint the contract cannot name is left out rather than failing the response.
    expect(stages).toHaveLength(FIRST_PASS_STAGES.length + 1);
    const eventStages = snapshot!.recentEvents.map((event) => event.stage);
    expect(eventStages).toEqual(["first-pass", "first-pass", "first-pass", null, "format-detect"]);
    // The reporting-only stage never enters the plan rollups.
    expect(snapshot!.progress.expectedStages).not.toContain("first-pass");
  });

  it("serves the SSE stream snapshot (no recent events) for the same run", async () => {
    const snapshot = await runs.getRunProgress("fp", "u1", { recentEventLimit: 0 });
    expect(snapshot?.stages.some((state) => state.stage === "first-pass")).toBe(true);
    expect(snapshot?.recentEvents).toEqual([]);
  });

  it("keeps every event in GET /v1/runs/:runId/events, with first-pass and null stages", async () => {
    const events = await runs.listRunEvents({ runId: "fp", userId: "u1", limit: 50 });
    expect(events.map((event) => event.id)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    expect(events.map((event) => event.stage)).toEqual(["first-pass", "first-pass", "first-pass", null, "format-detect"]);
  });

  it("reads a run whose own stage is unknown as queued (run detail, list and progress) and logs the raw name", async () => {
    stageLog.resetReportedRunStagesForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await runs.getRun("odd", "u1"))?.stage).toBe("queued");
      expect((await runs.listRuns("u1")).find((run) => run.id === "odd")?.stage).toBe("queued");
      const snapshot = await runs.getRunProgress("odd", "u1", { recentEventLimit: 20 });
      expect(snapshot?.run.stage).toBe("queued");
      expect(snapshot?.progress.currentStage).toBe("queued");
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes("unknown_internal_stage") && line.includes(UNKNOWN_STAGE) && line.includes("source=run"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs an unknown checkpoint stage to telemetry once, not into the response", async () => {
    stageLog.resetReportedRunStagesForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = await runs.getRunProgress("fp", "u1", { recentEventLimit: 20 });
      await runs.getRunProgress("fp", "u1", { recentEventLimit: 20 });
      expect(JSON.stringify(snapshot)).not.toContain(UNKNOWN_STAGE);
      const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(UNKNOWN_STAGE));
      expect(lines.filter((line) => line.includes("source=stage-state"))).toHaveLength(1);
      expect(lines.filter((line) => line.includes("source=run-event"))).toHaveLength(1);
      // Internal first-pass names are known: they are mapped silently.
      expect(warn.mock.calls.some((call) => String(call[0]).includes("first-pass"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
