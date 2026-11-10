import postgres from "postgres";
import { afterAll,beforeAll,expect,it,vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
let sql:postgres.Sql,stop:()=>Promise<void>;
let check:typeof import("./session.js").revalidateRealtimeSession;
const session={userId:"socket-owner",sessionId:"socket-session"};
const signal=new AbortController().signal;
beforeAll(async()=>{
  const db=await startMigratedPostgres();stop=db.stop;
  sql=postgres(db.url,{max:1,prepare:false,onnotice(){}});
  vi.doMock("../db.js",()=>({sql}));
  check=(await import("./session.js")).revalidateRealtimeSession;
  await sql`insert into "user"(id,name,email) values('socket-owner','Socket','socket@example.test')`;
  await sql`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values('socket-session','test-token','socket-owner',now()+interval '1 day',now(),now())`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values('socket-org','Socket','socket-test','socket-owner')`;
  await sql`insert into org_memberships(org_id,user_id,role) values('socket-org','socket-owner','owner') on conflict do nothing`;
},60000);
afterAll(async()=>{await sql?.end();await stop?.();});
it("checks expiry, deletion, identity and current MFA policy without cached grants",async()=>{
  expect(await check(session,signal)).toEqual(session);
  expect(await check({...session,userId:"foreign"},signal)).toBeNull();
  await sql`update "user" set "twoFactorEnabled"=true where id='socket-owner'`;
  expect(await check(session,signal)).toBeNull();
  await sql`update session set "mfaVerified"=true where id='socket-session'`;
  expect(await check(session,signal)).toEqual(session);
  await sql`update "user" set "twoFactorEnabled"=false where id='socket-owner'`;
  await sql`update session set "mfaVerified"=false where id='socket-session'`;
  await sql`update organizations set require_mfa=true,require_mfa_since=now()-interval '1 day',mfa_grace_period_days=0 where id='socket-org'`;
  expect(await check(session,signal)).toBeNull();
  await sql`update session set "mfaVerified"=true where id='socket-session'`;
  expect(await check(session,signal)).toEqual(session);
  await sql`update session set "expiresAt"=now()-interval '1 second' where id='socket-session'`;
  expect(await check(session,signal)).toBeNull();
  await sql`update session set "expiresAt"=now()+interval '1 day' where id='socket-session'`;
  await sql`update "user" set deleted_at=now() where id='socket-owner'`;
  expect(await check(session,signal)).toBeNull();
  await expect(check(session,AbortSignal.abort())).rejects.toBeDefined();
  await sql`delete from session where id='socket-session'`;
  expect(await check(session,signal)).toBeNull();
});

it("requires fresh cohort membership and refuses foreign/deleted organizations", async () => {
  const { hasRealtimeCanaryMembership } = await import("./session.js");
  const org = "00000000-0000-4000-8000-000000000001";
  await sql`insert into "user"(id,name,email) values('canary-owner','Canary','canary@example.test')`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values(${org},'Canary','canary-scope','canary-owner')`;
  await sql`insert into org_memberships(org_id,user_id,role) values(${org},'canary-owner','owner')`;
  vi.stubEnv("REALTIME_CANARY_ORG_IDS", org);
  try {
    expect(await hasRealtimeCanaryMembership("canary-owner", org, signal)).toBe(true);
    expect(await hasRealtimeCanaryMembership("canary-owner", undefined, signal)).toBe(true);
    expect(await hasRealtimeCanaryMembership("foreign", org, signal)).toBe(false);
    expect(await hasRealtimeCanaryMembership("canary-owner", "socket-org", signal)).toBe(false);
    await sql`delete from org_memberships where org_id=${org}`;
    expect(await hasRealtimeCanaryMembership("canary-owner", org, signal)).toBe(false);
    await sql`insert into org_memberships(org_id,user_id,role) values(${org},'canary-owner','owner')`;
    await sql`update organizations set deleted_at=now() where id=${org}`;
    expect(await hasRealtimeCanaryMembership("canary-owner", org, signal)).toBe(false);
    await expect(hasRealtimeCanaryMembership("canary-owner",org,AbortSignal.abort())).rejects.toBeDefined();
  } finally { vi.unstubAllEnvs(); }
});
