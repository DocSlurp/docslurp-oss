import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {WebSocket} from "ws";
import {Pool} from "pg";
import {pathToFileURL} from "node:url";
import { randomUUID, createHmac } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll,beforeAll,expect,it,vi } from "vitest";
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
    expect((await app.request(`/v1/chat/operations/${operationId}`)).status).toBe(409);actor=original;
    await sql`delete from session where id=${actor.sessionId}`;
    expect((await app.request(`/v1/chat/operations/${operationId}`)).status).toBe(409);
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
