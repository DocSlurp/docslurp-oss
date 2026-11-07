import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { WebSocket } from "ws";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createMigratedDatabase, serveOnRandomPort } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let api: typeof import("./index.js");
let operations: typeof import("../services/chat-operations.js");
const ORIGIN = "https://realtime.example.test";
const WS = "00000000-0000-4000-8000-000000000001";
let sessionId = "session-1";
const actor = () => ({ type: "session" as const, userId: "owner", sessionId, user: { id: "owner", email: "owner@example.test", name: "Owner" } });
beforeAll(async () => {
  const db = await createMigratedDatabase();
  // postgres.js LISTEN owns one dedicated connection beside the query pool.
  const socketServer = await serveOnRandomPort(db, { maxConnections: 2 });
  stop = async () => { await socketServer.server.stop(); await db.close(); };
  sql = postgres(`postgres://postgres@127.0.0.1:${socketServer.port}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  vi.doMock("../lib/request-actor.js", async importOriginal => ({
    ...await importOriginal<typeof import("../lib/request-actor.js")>(),
    // Deliberately stale auth cache: database liveness must still revoke it.
    resolveBetterAuthSessionActor: async () => actor(),
  }));
  vi.stubEnv("REALTIME_ENABLED", "true"); vi.stubEnv("DOCSLURP_DURABLE_CHAT", "1"); vi.stubEnv("CORS_ALLOWED_ORIGINS", ORIGIN);
  api = await import("./index.js"); operations = await import("../services/chat-operations.js");
  await sql`insert into "user"(id,name,email) values('owner','Owner','owner@example.test')`;
  await sql`insert into session(id,"userId",token,"expiresAt") values('session-1','owner','test-token',now()+interval '1 hour')`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values('org','Org','realtime-operation-org','owner')`;
  await sql`insert into org_memberships(org_id,user_id,role) values('org','owner','owner') on conflict do nothing`;
  await sql`insert into projects(id,org_id,user_id,name) values(${WS},'org','owner','Operations')`;
}, 60_000);
afterAll(async () => { vi.unstubAllEnvs(); await sql?.end(); await stop?.(); });

async function host() {
  const server = createServer((_req,res) => res.end());
  const adapter = api.attachFirstPartyRealtime(server);
  await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime`,
    close: async () => { await adapter.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function observe(url: string, id: string, after = 0) {
  const socket = new WebSocket(url, { headers: { origin: ORIGIN, cookie: "session=owner" } });
  const frames: any[] = [];
  socket.on("message", data => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve,reject) => { socket.once("open",resolve); socket.once("error",reject); });
  socket.send(JSON.stringify({v:1,type:"subscribe",subscriptionId:"answer",generation:1,resource:{kind:"operation",operationId:id,after}}));
  return {socket,frames};
}
it("detaches without cancelling and recovers accepted output on another host", async () => {
  const root = await operations.launchChatOperation({userId:"owner",orgId:"org",projectId:WS,key:"ws-recovery-test",input:{q:"test"}});
  const attempt = await operations.claimChatOperation(); expect(attempt?.id).toBe(root.id);
  await operations.appendChatOperation(root.id,attempt!.attempt_id!,"text",{text:"first "});
  const first = await host(); const firstView = await observe(first.url,root.id);
  try {
    await vi.waitFor(() => expect(firstView.frames.some(frame => frame.type === "snapshot")).toBe(true));
    firstView.socket.terminate(); await first.close();
    await operations.appendChatOperation(root.id,attempt!.attempt_id!,"text",{text:"second"});
    const second = await host(); const secondView = await observe(second.url,root.id,1);
    try {
      await vi.waitFor(() => expect(secondView.frames.some(frame => frame.data?.operation?.snapshot?.text === "first second")).toBe(true));
      const state = await operations.readChatOperation("owner",root.id,0);
      expect(state?.operation.cancel_requested).toBe(false);
      const child = await operations.launchChatOperation({userId:"owner",orgId:"org",projectId:WS,key:"ws-child-test",parentId:root.id,input:{q:"child"}});
      // Child discovery advances the transport revision even if root sequence does not change.
      await vi.waitFor(() => expect(secondView.frames.some(frame => frame.data?.tasks?.some((task: any) => task.id === child.id))).toBe(true), {timeout:3_000});
      const payloads = secondView.frames.filter(frame => frame.type === "snapshot" || frame.type === "upsert");
      expect(payloads.at(-1).revision).toBeGreaterThan(payloads[0].revision);
      await sql`delete from session where id='session-1'`;
      await vi.waitFor(() => expect(secondView.socket.readyState).toBe(WebSocket.CLOSED), {timeout:6_000});
    } finally { secondView.socket.terminate(); await second.close(); }
  } finally { firstView.socket.terminate(); await first.close(); }
}, 15_000);
it("denies cached-but-expired sessions and explicit API credentials", async () => {
  await sql`insert into session(id,"userId",token,"expiresAt") values('expired','owner','expired-token',now()-interval '1 minute')`;
  sessionId="expired";
  expect(await api.authenticateRealtimeSession(new Headers({cookie:"stale-cache"}))).toBeNull();
  expect(await api.authenticateRealtimeSession(new Headers({authorization:"Bearer test"}))).toBeNull();
});

it("pushes project, suggestion and viewer changes through the production adapter and SQL backend", async () => {
  sessionId="dashboard-session";
  await sql`insert into session(id,"userId",token,"expiresAt") values(${sessionId},'owner','dashboard-token',now()+interval '1 hour')`;
  const documentId = "00000000-0000-4000-8000-000000000003";
  await sql`insert into documents(id,user_id,org_id,project_id,filename,mime_type,source_key,status)
    values(${documentId},'owner','org',${WS},'live.txt','text/plain','private-source','processing')`;
  const server = await host();
  const socket = new WebSocket(server.url, {headers:{origin:ORIGIN,cookie:"session=owner"}});
  const frames: any[] = [];
  socket.on("message", data => frames.push(JSON.parse(data.toString())));
  try {
    await new Promise<void>((resolve,reject) => {socket.once("open",resolve);socket.once("error",reject);});
    socket.send(JSON.stringify({v:1,type:"subscribe",subscriptionId:"project",generation:1,resource:{kind:"project",projectId:WS}}));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "snapshot" && frame.data?.id === WS)).toBe(true),{timeout:4_000});
    for (const resource of [{kind:"suggestions",projectId:WS},{kind:"viewer",documentId}]) {
      socket.send(JSON.stringify({v:1,type:"subscribe",subscriptionId:resource.kind,generation:1,resource}));
    }
    await vi.waitFor(() => expect(frames.some(frame => frame.resource?.kind === "viewer" && frame.data?.document?.status === "processing")).toBe(true),{timeout:3_000});
    await sql`update projects set name='Committed live change' where id=${WS}`;
    await sql`update documents set status='completed',page_count=3 where id=${documentId}`;
    await sql`insert into query_suggestions(id,user_id,project_id,phrase,weight) values('ws-suggestion','owner',${WS},'Live SQL question',999)`;
    await vi.waitFor(() => expect(frames.some(frame => frame.data?.name === "Committed live change")).toBe(true),{timeout:3_000});
    await vi.waitFor(() => expect(frames.some(frame => frame.resource?.kind === "suggestions" && frame.data?.suggestions?.includes("Live SQL question"))).toBe(true),{timeout:3_000});
    await vi.waitFor(() => expect(frames.some(frame => frame.resource?.kind === "viewer" && frame.data?.document?.status === "completed" && frame.data?.pageStats?.pageCount === 3)).toBe(true),{timeout:3_000});
    await sql`delete from documents where id=${documentId}`;
    await vi.waitFor(() => expect(frames.some(frame => frame.resource?.kind === "viewer" && frame.type === "error")).toBe(true),{timeout:3_000});
  } finally {socket.terminate();await server.close();}
},15_000);
