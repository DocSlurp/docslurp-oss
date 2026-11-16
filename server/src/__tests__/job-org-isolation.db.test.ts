import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Organization isolation for jobs: a job id never reports another organization's (or an unreachable project's)
 * runs, and a job can never be stamped across organizations.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let jobs: typeof import("../services/jobs.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  // Two organizations (one org per user is enforced by the schema).
  await sql`insert into "user"(id, name, email) values ('u-a', 'A', 'job-a@example.com'), ('u-b', 'B', 'job-b@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'job-org-a', 'u-a'), ('org-b', 'B', 'job-org-b', 'u-b')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('org-a', 'u-a', 'owner'), ('org-b', 'u-b', 'owner')`;
  for (const [id, org, user] of [["p-a", "org-a", "u-a"], ["p-b", "org-b", "u-b"]] as const) {
    await sql`insert into projects(id, org_id, user_id, name, slug, pipeline) values (${id}, ${org}, ${user}, ${id}, ${`${id}-slug`}, '{}'::jsonb)`;
  }
  jobs = await import("../services/jobs.js");
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  await sql`delete from project_runs`;
  for (const [id, org, user, project] of [["run-a", "org-a", "u-a", "p-a"], ["run-b", "org-b", "u-b", "p-b"]] as const) {
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values (${id}, ${org}, ${user}, ${project}, 'reprocess', 'completed', 'completed', '{}', 7, 70)`;
  }
});

const meta = (id: string) => jobs.jobMetaFor(id, "reprocess", { estimate: null });

describe("job organization isolation", () => {
  it("refuses to stamp one job id on runs of two organizations", async () => {
    await expect(jobs.recordJobMeta(["run-a", "run-b"], meta("run-a"))).rejects.toThrow(/one organization/);
    const rows = await sql<{ id: string; job_id: string | null }[]>`select id, job_id from project_runs order by id`;
    expect(rows.every((row) => row.job_id === null)).toBe(true);
  });

  it("never reports another organization's run under a shared job id, even if one exists", async () => {
    // A row shape the writer now refuses (both runs carry org A's job id): the read still isolates.
    await sql`update project_runs set job_id = 'run-a'`;
    const forA = await jobs.getJobStatus("run-a", "u-a");
    expect(forA?.runIds).toEqual(["run-a"]);
    expect(forA?.progress.documentsTotal).toBe(7);
    // Org B's member sees only org B's own run (which carries the id), never org A's run id or counts.
    const forB = await jobs.getJobStatus("run-a", "u-b");
    expect(forB?.runIds).toEqual(["run-b"]);
    expect(forB?.progress.documentsTotal).toBe(7);
  });

  it("filters runs by the API key's organization and project allowlist", async () => {
    await sql`update project_runs set job_id = 'run-a'`;
    const keyA = { orgId: "org-a", projectIds: [] as string[] };
    expect((await jobs.getJobStatus("run-a", "u-a", { apiKey: keyA as never }))?.runIds).toEqual(["run-a"]);
    const wrongProject = { orgId: "org-a", projectIds: ["p-other"] };
    expect(await jobs.getJobStatus("run-a", "u-a", { apiKey: wrongProject as never })).toBeNull();
    // A key of the other organization (wrong scope) sees nothing of org A's job.
    const keyB = { orgId: "org-b", projectIds: [] as string[] };
    expect(await jobs.getJobStatus("run-a", "u-a", { apiKey: keyB as never })).toBeNull();
  });

  it("stamps a single-organization job normally", async () => {
    await jobs.recordJobMeta(["run-a"], meta("run-a"));
    expect((await jobs.getJobStatus("run-a", "u-a"))?.runIds).toEqual(["run-a"]);
  });
});
