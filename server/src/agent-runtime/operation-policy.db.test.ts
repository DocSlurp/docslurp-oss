import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import type { SessionRequestActor } from "../lib/request-actor.js";
let sql:postgres.Sql;let stop:()=>Promise<void>;
let createPolicy:typeof import("./operation-policy.js").createNativeOperationPolicy;
let ops:typeof import("../services/chat-operations.js");
const actor:SessionRequestActor={type:"session",userId:"native-owner",sessionId:"native-session",user:{id:"native-owner",email:"native@example.test",name:"Native"}};
let operationId:string;
beforeAll(async()=>{
  const pg=await startMigratedPostgres();stop=pg.stop;sql=postgres(pg.url,{max:1,prepare:false,onnotice:()=>{}});
  vi.doMock("../db.js",()=>({sql}));
  vi.doMock("../lib/auth.js",()=>({auth:{api:{getSession:async()=>null}},appDbPool:{}}));
  ({createNativeOperationPolicy:createPolicy}=await import("./operation-policy.js"));ops=await import("../services/chat-operations.js");
  await sql`insert into "user"(id,name,email) values('native-owner','Native','native@example.test'),('native-foreign','Foreign','foreign@example.test')`;
  await sql`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt")
    values('native-session','native-test-token','native-owner',now()+interval '1 day',now(),now())`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values('native-org','Native','native-policy','native-owner')`;
  await sql`insert into org_memberships(org_id,user_id,role) values('native-org','native-owner','owner') on conflict do nothing`;
  await sql`insert into workspaces(id,org_id,user_id,name) values('00000000-0000-4000-8000-000000000319','native-org','native-owner','Native')`;
  operationId=(await ops.launchChatOperation({userId:"native-owner",orgId:"native-org",workspaceId:"00000000-0000-4000-8000-000000000319",key:"native_binding",input:{q:"fixture"}})).id;
},120000);
afterAll(async()=>{await sql?.end();await stop?.();});
it("authorizes session and workspace before exposing a persisted native binding",async()=>{
  const policy=createPolicy(async()=>actor);
  expect(await policy.authorize(operationId)).toMatchObject({id:operationId,userId:actor.userId,workspaceId:"00000000-0000-4000-8000-000000000319"});
  await expect(createPolicy(async()=>({...actor,userId:"native-foreign"})).authorize(operationId)).rejects.toThrow("operation_forbidden");
  await expect(createPolicy(async()=>null).authorize(operationId)).rejects.toThrow("operation_forbidden");
  await sql`update session set "expiresAt"=now()-interval '1 second' where id=${actor.sessionId}`;
  await expect(policy.authorize(operationId)).rejects.toThrow("operation_forbidden");
  await sql`update session set "expiresAt"=now()+interval '1 day' where id=${actor.sessionId}`;
  await sql`delete from org_memberships where org_id='native-org'`;
  await expect(policy.authorize(operationId)).rejects.toThrow("operation_forbidden");
  await sql`insert into org_memberships(org_id,user_id,role) values('native-org','native-owner','owner')`;
});
it("records root cancellation before refusing any subsequent native acceptance",async()=>{
  const policy=createPolicy(async()=>actor);const binding=await policy.authorize(operationId);
  const accept=vi.fn(async()=>"accepted");
  expect(await policy.serializeAcceptance(binding,accept)).toBe("accepted");
  await policy.recordCancellation(binding,"tree");
  await expect(policy.serializeAcceptance(binding,accept)).rejects.toThrow("operation_cancelled_or_expired");
  expect(accept).toHaveBeenCalledTimes(1);
});
