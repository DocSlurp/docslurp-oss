import postgres from "postgres";
import { intakeReceiptContext, bindIntakeReceipt } from "../services/intake-receipt-context.js";
import { afterAll, beforeAll, expect, it, vi, describe } from "vitest";
import { readFile } from "node:fs/promises";
describe.skipIf(!process.env.TEST_DATABASE_URL)("durable monthly admission (real PostgreSQL)", () => {
let sql: postgres.Sql;
let guard: typeof import("../services/billing/spend-guard.js");
beforeAll(async () => {
 const url=process.env.TEST_DATABASE_URL;
 if (!url || new URL(url).hostname!=="127.0.0.1") throw new Error("Requires isolated loopback TEST_DATABASE_URL");
 sql=postgres(url,{max:5,prepare:false,onnotice:()=>{}});
 for (let repeat=0;repeat<2;repeat++) await sql.unsafe(await readFile(new URL("../../db/migrations/0168_monthly_admission_receipts.sql",import.meta.url),"utf8"));
 vi.doMock("../db.js",()=>({sql}));
 guard=await import("../services/billing/spend-guard.js");
 await sql`insert into "user"(id,name,email) values('capacity-u','U','capacity@example.test')`;
 await sql`insert into organizations(id,name,slug,created_by_user_id,credit_balance_cents,monthly_budget_cents) values('capacity-o','O','capacity-o','capacity-u',1000,10)`;
 await sql`insert into organizations(id,name,slug,created_by_user_id,credit_balance_cents) values('capacity-project-org','O','capacity-project-org','capacity-u',1000)`;
 await sql`insert into projects(id,org_id,user_id,name,monthly_budget_cents) values('capacity-project-only','capacity-project-org','capacity-u','P',10)`;
 await sql`insert into projects(id,org_id,user_id,name,monthly_budget_cents) values('capacity-p','capacity-o','capacity-u','P',10)`;
});
afterAll(async()=>{await sql?.end();});
const insert=(id:string)=>guard.admitRunSpend("capacity-o","capacity-p",tx=>tx`insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline,monthly_reservation_cents)
 values(${id},'capacity-o','capacity-p','capacity-u','bulk-upload','queued','queued','{}',6)`,{leaseRunId:id});
it("serializes real pending work across five connections and releases failure capacity",async()=>{
 const results=await Promise.allSettled(Array.from({length:8},(_,i)=>insert(`capacity-${i}`)));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(Number((await sql`select sum(cents) as n from pending_monthly_capacity where org_id='capacity-o'`)[0]!.n)).toBe(6);
 await sql`update project_runs set status='failed' where org_id='capacity-o'`;
 await insert('capacity-after-failure');
});
it("reconciles posted usage and releases the unused remainder on completion",async()=>{
 await sql`insert into usage_events(id,user_id,org_id,project_id,run_id,metric,provider,model,unit,amount,cost_cents)
 values('capacity-usage','capacity-u','capacity-o','capacity-p','capacity-after-failure','ingest-page-fast','docslurp','unit','page',1,2)`;
 expect(Number((await sql`select cents from pending_monthly_capacity where run_id='capacity-after-failure'`)[0]!.cents)).toBe(4);
 await sql`update project_runs set status='completed' where id='capacity-after-failure'`;
 expect(await sql`select * from pending_monthly_capacity where run_id='capacity-after-failure'`).toHaveLength(0);
});
it("binds receipt atomically and survives an absent response cache",async()=>{
 await sql`update project_runs set status='failed' where org_id='capacity-o'`;
 await sql`insert into intake_request_receipts(idempotency_key,route_key,request_hash,user_id) values('capacity-key','uploads.bulk','hash','capacity-u')`;
 await intakeReceiptContext.run({ key: 'capacity-key', route: 'uploads.bulk', hash: 'hash', userId: 'capacity-u' },()=>sql.begin(async tx=>{
 await tx`insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline) values('capacity-receipt','capacity-o','capacity-p','capacity-u','bulk-upload','queued','queued','{}')`;
 await bindIntakeReceipt(tx,'capacity-receipt');
 }));
 // Simulated process death: no response cache write occurs after commit.
 expect((await sql`select run_id from intake_request_receipts where idempotency_key='capacity-key'`)[0]!.run_id).toBe('capacity-receipt');
 await sql`insert into intake_request_receipts(idempotency_key,route_key,request_hash,user_id) values('capacity-rollback','uploads.bulk','hash','capacity-u')`;
 await expect(intakeReceiptContext.run({key:'capacity-rollback',route:'uploads.bulk',hash:'hash',userId:'capacity-u'},()=>sql.begin(async tx=>{
 await tx`insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline) values('capacity-rollback','capacity-o','capacity-p','capacity-u','bulk-upload','queued','queued','{}')`;
 await bindIntakeReceipt(tx,'capacity-rollback');
 throw new Error('commit boundary fault');
 }))).rejects.toThrow('commit boundary fault');
 expect(await sql`select id from project_runs where id='capacity-rollback'`).toHaveLength(0);
 expect((await sql`select run_id from intake_request_receipts where idempotency_key='capacity-rollback'`)[0]!.run_id).toBeNull();
});

it("enforces a project cap independently and refuses a foreign billing scope",async()=>{
 const results=await Promise.allSettled(Array.from({length:8},(_,i)=>guard.admitRunSpend('capacity-project-org','capacity-project-only',tx=>tx`
 insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline,monthly_reservation_cents)
 values(${`capacity-project-${i}`},'capacity-project-org','capacity-project-only','capacity-u','bulk-upload','queued','queued','{}',6)`)));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 await expect(guard.admitRunSpend('capacity-o','capacity-project-only',async()=>{})).rejects.toMatchObject({code:'plan_not_entitled'});
});

it("production materialization reserves pending workflow capacity across five connections", async () => {
 await sql`update project_runs set status='failed' where org_id='capacity-o'`;
 await sql`update organizations set monthly_budget_cents=10 where id='capacity-o'`;
 await sql`update projects set monthly_budget_cents=10 where id='capacity-p'`;
 vi.doMock("../lib/temporal.js", () => ({ startMaterializeWorkflow: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn() }));
 const { defaultMaterializeDeps } = await import("../search/deferred/materialize-client.js");
 const results = await Promise.allSettled(Array.from({length:8}, () => defaultMaterializeDeps.createRun({ orgId:'capacity-o', projectId:'capacity-p', userId:'capacity-u', documentId:'missing', documents:1, pages:20, maxCredits:6 })));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(Number((await sql`select sum(cents) as n from pending_monthly_capacity where org_id='capacity-o'`)[0]!.n)).toBe(6);
 const runId=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
 // Two posted cents from the earlier test + six pending cents exactly fill both caps.
 await sql`update organizations set monthly_budget_cents=8 where id='capacity-o'`;
 await sql`update projects set monthly_budget_cents=8 where id='capacity-p'`;
 await sql`update project_runs set control_state='paused', pause_reason='credit_exhausted' where id=${runId}`;
 const { sweepSpendPausedRuns }=await import('../services/spend-paused-runs.js');
 const signals={pause:vi.fn(async()=>{}),resume:vi.fn(async()=>{})};
 expect(await sweepSpendPausedRuns({sql:sql as never,signals,orgId:'capacity-o'})).toEqual({resumed:1,stillBlocked:0});
 expect(signals.resume).toHaveBeenCalledWith(runId);
});

});
