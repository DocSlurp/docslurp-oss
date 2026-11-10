import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ admitted: false, live: true, failure: null as string | null, launch: vi.fn(), retry: vi.fn(), cancel: vi.fn(), create: vi.fn() }));
vi.mock("../db.js", () => ({ sql: async () => [{runtime:"mastra"}] }));
vi.mock("../agent-runtime/runtime.js", () => ({ nativeOperations: async () => ({launch:state.launch,retry:state.retry,cancel:state.cancel}) }));
vi.mock("../lib/request-actor.js", () => ({ getRequestActor: () => ({type:"session",userId:"u",sessionId:"s"}), resolveActorProjectId:async()=>"p", loadActorScopedProject:async()=>({id:"p",orgId:"o"}) }));
vi.mock("../services/chat-operation-access.js", () => ({ authorizeChatOperation:async()=>{if(state.failure)throw new Error(state.failure);return {id:"p",orgId:"o"};},authorizedChatOperationSnapshot:async()=>({watermark:2}) }));
vi.mock("../services/chat-operations.js", () => ({ launchChatOperation:state.create,readChatOperation:vi.fn(),cancelChatOperation:vi.fn() }));
vi.mock("../services/project-chat.js", () => ({projectChatDisabledBody:async()=>null}));
vi.mock("../realtime/session.js", () => ({ revalidateRealtimeSession:async()=>state.live?{}:null,hasRealtimeCanaryMembership:async()=>state.admitted }));
import { chatOperationRoutes } from "../routes/chat-operations.js";
const app = new Hono().route("/",chatOperationRoutes);
const id="00000000-0000-4000-8000-000000000001";
afterEach(() => {vi.unstubAllEnvs();vi.clearAllMocks();state.admitted=false;state.live=true;state.failure=null;});
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
