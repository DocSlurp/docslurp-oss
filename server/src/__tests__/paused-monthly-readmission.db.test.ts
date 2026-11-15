import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures, DISTINCT_TEST_PRICING, installTestPricing } from "@docslurp/shared";
import type { SqlClient } from "../db.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("measured paused monthly readmission (PostgreSQL)", () => {
  let sql: postgres.Sql;
  let guard: typeof import("../services/billing/spend-guard.js");
  let funding: typeof import("../services/spend-paused-runs.js");
  let lifecycle: ReturnType<typeof import("../services/run-lifecycle.js").createRunLifecycle>;
  let buildRunProcessingPreview: typeof import("../services/run-processing-preview.js").buildRunProcessingPreview;
  const signals = { pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
  const pipeline = { ...defaultPipelineFeatures, quality: "fast" as const };
  const files = [{ filename: "measured.pdf", mimeType: "application/pdf", sizeBytes: 1000, pages: 1000 }];
  const forecast = (boost = false) => Math.max(1, buildRunProcessingPreview({
    request: { project: "paused-p", pipeline: { ...pipeline, speedBoost: boost }, speedBoost: boost, files, urls: [] },
  }).current.estimatedCost.maxCents);

  beforeAll(async () => {
    vi.stubEnv("WORKER_CREDIT_LEASES", "off");
    vi.stubEnv("CHAT_CREDIT_RESERVE_CREDITS", "0");
    vi.stubEnv("CHAT_CREDIT_RESERVE_STARTER_CREDITS", "0");
    sql = postgres(url!, { max: 5, prepare: false, onnotice: () => {} });
    vi.doMock("../db.js", () => ({ sql }));
    ({ buildRunProcessingPreview } = await import("../services/run-processing-preview.js"));
    const { createRunLifecycle } = await import("../services/run-lifecycle.js");
    guard = await import("../services/billing/spend-guard.js");
    funding = await import("../services/spend-paused-runs.js");
    lifecycle = createRunLifecycle({ sql: sql as unknown as SqlClient, startWorkflow: vi.fn(), failureThreshold: 3 });
    await sql`insert into "user"(id,name,email) values('paused-u','Paused','paused@example.test') on conflict do nothing`;
    await sql`insert into organizations(id,name,created_by_user_id,credit_balance_cents) values('paused-o','Paused','paused-u',1000000) on conflict do nothing`;
    await sql`insert into projects(id,org_id,user_id,name) values('paused-p','paused-o','paused-u','Paused') on conflict do nothing`;
    await sql`insert into org_memberships(org_id,user_id,role) values('paused-o','paused-u','owner') on conflict do nothing`;
  });
  beforeEach(async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    signals.resume.mockClear();
    await sql`delete from usage_events`;
    await sql`delete from documents`;
    await sql`delete from project_runs`;
    await sql`update organizations set monthly_budget_cents=null,credit_balance_cents=1000000 where id='paused-o'`;
    await sql`update projects set monthly_budget_cents=null where id='paused-p'`;
  });
  afterAll(async () => { await sql?.end(); installTestPricing(); vi.unstubAllEnvs(); });

  async function seed(path: string, reservation = 10, consumed = 10, boost = false) {
    await sql`insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline,control_state,pause_reason,monthly_reservation_cents)
      values('paused-r','paused-o','paused-p','paused-u','upload','processing','extract-markdown',
        ${sql.json(JSON.parse(JSON.stringify({ ...pipeline, speedBoost: boost })))},'paused',${path === "funding" ? "credit_exhausted" : null},${reservation})`;
    await sql`insert into documents(id,org_id,project_id,user_id,run_id,filename,mime_type,source_key,status,file_size,page_count,billing_pages,page_count_source)
      values('paused-d','paused-o','paused-p','paused-u','paused-r','measured.pdf','application/pdf','raw/measured','processing',1000,1000,1000,'counted')`;
    await sql`insert into document_run_stage_states(run_id,document_id,stage_name,status)
      values('paused-r','paused-d','parse','completed')`;
    if (consumed) await sql`insert into usage_events(id,user_id,org_id,project_id,run_id,metric,provider,model,unit,amount,cost_cents,created_at)
      values('paused-usage','paused-u','paused-o','paused-p','paused-r','ingest-page-fast','docslurp','unit','page',1,${consumed},date_trunc('month',now())-interval '1 day')`;
  }
  async function resume(path: string, boost = false) {
    if (path === "funding") return funding.resumeSpendPausedRunOutcome("paused-r", { sql: sql as unknown as SqlClient, signals });
    return guard.admitRunSpend("paused-o", "paused-p", tx => lifecycle.control({
      id: "paused-r", status: "processing", priority: 0, controlState: "paused", error: null,
    }, { action: "resume" }, tx), { readmission: true, leaseRunId: "paused-r", speedBoost: boost });
  }
  async function refused(path: string, boost = false) {
    if (path === "funding") expect((await resume(path, boost) as { status: string }).status).not.toBe("resumed");
    else await expect(resume(path, boost)).rejects.toThrow();
    expect((await sql`select control_state,monthly_reservation_cents::float8 as monthly_reservation_cents from project_runs where id='paused-r'`)[0])
      .toMatchObject({ control_state: "paused", monthly_reservation_cents: 10 });
    expect(signals.resume).not.toHaveBeenCalled();
    expect(await sql`select id from project_run_events where run_id='paused-r'`).toHaveLength(0);
    expect((await sql`select status from document_run_stage_states where run_id='paused-r' and stage_name='parse'`)[0]!.status).toBe("completed");
  }

  for (const path of ["operator", "funding"]) {
    it.each(["organization", "project"])(`${path} refuses exhausted lifetime coverage after month rollover at a changed %s cap`, async scope => {
      await seed(path);
      const cap = forecast() - 1;
      if (scope === "organization") await sql`update organizations set monthly_budget_cents=${cap} where id='paused-o'`;
      else await sql`update projects set monthly_budget_cents=${cap} where id='paused-p'`;
      await refused(path);
    });
    it(`${path} restores consumed coverage and permits exact current capacity`, async () => {
      await seed(path);
      await sql`update organizations set monthly_budget_cents=${forecast()} where id='paused-o'`;
      await sql`update projects set monthly_budget_cents=${forecast()} where id='paused-p'`;
      await resume(path);
      expect((await sql`select control_state,monthly_reservation_cents::float8 as monthly_reservation_cents from project_runs where id='paused-r'`)[0])
        .toMatchObject({ control_state: null, monthly_reservation_cents: 10 + forecast() });
      expect(Number((await sql`select cents from pending_monthly_capacity where run_id='paused-r'`)[0]!.cents)).toBe(forecast());
    });
    it(`${path} reuses intact exact coverage without charging twice`, async () => {
      await seed(path, 10 + forecast());
      await sql`update organizations set monthly_budget_cents=${forecast()} where id='paused-o'`;
      await resume(path);
      expect((await sql`select control_state,monthly_reservation_cents::float8 as monthly_reservation_cents from project_runs where id='paused-r'`)[0])
        .toMatchObject({ control_state: null, monthly_reservation_cents: 10 + forecast() });
    });
    it(`${path} refuses missing measured work with pause/reservation unchanged`, async () => {
      await seed(path);
      await sql`update documents set file_size=0,billing_pages=null,page_count_source='assumed' where id='paused-d'`;
      await refused(path);
    });
    it(`${path} rolls replenishment back when current credits refuse`, async () => {
      await seed(path);
      await sql`update organizations set credit_balance_cents=0 where id='paused-o'`;
      await refused(path);
    });
    it(`${path} prices only this run's unfinished nonsuperseded documents`, async () => {
      await seed(path);
      await sql`insert into documents(id,org_id,project_id,user_id,run_id,filename,mime_type,source_key,status,billing_pages,superseded_at)
        values('done-d','paused-o','paused-p','paused-u','paused-r','done.pdf','application/pdf','raw/done','completed',1000000,null),
          ('old-d','paused-o','paused-p','paused-u','paused-r','old.pdf','application/pdf','raw/old','processing',1000000,now())`;
      await sql`insert into projects(id,org_id,user_id,name) values('other-p','paused-o','paused-u','Other') on conflict do nothing`;
      await sql`insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline)
        values('other-r','paused-o','other-p','paused-u','upload','failed','extract-markdown','{}')`;
      await sql`insert into documents(id,org_id,project_id,user_id,run_id,filename,mime_type,source_key,status,billing_pages)
        values('other-d','paused-o','other-p','paused-u','other-r','other.pdf','application/pdf','raw/other','processing',1000000)`;
      await sql`update organizations set monthly_budget_cents=${forecast()} where id='paused-o'`;
      await resume(path);
      expect(Number((await sql`select cents from pending_monthly_capacity where run_id='paused-r'`)[0]!.cents)).toBe(forecast());
    });
    it.each(["organization", "project"])(`${path} serializes replenishment against a new admission at the %s cap`, async scope => {
      await seed(path);
      if (scope === "organization") await sql`update organizations set monthly_budget_cents=${forecast()} where id='paused-o'`;
      else await sql`update projects set monthly_budget_cents=${forecast()} where id='paused-p'`;
      const outcomes = await Promise.allSettled([resume(path), guard.admitRunSpend("paused-o", "paused-p", tx => tx`
        insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline,monthly_reservation_cents)
        values('new-r','paused-o','paused-p','paused-u','upload','queued','queued','{}',${forecast()})`)]);
      const [run] = await sql`select control_state from project_runs where id='paused-r'`;
      const count = (run!.control_state === null ? 1 : 0) + (await sql`select id from project_runs where id='new-r'`).length;
      expect(count).toBe(1);
      expect(Number((await sql`select sum(cents) as cents from pending_monthly_capacity where org_id='paused-o'`)[0]!.cents)).toBe(forecast());
      expect(outcomes).toHaveLength(2);
    });
    it.each(["organization", "project"])(`${path} prices the effective boosted pipeline before checking the %s cap`, async scope => {
      expect(forecast(true)).toBe(4 * forecast());
      await seed(path, 10, 10, true);
      const cap = forecast() + 1;
      if (scope === "organization") await sql`update organizations set monthly_budget_cents=${cap} where id='paused-o'`;
      else await sql`update projects set monthly_budget_cents=${cap} where id='paused-p'`;
      await refused(path, true);
    });
    it(`${path} admits the exact boosted cap with persisted pipeline parity`, async () => {
      await seed(path, 10, 10, true);
      await sql`update organizations set monthly_budget_cents=${forecast(true)} where id='paused-o'`;
      await sql`update projects set monthly_budget_cents=${forecast(true)} where id='paused-p'`;
      await resume(path, true);
      expect((await sql`select control_state,pipeline,monthly_reservation_cents::float8 as monthly_reservation_cents from project_runs where id='paused-r'`)[0])
        .toMatchObject({ control_state: null, pipeline: { speedBoost: true }, monthly_reservation_cents: 10 + forecast(true) });
    });
  }
  it("rolls back replenishment with a failed funding resume signal", async () => {
    await seed("funding");
    signals.resume.mockRejectedValueOnce(new Error("Injected signal refusal"));
    expect(await resume("funding")).toEqual({ status: "deferred" });
    expect((await sql`select control_state,monthly_reservation_cents::float8 as cents from project_runs where id='paused-r'`)[0])
      .toMatchObject({ control_state: "paused", cents: 10 });
    expect(await sql`select id from project_run_events where run_id='paused-r'`).toHaveLength(0);
  });
  it("refuses a wrong tenant before changing active coverage or pause", async () => {
    await seed("operator");
    await expect(guard.admitRunSpend("other-o", "paused-p", tx => lifecycle.control({ id: "paused-r", status: "processing",
      priority: 0, controlState: "paused", error: null }, { action: "resume" }, tx),
    { readmission: true, leaseRunId: "paused-r", speedBoost: false })).rejects.toMatchObject({ code: "plan_not_entitled" });
    expect((await sql`select control_state,monthly_reservation_cents::float8 as cents from project_runs where id='paused-r'`)[0])
      .toMatchObject({ control_state: "paused", cents: 10 });
  });
  it.each(["organization", "project", "exact"])("terminal retry uses boosted measured demand at the %s cap", async scope => {
    await seed("operator", 10, 10, true);
    await sql`update project_runs set status='failed',control_state=null where id='paused-r'`;
    await sql`update documents set status='failed' where id='paused-d'`;
    await sql`insert into document_run_stage_states(run_id,document_id,stage_name,status) values('paused-r','paused-d','extract-markdown','failed')`;
    const cap = scope === "exact" ? forecast(true) : forecast() + 1;
    if (scope === "organization") await sql`update organizations set monthly_budget_cents=${cap} where id='paused-o'`;
    else await sql`update projects set monthly_budget_cents=${cap} where id='paused-p'`;
    const retry = () => guard.admitRunSpend("paused-o", "paused-p", tx => lifecycle.prepareRetry({
      id: "paused-r", status: "failed", pipeline: { ...pipeline, speedBoost: true },
    }, tx), { readmission: true, leaseRunId: "paused-r", speedBoost: true });
    if (scope === "exact") {
      await retry();
      expect(Number((await sql`select monthly_reservation_cents from project_runs where id='paused-r'`)[0]!.monthly_reservation_cents)).toBe(10 + forecast(true));
    } else {
      await expect(retry()).rejects.toMatchObject({ code: scope === "organization" ? "org_budget_paused" : "project_budget_paused" });
      expect((await sql`select status,monthly_reservation_cents::float8 as monthly_reservation_cents from project_runs where id='paused-r'`)[0]).toMatchObject({ status: "failed", monthly_reservation_cents: 10 });
      expect((await sql`select status from document_run_stage_states where run_id='paused-r' and stage_name='extract-markdown'`)[0]!.status).toBe("failed");
    }
  });
  for (const path of ["creation", "config-change", "full-index"]) {
    it.each(["organization", "project", "exact"])(`${path} reserves the persisted boosted pipeline at the %s cap`, async scope => {
      await seed("operator", 10, 0, true);
      await sql`update project_runs set status='completed',control_state=null where id='paused-r'`;
      await sql`update documents set status='completed',indexing_mode='map' where id='paused-d'`;
      const cap = scope === "exact" ? forecast(true) : forecast() + 1;
      if (scope === "organization") await sql`update organizations set monthly_budget_cents=${cap} where id='paused-o'`;
      else await sql`update projects set monthly_budget_cents=${cap} where id='paused-p'`;
      const create = async () => {
        const boosted = { ...pipeline, speedBoost: true };
        if (path === "creation") {
          const { createRunCreation } = await import("../services/run-creation.js");
          return createRunCreation({ sql: sql as unknown as SqlClient, start: async () => ({ status: "started" }) }).create({
            userId: "paused-u", projectId: "paused-p", kind: "reprocess", pipeline: boosted, speedBoost: true,
            sources: { kind: "versionsOf", documentIds: ["paused-d"], reuse: true },
          });
        }
        const [doc] = await sql<import("../services/config-change.js").ReindexTarget[]>`select * from documents where id='paused-d'`;
        if (path === "full-index") {
          const { commitIndexJobs } = await import("../services/project-indexing-mode.js");
          return commitIndexJobs({ orgId: "paused-o", projectId: "paused-p", pages: 1000,
            batches: [{ docs: [doc!], pipeline: boosted, mode: "full", partial: false }] }, "paused-u");
        }
        const { createReindexRuns } = await import("../services/config-change.js");
        const { getProject } = await import("../services/projects.js");
        const project = await getProject("paused-p", "paused-u");
        if (!project) throw new Error("Missing fixture project");
        return sql.begin(tx => createReindexRuns({ tx, project, pipeline: boosted, userId: "paused-u",
          meta: { kind: "reindex" }, blockedReason: null, reusable: { partial: [], full: [doc!] } }));
      };
      if (scope !== "exact") {
        await expect(create()).rejects.toThrow();
        expect(await sql`select id from project_runs where id<>'paused-r'`).toHaveLength(0);
        expect(await sql`select id from documents where id<>'paused-d'`).toHaveLength(0);
        expect((await sql`select superseded_at from documents where id='paused-d'`)[0]!.superseded_at).toBeNull();
      } else {
        await create();
        const [run] = await sql`select pipeline,monthly_reservation_cents::float8 as cents from project_runs where id<>'paused-r'`;
        expect(run!.pipeline.speedBoost).toBe(true);
        const expected = buildRunProcessingPreview({ request: { project: "paused-p", pipeline: run!.pipeline,
          speedBoost: true, files: [{ ...files[0]!, sizeBytes: path === "creation" ? 1000 : 0 }], urls: [] } }).current.estimatedCost.maxCents;
        expect(run!.cents).toBe(expected);
        expect(run!.cents).toBe(forecast(true));
      }
    });
  }
});
