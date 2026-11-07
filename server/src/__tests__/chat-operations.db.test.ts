import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
const runtime = vi.hoisted(() => ({ chat: vi.fn(), allowed: true }));
let sql: postgres.Sql;
let stop: () => Promise<void>;
let ops: typeof import("../services/chat-operations.js");
beforeAll(async () => {
  const external = process.env.CHAT_OPERATION_TEST_DATABASE_URL;
  if (external && new URL(external).hostname !== "127.0.0.1") throw new Error("Race tests require an isolated loopback database");
  const database = external ? { url: external, stop: async () => {} } : await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: external ? 5 : 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/request-actor.js", () => ({ getRequestActor: (c: {get:(key:string)=>unknown})=>c.get("requestActor"), resolveActorProjectId:async()=>"w", loadActorScopedProject: async (_id: string, actor: { userId: string }) => runtime.allowed && actor.userId === "u" ? {id:"w",orgId:"o"} : null }));
  vi.doMock("../config.js", () => ({env:{publicChatAgentEnabled:true}}));
  vi.doMock("../services/project-chat.js", () => ({ chatProject:runtime.chat,projectChatDisabledBody:async()=>null }));
  ops = await import("../services/chat-operations.js");
  await sql`insert into "user" (id,name,email) values ('u','Owner','owner@example.test'),('v','Other','other@example.test')`;
  await sql`insert into organizations (id,name,slug,created_by_user_id) values ('o','Org','durable','u')`;
  await sql`insert into projects (id,org_id,user_id,name) values ('w','o','u','Project')`;
}, 120_000);
beforeEach(async () => { runtime.allowed=true; runtime.chat.mockReset(); await sql`delete from chat_operations`; });
afterAll(async () => { await sql?.end(); await stop?.(); });
const launch = (key: string, parentId?: string) => ops.launchChatOperation({ userId: "u", projectId: "w", orgId: "o", key, input: { q: "hello" }, parentId });
it("deduplicates a lost launch ACK, rejects changed input and claims exactly once", async () => {
  const [a,b] = await Promise.all([launch("lost_ack_1"),launch("lost_ack_1")]);
  expect(a.id).toBe(b.id);
  await expect(ops.launchChatOperation({ userId:"u",projectId:"w",orgId:"o",key:"lost_ack_1",input:{q:"changed"} })).rejects.toThrow(/Idempotency/);
  const claim = await ops.claimChatOperation(); expect(claim?.id).toBe(a.id);
  expect(await ops.claimChatOperation()).toBeNull();
  await ops.appendChatOperation(a.id,claim!.attempt_id!,"text",{text:"partial"});
  await ops.appendChatOperation(a.id,claim!.attempt_id!,"result",{answer:"partial",citations:["page1"]},"completed");
  const recovered = await ops.readChatOperation("u",a.id,0);
  expect(recovered?.events.map(e=>e.sequence)).toEqual([1,2]);
  expect(recovered?.operation.snapshot).toMatchObject({answer:"partial",citations:["page1"]});
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
  await expect(ops.launchChatOperation({userId:"u",projectId:"w",orgId:"o",key:"oversized",input:{q:"x".repeat(128001)}})).rejects.toThrow(/size/);
  const root=await launch("foreign_root");
  await expect(ops.launchChatOperation({userId:"v",projectId:"w",orgId:"o",key:"foreign_child",input:{q:"hi"},parentId:root.id})).rejects.toThrow(/Parent/);
});

it("disconnect detaches an observer while the executor completes; another instance recovers", async () => {
  const actor = {type:"session" as const,userId:"u",sessionId:"browser",user:{id:"u",name:"Owner",email:"owner@example.test"}};
  await sql`insert into "session" (id,token,"userId","expiresAt") values ('browser','test-token','u',now()+interval '1 hour')`;
  const task = await ops.launchChatOperation({userId:"u",projectId:"w",orgId:"o",key:"disconnect_1",input:{q:"hello",authSessionId:"browser"}});
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

// HTTP initiation/recovery/cancel now exercise native ownership in agent-runtime/runtime.integration.test.ts.
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
  const task=await ops.launchChatOperation({userId:"u",projectId:"w",orgId:"o",key:"revocation_test",input:{q:"hello",authSessionId:"revoked"}});
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


it.each(["cancel", "deadline"])("rejects late output and successful completion after %s commits", async reason => {
  const task = await launch(`commit_${reason}`);
  const claim = await ops.claimChatOperation();
  await ops.appendChatOperation(task.id, claim!.attempt_id!, "text", { text: "accepted" });
  if (reason === "cancel") await ops.cancelChatOperation("u", task.id, "task");
  else await sql`update chat_operations set deadline=now()-interval '1 second' where id=${task.id}`;
  await expect(ops.appendChatOperation(task.id, claim!.attempt_id!, "text", { text: "late" })).rejects.toThrow();
  await expect(ops.appendChatOperation(task.id, claim!.attempt_id!, "result", { answer: "late" }, "completed")).rejects.toThrow();
  await ops.appendChatOperation(task.id, claim!.attempt_id!, "error", { code: "execution_stopped" }, "failed");
  const state = await ops.readChatOperation("u", task.id, 0);
  expect(state?.operation.status).toBe("cancelled");
  expect(state?.operation.snapshot.text).toBe("accepted");
  expect(state?.events.some(event => event.kind === "result")).toBe(false);
});

it("consumes rejected synchronous evidence callbacks and preserves executor cancellation context", async () => {
  await sql`insert into "session" (id,token,"userId","expiresAt") values ('evidence','evidence-token','u',now()+interval '1 hour')`;
  const task = await ops.launchChatOperation({userId:"u",projectId:"w",orgId:"o",key:"evidence_rejection",input:{q:"hello",authSessionId:"evidence"}});
  const claim = await ops.claimChatOperation();
  const { getDeferredContext } = await import("../search/deferred/deferred-context.js");
  runtime.chat.mockImplementation(async (args: {signal: AbortSignal; onEvidence: (event: unknown) => void}) => {
    expect(getDeferredContext()?.signal).toBe(args.signal);
    args.onEvidence({ text: "x".repeat(262145) });
    await new Promise<void>(resolve => args.signal.addEventListener("abort", () => resolve(), {once:true}));
    throw args.signal.reason;
  });
  const { executeChatOperation } = await import("../services/chat-operation-executor.js");
  await executeChatOperation(claim!);
  await new Promise(resolve => setImmediate(resolve));
  expect((await ops.readChatOperation("u", task.id, 0))?.operation.status).toBe("failed");
});


it("retains a near-limit successful streamed result without charging its text twice", async () => {
  const task = await launch("large_completed_result");
  const claim = await ops.claimChatOperation();
  const answer = "x".repeat(240 * 1024);
  await ops.appendChatOperation(task.id, claim!.attempt_id!, "text", { text: answer });
  await ops.appendChatOperation(task.id, claim!.attempt_id!, "result", { answer, citations: [{ page: 3 }] }, "completed");
  const state = await ops.readChatOperation("u", task.id, 1);
  expect(state?.operation.status).toBe("completed");
  expect(state?.operation.snapshot.answer).toBe(answer);
  expect(state?.resync).toBe(true);
  expect(state?.events).toEqual([]);
  expect(state?.operation.snapshot.citations).toEqual([{ page: 3 }]);
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(512 * 1024);
  const [stored] = await sql`select snapshot,output_bytes from chat_operations where id=${task.id}`;
  expect(stored.snapshot.answer).toBeUndefined();
  expect(stored.output_bytes).toBeLessThan(ops.CHAT_OPERATION_LIMITS.outputBytes);
});


it.skipIf(!process.env.CHAT_OPERATION_TEST_DATABASE_URL).each(["cancel", "deadline"])("fences append contending on the root lock with %s", async reason => {
  const task = await launch(`concurrent_${reason}`);
  const claim = await ops.claimChatOperation();
  let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  let unlock!: () => void;
  const release = new Promise<void>(resolve => { unlock = resolve; });
  const holder = sql.begin(async tx => {
    await tx`select id from chat_operations where id=${task.id} for update`;
    if (reason === "deadline") await tx`update chat_operations set deadline=clock_timestamp()+interval '200 milliseconds' where id=${task.id}`;
    locked(); await release;
  });
  await ready;
  const waiting = async (count: number) => vi.waitFor(async () => {
    const [row] = await sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%chat_operations%'`;
    expect(row.n).toBeGreaterThanOrEqual(count);
  });
  try {
    const cancelling = reason === "cancel" ? ops.cancelChatOperation("u", task.id, "task") : Promise.resolve();
    if (reason === "cancel") await waiting(1);
    const append = ops.appendChatOperation(task.id, claim!.attempt_id!, "result", {answer:"late"}, "completed");
    const rejected = expect(append).rejects.toThrow();
    await waiting(reason === "cancel" ? 2 : 1);
    if (reason === "deadline") await sql`select pg_sleep(0.25)`;
    unlock(); await holder; await cancelling; await rejected;
    expect((await ops.readChatOperation("u", task.id, 0))?.operation.status).not.toBe("completed");
  } finally { unlock(); await holder; }
});

it("requires an active-root slot when adding a child to a completed root",async()=>{
  const dormant=await launch("dormant_root");
  const attempt=(await ops.claimChatOperation())!;
  await ops.appendChatOperation(dormant.id,attempt.attempt_id!,"result",{answer:"finished"},"completed");
  for(let n=0;n<8;n++)await launch(`other_root_${n}`);
  await expect(launch("reactivate_child",dormant.id)).rejects.toThrow("Active operation limit");
  await sql`update chat_operations set status='completed' where id=(select id from chat_operations where id<>${dormant.id} limit 1)`;
  await expect(launch("reactivate_child",dormant.id)).resolves.toBeTruthy();
});
it("keeps native bindings out of even a legacy queued-status claim",async()=>{
  const native=await ops.launchChatOperation({userId:"u",projectId:"w",orgId:"o",key:"native_unclaimable",input:{},runtime:"mastra"});
  expect(native.status).toBe("waiting");
  expect(await ops.claimChatOperation()).toBeNull();
});
