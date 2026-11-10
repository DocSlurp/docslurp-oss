import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { EventEmitterPubSub } from "@mastra/core/events";
import { InMemoryServerCache } from "@mastra/core/cache";
import { StrictCachingPubSub } from "../agent-runtime/strict-pubsub.js";
import { NativeOperations } from "../agent-runtime/native-operations.js";
import { publishOperationOutput } from "../agent-runtime/operation-delivery.js";
import type { SessionRequestActor } from "../lib/request-actor.js";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let host: Mastra;
let app: Hono;
const project = "00000000-0000-4000-8000-000000000319";
const owner: SessionRequestActor = { type: "session", userId: "pause-owner", sessionId: "pause-session", user: { id: "pause-owner", name: "Owner", email: "owner@pause.test" } };
let actor = owner;
let native: NativeOperations;
let pubsub: StrictCachingPubSub;

beforeAll(async () => {
  const pg = await startMigratedPostgres(); stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  vi.doMock("../lib/request-actor.js", async original => ({ ...await original<typeof import("../lib/request-actor.js")>(), getRequestActor: () => actor }));
  vi.doMock("../agent-runtime/runtime.js", () => ({ nativeOperations: async () => native }));
  // No model invocation: exercise native ownership, SQL authorization and HTTP recovery.
  vi.doMock("../services/project-chat.js", () => ({ projectChatDisabledBody: async () => null }));
  vi.stubEnv("DOCSLURP_DURABLE_CHAT", "1"); vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION", "1");
  await sql`insert into "user"(id,name,email) values('pause-owner','Owner','owner@pause.test'),('pause-foreign','Foreign','foreign@pause.test')`;
  await sql`insert into session(id,token,"userId","expiresAt") values('pause-session','pause-token','pause-owner',now()+interval '1 hour')`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values('pause-org','Pause','pause-admission','pause-owner')`;
  await sql`insert into org_memberships(org_id,user_id,role) values('pause-org','pause-owner','owner') on conflict do nothing`;
  await sql`insert into projects(id,org_id,user_id,name) values(${project},'pause-org','pause-owner','Pause')`;
  pubsub = new StrictCachingPubSub(new EventEmitterPubSub(), new InMemoryServerCache());
  host = new Mastra({ storage: new InMemoryStore(), pubsub, workers: false, backgroundTasks: { enabled: true, mode: "producer", recoverStaleTasksOnStart: false } });
  const { createNativeOperationPolicy } = await import("../agent-runtime/operation-policy.js");
  native = new NativeOperations(host.backgroundTaskManager!, pubsub, createNativeOperationPolicy(async () => actor));
  const { chatOperationRoutes, durableChatLaunchHandler } = await import("../routes/chat-operations.js");
  app = new Hono().route("/operations", chatOperationRoutes).post("/chat", c => durableChatLaunchHandler(c));
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await host?.shutdown(); await sql?.end(); await stop?.(); });

it("recovers a lost ACK during pause without accepting another native task and preserves scoped Stop", async () => {
  const launch = await app.request("/operations", { method: "POST", headers: { "Idempotency-Key": "pause_lost_ack" }, body: JSON.stringify({ q: "hello", project }) });
  expect(launch.status).toBe(202);
  const { operationId } = await launch.json();
  const manager = host.backgroundTaskManager!;
  const [task] = (await manager.listTasks({ toolCallId: operationId })).tasks;
  vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION", "0");
  // Accepted native output can still arrive after the operator pauses new work.
  await publishOperationOutput(pubsub, task!.id, { kind: "text", payload: { text: "retained during pause" } });
  for (const path of ["/operations", "/chat", `/operations/${operationId}/tasks`, `/operations/${operationId}/retry`]) {
    expect((await app.request(path, { method: "POST", headers: { "Idempotency-Key": "pause_lost_ack" }, body: JSON.stringify({ q: "hello", project }) })).status).toBe(403);
  }
  const discovery = await (await app.request("/operations")).json();
  expect(discovery.operations).toEqual([expect.objectContaining({ id: operationId })]);
  expect((await (await app.request(`/operations/${operationId}`)).json()).operation.snapshot.text).toBe("retained during pause");
  expect((await manager.listTasks({ toolCallId: operationId })).total).toBe(1);
  expect(Number((await sql`select count(*) as n from chat_operations`)[0]!.n)).toBe(1);
  actor = { ...owner, userId: "pause-foreign" };
  expect((await app.request(`/operations/${operationId}`)).status).toBe(403);
  expect((await app.request(`/operations/${operationId}/cancel`, { method: "POST", body: JSON.stringify({ scope: "tree" }) })).status).toBe(403);
  expect((await (await app.request("/operations")).json()).operations).toEqual([]);
  actor = owner;
  await sql`update session set "expiresAt"=now()-interval '1 second' where id=${owner.sessionId}`;
  expect((await app.request(`/operations/${operationId}`)).status).toBe(403);
  await sql`update session set "expiresAt"=now()+interval '1 hour' where id=${owner.sessionId}`;
  expect((await app.request(`/operations/${operationId}/cancel`, { method: "POST", body: JSON.stringify({ scope: "tree" }) })).status).toBe(200);
  expect((await sql`select tree_cancel_requested from chat_operations where id=${operationId}`)[0]!.tree_cancel_requested).toBe(true);
  expect((await manager.listTasks({ toolCallId: operationId })).total).toBe(1);
}, 20_000);
