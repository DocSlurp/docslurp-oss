import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {WebSocket} from "ws";
import {Pool} from "pg";
import {pathToFileURL} from "node:url";
import { randomUUID, createHmac } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll,beforeAll,expect,it,vi } from "vitest";
import type { RequestActor } from "../lib/request-actor.js";
import { StrictCachingPubSub } from "./strict-pubsub.js";
import { operationOutputTopic } from "./operation-delivery.js";
const state=vi.hoisted(()=>({chat:vi.fn()}));
const url=process.env.NATIVE_CHAT_TEST_DATABASE_URL;
const redis=process.env.NATIVE_CHAT_TEST_REDIS_URL;
const enabled=!!url&&!!redis;
let sql:postgres.Sql;
let authPool:Pool;
const authSecret="native-local-auth-fixture-".padEnd(48,"x");
const origin="http://localhost:4321";
let runtime:typeof import("./runtime.js");
let routes:typeof import("../routes/chat-operations.js").chatOperationRoutes;
const shutdown=new AbortController();
let worker:Promise<void>;
let actor={type:"session" as const,userId:"native-api-owner",sessionId:"native-api-session",user:{id:"native-api-owner",name:"Native",email:"native-api@example.test"}};
const project="00000000-0000-4000-8000-000000000320";
const requestApp=()=>new Hono().use("*",async(c,next)=>{c.set("requestActor",actor);await next();}).route("/v1/chat/operations",routes);
async function restoreSession() {
  await sql`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt")
    values('native-api-session','native-api-test-token-child','native-api-owner',now()+interval '1 day',now(),now())
    on conflict(id) do update set "expiresAt"=now()+interval '1 day'`;
}
beforeAll(async()=>{
  if(!enabled)return;
  if(new URL(url!).hostname!=="127.0.0.1"||new URL(redis!).hostname!=="127.0.0.1")throw new Error("isolated loopback services required");
  sql=postgres(url!,{max:5,prepare:false,onnotice(){}});
  vi.doMock("../db.js",()=>({sql}));
  vi.doMock("../config.js",async original=>({env:{...(await original<typeof import("../config.js")>()).env,databaseUrl:url,publicChatAgentEnabled:true}}));
  vi.stubEnv("NODE_ENV","test");vi.stubEnv("DATABASE_URL",url!);vi.stubEnv("BETTER_AUTH_URL",origin);
  vi.stubEnv("BETTER_AUTH_SECRET",authSecret);vi.stubEnv("PASSKEY_ORIGINS","");
  vi.stubEnv("CORS_ALLOWED_ORIGINS",origin);
  authPool=new Pool({connectionString:url,max:4});
  (globalThis as {__docslurpAuthPool?:Pool}).__docslurpAuthPool=authPool;
  vi.doMock("../services/project-chat.js",()=>({chatProject:state.chat,projectChatDisabledBody:async()=>null}));
  vi.stubEnv("DOCSLURP_DURABLE_CHAT","1");vi.stubEnv("MASTRA_REDIS_URL",redis!);vi.stubEnv("MASTRA_NAMESPACE",`native-api-test:${randomUUID()}`);
  await sql`delete from chat_operations where user_id='native-api-owner'`;
  await sql`delete from documents where user_id='native-api-owner'`;
  await sql`delete from project_runs where user_id='native-api-owner'`;
  await sql`delete from projects where user_id='native-api-owner'`;
  await sql`delete from organizations where id='native-api-org'`;
  await sql`delete from "user" where id='native-api-owner'`;
  await sql`insert into "user"(id,name,email) values('native-api-owner','Native','native-api@example.test')`;
  await sql`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt")
    values('native-api-session','native-api-test-token','native-api-owner',now()+interval '1 day',now(),now())`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values('native-api-org','Native','native-api-org','native-api-owner')`;
  await sql`insert into org_memberships(org_id,user_id,role) values('native-api-org','native-api-owner','owner') on conflict do nothing`;
  await sql`insert into projects(id,org_id,user_id,name) values(${project},'native-api-org','native-api-owner','Native')`;
  runtime=await import("./runtime.js");
  routes=(await import("../routes/chat-operations.js")).chatOperationRoutes;
  worker=runtime.runNativeChatWorker(shutdown.signal);
},60000);
afterAll(async()=>{
  if(!enabled)return;
  shutdown.abort();await worker;await runtime?.closeNativeChatRuntime();await sql?.end();await authPool?.end();delete (globalThis as {__docslurpAuthPool?:Pool}).__docslurpAuthPool;vi.unstubAllEnvs();
});
it.runIf(enabled)("runs once under native ownership, recovers a lost HTTP ACK and keeps output after observer detachment",async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  state.chat.mockImplementation(async(args)=>{
    await args.onTextDelta("first ");
    await gate;
    args.signal.throwIfAborted();
    await args.onTextDelta("second");
    return {answer:"first second",citations:[{documentId:"native-test-doc",page:1}]};
  });
  const app=new Hono().use("*",async(c,next)=>{c.set("requestActor",actor);await next();}).route("/v1/chat/operations",routes);
  const post=()=>app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"native_lost_ack"},
    body:JSON.stringify({q:"synthetic",project})});
  try {
    const accepted=await post();expect(accepted.status).toBe(202);
    const {operationId}=await accepted.json();
    expect(await (await post()).json()).toMatchObject({operationId});
    await vi.waitFor(()=>expect(state.chat).toHaveBeenCalledTimes(1),{timeout:15000});
    let recovered: any;
    await vi.waitFor(async()=>{
      const response=await app.request(`/v1/chat/operations/${operationId}?after=0`);
      expect(response.status).toBe(200);recovered=await response.json();
      expect(recovered.operation.snapshot.text).toBe("first ");
    },{timeout:5000});
    const {createChatOperationProvider}=await import("../services/chat-operation-access.js");
    const abort=new AbortController();
    const observation=await createChatOperationProvider(async()=>actor).subscribe({userId:actor.userId,
      resource:{kind:"operation",operationId,after:1},signal:abort.signal,
      observer:{snapshot:async()=>{},append:async()=>{},resync:async()=>{}}});
    abort.abort();await observation.close();
    release();
    await vi.waitFor(async()=>{
      recovered=await (await app.request(`/v1/chat/operations/${operationId}?after=1`)).json();
      expect(recovered.operation.status).toBe("completed");
    },{timeout:15000});
    expect(recovered.operation.snapshot).toMatchObject({answer:"first second",citations:[{documentId:"native-test-doc",page:1}]});
    expect(recovered.events.map((e:any)=>e.sequence)).toEqual([2,3]);
    expect(recovered.treeSettled).toBe(true);expect(state.chat).toHaveBeenCalledTimes(1);
    // Recreate the API-side native host: recovery uses shared native PG/Redis,
    // never the initiating process's in-memory output or task objects.
    await runtime.closeNativeChatRuntime();
    const {attachFirstPartyRealtime}=await import("../realtime/index.js");
    let mounted:{server:{server:ReturnType<typeof createServer>};drain():Promise<void>}|undefined;
    const astroEntry=process.env.NATIVE_CHAT_TEST_ASTRO_ENTRY;
    if(astroEntry) {
      vi.stubEnv("ASTRO_NODE_AUTOSTART","disabled");vi.stubEnv("REALTIME_ENABLED","false");
      vi.stubEnv("PORT","0");vi.stubEnv("HOST","127.0.0.1");
      mounted=(await import(/* @vite-ignore */ pathToFileURL(astroEntry).href)).startServer();
    }
    const server=mounted?.server.server ?? createServer((_req,res)=>res.end());
    vi.stubEnv("REALTIME_ENABLED","true");
    const adapter=attachFirstPartyRealtime(server);
    if(!server.listening)await new Promise<void>(resolve=>{
      if(mounted)server.once("listening",resolve);else server.listen(0,"127.0.0.1",resolve);
    });
    const token="native-api-test-token";
    const signature=createHmac("sha256",authSecret).update(token).digest("base64");
    const cookie=`better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
    const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime`,{headers:{origin,cookie}});
    const frames:any[]=[];socket.on("message",data=>frames.push(JSON.parse(data.toString())));
    try {
      await new Promise<void>((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
      socket.send(JSON.stringify({v:1,type:"subscribe",subscriptionId:"native",generation:1,resource:{kind:"operation",operationId,after:1}}));
      await vi.waitFor(()=>expect(frames.some(frame=>frame.data?.operation?.snapshot?.answer==="first second")).toBe(true),{timeout:5000});
      expect(state.chat).toHaveBeenCalledTimes(1);
    } finally {socket.terminate();await adapter.close();if(mounted)await mounted.drain();else await new Promise<void>(resolve=>server.close(()=>resolve()));}

    const original=actor;actor={...actor,userId:"foreign"};
    expect((await app.request(`/v1/chat/operations/${operationId}`)).status).toBe(403);actor=original;
    await sql`delete from session where id=${actor.sessionId}`;
    expect((await app.request(`/v1/chat/operations/${operationId}`)).status).toBe(403);
  } finally {release();}
},40000);

it.runIf(enabled)("explicit native cancellation aborts only the accepted task and exposes terminal state",async()=>{
  await sql`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt")
    values('native-api-session','native-api-test-token-2','native-api-owner',now()+interval '1 day',now(),now()) on conflict do nothing`;
  let aborted=false;
  state.chat.mockImplementation(async(args)=>{
    await args.onTextDelta("kept partial");
    await new Promise<void>((resolve,reject)=>{
      const stop=()=>{aborted=true;reject(new Error("cancelled"));};
      if(args.signal.aborted)stop();else args.signal.addEventListener("abort",stop,{once:true});
    });
    return {answer:"unreachable"};
  });
  const app=new Hono().use("*",async(c,next)=>{c.set("requestActor",actor);await next();}).route("/v1/chat/operations",routes);
  const response=await app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"native_cancel_task"},
    body:JSON.stringify({q:"cancel fixture",project})});
  expect(response.status).toBe(202);
  const {operationId}=await response.json();
  await vi.waitFor(async()=>expect((await (await app.request(`/v1/chat/operations/${operationId}`)).json()).operation.snapshot.text).toBe("kept partial"),{timeout:10000});
  expect((await app.request(`/v1/chat/operations/${operationId}/cancel`,{method:"POST",headers:{"content-type":"application/json"},body:'{"scope":"task"}'})).status).toBe(200);
  await vi.waitFor(()=>expect(aborted).toBe(true),{timeout:5000});
  const result=await (await app.request(`/v1/chat/operations/${operationId}`)).json();
  expect(result.operation.status).toBe("cancelled");expect(result.operation.snapshot.text).toBe("kept partial");
  expect(result.treeSettled).toBe(true);
},20000);
it.runIf(enabled)("executes an explicitly retried child as a new native attempt while retaining old output and recovering a lost retry ACK",async()=>{
  await restoreSession();
  let childCalls=0;let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  state.chat.mockReset().mockImplementation(async(args)=>{
    if(args.query==="retry parent")return {answer:"parent available",citations:[]};
    childCalls++;
    if(childCalls===1){await args.onTextDelta("first attempt partial");throw new Error("synthetic_transient_failure");}
    await args.onTextDelta("second attempt ");await gate;
    await args.onTextDelta("answer");return {answer:"second attempt answer",citations:[{documentId:"retry-document",page:2}]};
  });
  const app=requestApp();
  const launch=await app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"retry_parent_fixture"},body:JSON.stringify({q:"retry parent",project})});
  expect(launch.status).toBe(202);const rootId=(await launch.json()).operationId;
  const child=await app.request(`/v1/chat/operations/${rootId}/tasks`,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"retry_child_fixture"},body:JSON.stringify({q:"retry child"})});
  expect(child.status).toBe(202);const id=(await child.json()).operationId;
  let before:any;
  await vi.waitFor(async()=>{before=await (await app.request(`/v1/chat/operations/${id}`)).json();expect(before.operation.status).toBe("failed");},{timeout:15000});
  expect(before.operation.snapshot.text).toBe("first attempt partial");
  const retry=(body:unknown={authorizeNewAttempt:true,observedAttemptId:before.operation.attempt_id},key="retry_ack_fixture")=>app.request(`/v1/chat/operations/${id}/retry`,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":key},body:JSON.stringify(body)});
  expect((await retry({authorizeNewAttempt:false})).status).toBe(409);
  expect((await retry({authorizeNewAttempt:true,q:"replacement"})).status).toBe(409);
  expect((await retry({authorizeNewAttempt:true,extra:"x".repeat(300)})).status).toBe(413);
  expect(childCalls).toBe(1);
  const previousActor=actor;
  await sql`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values('retry-fresh-session','retry-fresh-test-token',${actor.userId},now()+interval '1 day',now(),now())`;
  actor={...actor,sessionId:"retry-fresh-session"};
  await sql`update session set "expiresAt"=now()-interval '1 second' where id=${previousActor.sessionId}`;
  try {
    expect((await retry()).status).toBe(202); // Deliberately lose this response.
    const repeated=await retry();expect(repeated.status).toBe(202);expect((await repeated.json()).operationId).toBe(id);
    let current:any;
    await vi.waitFor(async()=>{current=await (await app.request(`/v1/chat/operations/${id}?after=${before.watermark}`)).json();expect(current.operation.snapshot.text).toBe("second attempt ");},{timeout:15000});
    expect(current.operation.attempt_id).not.toBe(before.operation.attempt_id);
    expect(current.watermark).toBeGreaterThan(before.watermark);
    expect(current.operation.snapshot.priorAttempts).toMatchObject([{snapshot:{text:"first attempt partial"}}]);
    expect((await retry({authorizeNewAttempt:true,observedAttemptId:current.operation.attempt_id},"overlap_fixture")).status).toBe(409);
    expect(childCalls).toBe(2);
    const offline=new AbortController();
    const {createChatOperationProvider}=await import("../services/chat-operation-access.js");
    const watch=await createChatOperationProvider(async()=>actor).subscribe({userId:actor.userId,resource:{kind:"operation",operationId:id,after:current.watermark},signal:offline.signal,
      observer:{snapshot:async()=>{},append:async()=>{},resync:async()=>{}}});
    offline.abort();await watch.close();release();
    await vi.waitFor(async()=>{current=await (await app.request(`/v1/chat/operations/${id}`)).json();expect(current.operation.status).toBe("completed");},{timeout:15000});
    expect(current.operation.snapshot).toMatchObject({answer:"second attempt answer",citations:[{documentId:"retry-document",page:2}],priorAttempts:[{snapshot:{text:"first attempt partial"}}]});
    const [budget]=await sql`select output_bytes from chat_operations where id=${id}`;
    await sql`update chat_operations set output_bytes=262144 where id=${id}`;
    expect((await retry()).status).toBe(202);expect(childCalls).toBe(2);
    await sql`update chat_operations set output_bytes=${Number(budget!.output_bytes)} where id=${id}`;
    const host=await runtime.nativeChatRuntime();expect((await host.mastra.backgroundTaskManager!.listTasks({toolCallId:id})).total).toBe(2);
    await sql`update session set "expiresAt"=now()-interval '1 second' where id=${actor.sessionId}`;
    expect((await retry()).status).toBe(403);expect(childCalls).toBe(2);
  }finally{release();actor=previousActor;await restoreSession();}
},30000);
it.runIf(enabled)("refuses delayed consent for an older failed attempt without another execution",async()=>{
  await restoreSession();let childCalls=0;
  state.chat.mockReset().mockImplementation(async(args)=>{
    if(args.query==="consent parent")return {answer:"parent",citations:[]};
    childCalls++;throw new Error("synthetic_consent_failure");
  });
  const app=requestApp();const headers={"content-type":"application/json","Idempotency-Key":"consent_parent_fixture"};
  const root=(await (await app.request("/v1/chat/operations",{method:"POST",headers,body:JSON.stringify({q:"consent parent",project})})).json()).operationId;
  const id=(await (await app.request(`/v1/chat/operations/${root}/tasks`,{method:"POST",headers:{...headers,"Idempotency-Key":"consent_child_fixture"},body:JSON.stringify({q:"consent child"})})).json()).operationId;
  const read=async()=>{const response=await app.request(`/v1/chat/operations/${id}`);expect(response.status).toBe(200);return response.json();};
  let first:any;await vi.waitFor(async()=>{first=await read();expect(first.operation.status).toBe("failed");},{timeout:15000});
  const retry=(key:string,observedAttemptId?:string)=>app.request(`/v1/chat/operations/${id}/retry`,{method:"POST",headers:{...headers,"Idempotency-Key":key},body:JSON.stringify({authorizeNewAttempt:true,observedAttemptId})});
  expect((await retry("consent_missing_source")).status).toBe(409);
  expect((await retry("consent_client_b",first.operation.attempt_id)).status).toBe(202);
  let second:any;await vi.waitFor(async()=>{second=await read();expect(second.operation.attemptOrdinal).toBe(1);expect(second.operation.status).toBe("failed");},{timeout:15000});
  // A delayed unused key from client A must not authorize client B's successor.
  expect((await retry("consent_delayed_a",first.operation.attempt_id)).status).toBe(409);
  expect((await retry("consent_client_b",second.operation.attempt_id)).status).toBe(409);
  expect((await retry("consent_client_b",first.operation.attempt_id)).status).toBe(202);
  expect(childCalls).toBe(2);
  const host=await runtime.nativeChatRuntime();expect((await host.mastra.backgroundTaskManager!.listTasks({toolCallId:id})).total).toBe(2);
  expect((await retry("consent_fresh_source",second.operation.attempt_id)).status).toBe(202);
  await vi.waitFor(async()=>{const last=await read();expect(last.operation.attemptOrdinal).toBe(2);expect(last.operation.status).toBe("failed");},{timeout:15000});
  expect(childCalls).toBe(3);expect((await host.mastra.backgroundTaskManager!.listTasks({toolCallId:id})).total).toBe(3);
},40000);
it.runIf(enabled)("does not turn a refused oversized first delta into missing history on a later retry",async()=>{
  await restoreSession();let calls=0;
  state.chat.mockReset().mockImplementation(async(args)=>{
    if(args.query==="oversized parent")return {answer:"parent",citations:[]};
    calls++;await args.onTextDelta(calls===1?"x".repeat(262145):"bounded retry");return {answer:"bounded retry",citations:[]};
  });
  const app=requestApp();const headers={"content-type":"application/json","Idempotency-Key":"oversized_parent_fixture"};
  const root=(await (await app.request("/v1/chat/operations",{method:"POST",headers,body:JSON.stringify({q:"oversized parent",project})})).json()).operationId;
  const id=(await (await app.request(`/v1/chat/operations/${root}/tasks`,{method:"POST",headers:{...headers,"Idempotency-Key":"oversized_child_fixture"},body:JSON.stringify({q:"oversized child"})})).json()).operationId;
  const host=await runtime.nativeChatRuntime();
  await vi.waitFor(async()=>expect((await host.mastra.backgroundTaskManager!.listTasks({toolCallId:id})).tasks[0]?.status).toBe("failed"),{timeout:15000});
  const failed=await app.request(`/v1/chat/operations/${id}`);expect(failed.status).toBe(200);
  const failedState=await failed.json();expect(failedState.operation.snapshot.text).toBe("");
  expect((await app.request(`/v1/chat/operations/${id}/retry`,{method:"POST",headers:{...headers,"Idempotency-Key":"oversized_retry_fixture"},body:JSON.stringify({authorizeNewAttempt:true,observedAttemptId:failedState.operation.attempt_id})})).status).toBe(202);
  let current:any;await vi.waitFor(async()=>{current=await (await app.request(`/v1/chat/operations/${id}`)).json();expect(current.operation.status).toBe("completed");},{timeout:15000});
  expect(current.operation.snapshot).toMatchObject({answer:"bounded retry",priorAttempts:[{historyUnavailable:false,snapshot:{text:""}}]});
  expect(calls).toBe(2);
},30000);

it.runIf(enabled)("refuses retry admission after quota, deadline, cancellation or authorization loss without another execution",async()=>{
  await restoreSession();let childCalls=0;
  state.chat.mockReset().mockImplementation(async(args)=>{
    if(args.query==="retry guard parent")return {answer:"parent",citations:[]};
    childCalls++;throw new Error("synthetic_guard_failure");
  });
  const app=requestApp();const headers={"content-type":"application/json","Idempotency-Key":"retry_guard_parent"};
  const root=(await (await app.request("/v1/chat/operations",{method:"POST",headers,body:JSON.stringify({q:"retry guard parent",project})})).json()).operationId;
  const id=(await (await app.request(`/v1/chat/operations/${root}/tasks`,{method:"POST",headers:{...headers,"Idempotency-Key":"retry_guard_child"},body:JSON.stringify({q:"retry guard child"})})).json()).operationId;
  const host=await runtime.nativeChatRuntime();
  await vi.waitFor(async()=>expect((await host.mastra.backgroundTaskManager!.listTasks({toolCallId:id})).tasks[0]?.status).toBe("failed"),{timeout:15000});
  const observedAttemptId=`${(await host.mastra.backgroundTaskManager!.listTasks({toolCallId:id})).tasks[0]!.id}:0`;
  const [originalRoot]=await sql`select output_bytes,deadline from chat_operations where id=${root}`;
  const request=(target:Hono=app)=>target.request(`/v1/chat/operations/${id}/retry`,{method:"POST",headers:{...headers,"Idempotency-Key":"retry_guard_attempt"},body:JSON.stringify({authorizeNewAttempt:true,observedAttemptId})});
  const denied=async(status=409)=>{const response=await request();expect(response.status).toBe(status);if(status===403)expect(await response.json()).toEqual({error:"forbidden"});expect(childCalls).toBe(1);};
  await sql`update chat_operations set output_bytes=262144 where id=${id}`;await denied();
  await sql`update chat_operations set output_bytes=0 where id=${id}`;
  await sql`update chat_operations set output_bytes=524288 where id=${root}`;await denied();
  await sql`update chat_operations set output_bytes=${Number(originalRoot!.output_bytes)},deadline=clock_timestamp()-interval '1 second' where id=${root}`;await denied();
  await sql`update chat_operations set deadline=${originalRoot!.deadline},tree_cancel_requested=true where id=${root}`;await denied();
  await sql`update chat_operations set tree_cancel_requested=false where id=${root}`;
  await sql`update chat_operations set cancel_requested=true where id=${id}`;await denied();
  await sql`update chat_operations set cancel_requested=false where id=${id}`;
  await sql`update session set "expiresAt"=now()-interval '1 second' where id=${actor.sessionId}`;await denied(403);await restoreSession();
  await sql`update "user" set "twoFactorEnabled"=true where id=${actor.userId}`;await denied(403);
  await sql`update "user" set "twoFactorEnabled"=false where id=${actor.userId}`;
  await sql`delete from org_memberships where org_id='native-api-org' and user_id=${actor.userId}`;await denied(403);
  await sql`insert into org_memberships(org_id,user_id,role) values('native-api-org',${actor.userId},'owner')`;
  const asActor=(value:RequestActor)=>new Hono().use("*",async(c,next)=>{c.set("requestActor",value);await next();}).route("/v1/chat/operations",routes);
  expect((await request(asActor({type:"apiKey",userId:actor.userId,apiKey:{keyId:"retry-key",userId:actor.userId,orgId:"native-api-org",keyType:"server",allowedDomains:[],scopes:["ingest"],rateLimitRpm:null,rateLimitPpd:100,rateLimits:[],projectIds:[project]}}))).status).toBe(403);
  await sql`insert into "user"(id,name,email) values('retry-other-owner','Other','retry-other@example.test') on conflict do nothing`;
  await sql`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values('retry-other-session','retry-other-test-token','retry-other-owner',now()+interval '1 day',now(),now()) on conflict do nothing`;
  expect((await request(asActor({type:"session",userId:"retry-other-owner",sessionId:"retry-other-session",user:{id:"retry-other-owner",name:"Other",email:"retry-other@example.test"}}))).status).toBe(403);
  const intents:string[]=[];
  try {
    const {launchChatOperation}=await import("../services/chat-operations.js");
    for(let n=0;n<8;n++)intents.push((await launchChatOperation({userId:actor.userId,projectId:project,orgId:"native-api-org",key:`retry_capacity_${n}`,input:{q:"unaccepted capacity fixture"},runtime:"mastra"})).id);
    await denied();
  }finally{if(intents.length)await sql`update chat_operations set cancel_requested=true,tree_cancel_requested=true,deadline=clock_timestamp()-interval '1 second' where id=any(${intents})`;}
  expect(childCalls).toBe(1);expect((await host.mastra.backgroundTaskManager!.listTasks({toolCallId:id})).total).toBe(1);
},40000);

it.runIf(enabled)("serializes retry acceptance with root cancellation and never accepts a later new attempt",async()=>{
  await restoreSession();let calls=0;
  state.chat.mockReset().mockImplementation(async(args)=>{
    if(args.query==="retry race parent")return {answer:"parent",citations:[]};
    calls++;if(calls===1)throw new Error("synthetic_retry_race_failure");
    await new Promise<void>((_resolve,reject)=>{
      if(args.signal.aborted)reject(args.signal.reason);
      else args.signal.addEventListener("abort",()=>reject(args.signal.reason),{once:true});
    });
  });
  const app=requestApp();const headers={"content-type":"application/json","Idempotency-Key":"retry_race_parent"};
  const root=(await (await app.request("/v1/chat/operations",{method:"POST",headers,body:JSON.stringify({q:"retry race parent",project})})).json()).operationId;
  const id=(await (await app.request(`/v1/chat/operations/${root}/tasks`,{method:"POST",headers:{...headers,"Idempotency-Key":"retry_race_child"},body:JSON.stringify({q:"retry race child"})})).json()).operationId;
  const host=await runtime.nativeChatRuntime();const manager=host.mastra.backgroundTaskManager!;
  await vi.waitFor(async()=>expect((await manager.listTasks({toolCallId:id})).tasks[0]?.status).toBe("failed"),{timeout:15000});
  const observedAttemptId=`${(await manager.listTasks({toolCallId:id})).tasks[0]!.id}:0`;
  const enqueue=manager.enqueue.bind(manager);let entered=false;let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const spy=vi.spyOn(manager,"enqueue").mockImplementation(async(...args)=>{if(args[0].toolCallId===id){entered=true;await gate;}return enqueue(...args);});
  const retry=(key="retry_race_attempt")=>app.request(`/v1/chat/operations/${id}/retry`,{method:"POST",headers:{...headers,"Idempotency-Key":key},body:JSON.stringify({authorizeNewAttempt:true,observedAttemptId})});
  try {
    const accepting=retry();await vi.waitFor(()=>expect(entered).toBe(true),{timeout:10000});
    const cancelling=app.request(`/v1/chat/operations/${root}/cancel`,{method:"POST",headers:{"content-type":"application/json"},body:'{"scope":"tree"}'});
    release();expect((await accepting).status).toBe(202);expect((await cancelling).status).toBe(200);
    await vi.waitFor(async()=>{
      const value=await (await app.request(`/v1/chat/operations/${id}`)).json();
      // The native executor may refuse on durable intent before native cancel
      // reaches it. Preserve its outcome while exposing the recorded intent.
      expect(["cancelled","failed"]).toContain(value.operation.status);
      expect(value.operation).toMatchObject({cancel_requested:true,tree_cancel_requested:true,canRetry:false});
    },{timeout:10000});
    expect((await retry()).status).toBe(202); // Recover the accepted key, without reexecution.
    expect((await retry("retry_after_cancel")).status).toBe(409);
    expect((await manager.listTasks({toolCallId:id})).total).toBe(2);expect(calls).toBeLessThanOrEqual(2);
  }finally{release();spy.mockRestore();}
},30000);

it.runIf(enabled)("reconciles a full logical tree with retained retry attempts without exceeding the watcher bound",async()=>{
  await restoreSession();state.chat.mockReset().mockResolvedValue({answer:"bounded root",citations:[]});
  const app=requestApp();
  const root=(await (await app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"retained_attempt_tree"},body:JSON.stringify({q:"root",project})})).json()).operationId;
  await vi.waitFor(async()=>expect((await (await app.request(`/v1/chat/operations/${root}`)).json()).operation.status).toBe("completed"),{timeout:15000});
  const {launchChatOperation}=await import("../services/chat-operations.js");
  const host=await runtime.nativeChatRuntime();const storage=await host.mastra.backgroundTaskManager!.getStorage();
  for(let n=0;n<63;n++) {
    const child=await launchChatOperation({userId:actor.userId,projectId:project,orgId:"native-api-org",key:`retained_tree_child_${n}`,input:{q:"fixture"},parentId:root,runtime:"mastra"});
    let prior:string|undefined;
    for(let ordinal=0;ordinal<3;ordinal++) {
      const id=randomUUID();
      await storage.createTask({id,status:ordinal===2?"completed":"failed",agentId:"docslurp-project-chat",runId:root,toolCallId:child.id,threadId:child.id,
        toolName:"docslurpProjectChat",resourceId:JSON.stringify(["native-api-org",actor.userId]),args:{operationId:child.id},
        createdAt:new Date(),retryCount:0,maxRetries:0,timeoutMs:10000,metadata:{attemptOrdinal:ordinal,outputExpected:false,...(prior?{retryOf:prior,retryKey:`fixture_${ordinal}`}:{})},result:{result:{answer:""},watermark:0}});
      prior=id;
    }
  }
  const {operationHub}=await import("../realtime/operation-hub.js");
  const refresh=vi.fn(async()=>false);const failed=vi.fn(async()=>{});
  const release=operationHub.watch({rootId:root,userId:actor.userId,refresh,failed});
  try {await operationHub.tick();expect(refresh).toHaveBeenCalledTimes(1);expect(failed).not.toHaveBeenCalled();}
  finally{release();}
  const recovered=await app.request(`/v1/chat/operations/${root}`);expect(recovered.status).toBe(200);
  const value=await recovered.json();expect(value.tasks).toHaveLength(64);expect(value.treeSettled).toBe(true);
  expect(state.chat).toHaveBeenCalledTimes(1);
},30000);

it.runIf(enabled)("keeps quota charged when retained output succeeds but its publish acknowledgement fails",async()=>{
  await restoreSession();
  const text="accepted despite lost acknowledgement";
  let entered=false;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  state.chat.mockReset().mockImplementation(async(args)=>{await args.onTextDelta(text);return {answer:text,citations:[]};});
  const publish=StrictCachingPubSub.prototype.publish;
  const spy=vi.spyOn(StrictCachingPubSub.prototype,"publish").mockImplementation(async function(this:StrictCachingPubSub,topic,event,options){
    if(topic.startsWith(operationOutputTopic(""))&&JSON.stringify(event.data).includes(text)) {
      entered=true;await gate;await publish.call(this,topic,event,options);throw new Error("synthetic_lost_output_ack");
    }
    return publish.call(this,topic,event,options);
  });
  try {
    const app=requestApp();
    const response=await app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"output_ack_quota_fixture"},body:JSON.stringify({q:"output acknowledgement",project})});
    expect(response.status).toBe(202);const id=(await response.json()).operationId;
    await vi.waitFor(()=>expect(entered).toBe(true),{timeout:15000});
    // A persisted intent marker is not proof that a still-running append finished.
    const pending=await app.request(`/v1/chat/operations/${id}`);expect(pending.status).toBe(200);
    expect((await pending.json()).operation.snapshot.text).toBe("");
    release();let recovered:any;
    await vi.waitFor(async()=>{recovered=await (await app.request(`/v1/chat/operations/${id}`)).json();expect(recovered.operation.status).toBe("failed");},{timeout:15000});
    expect(recovered.operation.snapshot.text).toBe(text);
    const [row]=await sql`select output_bytes from chat_operations where id=${id}`;
    expect(Number(row!.output_bytes)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify({text})));
    expect(state.chat).toHaveBeenCalledTimes(1);
  }finally{release();spy.mockRestore();}
},30000);

it.runIf(enabled)("launches parallel and nested native children after the parent answer, recovering their true tree from another host", async () => {
  await restoreSession();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const started=new Set<string>();
  state.chat.mockReset().mockImplementation(async args=>{
    started.add(args.query);
    await args.onTextDelta(`${args.query} partial`);
    if(args.query!=="tree root") await gate;
    args.signal.throwIfAborted();
    return {answer:`${args.query} result`,citations:[]};
  });
  const app=requestApp();
  const post=(path:string,key:string,q:string)=>app.request(path,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":key},body:JSON.stringify({q,...(path==="/v1/chat/operations"?{project}:{})})});
  const rootResponse=await post("/v1/chat/operations","native_child_root","tree root");
  expect(rootResponse.status).toBe(202);
  const root=(await rootResponse.json()).operationId;
  let second:Awaited<ReturnType<typeof import("./native-host.js").createNativeChatHost>>|undefined;
  const secondPool=new Pool({connectionString:url,max:3});
  try {
    await vi.waitFor(async()=>expect((await (await app.request(`/v1/chat/operations/${root}`)).json()).operation.status).toBe("completed"),{timeout:10000});
    const responses=await Promise.all([post(`/v1/chat/operations/${root}/tasks`,"native_child_a","tree child a"),post(`/v1/chat/operations/${root}/tasks`,"native_child_b","tree child b")]);
    expect(responses.map(r=>r.status)).toEqual([202,202]);
    const [a,b]=await Promise.all(responses.map(async r=>(await r.json()).operationId));
    const repeated=await post(`/v1/chat/operations/${root}/tasks`,"native_child_a","tree child a");
    expect(repeated.status).toBe(202);expect((await repeated.json()).operationId).toBe(a);
    const nested=await post(`/v1/chat/operations/${a}/tasks`,"native_grandchild","tree grandchild");
    expect(nested.status).toBe(202);const grandchild=(await nested.json()).operationId;
    await vi.waitFor(()=>expect(started.size).toBe(4),{timeout:10000});
    const {createNativeChatHost}=await import("./native-host.js");
    const {NativeOperations}=await import("./native-operations.js");
    const {createNativeOperationPolicy}=await import("./operation-policy.js");
    second=await createNativeChatHost({pool:secondPool,redisUrl:redis!,namespace:process.env.MASTRA_NAMESPACE,worker:false});
    const recovered=new NativeOperations(second.mastra.backgroundTaskManager!,second.pubsub,createNativeOperationPolicy(async()=>actor));
    const tree=await recovered.read(root,0);
    expect(tree.operation.status).toBe("completed");expect(tree.treeSettled).toBe(false);
    expect(tree.tasks).toHaveLength(4);
    expect(tree.tasks.find(t=>t.id===root)?.parent_id).toBeNull();
    expect(tree.tasks.find(t=>t.id===a)?.parent_id).toBe(root);
    expect(tree.tasks.find(t=>t.id===b)?.parent_id).toBe(root);
    expect(tree.tasks.find(t=>t.id===grandchild)?.parent_id).toBe(a);
    expect((await recovered.read(grandchild,0)).operation.parent_id).toBe(a);
    release();
    await vi.waitFor(async()=>expect((await recovered.read(root,0)).treeSettled).toBe(true),{timeout:10000});
    for(const id of [a,b,grandchild])expect((await recovered.read(id,0)).operation.status).toBe("completed");
    for(const q of started)expect(state.chat.mock.calls.filter(([args])=>args.query===q)).toHaveLength(1);
  } finally {release();await second?.close();await secondPool.end();}
},40000);

it.runIf(enabled)("rejects child scope selectors, foreign/API-key/revoked actors, oversized input and cancelled or expired roots", async () => {
  await restoreSession();
  state.chat.mockReset().mockImplementation(async()=>({answer:"guard root",citations:[]}));
  const app=requestApp();
  const rootResponse=await app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"native_child_guards"},body:JSON.stringify({q:"guards",project})});
  expect(rootResponse.status).toBe(202);const root=(await rootResponse.json()).operationId;
  await vi.waitFor(async()=>expect((await (await app.request(`/v1/chat/operations/${root}`)).json()).operation.status).toBe("completed"),{timeout:10000});
  const headers={"content-type":"application/json","Idempotency-Key":"native_rejected_child"};
  expect((await app.request(`/v1/chat/operations/${root}/tasks`,{method:"POST",headers,body:JSON.stringify({q:"child",project})})).status).toBe(400);
  expect((await app.request(`/v1/chat/operations/${root}/tasks`,{method:"POST",headers,body:JSON.stringify({q:"x".repeat(128001)})})).status).toBe(413);
  const asActor=(value:RequestActor)=>new Hono().use("*",async(c,next)=>{c.set("requestActor",value);await next();}).route("/v1/chat/operations",routes);
  const retryAs=(target:Hono)=>target.request(`/v1/chat/operations/${root}/retry`,{method:"POST",headers,body:'{"authorizeNewAttempt":true,"observedAttemptId":"root-not-retryable:0"}'});
  const launchAs=(target:Hono)=>target.request(`/v1/chat/operations/${root}/tasks`,{method:"POST",headers,body:'{"q":"child"}'});
  expect((await launchAs(asActor({type:"apiKey",userId:actor.userId,apiKey:{keyId:"native-child-test-key",userId:actor.userId,orgId:"native-api-org",keyType:"server",allowedDomains:[],scopes:["ingest"],rateLimitRpm:null,rateLimitPpd:100,rateLimits:[],projectIds:[project]}}))).status).toBe(403);
  await sql`insert into "user"(id,name,email) values('native-child-foreign','Foreign','foreign-child@example.test') on conflict do nothing`;
  await sql`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values('native-child-foreign-session','native-child-foreign-test-token','native-child-foreign',now()+interval '1 day',now(),now()) on conflict do nothing`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values('native-child-foreign-org','Foreign','native-child-foreign','native-child-foreign') on conflict do nothing`;
  await sql`insert into org_memberships(org_id,user_id,role) values('native-child-foreign-org','native-child-foreign','owner') on conflict do nothing`;
  const foreign={type:"session" as const,userId:"native-child-foreign",sessionId:"native-child-foreign-session",user:{id:"native-child-foreign",name:"Foreign",email:"foreign-child@example.test"}};
  expect(await (await import("../realtime/session.js")).revalidateRealtimeSession(foreign,AbortSignal.timeout(5000))).toEqual(foreign);
  expect((await launchAs(asActor(foreign))).status).toBe(403);
  expect((await retryAs(asActor(foreign))).status).toBe(403);
  await sql`delete from org_memberships where org_id='native-api-org' and user_id=${actor.userId}`;
  expect((await launchAs(app)).status).toBe(403);
  expect((await retryAs(app)).status).toBe(403);
  await sql`insert into org_memberships(org_id,user_id,role) values('native-api-org',${actor.userId},'owner')`;
  await sql`update "user" set "twoFactorEnabled"=true where id=${actor.userId}`;
  expect((await launchAs(app)).status).toBe(403);
  expect((await retryAs(app)).status).toBe(403);
  await sql`update "user" set "twoFactorEnabled"=false where id=${actor.userId}`;
  await sql`update session set "expiresAt"=now()-interval '1 second' where id=${actor.sessionId}`;
  expect((await launchAs(app)).status).toBe(403);
  expect((await retryAs(app)).status).toBe(403);
  await restoreSession();
  await sql`update chat_operations set deadline=clock_timestamp()-interval '1 second' where id=${root}`;
  expect((await launchAs(app)).status).toBe(409);
  expect((await retryAs(app)).status).toBe(409);
  await sql`update chat_operations set deadline=clock_timestamp()+interval '1 minute',tree_cancel_requested=true where id=${root}`;
  expect((await launchAs(app)).status).toBe(409);
  expect((await retryAs(app)).status).toBe(409);
  expect(state.chat.mock.calls.filter(([args])=>args.query==="child")).toHaveLength(0);
  expect((await sql`select count(*)::int as count from chat_operations where parent_id=${root}`)[0].count).toBe(0);
},25000);

it.runIf(enabled)("cancels one child independently and fences a child-launch race with root cancellation", async () => {
  await restoreSession();
  const aborted=new Set<string>();
  state.chat.mockReset().mockImplementation(async args=>{
    if(args.query==="cancel tree root")return {answer:"root",citations:[]};
    await args.onTextDelta("child running");
    await new Promise<void>((_resolve,reject)=>{
      const stop=()=>{aborted.add(args.query);reject(new Error("cancelled"));};
      if(args.signal.aborted)stop();else args.signal.addEventListener("abort",stop,{once:true});
    });
    return {answer:"unreachable"};
  });
  const app=requestApp();
  const post=(path:string,key:string,q:string)=>app.request(path,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":key},body:JSON.stringify({q,...(path==="/v1/chat/operations"?{project}:{})})});
  const rootResponse=await post("/v1/chat/operations","native_cancel_tree_root","cancel tree root");
  expect(rootResponse.status).toBe(202);const root=(await rootResponse.json()).operationId;
  const cancel=(id:string,scope:string)=>app.request(`/v1/chat/operations/${id}/cancel`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scope})});
  try {
    const children=await Promise.all([post(`/v1/chat/operations/${root}/tasks`,"native_cancel_child_a","cancel child a"),post(`/v1/chat/operations/${root}/tasks`,"native_cancel_child_b","cancel child b")]);
    expect(children.map(r=>r.status)).toEqual([202,202]);
    const [a,b]=await Promise.all(children.map(async r=>(await r.json()).operationId));
    // Both children must be running before one is cancelled; launches start in either order.
    for(const child of [a,b])await vi.waitFor(async()=>expect((await (await app.request(`/v1/chat/operations/${child}`)).json()).operation.snapshot.text).toBe("child running"),{timeout:10000});
    expect((await cancel(a,"task")).status).toBe(200);
    await vi.waitFor(()=>expect(aborted.has("cancel child a")).toBe(true),{timeout:5000});
    expect(aborted.has("cancel child b")).toBe(false);
    const [cancelled,racing]=await Promise.all([cancel(root,"tree"),post(`/v1/chat/operations/${b}/tasks`,"native_cancel_racing_child","cancel racing child")]);
    expect(cancelled.status).toBe(200);expect([202,409]).toContain(racing.status);
    await vi.waitFor(()=>expect(aborted.has("cancel child b")).toBe(true),{timeout:5000});
    if(racing.status===202){
      const id=(await racing.json()).operationId;
      await vi.waitFor(async()=>expect(["cancelled","failed"]).toContain((await (await app.request(`/v1/chat/operations/${id}`)).json()).operation.status),{timeout:10000});
    }
    expect((await post(`/v1/chat/operations/${root}/tasks`,"native_cancel_after_commit","cancel late child")).status).toBe(409);
  } finally {await cancel(root,"tree");}
},30000);

it.runIf(enabled)("applies the shared output quota across concurrent native children", async () => {
  await restoreSession();
  const text="x".repeat(190000);
  state.chat.mockReset().mockImplementation(async args=>{
    if(args.query==="quota root")return {answer:"root",citations:[]};
    await args.onTextDelta(text);
    return {answer:text,citations:[]};
  });
  const app=requestApp();
  const post=(path:string,key:string,q:string)=>app.request(path,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":key},body:JSON.stringify({q,...(path==="/v1/chat/operations"?{project}:{})})});
  const rootResponse=await post("/v1/chat/operations","native_child_quota_root","quota root");
  expect(rootResponse.status).toBe(202);const root=(await rootResponse.json()).operationId;
  const responses=await Promise.all([0,1,2].map(i=>post(`/v1/chat/operations/${root}/tasks`,`native_child_quota_${i}`,`quota child ${i}`)));
  expect(responses.map(r=>r.status)).toEqual([202,202,202]);
  const ids=await Promise.all(responses.map(async r=>(await r.json()).operationId));
  await vi.waitFor(async()=>{
    const result=await (await app.request(`/v1/chat/operations/${root}`)).json();
    expect(result.tasks).toHaveLength(4);expect(result.treeSettled).toBe(true);
    expect(result.tasks.filter((task:{id:string})=>ids.includes(task.id)).map((task:{status:string})=>task.status).sort()).toEqual(["completed","completed","failed"]);
  },{timeout:10000});
  const [usage]=await sql`select sum(output_bytes)::int as bytes from chat_operations where root_id=${root}`;
  expect(usage.bytes).toBeGreaterThan(380000);expect(usage.bytes).toBeLessThanOrEqual(524288);
},20000);

it.runIf(enabled)("keeps an unaccepted child visible without executing it until the launch key is replayed", async () => {
  await restoreSession();
  state.chat.mockReset().mockImplementation(async args=>({answer:args.query,citations:[]}));
  const app=requestApp();
  const rootResponse=await app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"native_intent_root"},body:JSON.stringify({q:"intent root",project})});
  expect(rootResponse.status).toBe(202);const root=(await rootResponse.json()).operationId;
  await vi.waitFor(async()=>expect((await (await app.request(`/v1/chat/operations/${root}`)).json()).operation.status).toBe("completed"),{timeout:10000});
  // Reproduce a launcher dying after intent commits and before native enqueue.
  const {launchChatOperation}=await import("../services/chat-operations.js");
  const intent=await launchChatOperation({userId:actor.userId,projectId:project,orgId:"native-api-org",key:"native_unaccepted_child",input:{q:"intent child",authSessionId:actor.sessionId},parentId:root,runtime:"mastra"});
  const tree=await (await app.request(`/v1/chat/operations/${root}`)).json();
  expect(tree.treeSettled).toBe(false);
  expect(tree.tasks.find((task:{id:string})=>task.id===intent.id)).toMatchObject({parent_id:root,status:"waiting",nativeTaskId:null,attempt_id:null});
  expect((await (await app.request(`/v1/chat/operations/${intent.id}`)).json()).operation.status).toBe("waiting");
  expect((await app.request(`/v1/chat/operations/${intent.id}?after=invalid`)).status).toBe(409);
  const host=await runtime.nativeChatRuntime();
  expect((await host.mastra.backgroundTaskManager!.listTasks({toolCallId:intent.id})).total).toBe(0);
  const expired=await launchChatOperation({userId:actor.userId,projectId:project,orgId:"native-api-org",key:"native_expired_intent",input:{q:"expired intent",authSessionId:actor.sessionId},parentId:root,runtime:"mastra"});
  await sql`update chat_operations set deadline=clock_timestamp()-interval '1 second' where id=${expired.id}`;
  expect((await (await app.request(`/v1/chat/operations/${expired.id}`)).json()).operation).toMatchObject({status:"interrupted",nativeTaskId:null});
  expect((await host.mastra.backgroundTaskManager!.listTasks({toolCallId:expired.id})).total).toBe(0);
  const retry=()=>app.request(`/v1/chat/operations/${root}/tasks`,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"native_unaccepted_child"},body:'{"q":"intent child"}'});
  const replies=await Promise.all([retry(),retry()]);
  expect(replies.map(r=>r.status)).toEqual([202,202]);
  for(const reply of replies)expect((await reply.json()).operationId).toBe(intent.id);
  await vi.waitFor(async()=>expect((await (await app.request(`/v1/chat/operations/${root}`)).json()).treeSettled).toBe(true),{timeout:10000});
  expect(state.chat.mock.calls.filter(([args])=>args.query==="intent child")).toHaveLength(1);
},20000);

it.runIf(enabled)("bounds native launch intents at 64 references and settles unaccepted children on tree cancellation", async () => {
  await restoreSession();
  state.chat.mockReset().mockImplementation(async()=>({answer:"fanout root",citations:[]}));
  const app=requestApp();
  const rootResponse=await app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"native_fanout_root"},body:JSON.stringify({q:"fanout root",project})});
  expect(rootResponse.status).toBe(202);const root=(await rootResponse.json()).operationId;
  await vi.waitFor(async()=>expect((await (await app.request(`/v1/chat/operations/${root}`)).json()).operation.status).toBe("completed"),{timeout:10000});
  const {launchChatOperation}=await import("../services/chat-operations.js");
  for(let i=0;i<63;i++)await launchChatOperation({userId:actor.userId,projectId:project,orgId:"native-api-org",key:`native_fanout_child_${i}`,input:{q:"unaccepted child",authSessionId:actor.sessionId},parentId:root,runtime:"mastra"});
  const tree=await (await app.request(`/v1/chat/operations/${root}`)).json();
  expect(tree.tasks).toHaveLength(64);expect(tree.treeSettled).toBe(false);
  expect((await app.request(`/v1/chat/operations/${root}/tasks`,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"native_fanout_overflow"},body:'{"q":"overflow"}'})).status).toBe(409);
  expect((await sql`select count(*)::int as count from chat_operations where root_id=${root}`)[0].count).toBe(64);
  expect((await app.request(`/v1/chat/operations/${root}/cancel`,{method:"POST",headers:{"content-type":"application/json"},body:'{"scope":"tree"}'})).status).toBe(200);
  expect((await (await app.request(`/v1/chat/operations/${root}`)).json()).treeSettled).toBe(true);
  expect(state.chat.mock.calls.filter(([args])=>args.query==="unaccepted child")).toHaveLength(0);
},25000);

it.runIf(enabled)("permits explicit new child work after native parent failure without retrying the parent", async () => {
  await restoreSession();
  state.chat.mockReset().mockImplementation(async args=>{
    if(args.query==="failed native parent")throw new Error("executor_interrupted");
    return {answer:"explicit new child",citations:[]};
  });
  const app=requestApp();
  const rootResponse=await app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"native_failed_parent"},body:JSON.stringify({q:"failed native parent",project})});
  expect(rootResponse.status).toBe(202);const root=(await rootResponse.json()).operationId;
  await vi.waitFor(async()=>expect(["failed","interrupted"]).toContain((await (await app.request(`/v1/chat/operations/${root}`)).json()).operation.status),{timeout:10000});
  const child=await app.request(`/v1/chat/operations/${root}/tasks`,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"native_after_failure_child"},body:'{"q":"new explicit child"}'});
  expect(child.status).toBe(202);const id=(await child.json()).operationId;
  await vi.waitFor(async()=>expect((await (await app.request(`/v1/chat/operations/${id}`)).json()).operation.status).toBe("completed"),{timeout:10000});
  expect(state.chat.mock.calls.filter(([args])=>args.query==="failed native parent")).toHaveLength(1);
  expect(state.chat.mock.calls.filter(([args])=>args.query==="new explicit child")).toHaveLength(1);
},20000);

it.runIf(enabled)("keeps shared materialization visible after the native parent answer completes and tree cancellation",async()=>{
  await sql`insert into documents(id,user_id,org_id,project_id,filename,mime_type,source_key,status)
    values('native-linked-document','native-api-owner','native-api-org',${project},'fixture.txt','text/plain','synthetic','completed')
    on conflict do nothing`;
  const {defaultMaterializeDeps}=await import("../search/deferred/materialize-client.js");
  let runId="";
  state.chat.mockImplementation(async(args)=>{
    runId=await defaultMaterializeDeps.createRun({userId:actor.userId,orgId:"native-api-org",
      projectId:project,documentId:"native-linked-document",documents:1,pages:1,pageNumbers:[1]});
    await args.onTextDelta("parent answer");
    return {answer:"parent answer",citations:[]};
  });
  const app=new Hono().use("*",async(c,next)=>{c.set("requestActor",actor);await next();}).route("/v1/chat/operations",routes);
  const response=await app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"native_link_task"},
    body:JSON.stringify({q:"linked fixture",project})});
  expect(response.status).toBe(202);const {operationId}=await response.json();
  let recovered:any;
  await vi.waitFor(async()=>{
    recovered=await (await app.request(`/v1/chat/operations/${operationId}`)).json();
    expect(recovered.operation.status).toBe("completed");
  },{timeout:10000});
  expect(recovered.operation).toMatchObject({id:operationId,root_id:operationId,project_id:project});
  expect(recovered.treeSettled).toBe(false);
  expect(recovered.dependencies[0]).toMatchObject({run_id:runId,parent_id:operationId,status:"waiting",ownership:"shared",cancellation:"observe_only"});
  expect(recovered.dependencies[0].attempt_id).toBeTruthy();
  const cancel=()=>app.request(`/v1/chat/operations/${operationId}/cancel`,{method:"POST",headers:{"content-type":"application/json"},body:'{"scope":"tree"}'});
  expect((await cancel()).status).toBe(200);expect((await cancel()).status).toBe(200);
  expect((await sql`select status from project_runs where id=${runId}`)[0]!.status).toBe("processing");
  await sql`insert into document_page_states(document_id,page_number,state) values('native-linked-document',1,'indexed') on conflict(document_id,page_number) do update set state='indexed'`;
  recovered=await (await app.request(`/v1/chat/operations/${operationId}`)).json();
  expect(recovered.treeSettled).toBe(true);expect(recovered.dependencies[0]).toMatchObject({status:"completed",result_ref:{documentId:"native-linked-document",pages:[1]}});
},20000);
it.runIf(enabled).each(["valid", "expired", "cancelled"])("recovers %s pending dispatch on an already-running worker without another POST or restart",async(condition)=>{
  state.chat.mockReset().mockImplementation(async(args)=>{await args.onTextDelta("recovered dispatch");return {answer:"recovered dispatch",citations:[]};});
  const host=await runtime.nativeChatRuntime();
  const publish=host.pubsub.publish.bind(host.pubsub);
  let lost=false;
  const spy=vi.spyOn(host.pubsub,"publish").mockImplementation(async(topic,event,options)=>{
    if(topic==="background-tasks"&&event.type==="task.dispatch"&&!lost){lost=true;return;}
    return publish(topic,event,options);
  });
  const app=new Hono().use("*",async(c,next)=>{c.set("requestActor",actor);await next();}).route("/v1/chat/operations",routes);
  const post=()=>app.request("/v1/chat/operations",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":`native_lost_dispatch_${condition}`},
    body:JSON.stringify({q:"dispatch fixture",project})});
  try {
    const first=await post();expect(first.status).toBe(202);
    const {operationId}=await first.json();
    expect(lost).toBe(true);expect(state.chat).not.toHaveBeenCalled();
    if(condition==="expired")await sql`update chat_operations set deadline=clock_timestamp()-interval '1 second' where id=${operationId}`;
    if(condition==="cancelled")await sql`update chat_operations set tree_cancel_requested=true where id=${operationId}`;
    spy.mockRestore();
    // No initiation retry: recurring native recovery must discover this row.
    await vi.waitFor(async()=>expect((await (await app.request(`/v1/chat/operations/${operationId}`)).json()).operation.status).toBe(condition==="valid"?"completed":"failed"),{timeout:10000});
    expect(state.chat).toHaveBeenCalledTimes(condition==="valid"?1:0);
    expect((await host.mastra.backgroundTaskManager!.listTasks({toolCallId:operationId})).total).toBe(1);
  } finally {spy.mockRestore();}
},20000);
