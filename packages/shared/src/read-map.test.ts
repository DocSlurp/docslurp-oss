import { describe, expect, it } from "vitest";

import { ReadStepError } from "./read-loop-contract.js";
import { runReadMap, type ReadMapBudget } from "./read-map.js";

const budget = (over: Partial<ReadMapBudget> = {}): ReadMapBudget => ({
  maxCalls: 100,
  maxInputTokens: Infinity,
  maxCostCents: Infinity,
  maxWallMs: Infinity,
  concurrency: 3,
  ...over,
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe("runReadMap", () => {
  it("reads every item, in item order, with at most `concurrency` calls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await runReadMap({
      items: [5, 4, 3, 2, 1, 0],
      budget: budget({ concurrency: 2 }),
      map: async ({ item, index }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        for (let i = 0; i < item; i++) await tick();
        inFlight--;
        return { value: `${index}:${item}`, costCents: 1, inputTokens: 10 };
      },
    });
    expect(peak).toBe(2);
    expect(result.status).toBe("complete");
    expect(result.stoppedBy).toBe("exhausted");
    expect(result.outcomes.map((o) => (o.status === "ok" ? o.value : o.status))).toEqual(["0:5", "1:4", "2:3", "3:2", "4:1", "5:0"]);
    expect(result.usage).toMatchObject({ calls: 6, cached: 0, failed: 0, skipped: 0, inputTokens: 60, costCents: 6 });
    expect(result.error).toBeUndefined();
  });

  it("stops new calls at maxCalls and reports the rest as skipped", async () => {
    const result = await runReadMap({
      items: [1, 2, 3, 4, 5],
      budget: budget({ maxCalls: 2, concurrency: 1 }),
      map: async ({ item }) => ({ value: item, costCents: 0 }),
    });
    expect(result.status).toBe("partial");
    expect(result.stoppedBy).toBe("steps");
    expect(result.outcomes.map((o) => o.status)).toEqual(["ok", "ok", "skipped", "skipped", "skipped"]);
    expect(result.usage).toMatchObject({ calls: 2, skipped: 3 });
  });

  it("stops on the cost budget and on the external stop, both as `cost`", async () => {
    const spent = await runReadMap({
      items: [1, 2, 3],
      budget: budget({ maxCostCents: 5, concurrency: 1 }),
      map: async ({ item }) => ({ value: item, costCents: 5 }),
    });
    expect(spent.stoppedBy).toBe("cost");
    expect(spent.usage).toMatchObject({ calls: 1, skipped: 2, costCents: 5 });

    let stop = false;
    const external = await runReadMap({
      items: [1, 2, 3],
      budget: budget({ concurrency: 1 }),
      ports: { shouldStop: () => stop },
      map: async ({ item }) => {
        stop = true;
        return { value: item, costCents: 0 };
      },
    });
    expect(external.stoppedBy).toBe("cost");
    expect(external.usage).toMatchObject({ calls: 1, skipped: 2 });
  });

  it("checks the token budget before the call, using the estimate, then the provider's count", async () => {
    const result = await runReadMap({
      items: ["aaaa", "bbbb", "cccc"],
      estimateTokens: (item) => item.length,
      budget: budget({ maxInputTokens: 9, concurrency: 1 }),
      // The provider reports more than the estimate: two calls would fit by estimate alone (12 > 9 only at the third),
      // and the reported 5 + 5 leaves no room for the third's estimate either way.
      map: async ({ item }) => ({ value: item, costCents: 0, inputTokens: 5 }),
    });
    expect(result.stoppedBy).toBe("input-tokens");
    expect(result.outcomes.map((o) => o.status)).toEqual(["ok", "ok", "skipped"]);
    expect(result.usage.inputTokens).toBe(10);
  });

  it("answers from lookup without a call, and still does after a budget stopped new calls", async () => {
    const called: number[] = [];
    const result = await runReadMap({
      items: [0, 1, 2, 3],
      budget: budget({ maxCalls: 1, concurrency: 1 }),
      lookup: async ({ index }) => {
        if (index === 2) throw new Error("store down");
        return index === 3 ? { value: "cached" } : null;
      },
      map: async ({ index }) => {
        called.push(index);
        return { value: "fresh", costCents: 2 };
      },
    });
    expect(called).toEqual([0]);
    expect(result.outcomes).toEqual([
      { status: "ok", value: "fresh", cached: false },
      { status: "skipped" },
      { status: "skipped" },
      { status: "ok", value: "cached", cached: true },
    ]);
    expect(result.stoppedBy).toBe("steps");
    expect(result.usage).toMatchObject({ calls: 1, cached: 1, skipped: 2, costCents: 2 });
  });

  it("is complete with no call when every item is cached, even with a zero call budget", async () => {
    const result = await runReadMap({
      items: [1, 2],
      budget: budget({ maxCalls: 0 }),
      lookup: async ({ item }) => ({ value: item }),
      map: async () => {
        throw new Error("never");
      },
    });
    expect(result.status).toBe("complete");
    expect(result.stoppedBy).toBe("exhausted");
    expect(result.usage).toMatchObject({ calls: 0, cached: 2 });
  });

  it("stops starting items after the first failure, awaits calls in flight and keeps the error and its spend", async () => {
    const boom = new ReadStepError("provider failed", { costCents: 3, inputTokens: 7 });
    const started: number[] = [];
    const result = await runReadMap({
      items: [0, 1, 2, 3, 4],
      budget: budget({ concurrency: 2 }),
      map: async ({ index }) => {
        started.push(index);
        if (index === 0) throw boom;
        await tick();
        await tick();
        return { value: index, costCents: 1 };
      },
    });
    expect(started).toEqual([0, 1]);
    expect(result.status).toBe("partial");
    expect(result.stoppedBy).toBe("errors");
    expect(result.error).toBe(boom);
    expect(result.outcomes.map((o) => o.status)).toEqual(["failed", "ok", "skipped", "skipped", "skipped"]);
    expect(result.usage).toMatchObject({ calls: 2, failed: 1, skipped: 3, costCents: 4, inputTokens: 7 });
  });

  it("keeps going past a failure with onError continue", async () => {
    const result = await runReadMap({
      items: [0, 1, 2],
      onError: "continue",
      budget: budget({ concurrency: 1 }),
      map: async ({ index }) => {
        if (index === 1) throw new Error("bad window");
        return { value: index, costCents: 0 };
      },
    });
    expect(result.outcomes.map((o) => o.status)).toEqual(["ok", "failed", "ok"]);
    expect(result.status).toBe("partial");
    expect(result.stoppedBy).toBe("exhausted");
    expect(result.error).toBeInstanceOf(Error);
  });

  it("stops as aborted when the caller's signal fires, and starts nothing when it was already aborted", async () => {
    const ctl = new AbortController();
    const result = await runReadMap({
      items: [0, 1, 2],
      budget: budget({ concurrency: 1 }),
      ports: { signal: ctl.signal },
      map: async ({ index, signal }) => {
        if (index === 0) return { value: index, costCents: 0 };
        ctl.abort();
        expect(signal.aborted).toBe(true);
        throw new Error("aborted");
      },
    });
    expect(result.stoppedBy).toBe("aborted");
    expect(result.outcomes.map((o) => o.status)).toEqual(["ok", "failed", "skipped"]);

    let calls = 0;
    const before = await runReadMap({
      items: [0, 1],
      budget: budget(),
      ports: { signal: AbortSignal.abort() },
      lookup: async () => ({ value: 1 }),
      map: async () => {
        calls++;
        return { value: 1, costCents: 0 };
      },
    });
    expect(calls).toBe(0);
    expect(before.stoppedBy).toBe("aborted");
    expect(before.usage.skipped).toBe(2);
  });

  it("aborts calls in flight at the wall clock and reports wall-clock, not errors", async () => {
    const result = await runReadMap({
      items: [0, 1, 2],
      budget: budget({ maxWallMs: 20, concurrency: 1 }),
      map: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cut off")), { once: true });
        }),
    });
    expect(result.stoppedBy).toBe("wall-clock");
    expect(result.outcomes.map((o) => o.status)).toEqual(["failed", "skipped", "skipped"]);
    expect(result.usage.calls).toBe(1);
  });

  it("refuses a call when less than minCallWallMs remains", async () => {
    let t = 0;
    const result = await runReadMap({
      items: [0, 1],
      budget: budget({ maxWallMs: 100, minCallWallMs: 40, concurrency: 1 }),
      ports: { now: () => t },
      map: async ({ index }) => {
        t += 70;
        return { value: index, costCents: 0 };
      },
    });
    expect(result.stoppedBy).toBe("wall-clock");
    expect(result.outcomes.map((o) => o.status)).toEqual(["ok", "skipped"]);
  });

  it("handles an empty list, a throwing external check and hostile thrown values", async () => {
    const empty = await runReadMap({ items: [], budget: budget(), map: async () => ({ value: 1, costCents: 0 }) });
    expect(empty).toMatchObject({ status: "complete", stoppedBy: "exhausted", outcomes: [] });

    const hostile = Object.defineProperty({}, "costCents", {
      get() {
        throw new Error("getter");
      },
    });
    const result = await runReadMap({
      items: [0, 1],
      onError: "continue",
      budget: budget({ concurrency: 1 }),
      ports: {
        shouldStop: () => {
          throw new Error("check failed");
        },
      },
      map: async ({ index }) => {
        if (index === 0) throw hostile;
        return { value: index, costCents: Number.NaN };
      },
    });
    expect(result.outcomes.map((o) => o.status)).toEqual(["failed", "ok"]);
    expect(result.usage.costCents).toBe(0);
  });

  it("rejects an invalid budget", async () => {
    const map = async () => ({ value: 1, costCents: 0 });
    await expect(runReadMap({ items: [1], budget: budget({ maxCalls: Infinity }), map })).rejects.toThrow(/maxCalls/);
    await expect(runReadMap({ items: [1], budget: budget({ maxCostCents: Number.NaN }), map })).rejects.toThrow(/maxCostCents/);
    await expect(runReadMap({ items: [1], budget: budget({ maxWallMs: -1 }), map })).rejects.toThrow(/maxWallMs/);
  });
});
