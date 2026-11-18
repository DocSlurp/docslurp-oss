import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * 0199: the activity feeds read active runs plus recently finished ones through indexes, never a project's or an
 * organization's whole run history: listRuns(activity), getRun, the realtime activity projection and the org
 * activity summary. One large project holds the history (100K finished runs here, more on a real Postgres); every
 * SELECT the real functions send is captured and EXPLAINed with its parameters. Also checks the finished_at trigger.
 */
const external = process.env.TEST_DATABASE_URL;
const RUNS = external ? 400_000 : 100_000;
// The history lives in project_runs; the handful of projects and memberships may be scanned.
const BIG = /Seq Scan on project_runs\b/;

let sql: postgres.Sql;
let captured: Array<{ text: string; params: unknown[] }> = [];
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const pg = external ? null : await startMigratedPostgres();
  stop = pg?.stop;
  sql = postgres(external ?? pg!.url, {
    max: 1, prepare: false, onnotice: () => {},
    debug: (_connection, text, params) => { captured.push({ text, params: params as unknown[] }); },
  });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  await sql.unsafe(`
    INSERT INTO "user" (id,name,email) VALUES ('af-user','A','af@example.test');
    INSERT INTO organizations (id,name,slug,created_by_user_id,personal_owner_user_id) VALUES ('af-org','A','af-org','af-user','af-user');
    INSERT INTO org_memberships (org_id,user_id,role) VALUES ('af-org','af-user','owner');
    INSERT INTO projects (id,org_id,user_id,name,slug) VALUES ('af-big','af-org','af-user','Big','af-big'), ('af-small','af-org','af-user','Small','af-small');
    SET session_replication_role = replica;
    INSERT INTO project_runs (id, org_id, user_id, project_id, kind, status, stage, created_at, updated_at, finished_at)
    SELECT 'af-r' || g, 'af-org', 'af-user', CASE WHEN g % 50 = 0 THEN 'af-small' ELSE 'af-big' END, 'bulk-upload',
      CASE WHEN g % 10 = 0 THEN 'failed' ELSE 'completed' END, 'completed',
      now() - ((${RUNS} - g) * 20 || ' seconds')::interval, now() - ((${RUNS} - g) * 20 || ' seconds')::interval,
      now() - ((${RUNS} - g) * 20 || ' seconds')::interval
    FROM generate_series(1, ${RUNS}) g;
    SET session_replication_role = origin;
    SET session_replication_role = replica;
    INSERT INTO project_runs (id, org_id, user_id, project_id, kind, status, stage, created_at, updated_at)
    SELECT 'af-blocked' || g, 'af-org', 'af-user', 'af-big', 'bulk-upload', 'blocked', 'quarantine',
      now() - (g || ' hours')::interval, now() - (g || ' hours')::interval FROM generate_series(1, 2000) g;
    SET session_replication_role = origin;
    INSERT INTO project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, created_at) VALUES
      (100, 'af-live', 'af-org', 'af-user', 'af-big', 'bulk-upload', 'processing', 'extract', now() - interval '2 minutes'),
      (100, 'af-queued', 'af-org', 'af-user', 'af-big', 'bulk-upload', 'queued', 'quarantine', now() - interval '1 minute');
    ANALYZE;
  `);
}, 600_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

async function plansOf(work: () => Promise<unknown>): Promise<Array<{ text: string; plan: string }>> {
  captured = [];
  await work();
  const selects = [...captured].filter(query => /^\s*\(?\s*(select|with)\b/i.test(query.text));
  const plans: Array<{ text: string; plan: string }> = [];
  for (const query of selects) {
    const rows = await sql.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${query.text}`, query.params as never[]);
    plans.push({ text: query.text, plan: rows.map(row => row["QUERY PLAN"]).join("\n") });
  }
  return plans;
}

function expectNoBigSeqScan(plans: Array<{ text: string; plan: string }>): void {
  for (const { text, plan } of plans) {
    expect(plan, `${text.replace(/\s+/g, " ").slice(0, 200)}\n${plan}`).not.toMatch(BIG);
  }
}

describe("activity feed plans (0199)", () => {
  it("listRuns(activity) reads active, just-finished and blocked runs by index and returns only those", async () => {
    const { listRuns } = await import("../services/runs.js");
    let runs: Array<{ id: string }> = [];
    const plans = await plansOf(async () => { runs = await listRuns("af-user", true); });
    // The two active runs plus the 15 seeded runs that finished in the last five minutes (one every 20 s).
    expect(runs.map(run => run.id)).toEqual(expect.arrayContaining(["af-live", "af-queued", `af-r${RUNS}`]));
    expect(runs.length).toBe(17);
    const activity = plans.find(({ text }) => /finished_at > now\(\)/.test(text));
    // Either finished index (by project or by organization) bounds the five-minute window; either active index the rest.
    expect(activity?.plan).toMatch(/project_runs_(project|org)_finished_idx/);
    expect(activity?.plan).toMatch(/project_runs_(project|org)_active_idx/);
    expect(activity?.plan).toMatch(/project_runs_org_blocked_idx/);
    expectNoBigSeqScan(plans);
  }, 180_000);

  it("getRun reads one run by key without listing the caller's projects", async () => {
    const { getRun } = await import("../services/runs.js");
    const plans = await plansOf(async () => { expect((await getRun("af-r77", "af-user", { cost: false }))?.id).toBe("af-r77"); });
    expect(plans.some(({ text }) => /docslurp_project_access\(runs\.project_id/.test(text))).toBe(true);
    expect(plans.some(({ text }) => /from projects w\s+where \(/.test(text))).toBe(false);
    expectNoBigSeqScan(plans);
    expect(await getRun("af-r77", "nobody")).toBeNull();
  }, 120_000);

  it("getRun refuses another organization's run and a run outside an API key's project allowlist", async () => {
    const { getRun } = await import("../services/runs.js");
    const { Hono } = await import("hono");
    const { requestContextMiddleware, setCurrentRequestApiKeyProjectIds } = await import("../lib/request-context.js");
    await sql.unsafe(`
      INSERT INTO "user" (id,name,email) VALUES ('af-other','O','af-other@example.test') ON CONFLICT DO NOTHING;
      INSERT INTO organizations (id,name,slug,created_by_user_id) VALUES ('af-org2','B','af-org2','af-other') ON CONFLICT DO NOTHING;
      INSERT INTO org_memberships (org_id,user_id,role) VALUES ('af-org2','af-other','owner') ON CONFLICT DO NOTHING;
      INSERT INTO projects (id,org_id,user_id,name,slug) VALUES ('af-foreign','af-org2','af-other','F','af-foreign') ON CONFLICT DO NOTHING;
      INSERT INTO project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage)
        VALUES (100, 'af-foreign-run', 'af-org2', 'af-other', 'af-foreign', 'bulk-upload', 'processing', 'extract') ON CONFLICT DO NOTHING;
    `);
    expect(await getRun("af-foreign-run", "af-user", { cost: false })).toBeNull();
    // A member removed from the organization reads nothing.
    await sql`insert into "user" (id,name,email) values ('af-gone','G','af-gone@example.test') on conflict do nothing`;
    await sql`insert into org_memberships (org_id,user_id,role) values ('af-org2','af-gone','admin') on conflict do nothing`;
    expect((await getRun("af-foreign-run", "af-gone", { cost: false }))?.id).toBe("af-foreign-run");
    await sql`delete from org_memberships where org_id = 'af-org2' and user_id = 'af-gone'`;
    expect(await getRun("af-foreign-run", "af-gone", { cost: false })).toBeNull();
    expect((await getRun("af-foreign-run", "af-other", { cost: false }))?.id).toBe("af-foreign-run");
    const app = new Hono()
      .use("*", requestContextMiddleware)
      .use("*", async (_c, next) => { setCurrentRequestApiKeyProjectIds(["af-small"]); await next(); })
      .get("/run/:id", async c => c.json({ run: (await getRun(c.req.param("id"), "af-user", { cost: false }))?.id ?? null }));
    // r50 is in af-small (every 50th run), r77 in af-big: the key may use af-small only.
    expect(await (await app.request("/run/af-r50")).json()).toEqual({ run: "af-r50" });
    expect(await (await app.request("/run/af-r77")).json()).toEqual({ run: null });
  }, 120_000);

  it("the realtime activity projection reads active, then recently finished runs, in index order", async () => {
    const { realtimeBackend } = await import("../realtime/backend.js");
    let result: { runs: Array<{ id: string }>; truncated: boolean } | undefined;
    const plans = await plansOf(async () => { result = await realtimeBackend.project("af-user", { kind: "activity", orgId: "af-org" }) as typeof result; });
    expect(result?.runs[0]?.id).toMatch(/^af-(live|queued)$/);
    // Active runs, then blocked ones (newest first), then the most recently finished.
    expect(result?.runs[2]?.id).toBe("af-blocked1");
    expect(result?.truncated).toBe(true);
    const activity = plans.find(({ text }) => /finished_at is not null/.test(text));
    expect(activity?.plan).toMatch(/project_runs_org_finished_idx/);
    expect(activity?.plan).toMatch(/project_runs_org_active_idx/);
    expect(activity?.plan).toMatch(/project_runs_org_blocked_idx/);
    expectNoBigSeqScan(plans);
  }, 180_000);

  it("the org summary's recently completed read is a bounded finished_at range", async () => {
    const { computeOrgActivitySummary } = await import("../services/run-activity-summary.js");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const plans = await plansOf(() => computeOrgActivitySummary({ orgId: "af-org", projectIds: ["af-big", "af-small"] }));
    const recent = plans.find(({ text }) => /finished_at > now\(\)/.test(text));
    expect(recent?.plan).toMatch(/project_runs_org_finished_idx/);
    expectNoBigSeqScan(plans);
  }, 120_000);

  it("stamps finished_at once per finish and clears it while a run is active again", async () => {
    await sql`insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage)
      values (100, 'af-t', 'af-org', 'af-user', 'af-small', 'bulk-upload', 'processing', 'extract')`;
    const read = async () => (await sql<{ finished_at: Date | null }[]>`select finished_at from project_runs where id = 'af-t'`)[0]!.finished_at;
    expect(await read()).toBeNull();
    await sql`update project_runs set status = 'completed' where id = 'af-t'`;
    const first = await read();
    expect(first).not.toBeNull();
    // A heartbeat-style write (no status change) never moves it.
    await sql`update project_runs set updated_at = now() + interval '1 minute', status = 'completed' where id = 'af-t'`;
    expect((await read())?.getTime()).toBe(first!.getTime());
    await sql`update project_runs set status = 'queued' where id = 'af-t'`;
    expect(await read()).toBeNull();
  }, 60_000);
});
