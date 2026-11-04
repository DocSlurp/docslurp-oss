import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachRealtimeServer, type RealtimeHostOptions } from "./node.js";
import type { RealtimeBackend } from "./broker.js";

const ORIGIN = "https://app.example.test";
const ORG = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(overrides: Partial<RealtimeHostOptions> = {}) {
  let valid = true;
  let access = true;
  let revision = "1";
  let data: unknown = { runs: [{ id: RUN, status: "processing" }] };
  const backend: RealtimeBackend = {
    authorize: vi.fn(async (_user, resource) => access && (resource.kind !== "activity" || resource.orgId === ORG) ? ORG : null),
    authorizeDelivery: vi.fn(async () => access),
    project: vi.fn(async () => data),
    revisions: vi.fn(async () => new Map([[ORG, revision]])),
    listen: vi.fn(async () => async () => {}),
  };
  const server = createServer((_req, res) => { res.end("HTTP still available"); });
  const adapter = attachRealtimeServer(server, { enabled: true, allowedOrigins: [ORIGIN], backend,
    authenticate: async headers => valid && headers.get("cookie") === "session=owner" ? { userId: "owner", sessionId: "s1" } : null,
    authorizationRecheckMs: 100, reconcileMs: 20, ...overrides });
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
    // This tests admission, not the 100ms watchdog used by revocation fixtures.
    const f = await fixture({authorizationRecheckMs:1000}); const { ws, frames } = await connect(f.url);
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
  it("bounds oversized snapshots with an explicit reconnect/resync close", async () => {
    const f = await fixture(); const { ws } = await connect(f.url);
    const closed = new Promise<{code:number;reason:string}>(resolve => ws.once("close",(code,reason) => resolve({code,reason:reason.toString()})));
    f.update({ text: "x".repeat(600_000) }); subscribe(ws);
    expect(await closed).toEqual({code:1013,reason:"resync_required"});
  });
  it("delivers ten distinct watched runs on one socket", async () => {
    const f = await fixture(); const { ws,frames } = await connect(f.url);
    for(let n=0;n<10;n++) subscribe(ws,`distinct-${n}`,{kind:"run",runId:`00000000-0000-4000-8000-${String(n+10).padStart(12,"0")}`});
    await vi.waitFor(() => expect(frames.filter(frame => frame.type === "snapshot")).toHaveLength(10));
    expect(f.backend.listen).toHaveBeenCalledTimes(1); expect(f.backend.project).toHaveBeenCalledTimes(10);
  });

  it("bounds concurrent connections per authenticated user", async () => {
    const f = await fixture();
    for (let n=0; n<8; n++) await connect(f.url);
    expect(await rejected(f.url,{origin:ORIGIN,cookie:"session=owner"})).toBe(429);
  });

  it("rejects activity captured before constituent project revocation", async () => {
    const f = await fixture();
    let release!: () => void;
    const hold = new Promise<void>(resolve => {release=resolve;});
    vi.mocked(f.backend.project).mockImplementation(async () => { await hold; return { runs: [{id:RUN,projectId:"private"}] }; });
    const {ws,frames} = await connect(f.url); subscribe(ws);
    await vi.waitFor(() => expect(f.backend.project).toHaveBeenCalled());
    vi.mocked(f.backend.authorizeDelivery!).mockResolvedValue(false);
    release();
    await vi.waitFor(() => expect(frames.some(frame => frame.code === "access_revoked")).toBe(true));
    expect(frames.some(frame => frame.type === "snapshot")).toBe(false);
  });

  it("expires stalled resource verification despite successful unrelated session checks", async () => {
    const f = await fixture(); const {ws,frames} = await connect(f.url); subscribe(ws);
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "snapshot")).toBe(true));
    const original = f.backend.authorize;
    let release!: (value: string) => void;
    const stalled = new Promise<string>(resolve => {release=resolve;});
    f.backend.authorize = vi.fn(async (user, resource) => resource.kind === "activity" ? stalled : original(user, resource));
    const keepAlive = setInterval(() => subscribe(ws, "healthy", {kind:"run",runId:RUN}, Date.now()), 20);
    try { await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED)); }
    finally { clearInterval(keepAlive); release(ORG); }
  });

  it("releases timed-out upgrade reservations and cancels cooperative authentication", async () => {
    let healthy = false;
    let aborted = 0;
    const f = await fixture({ authenticationTimeoutMs: 10, authenticate: async (_headers, signal) => {
      if (healthy) return {userId:"owner",sessionId:"s1"};
      return await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => {aborted++;reject(signal!.reason);}, {once:true}));
    }});
    for (let batch=0; batch<17; batch++) {
      const codes = await Promise.all(Array.from({length:32}, () => rejected(f.url,{origin:ORIGIN,cookie:"session=owner"})));
      expect(codes.every(code => code === 408)).toBe(true);
    }
    expect(aborted).toBe(544);
    healthy = true;
    const {ws} = await connect(f.url);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  }, 15_000);

  it("bounds abandoned work when an authentication provider ignores cancellation", async () => {
    const signals: AbortSignal[] = [];
    const authenticate = vi.fn(async (_headers: Headers, signal?: AbortSignal) => {
      signals.push(signal!); return await new Promise<null>(() => {});
    });
    const f = await fixture({authenticationTimeoutMs:10, authenticate});
    for (let n=0;n<32;n++) expect(await rejected(f.url,{origin:ORIGIN,cookie:`session=${n}`})).toBe(408);
    expect(await rejected(f.url,{origin:ORIGIN,cookie:"session=overflow"})).toBe(503);
    expect(authenticate).toHaveBeenCalledTimes(32);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("does not let stale collection revocation remove a newer subscription generation", async () => {
    const f = await fixture({authorizationRecheckMs:1000});
    let release!: (value: boolean) => void;
    const hold = new Promise<boolean>(resolve => {release=resolve;});
    vi.mocked(f.backend.authorizeDelivery!).mockReturnValue(hold);
    const {ws,frames} = await connect(f.url); subscribe(ws,"switch");
    await vi.waitFor(() => expect(f.backend.authorizeDelivery).toHaveBeenCalled());
    subscribe(ws,"switch",{kind:"run",runId:RUN},2);
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "ack" && frame.generation === 2)).toBe(true));
    release(false);
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "snapshot" && frame.generation === 2)).toBe(true));
    expect(frames.some(frame => frame.type === "error" && frame.generation === 2)).toBe(false);
  });

});

it("uses one bounded resource batch per sweep and still revokes an individual topic", async () => {
  const f=await fixture();
  let permitted=true;
  f.backend.authorizeMany=vi.fn(async(_user,resources)=>resources.map(()=>permitted?ORG:null));
  const {ws,frames}=await connect(f.url);
  for(let n=0;n<10;n++)subscribe(ws,`run-${n}`,{kind:"run",runId:RUN});
  await vi.waitFor(()=>expect(frames.filter(frame=>frame.type==="snapshot")).toHaveLength(10));
  await vi.waitFor(()=>expect(f.backend.authorizeMany).toHaveBeenCalled());
  expect(vi.mocked(f.backend.authorizeMany).mock.calls.some(([,resources])=>resources.length===10)).toBe(true);
  permitted=false;
  await vi.waitFor(()=>expect(frames.filter(frame=>frame.type==="error"&&frame.code==="access_revoked")).toHaveLength(10));
});
it("fails closed when a batched resource sweep stalls despite healthy session checks", async () => {
  const f=await fixture();const {ws,frames}=await connect(f.url);
  subscribe(ws);await vi.waitFor(()=>expect(frames.some(frame=>frame.type==="snapshot")).toBe(true));
  let release!:()=>void;
  f.backend.authorizeMany=vi.fn(()=>new Promise<Array<string|null>>(resolve=>{release=()=>resolve([ORG]);}));
  const closed=new Promise<string>(resolve=>ws.once("close",(_code,reason)=>resolve(reason.toString())));
  expect(await closed).toBe("authorization_timeout");
  release?.();
});
