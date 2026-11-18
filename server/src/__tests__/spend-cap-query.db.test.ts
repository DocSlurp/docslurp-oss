import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import type { SqlClient } from "../db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
let sql: postgres.Sql;
let stop: () => Promise<void>;
let load: typeof import("../services/billing/spend-guard.js").loadSpendStatus;
beforeAll(async () => {
  const pg = databaseUrl ? null : await startMigratedPostgres();
  stop = pg?.stop ?? (async () => {});
  sql = postgres(databaseUrl ?? pg!.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  ({ loadSpendStatus: load } = await import("../services/billing/spend-guard.js"));
  await sql`insert into "user"(id,name,email) values('lazy-u','Lazy caps','lazy-caps@example.test')`;
  await sql`insert into organizations(id,name,created_by_user_id,credit_balance_cents) values('lazy-o','Lazy caps','lazy-u',1000)`;
  await sql`insert into projects(id,org_id,user_id,name) values('lazy-p','lazy-o','lazy-u','Lazy caps')`;
  await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,monthly_reservation_cents)
    values('lazy-r','lazy-o','lazy-u','lazy-p','upload','completed','completed','{}',100)`;
  await sql`insert into usage_events(id,user_id,org_id,project_id,run_id,metric,provider,model,unit,amount,cost_cents)
    values('lazy-usage','lazy-u','lazy-o','lazy-p','lazy-r','ingest-page-fast','docslurp','unit','page',1,150)`;
},120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
type Plan = { "Relation Name"?: string; "Actual Loops"?: number; Plans?: Plan[] };
const usageLoops = (node: Plan): number =>
  (node["Relation Name"]?.startsWith("usage_events") ? node["Actual Loops"] ?? 0 : 0) +
  (node.Plans ?? []).reduce((sum,child) => sum + usageLoops(child),0);

async function decisionAndPlan() {
  let captured: { parts: TemplateStringsArray; values: unknown[] } | undefined;
  const client = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    if (parts.join("?").includes("from org_spend_status")) captured = {parts,values};
    return (sql as unknown as (parts: TemplateStringsArray,...values:unknown[]) => unknown)(parts,...values);
  }) as unknown as SqlClient;
  const status = await load('lazy-o','lazy-p',{client});
  if (!captured) throw new Error('Spend query was not executed');
  const parts = Object.assign([...captured.parts],{raw:[...captured.parts.raw]});
  parts[0] = 'explain (analyze, format json) ' + parts[0];
  const rows = await (sql as unknown as (parts:TemplateStringsArray,...values:unknown[])=>Promise<Array<{"QUERY PLAN":Array<{Plan:Plan}>}>>)(parts as unknown as TemplateStringsArray,...captured.values);
  return {status,loops:usageLoops(rows[0]!["QUERY PLAN"][0]!.Plan)};
}

it("executes no monthly usage scan without caps, but executes the capped project sum", async () => {
  const uncapped = await decisionAndPlan();
  expect(uncapped.status?.projectBudgetPaused).toBe(false);
  expect(uncapped.loops).toBe(0);
  await sql`update projects set monthly_budget_cents=100 where id='lazy-p'`;
  const capped = await decisionAndPlan();
  expect(capped.status?.projectBudgetPaused).toBe(true);
  expect(capped.loops).toBeGreaterThan(0);
});

it("pauses an org over its monthly cap through the correlated org filter, and only that org", async () => {
  await sql`update projects set monthly_budget_cents=null where id='lazy-p'`;
  await sql`update organizations set monthly_budget_cents=100 where id='lazy-o'`;
  await sql`insert into "user"(id,name,email) values('lazy-u2','Other org','lazy-other@example.test')`;
  await sql`insert into organizations(id,name,created_by_user_id,credit_balance_cents,monthly_budget_cents) values('lazy-o2','Other org','lazy-u2',1000,100)`;
  await sql`insert into projects(id,org_id,user_id,name) values('lazy-p2','lazy-o2','lazy-u2','Other org')`;
  const capped = await decisionAndPlan();
  expect(capped.status?.orgBudgetPaused).toBe(true);
  expect(capped.status?.projectBudgetPaused).toBe(false);
  expect(capped.loops).toBeGreaterThan(0);
  const other = await load('lazy-o2','lazy-p2',{client: sql as unknown as SqlClient});
  expect(other?.orgBudgetPaused).toBe(false);
});
