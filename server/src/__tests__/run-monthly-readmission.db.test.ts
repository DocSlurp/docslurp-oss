import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { createRunLifecycle } from "../services/run-lifecycle.js";
import type { SqlClient } from "../db.js";

const url = process.env.TEST_DATABASE_URL;
let sql: postgres.Sql;
let guard: typeof import("../services/billing/spend-guard.js");
let lifecycle: ReturnType<typeof createRunLifecycle>;
beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 5, prepare: false });
  vi.doMock("../db.js", () => ({ sql }));
  guard = await import("../services/billing/spend-guard.js");
  lifecycle = createRunLifecycle({ sql: sql as unknown as SqlClient, startWorkflow: vi.fn(), failureThreshold: 3 });
  await sql`insert into "user"(id,name,email) values('readmit-u','Readmit','readmit@example.test')`;
  await sql`insert into organizations(id,name,created_by_user_id,credit_balance_cents) values('readmit-o','Readmit','readmit-u',10000)`;
  await sql`insert into projects(id,org_id,user_id,name) values('readmit-p','readmit-o','readmit-u','Readmit')`;
});
beforeEach(async () => { if (url) { await sql`delete from usage_events`; await sql`delete from documents`; await sql`delete from project_runs`; await sql`update organizations set monthly_budget_cents=null where id='readmit-o'`; } });
afterAll(async () => { await sql?.end(); });
async function seed(id: string, size: number) {
  await sql`insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline,monthly_reservation_cents)
    values(${id},'readmit-o','readmit-p','readmit-u','upload','failed','extract-markdown',${sql.json(defaultPipelineFeatures as never)},0)`;
  await sql`insert into documents(id,org_id,project_id,user_id,run_id,filename,mime_type,source_key,status,file_size)
    values(${id},'readmit-o','readmit-p','readmit-u',${id},'a.txt','text/plain','synthetic','failed',${size})`;
}
const retry = (id: string, org = 'readmit-o') => guard.admitRunSpend(org,'readmit-p',tx => lifecycle.prepareRetry({id,pipeline:defaultPipelineFeatures,status:'failed'},tx),{readmission:true,leaseRunId:id,speedBoost:false});
it.skipIf(!url)("restores zero capacity from measured work", async () => {
  await seed('restore',1000);
  await sql`insert into usage_events(id,user_id,org_id,project_id,run_id,metric,provider,model,unit,amount,cost_cents)
    values('readmit-usage','readmit-u','readmit-o','readmit-p','restore','ingest-page-fast','docslurp','unit','page',1,7)`;
  await retry('restore');
  const [run] = await sql`select status,monthly_reservation_cents from project_runs where id='restore'`;
  expect(run!.status).toBe('queued'); expect(Number(run!.monthly_reservation_cents)).toBeGreaterThan(7);
});
it.skipIf(!url).each([0, -1])("refuses invalid workload %s and wrong tenant before checkpoint changes", async size => {
  await seed('unknown',size);
  await expect(retry('unknown')).rejects.toThrow(/measured positive workload/);
  await expect(retry('unknown','other')).rejects.toMatchObject({code:'plan_not_entitled'});
  expect((await sql`select status,monthly_reservation_cents from project_runs where id='unknown'`)[0]).toMatchObject({status:'failed',monthly_reservation_cents:'0'});
  expect((await sql`select status from documents where id='unknown'`)[0]!.status).toBe('failed');
});
it.skipIf(!url)("serializes competing reactivations and rolls back the losing manifest", async () => {
  await seed('probe',1000); await retry('probe');
  const [probe] = await sql`select monthly_reservation_cents from project_runs where id='probe'`;
  await sql`delete from project_runs where id='probe'`;
  await sql`update organizations set monthly_budget_cents=${probe!.monthly_reservation_cents} where id='readmit-o'`;
  await seed('a',1000); await seed('b',1000);
  const outcomes = await Promise.allSettled([retry('a'),retry('b')]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await sql`select status from project_runs order by status`).map(r=>r.status)).toEqual(['failed','queued']);
  expect((await sql`select count(*)::int as n from documents where status='failed'`)[0]!.n).toBe(1);
});
