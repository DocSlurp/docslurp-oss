import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let guard: typeof import("../services/billing/spend-guard.js");
let admission: typeof import("../services/run-admission.js");
beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id,name,email) values ('u','U','u@example.com')`;
  await sql`insert into organizations (id,name,slug,created_by_user_id,credit_balance_cents)
    values ('o','O','o','u',1000), ('other','Other','other','u',1000)`;
  await sql`insert into projects (id,org_id,user_id,name,monthly_budget_cents)
    values ('p','o','u','P',1), ('other-p','other','u','Other',1)`;
  guard = await import("../services/billing/spend-guard.js");
  admission = await import("../services/run-admission.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

it("rechecks live attributed spend during serialized run admissions and interactive materialization", async () => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    admission.admitRunSpend("o", "p", async (tx) => {
      await tx`insert into project_runs (id,org_id,project_id,user_id,kind,status,stage,pipeline,monthly_reservation_cents)
        values (${`run-${i}`},'o','p','u','bulk-upload','queued','queued','{}',1)`;
      await tx`insert into usage_events (id,user_id,org_id,project_id,metric,provider,model,unit,amount,cost_cents)
        values (${`usage-${i}`},'u','o','p','ingest-page-fast','docslurp','unit','page',1,1)`;
    })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(Number((await sql`select count(*) as n from project_runs`)[0]!.n)).toBe(1);
  // Simulate lagging cached flags: admission must still read the actual spend.
  await sql`update projects set budget_paused=false where id='p'`;
  await expect(guard.assertCanSpend("o", "p", { kind: "interactive" }))
    .rejects.toMatchObject({ code: "project_budget_paused" });
  expect(await guard.canSpend("o", "p", { kind: "interactive" })).toBe(false);
  await sql`update projects set monthly_budget_cents=null, budget_paused=false where id='p'`;
  await sql`update organizations set monthly_budget_cents=1, budget_paused=false where id='o'`;
  await expect(guard.assertCanSpend("o", "p", { kind: "interactive" }))
    .rejects.toMatchObject({ code: "org_budget_paused" });
  await expect(guard.assertCanSpend("other", "other-p", { kind: "interactive" })).resolves.toBeUndefined();
  await expect(guard.assertCanSpend("other", "p", { kind: "interactive" }))
    .rejects.toMatchObject({ code: "plan_not_entitled" });
});

it("refuses active runs with an omitted monthly reservation", async () => {
  await expect(sql`insert into project_runs (id,org_id,project_id,user_id,kind,status,stage,pipeline)
    values ('missing-reservation','other','other-p','u','bulk-upload','queued','queued','{}')`)
    .rejects.toThrow(/Invalid monthly capacity/);
});
