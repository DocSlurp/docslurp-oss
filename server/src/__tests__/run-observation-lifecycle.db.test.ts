import postgres from "postgres";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let stop: () => Promise<void>;
let sql: postgres.Sql;
let runs: typeof import("../services/runs.js");
const temporal = vi.fn();

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", async importOriginal => ({
    ...await importOriginal<typeof import("../lib/temporal.js")>(),
    getPipelineTemporalSnapshot: temporal,
  }));
  runs = await import("../services/runs.js");
  await sql`insert into "user" (id, name, email) values
    ('observe-owner', 'Owner', 'owner@observation.test'),
    ('observe-other', 'Other', 'other@observation.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values
    ('observe-org', 'One', 'observe-one', 'observe-owner'),
    ('observe-other-org', 'Two', 'observe-two', 'observe-other')`;
  await sql`insert into org_memberships (org_id, user_id, role) values
    ('observe-org', 'observe-owner', 'owner'), ('observe-other-org', 'observe-other', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name) values
    ('observe-project', 'observe-org', 'observe-owner', 'One'),
    ('observe-other-project', 'observe-other-org', 'observe-other', 'Two')`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(async () => {
  temporal.mockReset();
  await sql`delete from project_runs where id in ('observe-run', 'observe-other-run')`;
  for (const [id, org, user, project] of [
    ["observe-run", "observe-org", "observe-owner", "observe-project"],
    ["observe-other-run", "observe-other-org", "observe-other", "observe-other-project"],
  ]) {
    await sql`insert into project_runs
      (id, org_id, user_id, project_id, kind, status, stage, pipeline,
       execution_generation, last_heartbeat_at, lease_expires_at, updated_at)
      values (${id!}, ${org!}, ${user!}, ${project!}, 'bulk-upload', 'processing', 'queued',
        ${sql.json(defaultPipelineFeatures as unknown as postgres.JSONValue)},
        'current-generation', now() - interval '20 minutes', now() - interval '15 minutes', now() - interval '20 minutes')`;
  }
});

async function persisted() {
  return {
    runs: await sql`select id, status, stage, failure_count, execution_generation, lease_expires_at, stats, updated_at
      from project_runs where id in ('observe-run', 'observe-other-run') order by id`,
    events: await sql`select run_id, event_type from project_run_events
      where run_id in ('observe-run', 'observe-other-run') order by id`,
  };
}

function snapshot(status: string) {
  return {
    workflowId: "pipeline-observe-run", workflowRunId: "previous-or-current-execution", workflowStatus: status,
    stage: null, stageIndex: null, totalStages: 13, historyLength: 10, historySizeBytes: 100,
    startTime: new Date(Date.now() - 1_800_000).toISOString(), executionTime: null,
    closeTime: status === "RUNNING" ? null : new Date(Date.now() - 60_000).toISOString(),
    elapsedMs: 1_800_000, activityUsageTally: { inputTokens: 0, outputTokens: 0, costCents: 0 },
    queriedAt: new Date().toISOString(),
  };
}

describe("run observation has no lifecycle authority", () => {
  it.each(["RUNNING", "UNKNOWN", "UNSPECIFIED", "FAILED", "TIMED_OUT", "CANCELLED", "TERMINATED", "COMPLETED", null])(
    "progress preserves cold queued work and failure history when Temporal reports %s", async status => {
      temporal.mockResolvedValue(status ? snapshot(status) : null);
      const before = await persisted();
      const result = await runs.getRunProgress("observe-run", "observe-owner");
      expect(result?.run.status).toBe("processing");
      expect(result?.temporal?.workflowStatus ?? null).toBe(status);
      expect(await persisted()).toEqual(before);
    },
  );

  it("activity inventory neither reconciles owner state nor mutates stale runs", async () => {
    temporal.mockResolvedValue(snapshot("RUNNING"));
    const before = await persisted();
    const result = await runs.listRuns("observe-owner", true);
    expect(result.map(run => [run.id, run.status])).toEqual([["observe-run", "processing"]]);
    expect(temporal).not.toHaveBeenCalled();
    expect(await persisted()).toEqual(before);
  });

  it("foreign progress and inventory expose no run and cannot mutate its lifecycle", async () => {
    const before = await persisted();
    expect(await runs.getRunProgress("observe-other-run", "observe-owner")).toBeNull();
    expect((await runs.listRuns("observe-owner", true)).map(run => run.id)).toEqual(["observe-run"]);
    expect(await persisted()).toEqual(before);
  });
  it("a previous terminal snapshot cannot fail a concurrently readmitted generation", async () => {
    temporal.mockImplementationOnce(async () => {
      await sql`update project_runs set execution_generation = 'next-generation', status = 'queued'
        where id = 'observe-run'`;
      return snapshot("FAILED");
    });
    await runs.getRunProgress("observe-run", "observe-owner");
    const [row] = await sql`select status, failure_count, execution_generation from project_runs where id = 'observe-run'`;
    expect(row).toMatchObject({ status: "queued", failure_count: 0, execution_generation: "next-generation" });
    expect(await sql`select id from project_run_events where run_id = 'observe-run'`).toHaveLength(0);
  });

  it.each(["completed", "failed"])("preserves existing %s history when an executor observation says running", async status => {
    await sql`update project_runs set status = ${status}, failure_count = 2,
      stats = ${sql.json({ retained: "failure history" })} where id = 'observe-run'`;
    temporal.mockResolvedValue(snapshot("RUNNING"));
    const before = await persisted();
    expect((await runs.getRunProgress("observe-run", "observe-owner"))?.run.status).toBe(status);
    expect(await persisted()).toEqual(before);
  });

});
