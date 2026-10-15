import { describe, expect, it, vi } from "vitest";

import {
  KeyedTaskPool,
  lanceMaintenanceConcurrency,
  lanceMaintenanceDrainTimeoutMs,
  lanceMaintenanceSweepIntervalMs,
} from "../stages/lancedb-maintenance-pool.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const quiet = () => undefined;

describe("KeyedTaskPool", () => {
  it("runs one task per key and coalesces requests into one follow-up run", async () => {
    const pool = new KeyedTaskPool({ concurrency: 4, log: quiet });
    const hold = gate();
    let runs = 0;
    const task = async () => { runs += 1; if (runs === 1) await hold.promise; };
    const first = pool.request("t", task);
    const second = pool.request("t", task);
    const third = pool.request("t", task);
    expect(pool.schedule("t", task)).toBe(true);
    await vi.waitFor(() => expect(runs).toBe(1));
    expect(pool.stats()).toMatchObject({ running: 1, queued: 1 });
    hold.release();
    await Promise.all([first, second, third]);
    await pool.idle();
    expect(runs).toBe(2);
    expect(pool.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it("bounds concurrency across keys and starts queued keys in order", async () => {
    const pool = new KeyedTaskPool({ concurrency: 2, log: quiet });
    const holds = new Map<string, ReturnType<typeof gate>>();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const task = (key: string) => async () => {
      started.push(key);
      active += 1;
      peak = Math.max(peak, active);
      const hold = gate();
      holds.set(key, hold);
      await hold.promise;
      active -= 1;
    };
    for (const key of ["a", "b", "c", "d"]) pool.schedule(key, task(key));
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    holds.get("a")!.release();
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
    for (const key of ["b", "c"]) holds.get(key)!.release();
    await vi.waitFor(() => expect(started).toHaveLength(4));
    holds.get("d")!.release();
    await pool.idle();
    expect(peak).toBe(2);
  });

  it("logs task failures instead of rejecting and keeps serving the key", async () => {
    const log = vi.fn();
    const pool = new KeyedTaskPool({ concurrency: 1, log });
    await expect(pool.request("t", async () => { throw new Error("commit conflict"); })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("task failed key=t: commit conflict"));
    let ran = false;
    await pool.request("t", async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("drain finishes accepted work, then refuses new work", async () => {
    const pool = new KeyedTaskPool({ concurrency: 1, log: quiet });
    const done: string[] = [];
    pool.schedule("a", async () => { await new Promise((resolve) => setTimeout(resolve, 20)); done.push("a"); });
    pool.schedule("b", async () => { done.push("b"); });
    const result = await pool.drain(5_000);
    expect(result).toEqual({ completed: true, running: [], dropped: [] });
    expect(done).toEqual(["a", "b"]);
    expect(pool.schedule("c", async () => { done.push("c"); })).toBe(false);
    await expect(pool.request("c", async () => { done.push("c"); })).resolves.toBeUndefined();
    expect(done).toEqual(["a", "b"]);
  });

  it("drain reports running and never-started keys at its deadline and releases waiters", async () => {
    const log = vi.fn();
    const pool = new KeyedTaskPool({ concurrency: 1, log });
    const hold = gate();
    pool.schedule("slow", () => hold.promise);
    const waiter = pool.request("queued", async () => undefined);
    const result = await pool.drain(20);
    expect(result).toEqual({ completed: false, running: ["slow"], dropped: ["queued"] });
    await expect(waiter).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("drain timed_out=true running=1 dropped=1"));
    hold.release();
  });

  it("bounds its env knobs", () => {
    expect(lanceMaintenanceConcurrency({})).toBe(1);
    expect(lanceMaintenanceConcurrency({ LANCEDB_MAINTENANCE_CONCURRENCY: "500" })).toBe(8);
    expect(lanceMaintenanceConcurrency({ LANCEDB_MAINTENANCE_CONCURRENCY: "0" })).toBe(1);
    expect(lanceMaintenanceDrainTimeoutMs({})).toBe(30_000);
    expect(lanceMaintenanceSweepIntervalMs({})).toBe(60_000);
    expect(lanceMaintenanceSweepIntervalMs({ LANCEDB_MAINTENANCE_SWEEP_INTERVAL_MS: "1" })).toBe(5_000);
    expect(lanceMaintenanceSweepIntervalMs({ LANCEDB_MAINTENANCE_SWEEP_INTERVAL_MS: "0" })).toBe(0);
    expect(lanceMaintenanceSweepIntervalMs({ LANCEDB_MAINTENANCE_SWEEP_INTERVAL_MS: "soon" })).toBe(60_000);
  });
});
