import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let svc: typeof import("../services/workspace-indexing-mode.js");
let failGrant = false;
const external = process.env.FULL_INDEX_TEST_DATABASE_URL;
const actor = { type: "session", userId: "fx-user", sessionId: "fx-session", user: { id: "fx-user", email: "fx@example.test", name: "FX" } } as const;
const policy = { maxPagesPerQuery: 40, maxCreditsPerQuery: 25, deadlineMs: 20000, allowFullIndexRequest: true, allowAgentDiscovery: true, mapRouter: "always" as const };
beforeAll(async () => {
  const pg = external ? null : await startMigratedPostgres();
  stop = pg?.stop ?? (async () => {});
  sql = postgres(external ?? pg!.url, { max: external ? 4 : 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/billing/credit-leases.js", async () => {
    const actual = await vi.importActual<typeof import("../services/billing/credit-leases.js")>("../services/billing/credit-leases.js");
    return { ...actual, grantRunCreditLease: async (...args: Parameters<typeof actual.grantRunCreditLease>) => {
      const grant = await actual.grantRunCreditLease(...args);
      if (failGrant) throw new Error("injected post-grant failure");
      return grant;
    } };
  });
  svc = await import("../services/workspace-indexing-mode.js");
  await sql`insert into "user" (id,name,email) values ('fx-user','FX','fx@example.test') on conflict (id) do nothing`;
}, 120000);
beforeEach(async () => {
  failGrant = false;
  for (const [key,value] of Object.entries({ DOCSLURP_DEFERRED_PROFILES: "1", NODE_ENV: "test", SKIP_RUN_BUDGET_GUARDS_IN_DEV: "false", WORKER_CREDIT_LEASES: "on", WORKER_CREDIT_LEASE_MIN_CREDITS: "1", WORKER_CREDIT_LEASE_MAX_CREDITS: "1", WORKER_CREDIT_LEASE_INITIAL_CREDITS: "1", WORKER_CREDIT_LEASE_FRACTION: "1", CHAT_CREDIT_RESERVE_CREDITS: "0", CHAT_CREDIT_RESERVE_STARTER_CREDITS: "0" })) vi.stubEnv(key,value);
  await sql`delete from workspaces where id in ('fx-a','fx-b')`;
  await sql`delete from organizations where id = 'fx-org'`;
  await sql`insert into organizations(id,name,slug,created_by_user_id,credit_balance_cents,funded_at) values ('fx-org','FX','fx-org','fx-user',6,now())`;
  await sql`insert into org_memberships(org_id,user_id,role) values ('fx-org','fx-user','owner')`;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await sql?.end(); await stop?.(); });
async function seed(workspaceId: string, count = 1) {
  await sql`insert into workspaces(id,org_id,user_id,name,pipeline) values (${workspaceId},'fx-org','fx-user',${workspaceId},${sql.json(JSON.parse(JSON.stringify({ ...defaultPipelineFeatures, indexingMode: 'map' })))})`;
  for (let i=0;i<count;i++) {
    const id = `${workspaceId}-${i}`;
    await sql`insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,pipeline,total_documents,pages_total) values (${`run-${id}`},'fx-org','fx-user',${workspaceId},'bulk-upload','completed','completed',${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))},1,3)`;
    await sql`insert into documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status,page_count,indexing_mode) values (${id},'fx-org','fx-user',${workspaceId},${`run-${id}`},'doc.pdf','application/pdf','raw/fx.pdf','completed',3,'map')`;
  }
  return svc.prepareFullIndex({ orgId: 'fx-org', workspaceId, actor, policy, speedBoost: true });
}
async function queued() { return (await sql<{ count: number }[]>`select count(*)::int as count from workspace_runs where org_id='fx-org' and status='queued'`)[0]!.count; }
it("sequential cross-workspace admissions retain the first lease", async () => {
  const first = await seed('fx-a'), second = await seed('fx-b');
  await svc.commitIndexJobs(first, 'fx-user');
  await expect(svc.commitIndexJobs(second, 'fx-user')).rejects.toMatchObject({ code: 'credit_exhausted' });
  expect(await queued()).toBe(1);
  const [status] = await sql<{ reserved: string }[]>`select reserved from org_spend_status('fx-org','fx-a',0)`;
  expect(Number(status!.reserved)).toBe(4);
});
it.skipIf(!external)("concurrent cross-workspace admissions cannot reuse the same credits", async () => {
  const first = await seed('fx-a'), second = await seed('fx-b');
  const results = await Promise.allSettled([svc.commitIndexJobs(first,'fx-user'), svc.commitIndexJobs(second,'fx-user')]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect(await queued()).toBe(1);
});
it("a later batch refusal rolls back every run and earlier lease", async () => {
  const prepared = await seed('fx-a',2), batch = prepared.batches[0]!;
  prepared.batches = batch.docs.map(doc => ({ ...batch, docs: [doc] }));
  await expect(svc.commitIndexJobs(prepared,'fx-user')).rejects.toMatchObject({ code: 'credit_exhausted' });
  expect(await queued()).toBe(0);
  const [status] = await sql<{ reserved: string }[]>`select reserved from org_spend_status('fx-org','fx-a',0)`;
  expect(Number(status!.reserved)).toBe(0);
});
it("a post-grant failure rolls back the run and its lease", async () => {
  const prepared = await seed('fx-a'); failGrant = true;
  await expect(svc.commitIndexJobs(prepared,'fx-user')).rejects.toThrow('injected post-grant failure');
  expect(await queued()).toBe(0);
  const [status] = await sql<{ reserved: string }[]>`select reserved from org_spend_status('fx-org','fx-a',0)`;
  expect(Number(status!.reserved)).toBe(0);
});
