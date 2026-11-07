import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { reconcileVisionReceipts } from "./vision-receipt-reconciliation.js";
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
let server: Awaited<ReturnType<typeof serveOnRandomPort>>["server"];
let sql: postgres.Sql;
beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`insert into "user"(id,name,email) values('receipt-test','Test','receipt@example.test')`);
  const served = await serveOnRandomPort(db); server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, prepare: false });
}, 120000);
afterAll(async () => { await sql?.end(); await server?.stop(); await db?.close(); vi.unstubAllGlobals(); });
beforeEach(async () => { await sql`delete from usage_events`; vi.unstubAllGlobals(); });
const known = { providerCostCents: 9, visionAttempts: [{ generationId: "known", inputTokens: 10, outputTokens: 2, costCents: 0.2 }] };
async function seed(id: string, org = "org-a", project = "project-a", metadata = known) {
  await sql`insert into usage_events(id,user_id,provider,model,metric,amount,unit,cost_cents,org_id,project_id,metadata)
    values(${id},'receipt-test','openrouter','m','page-analysis',1,'page',7,${org},${project},${sql.json(metadata)})`;
}
it("updates only the selected tenant and leaves customer credits unchanged", async () => {
  await seed("a"); await seed("b", "org-b"); await seed("c", "org-a", "project-b");
  expect((await reconcileVisionReceipts({ client: sql, orgId: "org-a", projectId: "project-a", apiKey: "test" })).updated).toBe(1);
  const rows = await sql`select id,cost_cents,metadata from usage_events order by id`;
  expect(rows.map(r => Number(r.cost_cents))).toEqual([7,7,7]);
  expect(rows[0]!.metadata.providerCostCents).toBe(0.2);
  expect(rows[1]!.metadata.providerCostCents).toBe(9); expect(rows[2]!.metadata.providerCostCents).toBe(9);
});
it("advances past one hundred unreconcilable rows", async () => {
  for (let n=0;n<100;n++) await seed(`a${String(n).padStart(3,"0")}`, "org-a", "project-a", { providerCostCents: 9, visionAttempts: [{ generationId: "", inputTokens: 10, outputTokens: 2 }] } as typeof known);
  await seed("z-recoverable");
  const args = { client: sql, orgId: "org-a", projectId: "project-a", apiKey: "test" };
  const first = await reconcileVisionReceipts(args);
  expect(first).toMatchObject({ updated: 0, examined: 100, nextCursor: "a099" });
  expect(await reconcileVisionReceipts({ ...args, afterId: first.nextCursor! })).toMatchObject({ updated: 1, examined: 1, nextCursor: null });
});
it("does not overwrite metadata changed while a receipt is fetched", async () => {
  await seed("race", "org-a", "project-a", { providerCostCents: 9, visionAttempts: [{ generationId: "pending", inputTokens: 10, outputTokens: 2 }] } as typeof known);
  vi.stubGlobal("fetch", vi.fn(async () => {
    await sql`update usage_events set metadata=metadata || '{"operatorNote":"preserve"}'::jsonb where id='race'`;
    return new Response(JSON.stringify({ data: { total_cost: 0.001, is_byok: false } }));
  }));
  expect((await reconcileVisionReceipts({ client: sql, orgId: "org-a", projectId: "project-a", apiKey: "test" })).updated).toBe(0);
  expect((await sql`select metadata from usage_events where id='race'`)[0]!.metadata).toMatchObject({ providerCostCents: 9, operatorNote: "preserve" });
});
