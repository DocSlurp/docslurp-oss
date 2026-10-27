import { createServer, constants, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import type { Connection } from "@temporalio/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: ReturnType<typeof postgres>;
let stop: () => Promise<void>;
let connection: Connection;
let resume: typeof import("../lib/temporal.js").signalPipelineResume;
let recover: typeof import("../services/spend-paused-runs.js").resumeSpendPausedRunOutcome;
const sessions = new Set<ServerHttp2Session>();
const grpc = createServer();
let signals = 0;
let cancelled = 0;
const previous = { leases: process.env.WORKER_CREDIT_LEASES, funded: process.env.CHAT_CREDIT_RESERVE_CREDITS, starter: process.env.CHAT_CREDIT_RESERVE_STARTER_CREDITS };

beforeAll(async () => {
  process.env.WORKER_CREDIT_LEASES = "on";
  process.env.CHAT_CREDIT_RESERVE_CREDITS = "0";
  process.env.CHAT_CREDIT_RESERVE_STARTER_CREDITS = "0";
  const db = await startMigratedPostgres(); stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false });
  vi.doMock("../db.js", () => ({ sql }));
  grpc.on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
  grpc.on("stream", (stream: ServerHttp2Stream, headers) => {
    if (!String(headers[":path"]).endsWith("/SignalWorkflowExecution")) throw new Error("Unexpected RPC");
    signals += 1;
    stream.on("error", () => {});
    stream.resume();
    if (signals === 1) {
      // Accept the request and never answer. Only gRPC cancellation can end it.
      stream.on("aborted", () => { if (stream.rstCode === constants.NGHTTP2_CANCEL) cancelled += 1; });
      return;
    }
    stream.on("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.from([0, 0, 0, 0, 0])); // Empty protobuf response in a gRPC frame.
    });
  });
  await new Promise<void>(resolve => grpc.listen(0, "127.0.0.1", resolve));
  const actual = await vi.importActual<typeof import("@temporalio/client")>("@temporalio/client");
  connection = actual.Connection.lazy({ address: `127.0.0.1:${(grpc.address() as AddressInfo).port}`, tls: false });
  // Use the actual SDK Client and gRPC connection; skip the unrelated initial
  // GetSystemInfo handshake so the server can stall exactly the resume RPC.
  vi.doMock("@temporalio/client", () => ({ ...actual, Connection: { connect: async () => connection } }));
  ({ signalPipelineResume: resume } = await import("../lib/temporal.js"));
  ({ resumeSpendPausedRunOutcome: recover } = await import("../services/spend-paused-runs.js"));
  await sql`insert into "user"(id, name, email) values ('deadline-user', 'Deadline', 'deadline@example.test')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('deadline-org', 'Deadline', 'deadline-org', 'deadline-user', 10)`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('deadline-ws', 'deadline-org', 'deadline-user', 'Deadline')`;
  await sql`insert into workspace_runs(id, org_id, workspace_id, user_id, kind, status, stage, pipeline, control_state, pause_reason)
    values ('deadline-run', 'deadline-org', 'deadline-ws', 'deadline-user', 'bulk-upload', 'processing', 'vision-extract', '{}', 'paused', 'credit_exhausted')`;
}, 60000);

afterAll(async () => {
  await connection?.close();
  for (const session of sessions) session.destroy();
  await new Promise<void>(resolve => grpc.close(() => resolve()));
  await sql?.end(); await stop?.();
  for (const [key, value] of [["WORKER_CREDIT_LEASES", previous.leases], ["CHAT_CREDIT_RESERVE_CREDITS", previous.funded], ["CHAT_CREDIT_RESERVE_STARTER_CREDITS", previous.starter]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});

it("cancels a stalled resume RPC, releases SQL/credit locks and retries without a false resume", async () => {
  const signalDeps = { pause: async () => {}, resume: (id: string) => resume(id, 500) };
  const started = Date.now();
  expect(await recover("deadline-run", { sql: sql as never, signals: signalDeps })).toEqual({ status: "deferred" });
  expect(Date.now() - started).toBeLessThan(3000);
  await vi.waitFor(() => expect(cancelled).toBe(1));
  // max:1 means these SELECTs also prove the transaction released its connection.
  expect((await sql`select control_state, pause_reason from workspace_runs where id = 'deadline-run'`)[0])
    .toMatchObject({ control_state: "paused", pause_reason: "credit_exhausted" });
  expect(Number((await sql`select org_outstanding_credit_leases('deadline-org') as credits`)[0]!.credits)).toBe(0);
  expect(await sql`select id from workspace_run_events where run_id = 'deadline-run'`).toHaveLength(0);
  expect(await recover("deadline-run", { sql: sql as never, signals: signalDeps })).toEqual({ status: "resumed" });
  expect(await recover("deadline-run", { sql: sql as never, signals: signalDeps })).toEqual({ status: "not-spend-paused" });
  expect(signals).toBe(2);
  expect(await sql`select id from workspace_run_events where run_id = 'deadline-run'`).toHaveLength(1);
}, 10000);
