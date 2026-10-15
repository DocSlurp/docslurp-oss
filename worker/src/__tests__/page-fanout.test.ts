import { describe, expect, it } from "vitest";

import { bundlePageTasks, runPageFanOut, slotBackoffMs } from "../temporal/page-fanout.js";

const zero = { inputTokens: 0, outputTokens: 0, costCents: 0 };
const waitFor = async (predicate: () => boolean) => {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 0));
};
const tick = (ms = 1) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class SlotDenied extends Error {}

describe("runPageFanOut", () => {
  it("never exceeds the run's fan-out cap and processes every bundle", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await runPageFanOut({
      bundles: Array.from({ length: 300 }, (_, i) => i),
      concurrency: 128,
      run: async (page) => { active++; peak = Math.max(peak, active); await tick(); active--; done.push(page); return { ...zero, costCents: 1 }; },
      onUsage: () => {}, isSlotUnavailable: () => false, waitFor, sleep: tick, now: Date.now, random: () => 0.5,
      isPaused: () => false, isCancelled: () => false,
    });
    expect(peak).toBe(128);
    expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });

  it("shrinks to the org's free slots, backs off, and still finishes every page", async () => {
    const orgSlots = 4; // shared with another run that holds the rest
    let held = 0;
    let peak = 0;
    let clock = 0;
    const completed = new Set<number>();
    const sleeps: number[] = [];
    const stats = await runPageFanOut({
      bundles: Array.from({ length: 40 }, (_, i) => i),
      concurrency: 32,
      run: async (page) => {
        if (held >= orgSlots) throw new SlotDenied();
        held++; peak = Math.max(peak, held);
        await tick(2);
        held--; completed.add(page);
        return zero;
      },
      onUsage: () => {}, isSlotUnavailable: (error) => error instanceof SlotDenied, waitFor,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; await tick(); }, now: () => clock, random: () => 0,
      isPaused: () => false, isCancelled: () => false,
    });
    expect(completed.size).toBe(40);
    expect(peak).toBeLessThanOrEqual(orgSlots);
    expect(stats.slotDenials).toBeGreaterThan(0);
    // One burst of denials on the first wave, not one per page per tick.
    expect(stats.slotDenials).toBeLessThan(40);
    expect(stats.minWindow).toBeLessThanOrEqual(orgSlots);
    expect(sleeps.every((ms) => ms >= 1_000)).toBe(true);
  });

  it("propagates a real failure after draining in-flight pages", async () => {
    let active = 0;
    const result = runPageFanOut({
      bundles: [1, 2, 3, 4, 5, 6],
      concurrency: 3,
      run: async (page) => { active++; await tick(page === 2 ? 1 : 5); active--; if (page === 2) throw new Error("boom"); return zero; },
      onUsage: () => {}, isSlotUnavailable: () => false, waitFor, sleep: tick, now: Date.now, random: () => 0,
      isPaused: () => false, isCancelled: () => false,
    });
    await expect(result).rejects.toThrow("boom");
    await tick(20);
    expect(active).toBe(0);
  });

  it("stops dispatching when cancelled", async () => {
    let cancelled = false;
    let ran = 0;
    await runPageFanOut({
      bundles: Array.from({ length: 50 }, (_, i) => i), concurrency: 2,
      run: async () => { ran++; if (ran === 3) cancelled = true; await tick(); return zero; },
      onUsage: () => {}, isSlotUnavailable: () => false, waitFor, sleep: tick, now: Date.now, random: () => 0,
      isPaused: () => false, isCancelled: () => cancelled,
    });
    expect(ran).toBeLessThan(6);
  });
});

describe("helpers", () => {
  it("backs off 1–2 s first, capped at 15–30 s", () => {
    expect(slotBackoffMs(0, () => 0)).toBe(1_000);
    expect(slotBackoffMs(0, () => 1)).toBe(2_000);
    expect(slotBackoffMs(10, () => 1)).toBe(30_000);
  });

  it("bundles consecutive pages of one document only", () => {
    const tasks = [{ documentId: "a" }, { documentId: "a" }, { documentId: "a" }, { documentId: "b" }];
    expect(bundlePageTasks(tasks, 2).map((bundle) => bundle.length)).toEqual([2, 1, 1]);
    expect(bundlePageTasks(tasks, 1)).toHaveLength(4);
  });
});
