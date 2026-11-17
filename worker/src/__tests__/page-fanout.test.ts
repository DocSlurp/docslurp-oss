import { describe, expect, it } from "vitest";

import { bundlePageTasks, createAdmissionBudget, runPageFanOut, slotBackoffMs } from "../temporal/page-fanout.js";

const zero = { inputTokens: 0, outputTokens: 0, costCents: 0 };
const waitFor = async (predicate: () => boolean) => {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 0));
};
const tick = (ms = 1) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class SlotDenied extends Error {}
class SpendPaused extends Error {}

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

  it("requeues a bundle refused for funds, waits for the pause and the resume, then redispatches it", async () => {
    let paused = false;
    let refusals = 0;
    const done: number[] = [];
    const sleeps: number[] = [];
    const run = runPageFanOut({
      bundles: [1, 2, 3],
      concurrency: 1,
      run: async (page) => {
        if (page === 2 && refusals === 0) { refusals++; paused = true; throw new SpendPaused(); }
        done.push(page);
        return zero;
      },
      onUsage: () => {}, isSlotUnavailable: () => false, isSpendPaused: (error) => error instanceof SpendPaused,
      waitFor, sleep: async (ms) => { sleeps.push(ms); await new Promise(() => undefined); }, now: Date.now, random: () => 0.5,
      isPaused: () => paused, isCancelled: () => false,
    });
    await tick(5);
    // Paused: nothing more is dispatched until the resume.
    expect(done).toEqual([1]);
    paused = false;
    const stats = await run;
    expect(done).toEqual([1, 2, 3]);
    expect(stats.spendPauses).toBe(1);
  });

  it("retries a spend-paused bundle after the wait when no pause signal arrives", async () => {
    let refusals = 0;
    const done: number[] = [];
    const stats = await runPageFanOut({
      bundles: [1],
      concurrency: 1,
      run: async (page) => { if (refusals++ < 2) throw new SpendPaused(); done.push(page); return zero; },
      onUsage: () => {}, isSlotUnavailable: () => false, isSpendPaused: (error) => error instanceof SpendPaused,
      waitFor, sleep: async () => { await tick(); }, now: Date.now, random: () => 0.5,
      isPaused: () => false, isCancelled: () => false,
    });
    expect(done).toEqual([1]);
    expect(stats.spendPauses).toBe(2);
  });

  it("128 lanes through many pause cycles: one probe at a time, redispatches never exhaust the admission budget (council R2-E)", async () => {
    let paused = false;
    let funded = 10;
    let cycles = 0;
    let peakAfterRefusal = 0;
    let inFlight = 0;
    let refusedSince = false;
    const done = new Set<number>();
    const stats = await runPageFanOut({
      bundles: Array.from({ length: 1_000 }, (_, i) => i),
      concurrency: 128,
      quietPeriodMs: 0,
      beforeDispatch: createAdmissionBudget(() => new Error("Admission history budget exhausted"), 1_100),
      run: async (page) => {
        inFlight += 1;
        if (refusedSince) peakAfterRefusal = Math.max(peakAfterRefusal, inFlight);
        await tick();
        inFlight -= 1;
        if (funded > 0) { funded -= 1; done.add(page); refusedSince = false; return zero; }
        refusedSince = true;
        if (!paused) { paused = true; cycles += 1; setTimeout(() => { funded = 10; paused = false; }, 3); }
        throw new SpendPaused();
      },
      onUsage: () => {}, isSlotUnavailable: () => false, isSpendPaused: (error) => error instanceof SpendPaused,
      waitFor, sleep: tick, now: Date.now, random: () => 0.5, isPaused: () => paused, isCancelled: () => false,
    });
    expect(done.size).toBe(1_000);
    expect(cycles).toBeGreaterThan(50);
    expect(stats.spendPauses).toBeGreaterThan(50);
    // After a refusal the next dispatch is a single probe, not a burst across every lane.
    expect(peakAfterRefusal).toBeLessThanOrEqual(1);
  }, 60_000);

  it("waits for the pause with the injected timed wait, so its timer can be cancelled", async () => {
    const waits: number[] = [];
    let refused = false;
    await runPageFanOut({
      bundles: [1], concurrency: 4,
      run: async () => { if (!refused) { refused = true; throw new SpendPaused(); } return zero; },
      onUsage: () => {}, isSlotUnavailable: () => false, isSpendPaused: (error) => error instanceof SpendPaused,
      waitForTimeout: async (_predicate, ms) => { waits.push(ms); },
      waitFor, sleep: async () => { throw new Error("raw sleep used"); }, now: Date.now, random: () => 0.5,
      isPaused: () => false, isCancelled: () => false, spendPauseWaitMs: 60_000,
    });
    expect(waits).toEqual([60_000]);
  });

  it("without the spend-pause rule a refusal for funds fails the fan-out as before", async () => {
    await expect(runPageFanOut({
      bundles: [1], concurrency: 1, run: async () => { throw new SpendPaused(); },
      onUsage: () => {}, isSlotUnavailable: () => false, waitFor, sleep: tick, now: Date.now, random: () => 0.5,
      isPaused: () => false, isCancelled: () => false,
    })).rejects.toBeInstanceOf(SpendPaused);
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

 it.each([1, 8, 128])("bounds prolonged contention across %i lanes and leaves pending work failed", async (concurrency) => {
   const exhausted = new Error("AdmissionExhausted");
   const admit = createAdmissionBudget(() => exhausted);
   let attempts = 0;
   let active = 0;
   await expect(runPageFanOut({
     bundles: Array.from({ length: 2000 }, (_, i) => i), concurrency,
     beforeDispatch: admit,
     run: async () => { attempts++; active++; await Promise.resolve(); active--; throw new SlotDenied(); },
     onUsage: () => { throw new Error("unexpected success"); },
     isSlotUnavailable: (error) => error instanceof SlotDenied,
     waitFor, sleep: async () => {}, now: () => 0, random: () => 0,
     isPaused: () => false, isCancelled: () => false,
   })).rejects.toBe(exhausted);
   expect(attempts).toBe(2048);
   expect(active).toBe(0);
 });

 it("charges successful dispatches to the same budget as denials", () => {
   const exhausted = new Error("AdmissionExhausted");
   const admit = createAdmissionBudget(() => exhausted, 3);
   admit(); admit(); admit();
   expect(admit).toThrow(exhausted);
   expect(admit).toThrow(exhausted);
 });
