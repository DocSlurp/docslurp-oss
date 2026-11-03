import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachRealtimeServer } from "./node.js";
import type { RealtimeBackend } from "./broker.js";

const ORIGIN = "https://app.example.test";
const ORG = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  let valid = true;
  let access = true;
  let revision = "1";
  let data: unknown = { runs: [{ id: RUN, status: "processing" }] };
  const backend: RealtimeBackend = {
    authorize: vi.fn(async (_user, resource) => access && (resource.kind !== "activity" || resource.orgId === ORG) ? ORG : null),
    project: vi.fn(async () => data),
    revisions: vi.fn(async () => new Map([[ORG, revision]])),
    listen: vi.fn(async () => async () => {}),
  };
  const server = createServer((_req, res) => { res.end("HTTP still available"); });
  const adapter = attachRealtimeServer(server, { enabled: true, allowedOrigins: [ORIGIN], backend,
    authenticate: async headers => valid && headers.get("cookie") === "session=owner" ? { userId: "owner", sessionId: "s1" } : null,
    authorizationRecheckMs: 100, reconcileMs: 20 });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime`;
  cleanups.push(async () => { await adapter.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { backend, url, revoke: () => { valid = false; }, deny: () => { access = false; }, update: (next: unknown) => { data = next; revision = String(Number(revision) + 1); } };
}
async function connect(url: string, headers: Record<string, string> = { origin: ORIGIN, cookie: "session=owner" }) {
  const ws = new WebSocket(url, { headers });
  const frames: any[] = [];
  ws.on("message", data => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  cleanups.push(async () => { ws.terminate(); });
  return { ws, frames };
}
function subscribe(ws: WebSocket, id = "activity", resource: unknown = { kind: "activity", orgId: ORG }, generation = 1) {
  ws.send(JSON.stringify({ v: 1, type: "subscribe", subscriptionId: id, generation, resource }));
}
async function rejected(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!); });
    ws.on("open", () => { ws.terminate(); reject(new Error("unexpected upgrade")); });
    ws.on("error", () => {});
  });
}
describe("real Node realtime Upgrade", () => {
  it("shares ten run subscriptions and activity on one connection; snapshots converge without HTTP reads", async () => {
    const f = await fixture(); const { ws, frames } = await connect(f.url);
    for (let n = 0; n < 10; n++) subscribe(ws, `run-${n}`, { kind: "run", runId: RUN });
    subscribe(ws);
    await vi.waitFor(() => expect(frames.filter(frame => frame.type === "snapshot").length).toBeGreaterThanOrEqual(11));
    expect(f.backend.listen).toHaveBeenCalledTimes(1);
    expect(f.backend.project).toHaveBeenCalledTimes(2);
    for (let n = 0; n < 100; n++) f.update({ runs: [] });
    await vi.waitFor(() => expect(frames.filter(frame => frame.type === "snapshot" && frame.data.runs.length === 0)).toHaveLength(11));
    expect(f.backend.project).toHaveBeenCalledTimes(4);
  });
  it.each<Record<string, string>>([
    {}, { origin: "null" }, { origin: "https://evil.example.test" },
    { origin: ORIGIN, authorization: "Bearer dslp_test" }, { origin: ORIGIN, "x-api-key": "test" },
  ])("rejects hostile/missing Origin and API keys", async headers => {
    const f = await fixture();
    expect(await rejected(f.url, { cookie: "session=owner", ...headers })).toBe(403);
    expect(f.backend.project).not.toHaveBeenCalled();
  });
  it("rejects missing session and URL credentials", async () => {
    const f = await fixture();
    expect(await rejected(f.url, { origin: ORIGIN })).toBe(401);
    expect(await rejected(`${f.url}?token=secret`, { origin: ORIGIN, cookie: "session=owner" })).toBe(403);
  });
  it("denies cross-tenant resources without projecting them", async () => {
    const f = await fixture(); const { ws, frames } = await connect(f.url);
    subscribe(ws, "foreign", { kind: "activity", orgId: RUN });
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "error")).toBe(true));
    expect(f.backend.project).not.toHaveBeenCalled();
  });
  it("closes revoked sessions and removes revoked resources while idle", async () => {
    const f = await fixture(); const { ws, frames } = await connect(f.url); subscribe(ws);
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "snapshot")).toBe(true));
    f.deny();
    await vi.waitFor(() => expect(frames.some(frame => frame.code === "access_revoked")).toBe(true));
    f.revoke();
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
  });
  it.each(["{", JSON.stringify({ v: 2, type: "heartbeat" }), "x".repeat(9_000)])("rejects malformed, incompatible and oversized frames", async raw => {
    const f = await fixture(); const { ws } = await connect(f.url); ws.send(raw);
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
  });
  it("bounds subscription flooding", async () => {
    const f = await fixture(); const { ws, frames } = await connect(f.url);
    for (let n = 0; n < 33; n++) {
      subscribe(ws, `s${n}`);
      if (n < 32) await vi.waitFor(() => expect(frames.some(frame => frame.subscriptionId === `s${n}` && frame.type === "ack")).toBe(true));
    }
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
  });
  it("resnapshots after a missed notification, including deletes and terminal state", async () => {
    const f = await fixture(); const first = await connect(f.url); subscribe(first.ws);
    await vi.waitFor(() => expect(first.frames.some(frame => frame.type === "snapshot")).toBe(true));
    first.ws.terminate(); f.update({ runs: [{ id: RUN, status: "completed" }] });
    const second = await connect(f.url); subscribe(second.ws);
    await vi.waitFor(() => expect(second.frames.some(frame => frame.data?.runs?.[0]?.status === "completed")).toBe(true));
    f.update({ runs: [] });
    await vi.waitFor(() => expect(second.frames.some(frame => frame.data?.runs?.length === 0)).toBe(true));
  });
});
