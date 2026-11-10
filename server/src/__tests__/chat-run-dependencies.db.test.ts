import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
let sql: postgres.Sql;
let stop: () => Promise<void>;
let ops: typeof import("../services/chat-operations.js");
let links: typeof import("../services/chat-run-dependencies.js");
let deps: typeof import("../search/deferred/materialize-client.js").defaultMaterializeDeps;
let snapshots: typeof import("../services/chat-operation-access.js");
let allowed = true;
beforeAll(async () => {
  const external=process.env.CHAT_OPERATION_TEST_DATABASE_URL;
  if(external && new URL(external).hostname!=="127.0.0.1")throw new Error("Requires isolated loopback database");
  const pg=external ? {url:external,stop:async()=>{}} : await startMigratedPostgres(); stop=pg.stop;
  sql=postgres(pg.url,{max:external?5:1,prepare:false,onnotice:()=>{}});
  vi.doMock("../db.js",()=>({sql}));
  vi.doMock("../lib/temporal.js",()=>({startMaterializeWorkflow:vi.fn()}));
  vi.doMock("../lib/request-actor.js",()=>({loadActorScopedProject:async (id:string)=>allowed && id==="w"?{id,orgId:"o"}:null}));
  ops=await import("../services/chat-operations.js"); links=await import("../services/chat-run-dependencies.js");
  snapshots=await import("../services/chat-operation-access.js");
  ({defaultMaterializeDeps:deps}=await import("../search/deferred/materialize-client.js"));
  await sql`insert into "user"(id,name,email) values('u','U','u@example.test')`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values('o','O','o','u')`;
  await sql`insert into projects(id,org_id,user_id,name) values('w','o','u','W')`;
  await sql`insert into documents(id,org_id,user_id,project_id,filename,mime_type,source_key,status)
    values('d','o','u','w','d.pdf','application/pdf','private','completed')`;
},120000);
beforeEach(async()=>{allowed=true;
  await sql`delete from session`;
  await sql`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values('session','token','u',now()+interval '1 hour',now(),now())`;
  await sql`insert into org_memberships(org_id,user_id,role) values('o','u','owner') on conflict do nothing`;
await sql`delete from chat_operations`;await sql`delete from project_runs`;await sql`delete from document_page_states`;});
afterAll(async()=>{await sql?.end();await stop?.();});
const actor = {type:"session" as const,userId:"u",sessionId:"session",user:{id:"u",email:"u@example.test",name:"U"}};
async function task(){await ops.launchChatOperation({userId:"u",orgId:"o",projectId:"w",key:"dependency_test",input:{q:"question",authSessionId:"session"}});return {...(await ops.claimChatOperation())!,signal:new AbortController().signal};}
const allocate=()=>deps.createRun({userId:"u",orgId:"o",projectId:"w",documentId:"d",documents:1,pages:1,pageNumbers:[1]});
it("recovers shared work after parent completion and cancellation, then observes durable page results",async()=>{
  const t=await task();const run=await links.withChatRunOwner(t,allocate);
  await ops.appendChatOperation(t.id,t.attempt_id!,"result",{answer:"parent available"},"completed");
  let snapshot=await snapshots.authorizedChatOperationSnapshot(actor,t.id,0);
  expect(snapshot.treeSettled).toBe(false);
  expect(snapshot.dependencies[0]).toMatchObject({run_id:run,parent_id:t.id,status:"waiting",ownership:"shared",cancellation:"observe_only",document_id:"d",pages:[1]});
  expect(snapshot.dependencies[0]!.attempt_id).toBeTruthy();
  await ops.cancelChatOperation("u",t.id,"tree");
  expect((await sql`select status from project_runs where id=${run}`)[0]!.status).toBe("processing");
  const [before]=await sql`select revision from realtime_revisions where org_id='o'`;
  await sql`insert into document_page_states(document_id,page_number,state) values('d',1,'indexed')`;
  expect(Number((await sql`select revision from realtime_revisions where org_id='o'`)[0]!.revision)).toBeGreaterThan(Number(before!.revision));
  snapshot=await snapshots.authorizedChatOperationSnapshot(actor,t.id,0);
  expect(snapshot.treeSettled).toBe(true);expect(snapshot.dependencies[0]!.status).toBe("completed");
  allowed=false;await expect(snapshots.authorizedChatOperationSnapshot(actor,t.id,0)).rejects.toThrow(/forbidden/);
  expect(await links.readChatRunDependencies(t.id,"foreign")).toEqual([]);
});
it("refuses cancelled, foreign, expired and over-quota acceptance before allocating a run",async()=>{
  const t=await task();
  await expect(links.withChatRunOwner({...t,org_id:"foreign"},allocate)).rejects.toThrow(/forbidden/);
  await sql`update chat_operations set deadline=now()-interval '1 second' where id=${t.id}`;
  await expect(links.withChatRunOwner(t,allocate)).rejects.toThrow(/cancelled/);
  await sql`update chat_operations set deadline=now()+interval '1 minute' where id=${t.id}`;
  await ops.cancelChatOperation("u",t.id,"tree");
  await expect(links.withChatRunOwner(t,allocate)).rejects.toThrow(/cancelled/);
  expect((await sql`select count(*)::int n from project_runs`)[0]!.n).toBe(0);
});
it("bounds combined children and dependencies before allocating",async()=>{
  const t=await task();const run=await links.withChatRunOwner(t,allocate);
  for(let n=0;n<62;n++) await ops.launchChatOperation({userId:"u",orgId:"o",projectId:"w",key:'child_'+String(n).padStart(4,'0'),input:{},parentId:t.id});
  await expect(links.withChatRunOwner(t,allocate)).rejects.toThrow(/limit/);
  expect((await sql`select count(*)::int n from project_runs`)[0]!.n).toBe(1);
});
it("does not report a deduplicated placeholder as completed work and expires unresolved dependencies honestly",async()=>{
  const t=await task();const run=await links.withChatRunOwner(t,allocate);
  await deps.closeDedupedRun(run);
  let [d]=await links.readChatRunDependencies(t.id,"u");expect(d!.status).toBe("waiting");expect(d!.attempt_id).toBeNull();
  await sql`update chat_run_dependencies set created_at=now()-interval '16 minutes'`;
  [d]=await links.readChatRunDependencies(t.id,"u");expect(d!.status).toBe("interrupted");
});

it("counts completed answers with outstanding shared work against active root admission",async()=>{
  for(let n=0;n<8;n++) {
    const t=await ops.launchChatOperation({userId:"u",orgId:"o",projectId:"w",key:'active_'+String(n).padStart(4,'0'),input:{}});
    const claim=(await ops.claimChatOperation())!;
    await links.withChatRunOwner({...claim,input:{...claim.input,authSessionId:"session"},signal:new AbortController().signal},allocate);
    await ops.appendChatOperation(t.id,claim.attempt_id!,"result",{answer:"available"},"completed");
  }
  await expect(ops.launchChatOperation({userId:"u",orgId:"o",projectId:"w",key:"ninth_root",input:{}})).rejects.toThrow(/Active operation limit/);
  await sql`insert into document_page_states(document_id,page_number,state) values('d',1,'indexed')`;
  await expect(ops.launchChatOperation({userId:"u",orgId:"o",projectId:"w",key:"ninth_root",input:{}})).resolves.toBeTruthy();
});

it.skipIf(!process.env.CHAT_OPERATION_TEST_DATABASE_URL).each(['session','membership','abort'])("rejects %s invalidation while materialization waits for the root lock", async reason => {
  const t=await task();
  const abort=new AbortController();
  let locked!:()=>void, unlock!:()=>void;
  const ready=new Promise<void>(resolve=>{locked=resolve;});
  const release=new Promise<void>(resolve=>{unlock=resolve;});
  const holder=sql.begin(async tx=>{await tx`select id from chat_operations where id=${t.id} for update`;locked();await release;});
  await ready;
  const accepting=links.withChatRunOwner({...t,signal:abort.signal},allocate);
  const rejected=expect(accepting).rejects.toThrow();
  try {
    await vi.waitFor(async()=>{
      const [row]=await sql`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%chat_operations%'`;
      expect(row!.n).toBeGreaterThan(0);
    });
    if(reason==='session')await sql`delete from session where id='session'`;
    else if(reason==='membership')await sql`delete from org_memberships where org_id='o' and user_id='u'`;
    else abort.abort(new Error('cancelled'));
  } finally {unlock();await holder;}
  await rejected;
  expect((await sql`select count(*)::int n from project_runs`)[0]!.n).toBe(0);
  expect((await sql`select count(*)::int n from chat_run_dependencies`)[0]!.n).toBe(0);
});
