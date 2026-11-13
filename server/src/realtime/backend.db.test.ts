import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
it("reads economics from maintained counters with exactly the former per-project aggregates", async () => {
  const former = async () => (await sql<Record<string, unknown>[]>`
    select w.id as "projectId", w.name,
      (select count(*)::int from documents d where d.project_id=w.id and d.superseded_at is null) as "documentCount",
      (select coalesce(sum(page_count),0)::float8 from documents d where d.project_id=w.id and d.superseded_at is null) as "pageCount",
      (select coalesce(sum(file_size),0)::float8 from documents d where d.project_id=w.id and d.superseded_at is null) as "sourceBytes",
      (select count(*)::int from project_runs r where r.project_id=w.id and r.status in ('queued','processing')) as "activeRuns",
      (select coalesce(sum(pages_processed),0)::float8 from project_runs r where r.project_id=w.id and r.status='completed') as "pagesProcessed",
      (select coalesce(sum(greatest(0,extract(epoch from(updated_at-created_at))*1000)),0)::float8 from project_runs r where r.project_id=w.id and r.status='completed') as "runtimeMs"
    from projects w where w.org_id='org' order by w.id limit 51`).map(row => ({ ...row }));
  const current = async () => ((await backend.project("owner", { kind: "economics", orgId: "org", page: 0 })) as { projects: Array<Record<string, unknown>> })
    .projects.map(({ usage: _usage, ...row }) => row);
  await sql`insert into projects(id,org_id,user_id,name) values ('econ-2','org','owner','Second')`;
  await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,job_id,pages_processed,created_at,updated_at) values
    ('econ-run-1','org','owner','project','upload','completed','completed','j',40,'2026-11-01 10:00:00.123456+00','2026-11-01 10:07:31.987654+00'),
    ('econ-run-2','org','owner','econ-2','upload','completed','completed','j',7,'2026-11-01 10:00:00+00','2026-11-01 09:59:00+00'),
    ('econ-run-3','org','owner','econ-2','upload','queued','queued','j',0,now(),now()),
    ('econ-run-4','org','owner','econ-2','upload','processing','extract','j',3,'2026-11-01 11:00:00+00','2026-11-01 11:00:05+00')`;
  const statuses = ["completed", "completed", "processing", "queued", "failed", "cancelled", "pii_blocked"];
  for (const [index, status] of statuses.entries()) {
    for (const projectId of ["project", "econ-2"]) {
      await sql`insert into documents(id,user_id,org_id,project_id,run_id,filename,mime_type,source_key,status,page_count,file_size,superseded_at)
        values(${`econ-${projectId}-${index}`},'owner','org',${projectId},'econ-run-1','e.pdf','application/pdf','k',${status},${index * 3 + 1},${index * 1_000_003 + 17},
          ${index === 1 ? sql`now()` : null})`;
    }
  }
  expect(await current()).toEqual(await former());
  // Transitions the counters must follow: completion, a later touch of a completed run, deletion,
  // supersession, a page recount, completed -> failed, and a run moving projects.
  await sql`update project_runs set status='completed', stage='completed', pages_processed=9, updated_at='2026-11-01 11:02:00.5+00' where id='econ-run-4'`;
  await sql`update project_runs set updated_at='2026-11-02 00:00:00+00' where id='econ-run-1'`;
  await sql`update project_runs set pages_processed=41 where id='econ-run-1'`;
  await sql`delete from project_runs where id='econ-run-2'`;
  await sql`update documents set superseded_at=now() where id='econ-project-0'`;
  await sql`update documents set page_count=99 where id='econ-econ-2-0'`;
  await sql`update documents set status='failed' where id='econ-econ-2-2'`;
  await sql`update documents set status='completed' where id='econ-project-3'`;
  await sql`update project_runs set project_id='project' where id='econ-run-4'`;
  expect(await current()).toEqual(await former());
  const rows = await current();
  expect(rows.find(row => row.projectId === "project")).toMatchObject({ pagesProcessed: 50, activeRuns: 1 });
  await sql`delete from documents where id like 'econ-%'`;
  await sql`delete from project_runs where id like 'econ-run-%'`;
  await sql`delete from projects where id='econ-2'`;
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
it("keeps ordinary progress and activity below the frame cap when diagnostics grow", async () => {
  const diagnostics = { diagnostic: "x".repeat(300_000), completedPages: 10 };
  const artifacts = { output: "x".repeat(300_000) };
  await sql`update project_runs set stats=${sql.json(diagnostics)},artifacts=${sql.json(artifacts)} where id='run-a'`;
  await sql`insert into documents(id,user_id,org_id,project_id,run_id,filename,mime_type,source_key,status)
    values('size-doc','owner','org','project','run-a','measurement.txt','text/plain','synthetic-source','completed')`;
  await sql`insert into document_run_stage_states(run_id,document_id,stage_name,status,stats)
    values('run-a','size-doc','quarantine','completed',${sql.json(diagnostics)})`;
  try {
    const snapshot = await backend.project("owner", {kind:"run",runId:"run-a"});
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(100_000);
    expect(snapshot).toMatchObject({run:{id:"run-a",status:"processing",jobId:"parent"},stages:[expect.objectContaining({stage:"quarantine",status:"completed"})]});
    const activity = await backend.project("owner",{kind:"activity",orgId:"org"});
    expect(Buffer.byteLength(JSON.stringify(activity))).toBeLessThan(100_000);
    // Compact transport projections must not erase diagnostics at rest.
    expect((await sql`select artifacts from project_runs where id='run-a'`)[0]!.artifacts).toEqual(artifacts);
  } finally {
    await sql`update project_runs set stats='{}'::jsonb,artifacts='{}'::jsonb where id='run-a'`;
    await sql`delete from document_run_stage_states where run_id='run-a' and stage_name='quarantine'`;
    await sql`delete from documents where id='size-doc'`;
  }
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

describe("customer realtime frames carry no backend models (council round 4)", () => {
  const privateRoute = "llm://private/acme-gpu/qwen/qwen3-vl-30b-a3b-instruct";
  let hidden: { ids: readonly string[]; names: readonly string[] };
  beforeAll(async () => {
    const snapshot = await import("../services/progress-snapshot.js");
    const shared = await import("@docslurp/shared");
    hidden = { ids: snapshot.customerHiddenModelIds(), names: snapshot.customerHiddenModelNames() };
    const pipeline = shared.resolveManagedPipeline(shared.normalizePipelineFeatures(shared.defaultPipelineFeatures), { vision: { modelUri: privateRoute } }, "test").pipeline;
    // Every catalog id rides in the run's pipeline and free text too, so a stray field cannot slip through.
    const runPipeline = { ...pipeline, textGeneration: { ...(pipeline as { textGeneration?: object }).textGeneration, models: { ...Object.fromEntries(hidden.ids.map((id, i) => [`task${i}`, id])), private: privateRoute } } };
    await sql`insert into "user"(id,name,email,"emailVerified") values ('operator','Operator','operator@example.test',true)`;
    // Own users: earlier tests in this file change the shared member's access.
    await sql`insert into "user"(id,name,email) values ('customer','Customer','customer@example.test'),('custadmin','Customer admin','custadmin@example.test')`;
    await sql`insert into org_memberships(org_id,user_id,role) values ('org','operator','member'),('org','customer','member'),('org','custadmin','admin')`;
    await sql`insert into projects(id,org_id,user_id,name,pipeline,managed_models) values
      ('models','org','owner','Models',${sql.json(JSON.parse(JSON.stringify(pipeline)))},${sql.json({ pipeline: { vision: { modelUri: privateRoute } } })})`;
    await sql`insert into project_members(project_id,user_id,role) values ('models','customer','viewer'),('models','custadmin','editor'),('models','operator','viewer')`;
    await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,job_id,pipeline,error,stats) values
      ('run-m','org','owner','models','upload','failed','vision-extract','job-m',${sql.json(JSON.parse(JSON.stringify(runPipeline)))},
       ${`DeepSeek V4.1 Flash and GPT-6.1 Sol refused; ${privateRoute} timed out; ${hidden.ids.join(" ")}`},
       ${sql.json({ pages: 3, decisionModel: "typesafe/jev-1.13", embeddingModel: "perplexity/pplx-embed-v1-0.6b", routerNote: `decision-chain:${hidden.ids[0]}=served` })})`;
  });
  afterEach(() => vi.unstubAllEnvs());

  function leaks(value: unknown): string[] {
    const text = JSON.stringify(value).toLowerCase();
    return [...hidden.ids, ...hidden.names.map((name) => name.toLowerCase()), "llm://", "acme-gpu"].filter((needle) => text.includes(needle));
  }
  const resources = [
    { kind: "project", projectId: "models" }, { kind: "activity", orgId: "org" }, { kind: "run", runId: "run-m" },
    { kind: "documents", projectId: "models", page: 0 }, { kind: "suggestions", projectId: "models" },
  ] as const;

  it("a member who is not an operator reads every resource without a model id, display name or route", async () => {
    vi.stubEnv("ADMIN_EMAILS", "operator@example.test");
    for (const resource of resources) {
      const frame = await backend.project("customer", resource).catch((error: Error) => { throw new Error(`${resource.kind}: ${error.message}`); });
      expect({ resource: resource.kind, leaks: leaks(frame) }).toEqual({ resource: resource.kind, leaks: [] });
    }
    // An organization admin is a customer too.
    for (const resource of resources) expect(leaks(await backend.project("custadmin", resource))).toEqual([]);
    const project = await backend.project("customer", { kind: "project", projectId: "models" }) as { pipeline: Record<string, Record<string, unknown>> };
    expect(project.pipeline.vision).not.toHaveProperty("modelUri");
    expect(project.pipeline.embedding).not.toHaveProperty("modelUri");
  });

  it("a platform operator still sees the managed models and providers", async () => {
    vi.stubEnv("ADMIN_EMAILS", "operator@example.test");
    const project = await backend.project("operator", { kind: "project", projectId: "models" }) as { pipeline: Record<string, Record<string, unknown>> };
    expect(String(project.pipeline.vision!.modelUri)).toMatch(/^llm:\/\//);
    expect(String(project.pipeline.embedding!.modelUri)).toMatch(/^llm:\/\//);
    const activity = await backend.project("operator", { kind: "activity", orgId: "org" }) as { runs: Array<{ id: string; pipeline: Record<string, Record<string, unknown>>; error?: string }> };
    const run = activity.runs.find((r) => r.id === "run-m")!;
    expect(String(run.pipeline.vision!.modelUri)).toMatch(/^llm:\/\//);
    expect(leaks(run.pipeline).length).toBeGreaterThan(0);
  });
});
