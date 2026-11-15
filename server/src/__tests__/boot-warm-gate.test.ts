import { afterEach, expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({ sql: {} }));
vi.mock("../search/lancedb.js", () => ({ warmLanceDbSearch: vi.fn() }));
import { createBootWarmGate } from "../search/boot-warm.js";
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
