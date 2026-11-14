import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let svc: typeof import("../services/project-indexing-mode.js");
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
  svc = await import("../services/project-indexing-mode.js");
  await sql`insert into "user" (id,name,email) values ('fx-user','FX','fx@example.test') on conflict (id) do nothing`;
}, 120000);
beforeEach(async () => {
  failGrant = false;
  for (const [key,value] of Object.entries({ DOCSLURP_DEFERRED_PROFILES: "1", NODE_ENV: "test", SKIP_RUN_BUDGET_GUARDS_IN_DEV: "false", WORKER_CREDIT_LEASES: "on", WORKER_CREDIT_LEASE_MIN_CREDITS: "1", WORKER_CREDIT_LEASE_MAX_CREDITS: "1", WORKER_CREDIT_LEASE_INITIAL_CREDITS: "1", WORKER_CREDIT_LEASE_FRACTION: "1", CHAT_CREDIT_RESERVE_CREDITS: "0", CHAT_CREDIT_RESERVE_STARTER_CREDITS: "0" })) vi.stubEnv(key,value);
  await sql`delete from projects where id in ('fx-a','fx-b')`;
  await sql`delete from organizations where id = 'fx-org'`;
  await sql`insert into organizations(id,name,slug,created_by_user_id,credit_balance_cents,funded_at) values ('fx-org','FX','fx-org','fx-user',6,now())`;
  await sql`insert into org_memberships(org_id,user_id,role) values ('fx-org','fx-user','owner')`;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await sql?.end(); await stop?.(); });
async function seed(projectId: string, count = 1) {
  await sql`insert into projects(id,org_id,user_id,name,pipeline) values (${projectId},'fx-org','fx-user',${projectId},${sql.json(JSON.parse(JSON.stringify({ ...defaultPipelineFeatures, indexingMode: 'map' })))})`;
  for (let i=0;i<count;i++) {
    const id = `${projectId}-${i}`;
    await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,total_documents,pages_total) values (${`run-${id}`},'fx-org','fx-user',${projectId},'bulk-upload','completed','completed',${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))},1,3)`;
    await sql`insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status,page_count,indexing_mode) values (${id},'fx-org','fx-user',${projectId},${`run-${id}`},'doc.pdf','application/pdf','raw/fx.pdf','completed',3,'map')`;
  }
  return svc.prepareFullIndex({ orgId: 'fx-org', projectId, actor, policy, speedBoost: true });
}
async function queued() { return (await sql<{ count: number }[]>`select count(*)::int as count from project_runs where org_id='fx-org' and status='queued'`)[0]!.count; }
it("sequential cross-project admissions retain the first lease", async () => {
  const first = await seed('fx-a'), second = await seed('fx-b');
  await svc.commitIndexJobs(first, 'fx-user');
  await expect(svc.commitIndexJobs(second, 'fx-user')).rejects.toMatchObject({ code: 'credit_exhausted' });
  expect(await queued()).toBe(1);
  const [status] = await sql<{ reserved: string }[]>`select reserved from org_spend_status('fx-org','fx-a',0)`;
  expect(Number(status!.reserved)).toBe(4);
});
it.skipIf(!external)("concurrent cross-project admissions cannot reuse the same credits", async () => {
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
it("prices a full index of a measured DOCX on its 300 billed pages and carries the measured count to the new version", async () => {
  vi.stubEnv('DOCSLURP_BILL_INGEST', 'true');
  await sql`update organizations set credit_balance_cents = 1000 where id = 'fx-org'`;
  await sql`insert into projects(id,org_id,user_id,name,pipeline) values ('fx-a','fx-org','fx-user','fx-a',${sql.json(JSON.parse(JSON.stringify({ ...defaultPipelineFeatures, indexingMode: 'map' })))})`;
  await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,total_documents,pages_total) values ('run-docx','fx-org','fx-user','fx-a','bulk-upload','completed','completed',${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))},1,1)`;
  const facts = { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', format: 'office-word' };
  await sql`insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status,page_count,billing_pages,billing_pages_method,page_count_source,file_facts,indexing_mode)
    values ('fx-docx','fx-org','fx-user','fx-a','run-docx','contract.docx',${facts.mimeType},'raw/c.docx','completed',1,300,'pdf-conversion','assumed',${sql.json(facts)},'map')`;
  const prepared = await svc.prepareFullIndex({ orgId: 'fx-org', projectId: 'fx-a', actor, policy });
  expect(prepared.unindexedPages).toBe(1); // what is left to index, in the page basis
  expect(prepared.estimatedCredits).toBeCloseTo(300 * svc.fullIndexCreditsPerPage()); // what it bills
  await svc.commitIndexJobs(prepared, 'fx-user');
  const [copy] = await sql`select page_count, billing_pages, billing_pages_method, page_count_source, file_facts from documents where previous_version_id = 'fx-docx'`;
  expect(copy).toEqual({ page_count: 1, billing_pages: 300, billing_pages_method: 'pdf-conversion', page_count_source: 'assumed', file_facts: facts });
});
it("a full-index run drops model values from the stored pipeline it copies (managed models, round 3)", async () => {
  await sql`update organizations set credit_balance_cents = 1000 where id = 'fx-org'`;
  const stale = { ...defaultPipelineFeatures, indexingMode: 'map', embedding: { ...defaultPipelineFeatures.embedding, modelUri: 'llm://transformers.js/Xenova/bge-m3' }, pageRouter: { ...(defaultPipelineFeatures as { pageRouter?: object }).pageRouter, decisionModel: 'acme/stale-decider' } };
  await sql`insert into projects(id,org_id,user_id,name,pipeline) values ('fx-a','fx-org','fx-user','fx-a',${sql.json(JSON.parse(JSON.stringify(stale)))})`;
  await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline,total_documents,pages_total) values ('run-stale','fx-org','fx-user','fx-a','bulk-upload','completed','completed',${sql.json(JSON.parse(JSON.stringify(stale)))},1,3)`;
  await sql`insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status,page_count,indexing_mode) values ('fx-stale','fx-org','fx-user','fx-a','run-stale','doc.pdf','application/pdf','raw/fx.pdf','completed',3,'map')`;
  const prepared = await svc.prepareFullIndex({ orgId: 'fx-org', projectId: 'fx-a', actor, policy });
  const { runIds } = await svc.commitIndexJobs(prepared, 'fx-user');
  expect(runIds.length).toBe(1);
  const [run] = await sql<{ pipeline: unknown }[]>`select pipeline from project_runs where id = ${runIds[0]!}`;
  expect(JSON.stringify(run!.pipeline)).not.toMatch(/bge-m3|stale-decider/);
});
