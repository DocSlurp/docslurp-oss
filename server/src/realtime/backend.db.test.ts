import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
let sql: postgres.Sql;
let stop: () => Promise<void>;
let backend: typeof import("./backend.js").realtimeBackend;
beforeAll(async () => {
  const database = await startMigratedPostgres(); stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  backend = (await import("./backend.js")).realtimeBackend;
  await sql`insert into "user"(id,name,email) values ('owner','Owner','owner@example.test'),('member','Member','member@example.test'),('stranger','Stranger','stranger@example.test')`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values ('org','Org','realtime-org','owner'),('foreign','Foreign','realtime-foreign','stranger')`;
  await sql`insert into org_memberships(org_id,user_id,role) values ('org','owner','owner'),('org','member','member'),('foreign','stranger','owner') on conflict do nothing`;
  await sql`insert into workspaces(id,org_id,user_id,name) values ('workspace','org','owner','Private'),('foreign-w','foreign','stranger','Foreign')`;
  await sql`insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,job_id) values
    ('run-a','org','owner','workspace','upload','processing','vision-extract','parent'),
    ('run-b','org','owner','workspace','reindex','completed','completed','parent')`;
}, 60_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
it("denies cross-tenant runs, workspaces, documents and billing", async () => {
  for (const resource of [
    { kind: "run", runId: "run-a" }, { kind: "workspace", workspaceId: "workspace" },
    { kind: "documents", workspaceId: "workspace", page: 0 }, { kind: "billing", orgId: "org" },
  ] as const) {
    expect(await backend.authorize("stranger", resource)).toBeNull();
    await expect(backend.project("stranger", resource)).rejects.toThrow("forbidden");
  }
});
it("allows activity but redacts inaccessible workspaces and denies member billing", async () => {
  expect(await backend.project("member", { kind: "activity", orgId: "org" })).toEqual({ runs: [], truncated: false });
  expect(await backend.authorize("member", { kind: "billing", orgId: "org" })).toBeNull();
  const activity = await backend.project("owner", { kind: "activity", orgId: "org" }) as { runs: Array<{ id: string; jobId: string }> };
  expect(activity.runs.map(r => r.id).sort()).toEqual(["run-a", "run-b"]);
  expect(activity.runs.every(r => r.jobId === "parent")).toBe(true);
});
it("projects bounded documents, settings, stage state and attributed billing", async () => {
  expect(await backend.project("owner", { kind: "documents", workspaceId: "workspace", page: 0 })).toMatchObject({ documents: [], totalCount: 0, limit: 50, truncated: false });
  expect(await backend.project("owner", { kind: "workspace", workspaceId: "workspace" })).toMatchObject({ id: "workspace", name: "Private" });
  expect(await backend.project("owner", { kind: "run", runId: "run-a" })).toMatchObject({ run: { id: "run-a", status: "processing", jobId: "parent" }, stages: [] });
  expect(await backend.project("owner", { kind: "billing", orgId: "org" })).toMatchObject({ orgId: "org", credits: { available: expect.any(Number) } });
});
it("bounds read-only suggestions and viewer metadata without leaking content or artifacts", async () => {
  await sql`insert into documents(id,user_id,org_id,workspace_id,run_id,filename,mime_type,source_key,status)
    values('view-doc','owner','org','workspace','run-a','viewer.txt','text/plain','private-source-secret','processing')`;
  await sql`insert into document_run_stage_states(run_id,document_id,stage_name,status,artifact_uri,stats)
    values('run-a','view-doc','vision-extract','processing','s3://private-artifact','{"text":"private-stage-text"}'::jsonb)`;
  await sql`insert into document_pages(id,document_id,run_id,user_id,page_number,text)
    values('view-page','view-doc','run-a','owner',1,'private-page-text')`;
  for (let n=0;n<12;n++) await sql`insert into query_suggestions(id,user_id,workspace_id,phrase)
    values(${`suggestion-${n}`},'owner','workspace',${`Question ${n}`})`;
  await sql`insert into query_suggestions(id,user_id,workspace_id,phrase) values('protected','owner','workspace','enc:private')`;
  const fetch = vi.spyOn(globalThis,"fetch");
  try {
    const suggestions = await backend.project("owner",{kind:"suggestions",workspaceId:"workspace"}) as {suggestions:string[]};
    expect(suggestions.suggestions.length).toBeGreaterThan(0);
    expect(suggestions.suggestions.length).toBeLessThanOrEqual(8);
    expect(suggestions.suggestions.every(text => !text.startsWith("enc:"))).toBe(true);
    const viewer = await backend.project("owner",{kind:"viewer",documentId:"view-doc"});
    expect(viewer).toMatchObject({document:{id:"view-doc",status:"processing"},pageStats:{pageCount:1},stages:[{stage_name:"vision-extract",status:"processing"}]});
    for (const secret of ["private-source-secret","private-artifact","private-stage-text","private-page-text"]) expect(JSON.stringify(viewer)).not.toContain(secret);
    expect(fetch).not.toHaveBeenCalled();
    await expect(backend.project("stranger",{kind:"viewer",documentId:"view-doc"})).rejects.toThrow("forbidden");
    await expect(backend.project("stranger",{kind:"suggestions",workspaceId:"workspace"})).rejects.toThrow("forbidden");
    await sql`delete from documents where id='view-doc'`;
    expect(await backend.authorize("owner",{kind:"viewer",documentId:"view-doc"})).toBeNull();
  } finally { fetch.mockRestore(); }
});
it("revokes billing on downgrade and workspace access on membership removal", async () => {
  await sql`update org_memberships set role='member' where user_id='owner' and org_id='org'`;
  expect(await backend.authorize("owner", { kind: "billing", orgId: "org" })).toBeNull();
  await sql`delete from org_memberships where user_id='owner' and org_id='org'`;
  expect(await backend.authorize("owner", { kind: "run", runId: "run-a" })).toBeNull();
});


it("reauthorizes constituent private workspaces after activity projection", async () => {
  await sql`insert into workspace_members(workspace_id,user_id,role) values('workspace','member','member')`;
  const resource = {kind:"activity",orgId:"org"} as const;
  const activity = await backend.project("member",resource);
  expect(await backend.authorizeDelivery!("member",resource,activity)).toBe(true);
  await sql`delete from workspace_members where workspace_id='workspace' and user_id='member'`;
  expect(await backend.authorize("member",resource)).toBe("org");
  expect(await backend.authorizeDelivery!("member",resource,activity)).toBe(false);
});
