import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures, DISTINCT_TEST_PRICING, installTestPricing } from "@docslurp/shared";
import type { SqlClient } from "../db.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("source-bound materialization monthly readmission (PostgreSQL)", () => {
  let sql: postgres.Sql;
  let create: typeof import("../search/deferred/materialize-client.js").defaultMaterializeDeps.createRun;
  let funding: typeof import("../services/spend-paused-runs.js");
  let guard: typeof import("../services/billing/spend-guard.js");
  let lifecycle: ReturnType<typeof import("../services/run-lifecycle.js").createRunLifecycle>;
  const signals = { pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
  const pages = [1, 2, 3, 4, 5, 6, 7, 8];
  let id: string;
  beforeAll(async () => {
    vi.stubEnv("WORKER_CREDIT_LEASES", "off");
    vi.stubEnv("CHAT_CREDIT_RESERVE_CREDITS", "0");
    vi.stubEnv("CHAT_CREDIT_RESERVE_STARTER_CREDITS", "0");
    sql = postgres(url!, { max: 5, prepare: false, onnotice: () => {} });
    vi.doMock("../db.js", () => ({ sql }));
    vi.doMock("../lib/temporal.js", () => ({ startMaterializeWorkflow: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn() }));
    ({ defaultMaterializeDeps: { createRun: create } } = await import("../search/deferred/materialize-client.js"));
    funding = await import("../services/spend-paused-runs.js");
    guard = await import("../services/billing/spend-guard.js");
    const { createRunLifecycle } = await import("../services/run-lifecycle.js");
    lifecycle = createRunLifecycle({ sql: sql as unknown as SqlClient, startWorkflow: vi.fn(), failureThreshold: 3 });
    await sql`insert into "user"(id,name,email) values('mat-u','Materialize','materialize@example.test') on conflict do nothing`;
    await sql`insert into organizations(id,name,created_by_user_id,credit_balance_cents) values('mat-o','Materialize','mat-u',1000000) on conflict do nothing`;
    await sql`insert into projects(id,org_id,user_id,name) values('mat-p','mat-o','mat-u','Materialize') on conflict do nothing`;
  });
  beforeEach(async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    signals.resume.mockClear();
    await sql`delete from usage_events`;
    await sql`delete from documents`;
    await sql`delete from project_runs`;
    await sql`update organizations set monthly_budget_cents=null,credit_balance_cents=1000000 where id='mat-o'`;
    await sql`update projects set monthly_budget_cents=null where id='mat-p'`;
  });
  afterAll(async () => { await sql?.end(); installTestPricing(); vi.unstubAllEnvs(); });
  const args = () => ({ orgId: "mat-o", projectId: "mat-p", userId: "mat-u", documentId: "mat-d",
    documents: 1, pages: pages.length, pageNumbers: pages, maxCredits: 2 });
  async function seed(path = "funding", boost = false, consumed = 0, currentMonth = false) {
    await sql`insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline)
      values('mat-source','mat-o','mat-p','mat-u','upload','completed','completed',${sql.json(JSON.parse(JSON.stringify({ ...defaultPipelineFeatures, speedBoost: boost })))})`;
    await sql`insert into documents(id,org_id,project_id,user_id,run_id,filename,mime_type,source_key,status,page_count,billing_pages,page_count_source)
      values('mat-d','mat-o','mat-p','mat-u','mat-source','measured.pdf','application/pdf','raw/measured','completed',8,8,'counted')`;
    id = await create(args());
    await sql`update project_runs set control_state='paused',pause_reason=${path === "funding" ? "credit_exhausted" : null} where id=${id}`;
    if (consumed) await sql`insert into usage_events(id,user_id,org_id,project_id,run_id,metric,provider,model,unit,amount,cost_cents,created_at)
      values('mat-usage','mat-u','mat-o','mat-p',${id},'ingest-page-rich','docslurp','unit','page',1,${consumed},
        case when ${currentMonth} then now() else date_trunc('month',now())-interval '1 day' end)`;
  }
  async function resume(path: string, boost = false) {
    if (path === "funding") return funding.sweepSpendPausedRuns({ sql: sql as unknown as SqlClient, signals, orgId: "mat-o" });
    return guard.admitRunSpend("mat-o", "mat-p", tx => lifecycle.control({ id, status: "processing", controlState: "paused", priority: 0, error: null },
      { action: "resume" }, tx), { readmission: true, leaseRunId: id, speedBoost: boost });
  }
  async function refused(path: string, boost = false) {
    const [before] = await sql`select monthly_reservation_cents from project_runs where id=${id}`;
    if (path === "funding") expect(await resume(path, boost)).toEqual({ resumed: 0, stillBlocked: 1 });
    else await expect(resume(path, boost)).rejects.toThrow();
    expect((await sql`select control_state,monthly_reservation_cents from project_runs where id=${id}`)[0])
      .toMatchObject({ control_state: "paused", monthly_reservation_cents: before!.monthly_reservation_cents });
    expect(signals.resume).not.toHaveBeenCalled();
  }
  for (const path of ["operator", "funding"]) {
    it(`${path} reuses intact exact capacity with no owned documents`, async () => {
      await seed(path);
      expect(await sql`select id from documents where run_id=${id}`).toHaveLength(0);
      await sql`update organizations set monthly_budget_cents=2 where id='mat-o'`;
      await sql`update projects set monthly_budget_cents=2 where id='mat-p'`;
      await resume(path);
      expect((await sql`select control_state,monthly_reservation_cents::float8 as cents from project_runs where id=${id}`)[0])
        .toMatchObject({ control_state: null, cents: 2 });
    });
    it.each([false, true])(`${path} replenishes consumed past-month coverage with boost=%s at exact caps`, async boost => {
      const demand = boost ? 8 : 2;
      await seed(path, boost, demand);
      await sql`update organizations set monthly_budget_cents=${demand} where id='mat-o'`;
      await sql`update projects set monthly_budget_cents=${demand} where id='mat-p'`;
      await resume(path, boost);
      expect((await sql`select control_state,monthly_reservation_cents::float8 as cents from project_runs where id=${id}`)[0])
        .toMatchObject({ control_state: null, cents: demand * 2 });
    });
    it.each(["organization", "project"])(`${path} refuses the current-month %s cap without double-counting old coverage`, async scope => {
      await seed(path, true, 8, true);
      if (scope === "organization") await sql`update organizations set monthly_budget_cents=15 where id='mat-o'`;
      else await sql`update projects set monthly_budget_cents=15 where id='mat-p'`;
      await refused(path, true);
    });
    it(`${path} permits exact current-month usage plus boosted remaining capacity`, async () => {
      await seed(path, true, 8, true);
      await sql`update organizations set monthly_budget_cents=16 where id='mat-o'`;
      await sql`update projects set monthly_budget_cents=16 where id='mat-p'`;
      await resume(path, true);
      expect((await sql`select control_state,monthly_reservation_cents::float8 as cents from project_runs where id=${id}`)[0])
        .toMatchObject({ control_state: null, cents: 16 });
    });
    it(`${path} prices only unfinished targets with verified page decisions`, async () => {
      await seed(path, false, 2);
      await sql`insert into document_page_states(document_id,page_number,state,materialized_by)
        select 'mat-d',p,'indexed','ingest' from generate_series(1,4) p`;
      await sql`update organizations set monthly_budget_cents=1 where id='mat-o'`;
      await resume(path);
      expect(Number((await sql`select cents from pending_monthly_capacity where run_id=${id}`)[0]!.cents)).toBe(1);
    });
    it(`${path} retains indexed-but-unbilled page demand`, async () => {
      await seed(path, false, 2);
      await sql`insert into document_page_states(document_id,page_number,state,materialized_by)
        select 'mat-d',p,'indexed','query' from generate_series(1,8) p`;
      await sql`update organizations set monthly_budget_cents=1 where id='mat-o'`;
      await refused(path);
    });
    it(`${path} reuses committed query-page decisions without reserving their cost twice`, async () => {
      await seed(path);
      await sql`insert into document_page_states(document_id,page_number,state,materialized_by,fee_billed_run)
        select 'mat-d',p,'indexed','query',${id} from generate_series(1,4) p`;
      for (const page of [1, 2, 3, 4]) await sql`insert into usage_events(id,user_id,org_id,project_id,run_id,metric,provider,model,unit,amount,cost_cents,metadata,created_at)
        values(${`mat-page-${page}`},'mat-u','mat-o','mat-p',${id},'ingest-page-rich','docslurp','unit','page',1,0.25,
          ${sql.json({ documentId: "mat-d", page })},date_trunc('month',now())-interval '1 day')`;
      await sql`update organizations set monthly_budget_cents=1 where id='mat-o'`;
      await resume(path);
      expect(Number((await sql`select cents from pending_monthly_capacity where run_id=${id}`)[0]!.cents)).toBe(1);
    });
    it(`${path} rolls replenishment back when live credits refuse`, async () => {
      await seed(path, false, 2);
      await sql`update organizations set credit_balance_cents=0 where id='mat-o'`;
      await refused(path);
    });
    it(`${path} serializes replenishment against new capacity`, async () => {
      await seed(path, false, 2);
      await sql`update organizations set monthly_budget_cents=2 where id='mat-o'`;
      await Promise.allSettled([resume(path), guard.admitRunSpend("mat-o", "mat-p", tx => tx`
        insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline,monthly_reservation_cents)
        values('mat-new','mat-o','mat-p','mat-u','upload','queued','queued','{}',2)`)]);
      const [run] = await sql`select control_state from project_runs where id=${id}`;
      expect((run!.control_state === null ? 1 : 0) + (await sql`select id from project_runs where id='mat-new'`).length).toBe(1);
      expect(Number((await sql`select sum(cents) as cents from pending_monthly_capacity where org_id='mat-o'`)[0]!.cents)).toBe(2);
    });
    it.each(["missing", "foreign", "corrupt", "bounds", "changed", "manifest", "foreign-source", "source-key", "blocked"])(`${path} refuses a %s persisted source/plan`, async fault => {
      await seed(path);
      if (fault === "missing") await sql`delete from documents where id='mat-d'`;
      if (fault === "foreign") await sql`update project_runs set stats=jsonb_set(stats,'{materialization,orgId}','"foreign"') where id=${id}`;
      if (fault === "corrupt") await sql`update project_runs set stats='{}' where id=${id}`;
      if (fault === "bounds") await sql`update project_runs set stats=jsonb_set(stats,'{materialization,pages}','[999]') where id=${id}`;
      if (fault === "changed") await sql`update documents set materialization_generation=materialization_generation+1 where id='mat-d'`;
      if (fault === "source-key") await sql`update documents set source_key='raw/replaced' where id='mat-d'`;
      if (fault === "blocked") await sql`update documents set source_materialization_blocked=true where id='mat-d'`;
      if (fault === "manifest") await sql`update project_runs set pages_total=9 where id=${id}`;
      if (fault === "foreign-source") {
        await sql`insert into organizations(id,name,created_by_user_id) values('foreign-o','Foreign','mat-u') on conflict do nothing`;
        await sql`insert into projects(id,org_id,user_id,name) values('foreign-p','foreign-o','mat-u','Foreign') on conflict do nothing`;
        await sql`insert into documents(id,org_id,project_id,user_id,filename,mime_type,source_key,status,page_count)
          values('foreign-d','foreign-o','foreign-p','mat-u','foreign.pdf','application/pdf','raw/foreign','completed',8)`;
        await sql`update project_runs set stats=jsonb_set(stats,'{materialization,documentId}','"foreign-d"') where id=${id}`;
      }
      await refused(path);
    });
  }
  it("rolls materialization replenishment back after refused signal delivery", async () => {
    await seed("funding", false, 2);
    signals.resume.mockRejectedValueOnce(new Error("Injected signal delivery fault"));
    expect(await funding.resumeSpendPausedRunOutcome(id, { sql: sql as unknown as SqlClient, signals })).toEqual({ status: "deferred" });
    expect((await sql`select control_state,monthly_reservation_cents::float8 as cents from project_runs where id=${id}`)[0])
      .toMatchObject({ control_state: "paused", cents: 2 });
    expect(await sql`select id from project_run_events where run_id=${id}`).toHaveLength(0);
  });
  it.each(["missing", "foreign", "duplicate", "unbounded"])("refuses %s work before allocation", async fault => {
    await seed();
    const request = args();
    if (fault === "missing") request.documentId = "missing";
    if (fault === "foreign") request.projectId = "foreign";
    if (fault === "duplicate") request.pageNumbers = [1, 1, 2, 3, 4, 5, 6, 7];
    if (fault === "unbounded") request.pageNumbers = [1, 2, 3, 4, 5, 6, 7, 9];
    await expect(create(request)).rejects.toThrow();
    expect(await sql`select id from project_runs where kind='materialize'`).toHaveLength(1);
  });
  it("persists the exact bounded source snapshot and boosted initial reservation", async () => {
    await seed("funding", true);
    expect((await sql`select stats,pipeline,monthly_reservation_cents::float8 as cents from project_runs where id=${id}`)[0])
      .toMatchObject({ cents: 8, pipeline: { speedBoost: true }, stats: { materialization: {
        version: 1, orgId: "mat-o", projectId: "mat-p", documentId: "mat-d", sourceRunId: "mat-source",
        sourceKey: "raw/measured", generation: 0, pageCount: 8, pages, maxCredits: 2,
      } } });
  });
  it.each(["organization", "project"])("refuses boosted initial work beyond the %s cap", async scope => {
    await seed("funding", true);
    await sql`update project_runs set status='failed' where id=${id}`;
    if (scope === "organization") await sql`update organizations set monthly_budget_cents=3 where id='mat-o'`;
    else await sql`update projects set monthly_budget_cents=3 where id='mat-p'`;
    await expect(create(args())).rejects.toThrow();
    expect(await sql`select id from project_runs where kind='materialize'`).toHaveLength(1);
  });
});
