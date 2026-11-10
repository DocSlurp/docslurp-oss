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
  await sql`insert into projects(id,org_id,user_id,name) values ('project','org','owner','Private'),('foreign-w','foreign','stranger','Foreign')`;
  await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,job_id) values
    ('run-a','org','owner','project','upload','processing','vision-extract','parent'),
    ('run-b','org','owner','project','reindex','completed','completed','parent')`;
}, 60_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
it("denies cross-tenant runs, projects, documents and billing", async () => {
  for (const resource of [
    { kind: "run", runId: "run-a" }, { kind: "project", projectId: "project" },
    { kind: "documents", projectId: "project", page: 0 }, { kind: "billing", orgId: "org" },
  ] as const) {
    expect(await backend.authorize("stranger", resource)).toBeNull();
    await expect(backend.project("stranger", resource)).rejects.toThrow("forbidden");
  }
});
it("allows activity but redacts inaccessible projects and denies member billing", async () => {
  expect(await backend.project("member", { kind: "activity", orgId: "org" })).toEqual({ runs: [], truncated: false });
  expect(await backend.authorize("member", { kind: "billing", orgId: "org" })).toBeNull();
  const activity = await backend.project("owner", { kind: "activity", orgId: "org" }) as { runs: Array<{ id: string; jobId: string }> };
  expect(activity.runs.map(r => r.id).sort()).toEqual(["run-a", "run-b"]);
  expect(activity.runs.every(r => r.jobId === "parent")).toBe(true);
});
it("projects bounded documents, settings, stage state and attributed billing", async () => {
  expect(await backend.project("owner", { kind: "documents", projectId: "project", page: 0 })).toMatchObject({ documents: [], totalCount: 0, limit: 50, truncated: false });
  expect(await backend.project("owner", { kind: "project", projectId: "project" })).toMatchObject({ id: "project", name: "Private" });
  expect(await backend.project("owner", { kind: "run", runId: "run-a" })).toMatchObject({ run: { id: "run-a", status: "processing", jobId: "parent" }, stages: [] });
  expect(await backend.project("owner", { kind: "billing", orgId: "org" })).toMatchObject({ orgId: "org", credits: { available: expect.any(Number) } });
});
it("bounds read-only suggestions and viewer metadata without leaking content or artifacts", async () => {
  await sql`insert into documents(id,user_id,org_id,project_id,run_id,filename,mime_type,source_key,status)
    values('view-doc','owner','org','project','run-a','viewer.txt','text/plain','private-source-secret','processing')`;
  await sql`insert into document_run_stage_states(run_id,document_id,stage_name,status,artifact_uri,stats)
    values('run-a','view-doc','vision-extract','processing','s3://private-artifact','{"text":"private-stage-text"}'::jsonb)`;
  await sql`insert into document_pages(id,document_id,run_id,user_id,page_number,text)
    values('view-page','view-doc','run-a','owner',1,'private-page-text')`;
  for (let n=0;n<12;n++) await sql`insert into query_suggestions(id,user_id,project_id,phrase)
    values(${`suggestion-${n}`},'owner','project',${`Question ${n}`})`;
  await sql`insert into query_suggestions(id,user_id,project_id,phrase) values('protected','owner','project','enc:private')`;
  const fetch = vi.spyOn(globalThis,"fetch");
  try {
    const suggestions = await backend.project("owner",{kind:"suggestions",projectId:"project"}) as {suggestions:string[]};
    expect(suggestions.suggestions.length).toBeGreaterThan(0);
    expect(suggestions.suggestions.length).toBeLessThanOrEqual(8);
    expect(suggestions.suggestions.every(text => !text.startsWith("enc:"))).toBe(true);
    const viewer = await backend.project("owner",{kind:"viewer",documentId:"view-doc"});
    expect(viewer).toMatchObject({document:{id:"view-doc",status:"processing"},pageStats:{pageCount:1},stages:[{stage_name:"vision-extract",status:"processing"}]});
    for (const secret of ["private-source-secret","private-artifact","private-stage-text","private-page-text"]) expect(JSON.stringify(viewer)).not.toContain(secret);
    expect(fetch).not.toHaveBeenCalled();
    await expect(backend.project("stranger",{kind:"viewer",documentId:"view-doc"})).rejects.toThrow("forbidden");
    await expect(backend.project("stranger",{kind:"suggestions",projectId:"project"})).rejects.toThrow("forbidden");
    await sql`delete from documents where id='view-doc'`;
    expect(await backend.authorize("owner",{kind:"viewer",documentId:"view-doc"})).toBeNull();
  } finally { fetch.mockRestore(); }
});
it("observes exact committed page readiness without URLs, work initiation or cross-tenant delivery",async()=>{
  await sql`insert into documents(id,user_id,org_id,project_id,run_id,filename,mime_type,source_key,status,page_count)
    values('image-doc','owner','org','project','run-a','page.pdf','application/pdf','private-source-secret','completed',3)`;
  const resource={kind:"page-image",documentId:"image-doc",runId:"run-a",pageNumber:2,quality:"reader"} as const;
  const fetch=vi.spyOn(globalThis,"fetch");
  try {
    expect(await backend.authorize("stranger",resource)).toBeNull();
    await expect(backend.project("stranger",resource)).rejects.toThrow("forbidden");
    expect(await backend.project("owner",resource)).toEqual({resource,status:"unavailable"});
    await sql`insert into document_page_renders(document_id,run_id,org_id,project_id,page_number,quality,dpi,expires_at)
      values('image-doc','run-a','org','project',2,'reader',120,now()+interval '10 minutes')`;
    expect(await backend.project("owner",resource)).toEqual({resource,status:"pending"});
    const revision=async()=>Number((await sql`select revision from realtime_revisions where org_id='org'`)[0]!.revision);
    const before=await revision();
    await expect(sql.begin(async tx=>{await tx`update project_runs set artifacts=${tx.json({"image-doc:raster-v3-reader-120dpi-page-2":"s3://private-image-secret"})} where id='run-a'`;throw new Error("rollback");})).rejects.toThrow("rollback");
    expect(await revision()).toBe(before);expect(await backend.project("owner",resource)).toEqual({resource,status:"pending"});
    await sql.begin(async tx=>{
      await tx`update project_runs set artifacts=${tx.json({"image-doc:raster-v3-reader-120dpi-page-2":"s3://private-image-secret"})} where id='run-a'`;
      await tx`delete from document_page_renders where document_id='image-doc'`;
    });
    expect(await revision()).toBeGreaterThan(before);
    const ready=await backend.project("owner",resource);expect(ready).toEqual({resource,status:"ready"});
    for(const secret of ["private-source-secret","private-image-secret","s3://"])expect(JSON.stringify(ready)).not.toContain(secret);
    expect(await backend.project("owner",{...resource,pageNumber:1})).toMatchObject({status:"unavailable"});
    expect(await backend.project("owner",{...resource,quality:"export"})).toMatchObject({status:"unavailable"});
    await sql`update documents set metadata='{"pii":{"withheldArtifactUris":["s3://private-image-secret"]}}'::jsonb where id='image-doc'`;
    expect(await backend.project("owner",resource)).toMatchObject({status:"unavailable"});
    await sql`update documents set run_id='run-b' where id='image-doc'`;
    expect(await backend.authorize("owner",resource)).toBeNull();
    await expect(backend.project("owner",resource)).rejects.toThrow("forbidden");
    expect(fetch).not.toHaveBeenCalled();
  } finally {fetch.mockRestore();}
});
it("revokes billing on downgrade and project access on membership removal", async () => {
  await sql`update org_memberships set role='member' where user_id='owner' and org_id='org'`;
  expect(await backend.authorize("owner", { kind: "billing", orgId: "org" })).toBeNull();
  await sql`delete from org_memberships where user_id='owner' and org_id='org'`;
  expect(await backend.authorize("owner", { kind: "run", runId: "run-a" })).toBeNull();
});


it("reauthorizes constituent private projects after activity projection", async () => {
  await sql`insert into project_members(project_id,user_id,role) values('project','member','member')`;
  const resource = {kind:"activity",orgId:"org"} as const;
  const activity = await backend.project("member",resource);
  expect(await backend.authorizeDelivery!("member",resource,activity)).toBe(true);
  await sql`delete from project_members where project_id='project' and user_id='member'`;
  expect(await backend.authorize("member",resource)).toBe("org");
  expect(await backend.authorizeDelivery!("member",resource,activity)).toBe(false);
});

it("batches mixed resource authorization in input order and observes membership changes without cached grants", async () => {
  const resources = [
    {kind:"activity",orgId:"org"}, {kind:"billing",orgId:"org"},
    {kind:"run",runId:"run-a"}, {kind:"project",projectId:"foreign-w"},
    {kind:"viewer",documentId:"missing"}, {kind:"suggestions",projectId:"project"},
  ] as const;
  await sql`insert into project_members(project_id,user_id,role) values('project','member','member') on conflict do nothing`;
  expect(await backend.authorizeMany!("member",[...resources])).toEqual(["org",null,"org",null,null,"org"]);
  await sql`delete from project_members where project_id='project' and user_id='member'`;
  expect(await backend.authorizeMany!("member",[...resources])).toEqual(["org",null,null,null,null,null]);
  expect(await backend.authorizeMany!("stranger",[...resources])).toEqual([null,null,null,"foreign",null,null]);
  await expect(backend.authorizeMany!("member",Array(33).fill(resources[0]))).rejects.toThrow("subscription_limit");
});

it("refuses otherwise authorized resources outside the configured cohort", async () => {
  vi.stubEnv("REALTIME_CANARY_ORG_IDS", "00000000-0000-4000-8000-000000000001");
  try {
    expect(await backend.authorize("owner", {kind:"project",projectId:"project"})).toBeNull();
    await expect(backend.project("owner", {kind:"project",projectId:"project"})).rejects.toThrow("forbidden");
  } finally { vi.unstubAllEnvs(); }
});
