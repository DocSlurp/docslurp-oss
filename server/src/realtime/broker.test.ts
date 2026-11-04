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
