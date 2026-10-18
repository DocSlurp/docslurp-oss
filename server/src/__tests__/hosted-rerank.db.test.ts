import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizePipelineFeatures, defaultWorkspaceSearchSettings } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let hybridSearch: typeof import("../services/search.js").hybridSearch;
const http = vi.hoisted(() => vi.fn());
const forbiddenInference = vi.hoisted(() => vi.fn(() => { throw Error("Unexpected model call"); }));
vi.mock("../lib/ai.js", async original => ({ ...await original<typeof import("../lib/ai.js")>(),
  embedConfiguredText: forbiddenInference, generateOpenRouterText: forbiddenInference,
  resolveOpenRouterApiKey: () => undefined,
}));
beforeAll(async () => {
  const database = await startMigratedPostgres(); stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.stubEnv("DEEPINFRA_API_KEY", "synthetic-no-provider-access");
  vi.stubEnv("SKIP_RUN_BUDGET_GUARDS_IN_DEV", "false");
  vi.stubEnv("SEARCH_RERANK_CONCURRENCY", "4");
  vi.stubEnv("SEARCH_RERANK_TIMEOUT_MS", "15000");
  vi.stubGlobal("fetch", http);
  http.mockImplementation(async (url: string, request: RequestInit) => {
    if (url !== "https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-0.6B") throw Error("Unexpected network destination");
    const payload = JSON.parse(String(request.body));
    return Response.json({ input_tokens: 174, scores: payload.documents.map((text: string) => text.includes("valve") ? 0.9 : 0.1) });
  });
  await sql`insert into "user" (id,name,email) values ('hosted-user','Ranking','hosted@example.invalid'),('outsider','Other','outsider@example.invalid')`;
  await sql`insert into organizations (id,name,slug,created_by_user_id,credit_balance_cents) values ('hosted-org','Ranking','hosted-ranking','hosted-user',10000)`;
  await sql`insert into org_memberships (org_id,user_id,role) values ('hosted-org','hosted-user','owner')`;
  const pipeline = JSON.parse(JSON.stringify(normalizePipelineFeatures({ privacyMode: "standard" })));
  await sql`insert into workspaces (id,org_id,user_id,name,pipeline) values ('hosted-ws','hosted-org','hosted-user','Ranking',${sql.json(pipeline)})`;
  await sql`insert into credit_grants (org_id,source,external_id,credits,pool) values ('hosted-org','starter','hosted-test-grant',10000,'prepaid')`;
  await sql`insert into workspace_runs (id,org_id,user_id,workspace_id,kind,status,stage,pipeline) values ('hosted-run','hosted-org','hosted-user','hosted-ws','bulk-upload','completed','completed','{}')`;
  await sql`insert into documents (id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status,page_count)
    values ('hosted-doc','hosted-org','hosted-user','hosted-ws','hosted-run','manual.txt','text/plain','local/manual','completed',2)`;
  await sql`insert into document_chunks (id,document_id,run_id,user_id,chunk_index,text,heading_path,token_estimate,page_number,metadata) values
    ('hosted-a','hosted-doc','hosted-run','hosted-user',0,'Pump maintenance schedule.','{}',5,1,'{}'),
    ('hosted-b','hosted-doc','hosted-run','hosted-user',1,'Pump maintenance valve inspection.','{}',5,2,'{}')`;
  const { upsertWorkspaceSearchSettings } = await import("../services/search-controls.js");
  await upsertWorkspaceSearchSettings({ ...defaultWorkspaceSearchSettings, workspaceId: "hosted-ws", userId: "hosted-user",
    retrievalDefaults: { ...defaultWorkspaceSearchSettings.retrievalDefaults, rerankProvider: "deepinfra", rerankModel: "Qwen/Qwen3-Reranker-0.6B", candidateDepth: 50, resultOrder: "relevance", minScore: 0, parentRetrieval: false } });
  ({ hybridSearch } = await import("../services/search.js"));
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("real hybrid search with hosted reranking and actual SQL usage", () => {
  const options = { filters: { workspaceId: "hosted-ws" }, queryVector: [1,0,0], limit: 2, minScore: 0,
    parentRetrieval: false, queryRewrite: false, selfQuery: false, useContextualCompression: false,
    useHyDE: false, stepback: false, iterativeMultiHop: false, enableGraphExpansion: false, enableCommunityExpansion: false };
  it("reads workspace opt-in, preserves citations and persists scoped actual tokens", async () => {
    const result = await hybridSearch("pump maintenance", "hosted-user", options);
    expect(http).toHaveBeenCalledTimes(1);
    expect(result.results[0].citation).toMatchObject({ documentId: "hosted-doc", pageNumber: 2 });
    expect(result.results[0].text).toBe("Pump maintenance valve inspection.");
    expect(result.usageEvents).toMatchObject([{ model: "Qwen/Qwen3-Reranker-0.6B", inputTokens: 174 }]);
    const { attributedUsage } = await import("../services/usage-attribution.js");
    const events = await sql`select org_id,workspace_id,input_tokens,run_id from ${attributedUsage(null)} au where au.metadata->>'sessionId'=${result.sessionId}`;
    expect(events.map(e => ({ ...e, input_tokens: Number(e.input_tokens) }))).toMatchObject([{ org_id: "hosted-org", workspace_id: "hosted-ws", input_tokens: 174, run_id: null }]);
    const [session] = await sql`select metadata from search_sessions where id=${result.sessionId}`;
    expect(session.metadata.diagnostics.hostedRerank).toMatchObject({ status: "success", inputTokens: 174 });
    expect(forbiddenInference).not.toHaveBeenCalled();
  });
  it("rerank off and denied tenant access make no provider request", async () => {
    const before = http.mock.calls.length;
    await hybridSearch("pump maintenance", "hosted-user", { ...options, useRerank: false });
    await expect(hybridSearch("pump maintenance", "outsider", options)).rejects.toThrow();
    expect(http).toHaveBeenCalledTimes(before);
  });
  it("persists late sibling usage before returning a parallel fallback", async () => {
    await sql`update documents set page_count=50 where id='hosted-doc'`;
    const extra=Array.from({length:48},(_,i)=>({id:`hosted-extra-${i}`,document_id:"hosted-doc",run_id:"hosted-run",user_id:"hosted-user",chunk_index:i+2,text:`Pump maintenance supplemental schedule ${i}.`,heading_path:[],token_estimate:8,page_number:i+3,metadata:{}}));
    await sql`insert into document_chunks ${sql(extra)}`;
    const waiting: Array<(r:Response)=>void> = [];
    http.mockImplementation(()=>new Promise<Response>(resolve=>waiting.push(resolve)));
    let returned=false;
    const running=hybridSearch("pump maintenance","hosted-user",{...options,rootSessionId:"hosted-parallel"}).then(r=>{returned=true;return r;});
    await vi.waitFor(()=>expect(waiting).toHaveLength(2));
    waiting[0](Response.json({input_tokens:10},{status:429}));
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(returned).toBe(false);
    waiting[1](Response.json({input_tokens:20,scores:Array(25).fill(.5)}));
    const result=await running;
    expect(result.usageEvents?.reduce((n,e)=>n+(e.inputTokens??0),0)).toBe(30);
    const { attributedUsage }=await import("../services/usage-attribution.js");
    const events=await sql`select input_tokens from ${attributedUsage(null)} au where au.metadata->>'sessionId'=${result.sessionId}`;
    expect(events).toHaveLength(2);
    expect(events.reduce((n,e)=>n+Number(e.input_tokens),0)).toBe(30);
    const [session]=await sql`select metadata from search_sessions where id=${result.sessionId}`;
    expect(session.metadata.diagnostics.hostedRerank).toMatchObject({status:"fallback",reason:"provider_http",inputTokens:30,unreceiptedRequests:0});
  });
  it("privacy and actual exhausted budget block provider calls", async () => {
    const before = http.mock.calls.length;
    await sql`update workspaces set pipeline=jsonb_set(pipeline,'{privacyMode}','"local-only"') where id='hosted-ws'`;
    await hybridSearch("pump maintenance", "hosted-user", options);
    await sql`update workspaces set pipeline=jsonb_set(pipeline,'{privacyMode}','"standard"') where id='hosted-ws'`;
    await sql`update organizations set credit_balance_cents=-100000 where id='hosted-org'`;
    await hybridSearch("pump maintenance", "hosted-user", options);
    expect(http).toHaveBeenCalledTimes(before);
  });
});
