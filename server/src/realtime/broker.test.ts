import { expect, it, vi } from "vitest";
import { RealtimeBroker, type RealtimeBackend } from "./broker.js";
const resource = { kind: "activity" as const, orgId: "org" };
it("registers before snapshot and converges when a commit races the read without NOTIFY", async () => {
  let revision = "1";
  let resolve!: (value: unknown) => void;
  const project = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue({ runs: [] });
  const backend: RealtimeBackend = { authorize: async () => "org", project,
    revisions: async () => new Map([["org",revision]]), listen: async () => async () => {} };
  const broker = new RealtimeBroker(backend, 60_000);
  const received: unknown[] = [];
  const close = await broker.subscribe("user",resource,async data => { received.push(data); });
  const pending = broker.tick();
  await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(1));
  revision="2"; resolve({ runs: [{id:"deleted"}] }); await pending;
  await broker.tick();
  expect(received).toEqual([{runs:[{id:"deleted"}]},{runs:[]}]);
  await broker.tick(); expect(project).toHaveBeenCalledTimes(2);
  close(); await broker.close();
});
it("shares projections across observers but never across actors; stops reads after detach", async () => {
  const backend: RealtimeBackend = { authorize: async () => "org", project: vi.fn(async userId => ({userId})),
    revisions: vi.fn(async () => new Map([["org","1"]])), listen: vi.fn(async () => async () => {}) };
  const broker = new RealtimeBroker(backend,60_000);
  const a: unknown[] = [], b: unknown[] = [];
  const detaches = await Promise.all([
    broker.subscribe("a",resource,async data => { a.push(data); }),
    broker.subscribe("a",resource,async data => { a.push(data); }),
    broker.subscribe("b",resource,async data => { b.push(data); }),
  ]);
  await broker.tick();
  expect(backend.project).toHaveBeenCalledTimes(2); expect(backend.listen).toHaveBeenCalledTimes(1);
  expect(a).toEqual([{userId:"a"},{userId:"a"}]); expect(b).toEqual([{userId:"b"}]);
  detaches.forEach(detach => detach()); await broker.tick();
  expect(backend.revisions).toHaveBeenCalledTimes(1); await broker.close();
});
it("fails observers closed when reconciliation cannot establish state", async () => {
  const failed = vi.fn();
  const backend: RealtimeBackend = { authorize: async () => "org", project: async () => ({}),
    revisions: async () => { throw new Error("database unavailable"); }, listen: async () => async () => {} };
  const broker = new RealtimeBroker(backend,60_000);
  const close = await broker.subscribe("user",resource,Object.assign(async () => {}, {failed}));
  await broker.tick(); expect(failed).toHaveBeenCalledTimes(1); close(); await broker.close();
});
it("re-projects only the subscriptions whose project or run scope moved", async () => {
  const scopes = new Map([["org\u0000project:a", "1"], ["org\u0000project:b", "1"], ["org\u0000run:r", "1"]]);
  let orgRevision = "1";
  const project = vi.fn(async (_userId: string, resource: { kind: string }) => ({ kind: resource.kind }));
  const authorize = vi.fn(async () => "org");
  const backend: RealtimeBackend = { authorize, project, listen: async () => async () => {},
    revisions: async () => new Map([["org", orgRevision]]),
    scopeRevisions: vi.fn(async (keys: Array<{ orgId: string; scope: string }>) => new Map<string, string>(keys.map(key => [`${key.orgId}\u0000${key.scope}`, scopes.get(`${key.orgId}\u0000${key.scope}`) ?? "0"]))) };
  const broker = new RealtimeBroker(backend, 60_000);
  const seen: string[] = [];
  const subscribe = (label: string, resource: Parameters<RealtimeBroker["subscribe"]>[1]) => broker.subscribe("user", resource, async () => { seen.push(label); });
  const closes = await Promise.all([
    subscribe("a", { kind: "project", projectId: "a" }), subscribe("a-docs", { kind: "documents", projectId: "a", page: 0 }),
    subscribe("b", { kind: "project", projectId: "b" }), subscribe("run", { kind: "run", runId: "r" }), subscribe("org", resource),
  ]);
  await broker.tick();
  expect(seen.sort()).toEqual(["a", "a-docs", "b", "org", "run"]);
  seen.length = 0; project.mockClear(); authorize.mockClear();
  // A change in project A: the organization revision and A's scope move, B's and the run's do not.
  orgRevision = "2"; scopes.set("org\u0000project:a", "2");
  await broker.tick();
  expect(seen.sort()).toEqual(["a", "a-docs", "org"]);
  expect(project.mock.calls.map(([, resource]) => resource.kind).sort()).toEqual(["activity", "documents", "project"]);
  // ...but every subscription was re-authorized on the organization revision.
  expect(authorize).toHaveBeenCalledTimes(5);
  seen.length = 0; authorize.mockClear();
  await broker.tick();
  expect(seen).toEqual([]); expect(authorize).not.toHaveBeenCalled();
  closes.forEach(close => close()); await broker.close();
});
it("revokes a subscription whose access changed even when its own data did not", async () => {
  let orgRevision = "1";
  let allowed = true;
  const revoked = vi.fn();
  const project = vi.fn(async () => ({ id: "b" }));
  const backend: RealtimeBackend = { authorize: async () => allowed ? "org" : null, project, listen: async () => async () => {},
    revisions: async () => new Map([["org", orgRevision]]),
    scopeRevisions: async () => new Map([["org\u0000project:b", "7"]]) };
  const broker = new RealtimeBroker(backend, 60_000);
  const close = await broker.subscribe("user", { kind: "project", projectId: "b" }, Object.assign(async () => {}, { revoked }));
  await broker.tick();
  expect(project).toHaveBeenCalledTimes(1);
  // Membership removed: only the organization revision moves.
  allowed = false; orgRevision = "2";
  await broker.tick();
  expect(revoked).toHaveBeenCalledTimes(1);
  expect(project).toHaveBeenCalledTimes(1);
  close(); await broker.close();
});
