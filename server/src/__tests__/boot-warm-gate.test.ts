import { afterEach, expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({ sql: {} }));
vi.mock("../search/lancedb.js", () => ({ warmLanceDbSearch: vi.fn() }));
import { createBootWarmGate, warmRecentSearchIndexes } from "../search/boot-warm.js";
afterEach(() => vi.useRealTimers());

it("holds readiness until warming completes and shares one startup across probes", async () => {
  let release!: () => void;
  const warm = vi.fn(() => new Promise<void>((r) => { release = r; }));
  const ready = createBootWarmGate(warm);
  let serving = false;
  const requests = Promise.all([ready(), ready(), ready()]).then(() => { serving = true; });
  await Promise.resolve();
  expect(serving).toBe(false);
  expect(warm).toHaveBeenCalledTimes(1);
  release();
  await requests;
  expect(serving).toBe(true);
});

it("never announces readiness after its deadline or starts more uncancellable loads", async () => {
  vi.useFakeTimers();
  const warm = vi.fn(() => new Promise<void>(() => {}));
  const ready = createBootWarmGate(warm, 30_000);
  const failed = expect(ready()).rejects.toThrow("readiness deadline");
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  await expect(ready()).rejects.toThrow("readiness deadline");
  expect(warm).toHaveBeenCalledTimes(1);
});


it("propagates the startup deadline to queued loaders and stops selecting new targets", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let signal!: AbortSignal;
  const blocked = new Promise<void>((r) => { release = r; });
  const warm = vi.fn(async (target: { signal?: AbortSignal }) => { signal = target.signal!; await blocked; });
  const target = { orgId: "org", projectId: "project", embeddingModel: "model", dimension: 2 };
  const ready = createBootWarmGate((startupSignal) => warmRecentSearchIndexes({ limit: 2, signal: startupSignal, targets: async () => [target, target], warm, log: () => {} }), 30_000);
  const failed = expect(ready()).rejects.toThrow("readiness deadline");
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  expect(signal.aborted).toBe(true);
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(warm).toHaveBeenCalledTimes(1);
});
