import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
const runtime = vi.hoisted(() => ({ chat: vi.fn(), allowed: true }));
let sql: postgres.Sql;
let stop: () => Promise<void>;
let ops: typeof import("../services/chat-operations.js");
beforeAll(async () => {
  const database = await startMigratedPostgres(); stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/request-actor.js", () => ({ getRequestActor: (c: {get:(key:string)=>unknown})=>c.get("requestActor"), resolveActorWorkspaceId:async()=>"w", loadActorScopedWorkspace: async (_id: string, actor: { userId: string }) => runtime.allowed && actor.userId === "u" ? {id:"w",orgId:"o"} : null }));
  vi.doMock("../config.js", () => ({env:{publicChatAgentEnabled:true}}));
  vi.doMock("../services/workspace-chat.js", () => ({ chatWorkspace:runtime.chat,workspaceChatDisabledBody:async()=>null }));
  ops = await import("../services/chat-operations.js");
  await sql`insert into "user" (id,name,email) values ('u','Owner','owner@example.test'),('v','Other','other@example.test')`;
  await sql`insert into organizations (id,name,slug,created_by_user_id) values ('o','Org','durable','u')`;
  await sql`insert into workspaces (id,org_id,user_id,name) values ('w','o','u','Workspace')`;
}, 120_000);
beforeEach(async () => { runtime.allowed=true; runtime.chat.mockReset(); await sql`delete from chat_operations`; });
afterAll(async () => { await sql?.end(); await stop?.(); });
const launch = (key: string, parentId?: string) => ops.launchChatOperation({ userId: "u", workspaceId: "w", orgId: "o", key, input: { q: "hello" }, parentId });
it("deduplicates a lost launch ACK, rejects changed input and claims exactly once", async () => {
  const [a,b] = await Promise.all([launch("lost_ack_1"),launch("lost_ack_1")]);
  expect(a.id).toBe(b.id);
  await expect(ops.launchChatOperation({ userId:"u",workspaceId:"w",orgId:"o",key:"lost_ack_1",input:{q:"changed"} })).rejects.toThrow(/Idempotency/);
  const claim = await ops.claimChatOperation(); expect(claim?.id).toBe(a.id);
  expect(await ops.claimChatOperation()).toBeNull();
  await ops.appendChatOperation(a.id,claim!.attempt_id!,"text",{text:"partial"});
  await ops.appendChatOperation(a.id,claim!.attempt_id!,"result",{answer:"partial",citations:["page1"]},"completed");
  const recovered = await ops.readChatOperation("u",a.id,0);
  expect(recovered?.events.map(e=>e.sequence)).toEqual([1,2]);
  expect(recovered?.operation.snapshot).toMatchObject({text:"partial",answer:"partial",citations:["page1"]});
  expect(await ops.readChatOperation("v",a.id,0)).toBeNull();
  expect(await ops.cancelChatOperation("v",a.id,"tree")).toBe(false);
  expect((await ops.readChatOperation("u",a.id,99))?.resync).toBe(true);
  await expect(ops.readChatOperation("u",a.id,-1)).rejects.toThrow(/cursor/);
});
it("cancel-tree serializes with child launches and parent completion does not conceal children",async()=>{
  const root=await launch("root_tree_1"); const child=await launch("child_tree_1",root.id);
  const claimed=await ops.claimChatOperation();
  await ops.appendChatOperation(root.id,claimed!.attempt_id!,"result",{answer:"done"},"completed");
  expect((await ops.readChatOperation("u",child.id,0))?.operation.status).toBe("queued");
  await ops.cancelChatOperation("u",root.id,"tree");
  expect((await ops.readChatOperation("u",child.id,0))?.operation.status).toBe("cancelled");
  await expect(launch("late_child_1",root.id)).rejects.toThrow(/cancelled/);
});
it("expired executor leases preserve output and interrupt without repeating a paid attempt",async()=>{
  const root=await launch("lease_loss_1"); const claim=await ops.claimChatOperation();
  await ops.appendChatOperation(root.id,claim!.attempt_id!,"text",{text:"accepted"});
  await sql`update chat_operations set lease_until=now()-interval '1 second' where id=${root.id}`;
  expect(await ops.claimChatOperation()).toBeNull();
  const state=await ops.readChatOperation("u",root.id,0);
  expect(state?.operation.status).toBe("interrupted"); expect(state?.events).toHaveLength(2);
  await expect(ops.appendChatOperation(root.id,claim!.attempt_id!,"text",{text:"late"})).rejects.toThrow(/lease/);
});
it("bounds hostile launch payloads and refuses a foreign parent",async()=>{
  await expect(ops.launchChatOperation({userId:"u",workspaceId:"w",orgId:"o",key:"oversized",input:{q:"x".repeat(128001)}})).rejects.toThrow(/size/);
  const root=await launch("foreign_root");
  await expect(ops.launchChatOperation({userId:"v",workspaceId:"w",orgId:"o",key:"foreign_child",input:{q:"hi"},parentId:root.id})).rejects.toThrow(/Parent/);
});

it("disconnect detaches an observer while the executor completes; another instance recovers", async () => {
  const actor = {type:"session" as const,userId:"u",sessionId:"browser",user:{id:"u",name:"Owner",email:"owner@example.test"}};
  await sql`insert into "session" (id,token,"userId","expiresAt") values ('browser','test-token','u',now()+interval '1 hour')`;
  const task = await ops.launchChatOperation({userId:"u",workspaceId:"w",orgId:"o",key:"disconnect_1",input:{q:"hello",authSessionId:"browser"}});
  const claim = await ops.claimChatOperation();
  let release!: () => void;
  const paused = new Promise<void>(resolve => {release=resolve;});
  let started!: () => void;
  const start = new Promise<void>(resolve => {started=resolve;});
  runtime.chat.mockImplementation(async (args: {signal:AbortSignal;onTextDelta:(text:string)=>Promise<void>}) => {
    await args.onTextDelta("first"); started(); await paused;
    expect(args.signal.aborted).toBe(false);
    await args.onTextDelta(" second");
    return {answer:"first second",citations:[{page:2}],toolOutcomes:[{ok:true}]};
  });
  const {executeChatOperation} = await import("../services/chat-operation-executor.js");
  const {createChatOperationProvider,authorizedChatOperationSnapshot} = await import("../services/chat-operation-access.js");
  const executing=executeChatOperation(claim!); await start;
  const disconnected=new AbortController();
  const observer={snapshot:vi.fn(async()=>{}),append:vi.fn(async()=>{}),resync:vi.fn(async()=>{})};
  const subscription=await createChatOperationProvider(async()=>actor).subscribe({userId:"u",resource:{kind:"operation",operationId:task.id,after:0},signal:disconnected.signal,observer});
  disconnected.abort(); await subscription.close(); release(); await executing;
  expect(runtime.chat).toHaveBeenCalledTimes(1);
  const recovered=await authorizedChatOperationSnapshot(actor,task.id,1);
  expect(recovered.events.map(event=>event.sequence)).toEqual([2,3]);
  expect(recovered.operation.snapshot.answer).toBe("first second"); expect(recovered.operation.status).toBe("completed");
  expect(recovered.treeSettled).toBe(true);
  await expect(createChatOperationProvider(async()=>null).subscribe({userId:"u",resource:{kind:"operation",operationId:task.id,after:0},signal:new AbortController().signal,observer})).rejects.toThrow(/forbidden/);
  await expect(authorizedChatOperationSnapshot({...actor,type:"apiKey"} as never,task.id,0)).rejects.toThrow(/forbidden/);
  runtime.allowed=false;
  await expect(authorizedChatOperationSnapshot(actor,task.id,0)).rejects.toThrow(/forbidden/);
  runtime.allowed=true;
});

it("HTTP initiation, lost acknowledgement, recovery and stop share one authorized identity",async()=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");
  const {chatOperationRoutes}=await import("../routes/chat-operations.js");
  let actor: unknown={type:"session",userId:"u",sessionId:"browser",user:{id:"u"}};
  const app=new Hono().use("*",async(c,next)=>{c.set("requestActor",actor as never);await next();}).route("/v1/chat/operations",chatOperationRoutes);
  const post=()=>app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"http_lost_ack"},body:JSON.stringify({q:"hello"})});
  expect((await app.request("/v1/chat/operations",{method:"POST",body:"x".repeat(128001)})).status).toBe(413);
  const first=await post();expect(first.status).toBe(202);
  const {operationId}=await first.json();expect(await (await post()).json()).toMatchObject({operationId});
  expect((await app.request(`/v1/chat/operations/${operationId}`)).status).toBe(200);
  expect((await app.request("/v1/chat/operations")).status).toBe(200);
  expect((await app.request(`/v1/chat/operations/${operationId}/cancel`,{method:"POST",headers:{"content-type":"application/json"},body:'{"scope":"tree"}'})).status).toBe(200);
  const state=await (await app.request(`/v1/chat/operations/${operationId}`)).json();expect(state.operation.status).toBe("cancelled");
  actor={type:"apiKey",userId:"u"};expect((await app.request(`/v1/chat/operations/${operationId}`)).status).toBe(403);
  actor={type:"session",userId:"v",sessionId:"other",user:{id:"v"}};expect((await app.request(`/v1/chat/operations/${operationId}`)).status).toBe(409);
  vi.unstubAllEnvs();
});
it("cancel-one leaves accepted siblings running and output budgets fail closed",async()=>{
  const root=await launch("scope_root");const a=await launch("scope_child_a",root.id);const b=await launch("scope_child_b",root.id);
  await ops.cancelChatOperation("u",a.id,"task");
  expect((await ops.readChatOperation("u",b.id,0))?.operation.status).toBe("queued");
  const claimed=await ops.claimChatOperation();expect(claimed?.id).toBe(root.id);
  await expect(ops.appendChatOperation(root.id,claimed!.attempt_id!,"text",{text:"x".repeat(262145)})).rejects.toThrow(/limit/);
  expect((await ops.readChatOperation("u",root.id,0))?.operation.sequence).toBe(0);
});

it("revoking the initiating session cancels the executor, independently of transport",async()=>{
  await sql`insert into "session" (id,token,"userId","expiresAt") values ('revoked','revoked-token','u',now()+interval '1 hour')`;
  const task=await ops.launchChatOperation({userId:"u",workspaceId:"w",orgId:"o",key:"revocation_test",input:{q:"hello",authSessionId:"revoked"}});
  const claimed=await ops.claimChatOperation();
  let started!:()=>void;const start=new Promise<void>(resolve=>{started=resolve;});
  runtime.chat.mockImplementation(async(args:{signal:AbortSignal})=>{
    started();return new Promise((_resolve,reject)=>args.signal.addEventListener("abort",()=>reject(args.signal.reason),{once:true}));
  });
  const {executeChatOperation}=await import("../services/chat-operation-executor.js");
  const executing=executeChatOperation(claimed!);await start;
  await sql`delete from "session" where id='revoked'`;
  await executing;
  expect((await ops.readChatOperation("u",task.id,0))?.operation.status).toBe("cancelled");
  expect(runtime.chat).toHaveBeenCalledTimes(1);
});
