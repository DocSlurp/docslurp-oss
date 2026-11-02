import postgres from "postgres";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {canonicalGeoProjectionJson,type GeoPredicate} from "@docslurp/shared";
import type {SearchFilters} from "../search/filters.js";
const native=vi.hoisted(()=>({search:vi.fn(async()=>[])}));
vi.mock("../search/lancedb.js",()=>({lanceDbVectorSearch:native.search,warmLanceDbSearch:vi.fn(async()=>{})}));
vi.mock("../lib/ai.js",async original=>({...await original<typeof import("../lib/ai.js")>(),
 resolveOpenRouterApiKey:()=>undefined,embedConfiguredText:()=>{throw new Error("UNEXPECTED_INFERENCE")},
 generateOpenRouterText:()=>{throw new Error("UNEXPECTED_INFERENCE")}}));
let db:postgres.Sql;
let resolve:typeof import("../search/geo-scope.js").resolveGeoDocumentScope;
let scope:typeof import("../search/retrieval-scope.js").retrievalScope;
let search:typeof import("../services/search.js");
const schema={type:"object",properties:{site:{type:"object",format:"geojson"}}};
const digest=createHash("sha256").update(canonicalGeoProjectionJson(schema)).digest("hex");
const tenant={workspaceId:"q-w",orgId:"q-o"};
const radius:GeoPredicate={field:"site",op:"radius",center:[0,0],radiusMeters:1000};
describe.skipIf(!process.env.GEO_TEST_SOCKET)("real spatial retrieval integration",()=>{
 beforeAll(async()=>{
  db=postgres({host:process.env.GEO_TEST_SOCKET!,user:"postgres",database:"postgres",max:2,prepare:false,onnotice:()=>{}});
  vi.doMock("../db.js",()=>({sql:db}));
  ({resolveGeoDocumentScope:resolve}=await import("../search/geo-scope.js"));
  ({retrievalScope:scope}=await import("../search/retrieval-scope.js"));
  await db`insert into "user"(id,name,email) values('q-u','User','q@example.com'),('q-other','Other','other-q@example.com')`;
  await db`insert into organizations(id,name,slug,created_by_user_id) values('q-o','Org','query-geo','q-u'),('q-x','Other','query-other','q-other')`;
  await db`insert into org_memberships(org_id,user_id,role) values('q-o','q-u','owner'),('q-x','q-other','owner')`;
  for (const [w,o,u] of [['q-w','q-o','q-u'],['q-foreign','q-x','q-other']]) {
   await db`insert into workspaces(id,org_id,user_id,name,pipeline) values(${w},${o},${u},${w},${db.json({outputSchema:schema})})`;
   await db`insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,pipeline) values(${w+'-r'},${o},${u},${w},'upload','completed','completed','{}')`;
  }
  for (const [id,point,foreign] of [['near',[0,0],false],['far',[10,10],false],['dateline',[179.9,0],false],['foreign',[0,0],true]] as const) {
   const w=foreign?'q-foreign':'q-w',o=foreign?'q-x':'q-o',u=foreign?'q-other':'q-u';
   await db`insert into documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status)
     values(${id},${o},${u},${w},${w+'-r'},${id+'.txt'},'text/plain',${id},'completed')`;
   await db`insert into document_chunks(id,document_id,run_id,user_id,chunk_index,text,token_estimate)
     values(${id+'-chunk'},${id},${w+'-r'},${u},0,'budget road evidence',4)`;
   await db`insert into geo_projection_generations values(${id},${w},${o},0,${digest},${'a'.repeat(64)})`;
   await db`insert into geo_projection_features values(${id},${w},${o},0,'/site',0,ST_SetSRID(ST_MakePoint(${point[0]},${point[1]}),4326))`;
  }
  search=await import("../services/search.js");
 },60000);
 afterAll(async()=>{await db?.end();});
 it("radius retains only the scoped zero point",async()=>{
  expect((await resolve(tenant,{geo:radius},schema)).documentIds).toEqual(['near']);
 });
 it("crossing bbox and boundary-inclusive polygon work",async()=>{
  expect((await resolve(tenant,{geo:{field:'site',op:'bbox',bbox:[179,-1,-179,1]}},schema)).documentIds).toEqual(['dateline']);
  expect((await resolve(tenant,{geo:{field:'site',op:'within',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}}},schema)).documentIds).toEqual(['near']);
 });
 it("explicit empty and conflicting document filters never widen",async()=>{
  const filters=await resolve(tenant,{geo:radius,documentIds:[]},schema);
  expect(filters.documentIds).toEqual([]);
  const rows=await db`select d.id from documents d where ${scope({workspaceId:'q-w',filters}).vectorDocument()}`;
  expect(rows).toEqual([]);
  expect((await resolve(tenant,{geo:radius,documentId:'near',documentIds:['far']},schema)).documentIds).toEqual([]);
 });
 it("actual hybrid retrieval refuses outsiders and preserves scope under expansion options",async()=>{
  await expect(search.hybridSearch('budget','q-other',{filters:{workspaceId:'q-w',geo:radius},queryVector:[1,0]})).rejects.toThrow();
  const result=await search.hybridSearch('budget','q-u',{filters:{workspaceId:'q-w',geo:radius},queryVector:[1,0],minScore:0,
   useRerank:false,queryRewrite:false,selfQuery:false,enableGraphExpansion:true,enableCommunityExpansion:true,summarySeed:true});
  expect(result.results.length).toBeGreaterThan(0);
  expect(result.results.every(row=>row.citation.documentId==='near')).toBe(true);
 });
 it("invalid topology and untyped fields are explicit errors",async()=>{
  await expect(resolve(tenant,{geo:{field:'site',op:'within',geometry:{type:'Polygon',coordinates:[[[0,0],[2,2],[0,2],[2,0],[0,0]]]}}},schema)).rejects.toThrow('topology');
  await expect(resolve(tenant,{geo:radius},{type:'object',properties:{site:{type:'object'}}})).rejects.toThrow('opted-in');
 });
 it("aborted spatial resolution never starts SQL",async()=>{
  const {withSearchSignal}=await import("../search/query-bounds.js");
  const controller=new AbortController(); controller.abort();
  await expect(withSearchSignal(controller.signal,()=>resolve(tenant,{geo:radius},schema))).rejects.toMatchObject({name:"AbortError"});
 });
 it.each([{mode:"timeout",loader:false},{mode:"abort",loader:false},{mode:"timeout",loader:true},{mode:"abort",loader:true}])("spatial loader=$loader obeys $mode while blocked in PostgreSQL",async({mode,loader})=>{
  const {withSearchSignal}=await import("../search/query-bounds.js");
  const blocker=await db.reserve();
  const previous=process.env.SEARCH_STATEMENT_TIMEOUT_MS;
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
   await blocker`begin`;
   if(loader) await blocker`lock table document_chunks in access exclusive mode`;
   else await blocker`lock table geo_projection_features in access exclusive mode`;
   process.env.SEARCH_STATEMENT_TIMEOUT_MS=mode==="timeout"?"100":"8000";
   if(mode==="abort") timer=setTimeout(()=>controller.abort(),200);
   const started=Date.now();
   await expect(withSearchSignal<unknown>(controller.signal,()=>loader ? search.loadWorkspaceWholeCorpusContext({workspaceId:"q-w",userId:"q-u",filters:{geo:radius}}) : resolve(tenant,{geo:radius},schema))).rejects.toMatchObject({name:mode==="abort"?"AbortError":"SearchStatementTimeoutError"});
   expect(Date.now()-started).toBeLessThan(3000);
  } finally {
   clearTimeout(timer); await blocker`rollback`; blocker.release();
   if(previous===undefined)delete process.env.SEARCH_STATEMENT_TIMEOUT_MS;else process.env.SEARCH_STATEMENT_TIMEOUT_MS=previous;
  }
 });
 it("a revision mutation cannot reuse prior readiness or a resolved scope",async()=>{
  const filters:SearchFilters=await resolve(tenant,{geo:radius},schema);
  await db`update documents set projection_revision=projection_revision+1 where id='near'`;
  expect(await db`select d.id from documents d where ${scope({workspaceId:'q-w',filters}).vectorDocument()}`).toEqual([]);
  await expect(resolve(tenant,{geo:radius},schema)).rejects.toThrow('missing or stale');
 });
});
