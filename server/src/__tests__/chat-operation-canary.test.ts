import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ admitted: false, live: true, failure: null as string | null, actorType:"session", modelRefused:false, launch: vi.fn(), retry: vi.fn(), cancel: vi.fn(), create: vi.fn() }));
vi.mock("../db.js", () => ({ sql: async () => [{runtime:"mastra"}] }));
vi.mock("../agent-runtime/runtime.js", () => ({ nativeOperations: async () => ({launch:state.launch,retry:state.retry,cancel:state.cancel}) }));
vi.mock("../lib/request-actor.js", () => ({ getRequestActor: () => ({type:state.actorType,userId:"u",sessionId:"s"}), resolveActorProjectId:async()=>"p", loadActorScopedProject:async()=>({id:"p",orgId:"o"}) }));
vi.mock("../services/chat-operation-access.js", () => ({ authorizeChatOperation:async()=>{if(state.failure)throw new Error(state.failure);return {id:"p",orgId:"o"};},authorizedChatOperationSnapshot:async()=>({watermark:2}) }));
vi.mock("../services/chat-operations.js", () => ({ launchChatOperation:state.create,readChatOperation:vi.fn(),cancelChatOperation:vi.fn() }));
vi.mock("../lib/chat-model-policy.js", () => ({ chatModelRefused: async () => state.modelRefused }));
vi.mock("../services/project-chat.js", () => ({projectChatDisabledBody:async()=>null}));
vi.mock("../realtime/session.js", () => ({ revalidateRealtimeSession:async()=>state.live?{}:null,hasRealtimeCanaryMembership:async()=>state.admitted }));
import { chatOperationRoutes } from "../routes/chat-operations.js";
const app = new Hono().route("/",chatOperationRoutes);
const id="00000000-0000-4000-8000-000000000001";
afterEach(() => {vi.unstubAllEnvs();vi.clearAllMocks();state.admitted=false;state.live=true;state.failure=null;state.actorType="session";state.modelRefused=false;});
it.each(["/",`/${id}/tasks`,`/${id}/retry`])("refuses new native work outside the cohort: %s",async path=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");
  const body=path.endsWith("retry")?{authorizeNewAttempt:true,observedAttemptId:"attempt"}:{q:"hello"};
  const response=await app.request(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  expect(response.status).toBe(403);
  expect(state.create).not.toHaveBeenCalled();expect(state.launch).not.toHaveBeenCalled();expect(state.retry).not.toHaveBeenCalled();
});
it("retains authorized recovery and Stop when removed from the cohort",async()=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");
  expect((await app.request(`/${id}`)).status).toBe(200);
  expect((await app.request(`/${id}/cancel`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scope:"tree"})})).status).toBe(200);
  expect(state.cancel).toHaveBeenCalledWith(id,"tree");
});
it("does not admit a revoked session even when the cohort allows it",async()=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");state.admitted=true;state.live=false;
  expect((await app.request("/",{method:"POST",body:JSON.stringify({q:"hello"})})).status).toBe(403);
  expect(state.create).not.toHaveBeenCalled();
});
it("rejects an oversized launch before paid admission",async()=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");state.admitted=true;
  expect((await app.request("/",{method:"POST",body:JSON.stringify({q:"x".repeat(128001)})})).status).toBe(413);
  expect(state.create).not.toHaveBeenCalled();
});

it.each(["operation_forbidden","backend_unavailable"])("distinguishes forbidden recovery from unavailable history: %s",async failure=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");state.failure=failure;
  const response=await app.request(`/${id}`);
  expect(response.status).toBe(failure==="operation_forbidden"?403:409);
  expect(await response.json()).toEqual({error:failure==="operation_forbidden"?"forbidden":"operation_unavailable"});
});
it("pauses new paid admission while retaining authorized recovery and Stop",async()=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION","0");state.admitted=true;
  for(const path of ["/",`/${id}/tasks`,`/${id}/retry`]) {
    const body=path.endsWith("retry")?{authorizeNewAttempt:true,observedAttemptId:"attempt"}:{q:"hello"};
    expect((await app.request(path,{method:"POST",body:JSON.stringify(body)})).status).toBe(403);
  }
  expect(state.create).not.toHaveBeenCalled();expect(state.retry).not.toHaveBeenCalled();expect(state.launch).not.toHaveBeenCalled();
  expect((await app.request(`/${id}`)).status).toBe(200);
  expect((await app.request(`/${id}/cancel`,{method:"POST",body:JSON.stringify({scope:"tree"})})).status).toBe(200);
  expect(state.cancel).toHaveBeenCalledWith(id,"tree");
});

it.each(["/",`/${id}/tasks`,`/${id}/retry`])("explicit admission permits an authorized request: %s",async path=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION","1");state.admitted=true;
  state.create.mockResolvedValueOnce({id});state.launch.mockResolvedValueOnce({operationId:id,rootId:id,status:"queued"});state.retry.mockResolvedValueOnce({operationId:id,rootId:id,status:"queued"});
  const body=path.endsWith("retry")?{authorizeNewAttempt:true,observedAttemptId:"attempt"}:{q:"hello"};
  expect((await app.request(path,{method:"POST",body:JSON.stringify(body)})).status).toBe(202);
});
it("admission opt-in never enables the globally disabled routes",async()=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","0");vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION","1");state.admitted=true;
  expect((await app.request("/",{method:"POST",body:JSON.stringify({q:"hello"})})).status).toBe(404);
  expect(state.create).not.toHaveBeenCalled();
});
it("explicit admission cannot enable API-key actors",async()=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION","1");state.admitted=true;state.actorType="apiKey";
  expect((await app.request("/",{method:"POST",body:JSON.stringify({q:"hello"})})).status).toBe(403);
  expect(state.create).not.toHaveBeenCalled();
});
it.each(["","true","not-a-policy"])("invalid policy refuses before creating work without echoing it: %s",async value=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION",value);state.admitted=true;
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  try {
    const response=await app.request("/",{method:"POST",body:JSON.stringify({q:"hello"})});
    expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"operation_unavailable"});
    expect(state.create).not.toHaveBeenCalled();expect(state.retry).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[native-chat] admission_refused invalid_policy");
  } finally {log.mockRestore();}
});
it("stores the composer options with the launch",async()=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION","1");state.admitted=true;
  state.create.mockResolvedValueOnce({id});state.launch.mockResolvedValueOnce({operationId:id,rootId:id,status:"queued"});
  const options={speedBoost:true,webTools:true,suggestions:false,retrieval:{resultCount:6},filters:{documentIds:["doc-1"]}};
  expect((await app.request("/",{method:"POST",body:JSON.stringify({q:"hello",...options})})).status).toBe(202);
  expect(state.create).toHaveBeenCalledWith(expect.objectContaining({input:expect.objectContaining({q:"hello",...options})}));
});
it.each([{webTools:"yes"},{retrieval:{resultCount:500}},{filters:{projectId:"other"}},{orgId:"other-org"}])("refuses malformed composer options before creating work: %j",async extra=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION","1");state.admitted=true;
  const response=await app.request("/",{method:"POST",body:JSON.stringify({q:"hello",...extra})});
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(state.create).not.toHaveBeenCalled();
});
it("refuses a disallowed model before creating work",async()=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION","1");state.admitted=true;state.modelRefused=true;
  const response=await app.request("/",{method:"POST",body:JSON.stringify({q:"hello",model:"not-allowed"})});
  expect(response.status).toBe(400);expect(await response.json()).toEqual({error:"model_not_allowed"});
  expect(state.create).not.toHaveBeenCalled();expect(state.launch).not.toHaveBeenCalled();
});
