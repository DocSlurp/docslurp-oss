import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConcurrencyLimiter,
  SearchCapacityError,
  resolveFastLaneOptions,
  resetSearchLimiterForTests,
  resolveSearchLimiterOptions,
  searchLimiterStats,
  withSearchLanes,
  withSearchSlot,
  type SearchLaneReport,
} from "../search/search-limiter.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => resetSearchLimiterForTests());

describe("search limiter", () => {
  it("derives its default from the pool size and honours env overrides", () => {
    // Native search (the default) turns on fair admission and the per-turn cap.
    expect(resolveSearchLimiterOptions({})).toEqual({ maxConcurrency: 6, maxQueue: 200, queueTimeoutMs: 30_000, maxSlotsPerGroup: 2, fairTenants: true });
    // Flag off: one FIFO queue and no per-turn cap.
    expect(resolveSearchLimiterOptions({ SEARCH_LANCEDB_NATIVE: "0" })).toEqual({ maxConcurrency: 6, maxQueue: 200, queueTimeoutMs: 30_000, maxSlotsPerGroup: 0, fairTenants: false });
    expect(resolveSearchLimiterOptions({ DATABASE_POOL_MAX: "40" }).maxConcurrency).toBe(13);
    expect(resolveSearchLimiterOptions({ DATABASE_POOL_MAX: "3" }).maxConcurrency).toBe(2);
    expect(resolveSearchLimiterOptions({ SEARCH_MAX_CONCURRENCY: "0", SEARCH_QUEUE_MAX: "5", SEARCH_QUEUE_TIMEOUT_MS: "1000" }))
      .toEqual({ maxConcurrency: 0, maxQueue: 5, queueTimeoutMs: 1_000, maxSlotsPerGroup: 2, fairTenants: true });
  });

  it("turns fair admission on with SEARCH_LANCEDB_NATIVE (the default) or SEARCH_FAIR_ADMISSION", () => {
    expect(resolveSearchLimiterOptions({})).toMatchObject({ maxSlotsPerGroup: 2, fairTenants: true });
    expect(resolveSearchLimiterOptions({ SEARCH_LANCEDB_NATIVE: "1" })).toMatchObject({ maxSlotsPerGroup: 2, fairTenants: true });
    expect(resolveSearchLimiterOptions({ SEARCH_LANCEDB_NATIVE: "0" })).toMatchObject({ maxSlotsPerGroup: 0, fairTenants: false });
    expect(resolveSearchLimiterOptions({ SEARCH_LANCEDB_NATIVE: "0", SEARCH_FAIR_ADMISSION: "1" })).toMatchObject({ maxSlotsPerGroup: 2, fairTenants: true });
    expect(resolveSearchLimiterOptions({ SEARCH_FAIR_ADMISSION: "true" })).toMatchObject({ maxSlotsPerGroup: 2, fairTenants: true });
    expect(resolveSearchLimiterOptions({ SEARCH_LANCEDB_NATIVE: "1", SEARCH_FAIR_ADMISSION: "0" })).toMatchObject({ maxSlotsPerGroup: 0, fairTenants: false });
    // A per-project trial does not change process-wide admission.
    expect(resolveSearchLimiterOptions({ SEARCH_LANCEDB_NATIVE: "0", SEARCH_LANCEDB_NATIVE_PROJECTS: "w1" })).toMatchObject({ maxSlotsPerGroup: 0, fairTenants: false });
    expect(resolveSearchLimiterOptions({ SEARCH_MAX_SLOTS_PER_TURN: "3" }).maxSlotsPerGroup).toBe(3);
  });

  it("keeps one FIFO queue across tenants and groups when fair admission is off", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueue: 50, queueTimeoutMs: 5_000, maxSlotsPerGroup: 0, fairTenants: false });
    let release!: () => void;
    const holder = limiter.run(() => new Promise<void>((resolve) => { release = resolve; }), undefined, { tenant: "org-a" });
    const order: string[] = [];
    const runs = [
      ...["a1", "a2", "a3"].map((label) => limiter.run(async () => { order.push(label); }, undefined, { tenant: "org-a", group: "turn-1" })),
      limiter.run(async () => { order.push("b1"); }, undefined, { tenant: "org-b", group: "turn-2" }),
    ];
    await sleep(1);
    release();
    await Promise.all([holder, ...runs]);
    expect(order).toEqual(["a1", "a2", "a3", "b1"]);
  });

  it("runs at most maxConcurrency searches and starts queued ones in order", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 2, maxQueue: 10, queueTimeoutMs: 5_000 });
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    await Promise.all(Array.from({ length: 6 }, (_, index) => limiter.run(async () => {
      started.push(index);
      peak = Math.max(peak, ++running);
      await sleep(10);
      running--;
    })));
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(limiter.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it("fails fast with 503 when the queue is full, and after the queue timeout", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 100 });
    let release!: () => void;
    const holder = limiter.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const waiting = limiter.run(async () => "late");
    const overflow = limiter.run(async () => "never");
    await expect(overflow).rejects.toBeInstanceOf(SearchCapacityError);
    await expect(waiting).rejects.toMatchObject({ status: 503 });
    release();
    await holder;
    expect(await limiter.run(async () => "free")).toBe("free");
    expect(limiter.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it("lets nested searches reuse their parent's slot instead of deadlocking", async () => {
    resetSearchLimiterForTests({ maxConcurrency: 1, maxQueue: 10, queueTimeoutMs: 500 });
    const result = await withSearchSlot(undefined, async () => {
      const children = await Promise.all([1, 2, 3].map((n) => withSearchSlot(undefined, async () => n * 2)));
      expect(searchLimiterStats()).toMatchObject({ running: 1, queued: 0 });
      return children;
    });
    expect(result).toEqual([2, 4, 6]);
    expect(searchLimiterStats()).toMatchObject({ running: 0 });
  });

  it("drops a queued search whose client aborts and keeps the slot count exact", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueue: 10, queueTimeoutMs: 5_000 });
    let release!: () => void;
    const holder = limiter.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    let ran = false;
    const aborted = limiter.run(async () => { ran = true; }, controller.signal);
    const next = limiter.run(async () => "next");
    expect(limiter.stats()).toMatchObject({ running: 1, queued: 2 });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(limiter.stats()).toMatchObject({ running: 1, queued: 1 });
    release();
    await holder;
    expect(await next).toBe("next");
    expect(ran).toBe(false);
    expect(limiter.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it("serves waiting tenants round-robin, so one tenant's fan-out cannot starve another", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueue: 50, queueTimeoutMs: 5_000 });
    let release!: () => void;
    const holder = limiter.run(() => new Promise<void>((resolve) => { release = resolve; }), undefined, { tenant: "a" });
    await sleep(1);
    const order: string[] = [];
    const work = (label: string, tenant: string) => limiter.run(async () => { order.push(label); await sleep(1); }, undefined, { tenant });
    // Tenant a queues six searches before tenant b's single search arrives.
    const runs = [...["a1", "a2", "a3", "a4", "a5", "a6"].map((label) => work(label, "a")), work("b1", "b")];
    expect(limiter.stats()).toMatchObject({ queued: 7, waitingTenants: 2 });
    release();
    await Promise.all([holder, ...runs]);
    // FIFO would run b1 last; fair admission runs it second.
    expect(order.indexOf("b1")).toBe(1);
    expect(order.filter((label) => label.startsWith("a"))).toEqual(["a1", "a2", "a3", "a4", "a5", "a6"]);
  });

  it("caps one admission group at maxSlotsPerGroup slots and leaves the rest to others", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 6, maxQueue: 50, queueTimeoutMs: 5_000, maxSlotsPerGroup: 2 });
    let running = 0;
    let peakTurn = 0;
    const releases: Array<() => void> = [];
    const turn = Array.from({ length: 8 }, () => limiter.run(async () => {
      peakTurn = Math.max(peakTurn, ++running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
    }, undefined, { tenant: "org-a", group: "turn-1" }));
    await sleep(1);
    expect(limiter.stats()).toMatchObject({ running: 2, queued: 6 });
    // Another turn of the same tenant still gets a slot at once.
    expect(await limiter.run(async () => "other turn", undefined, { tenant: "org-a", group: "turn-2" })).toBe("other turn");
    while (releases.length) { releases.shift()!(); await sleep(1); }
    await Promise.all(turn);
    expect(peakTurn).toBe(2);
    expect(limiter.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it("is a pass-through when disabled", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 0, maxQueue: 0, queueTimeoutMs: 100 });
    expect(await Promise.all([1, 2, 3].map((n) => limiter.run(async () => n)))).toEqual([1, 2, 3]);
  });
});

describe("search fast lane", () => {
  const main = { maxConcurrency: 2, maxQueue: 50, queueTimeoutMs: 60_000, maxSlotsPerGroup: 0, fairTenants: true };
  type Setup = { light: boolean };

  /** Admit one search whose setup takes setupMs and whose retrieval takes runMs (fake timers). */
  function search(setup: Setup, signal?: AbortSignal, tenant = "org:a", times = { setupMs: 5, runMs: 200 }) {
    const log: SearchLaneReport[] = [];
    const promise = withSearchLanes<Setup, string>(signal, { tenant }, {
      setup: async () => { await sleep(times.setupMs); return setup; },
      isLight: (value) => value.light,
      run: async () => { await sleep(setup.light ? 5 : times.runMs); return "done"; },
      onAdmitted: (report) => log.push(report),
    });
    return { promise, log };
  }

  it("keeps a search with nothing to retrieve out of the main slots", async () => {
    vi.useFakeTimers();
    try {
      resetSearchLimiterForTests(main);
      // Both main slots are busy with long retrievals; a third heavy search queues.
      const heavy = [search({ light: false }), search({ light: false }), search({ light: false })];
      await vi.advanceTimersByTimeAsync(10);
      expect(searchLimiterStats()).toMatchObject({ running: 2, queued: 1 });
      const light = search({ light: true });
      await vi.advanceTimersByTimeAsync(20);
      await expect(light.promise).resolves.toBe("done");
      expect(light.log[0]).toMatchObject({ lane: "fast", running: 2, queued: 1, mainWaitMs: 0 });
      expect(searchLimiterStats().queued).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(heavy.map((entry) => entry.promise));
      expect(searchLimiterStats()).toMatchObject({ running: 0, queued: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues a search that has something to retrieve for a main slot, as before", async () => {
    vi.useFakeTimers();
    try {
      resetSearchLimiterForTests({ ...main, maxConcurrency: 1 });
      const first = search({ light: false });
      const second = search({ light: false });
      await vi.advanceTimersByTimeAsync(10);
      expect(searchLimiterStats()).toMatchObject({ running: 1, queued: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all([first.promise, second.promise]);
      expect(first.log[0]).toMatchObject({ lane: "main", mainWaitMs: 0 });
      expect(second.log[0]!.mainWaitMs).toBeGreaterThanOrEqual(190);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the fast lane and the main slot when setup or retrieval fails or the client aborts", async () => {
    resetSearchLimiterForTests({ ...main, maxConcurrency: 1 });
    await expect(withSearchLanes(undefined, {}, {
      setup: async () => { throw new Error("setup failed"); }, isLight: () => true, run: async () => "x",
    })).rejects.toThrow("setup failed");
    await expect(withSearchLanes(undefined, {}, {
      setup: async () => ({}), isLight: () => false, run: async () => { throw new Error("retrieval failed"); },
    })).rejects.toThrow("retrieval failed");
    await expect(withSearchLanes(undefined, {}, {
      setup: async () => ({}), isLight: () => true, run: async () => { throw new Error("light failed"); },
    })).rejects.toThrow("light failed");
    // Abort while queued for a main slot, with the only main slot held.
    let release!: () => void;
    const holder = withSearchSlot(undefined, () => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const waiting = search({ light: false }, controller.signal);
    await sleep(20);
    expect(searchLimiterStats().queued).toBe(1);
    controller.abort();
    await expect(waiting.promise).rejects.toMatchObject({ name: "AbortError" });
    release();
    await holder;
    expect(searchLimiterStats()).toMatchObject({ running: 0, queued: 0 });
    // The fast lane is free again: a light search still goes through.
    await expect(search({ light: true }).promise).resolves.toBe("done");
  });

  it("keeps the queue bound and its 503 for searches that need a main slot", async () => {
    resetSearchLimiterForTests({ ...main, maxConcurrency: 1, maxQueue: 1 });
    let release!: () => void;
    const holder = withSearchSlot(undefined, () => new Promise<void>((resolve) => { release = resolve; }));
    const queued = search({ light: false });
    await sleep(20);
    await expect(search({ light: false }).promise).rejects.toBeInstanceOf(SearchCapacityError);
    // A light search is not counted against, and not refused by, the main queue.
    await expect(search({ light: true }).promise).resolves.toBe("done");
    release();
    await Promise.all([holder, queued.promise]);
  });

  it("still serves tenants fairly in the main queue and uses the org learned during setup", async () => {
    resetSearchLimiterForTests({ ...main, maxConcurrency: 1 });
    let release!: () => void;
    const holder = withSearchSlot(undefined, () => new Promise<void>((resolve) => { release = resolve; }));
    const order: string[] = [];
    const run = (label: string, tenant: string) => withSearchLanes<Setup, void>(undefined, { tenant: `project:${label}` }, {
      setup: async () => ({ light: false }), isLight: () => false, tenantOf: () => tenant,
      run: async () => { order.push(label); },
    });
    const runs = [run("a1", "org:a"), run("a2", "org:a"), run("a3", "org:a")];
    await sleep(5);
    runs.push(run("b1", "org:b"));
    await sleep(5);
    release();
    await Promise.all([holder, ...runs]);
    expect(order).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("lets nested searches reuse the parent's slot, light or not, without taking a fast-lane slot", async () => {
    resetSearchLimiterForTests({ ...main, maxConcurrency: 1 });
    const result = await withSearchLanes(undefined, {}, {
      setup: async () => ({ light: true }), isLight: () => true,
      run: () => withSearchLanes(undefined, {}, { setup: async () => 1, isLight: () => false, run: async () => "child" }),
    });
    expect(result).toBe("child");
    const heavy = await withSearchLanes(undefined, {}, {
      setup: async () => 0, isLight: () => false,
      run: () => withSearchLanes(undefined, {}, { setup: async () => 1, isLight: () => false, run: async () => "child" }),
    });
    expect(heavy).toBe("child");
  });

  it("falls back to one lane (setup inside the main slot) when SEARCH_FAST_LANE_CONCURRENCY is 0", async () => {
    expect(resolveFastLaneOptions(main, { SEARCH_FAST_LANE_CONCURRENCY: "0" })).toBeNull();
    expect(resolveFastLaneOptions(main, {})).toMatchObject({ maxConcurrency: 4, maxQueue: 50, maxSlotsPerGroup: 0 });
    expect(resolveFastLaneOptions({ ...main, maxConcurrency: 0 }, {})).toBeNull();
    const previous = process.env.SEARCH_FAST_LANE_CONCURRENCY;
    process.env.SEARCH_FAST_LANE_CONCURRENCY = "0";
    try {
      resetSearchLimiterForTests({ ...main, maxConcurrency: 1 });
      const report = search({ light: true });
      await expect(report.promise).resolves.toBe("done");
      expect(report.log[0]!.lane).toBe("main");
    } finally {
      if (previous === undefined) delete process.env.SEARCH_FAST_LANE_CONCURRENCY; else process.env.SEARCH_FAST_LANE_CONCURRENCY = previous;
    }
  });

  /**
   * Deterministic simulation (fake timers): 32 concurrent searches, two thirds against
   * projects with nothing to retrieve, 6 main slots; heavy retrieval 300 ms, setup 8 ms,
   * empty retrieval and finalize 20 ms. Prints the queue wait before (one lane) and after.
   */
  it("simulates 32 concurrent searches, two thirds with nothing to retrieve", async () => {
    const simulate = async (fastLane: boolean) => {
      vi.useFakeTimers();
      const previous = process.env.SEARCH_FAST_LANE_CONCURRENCY;
      if (!fastLane) process.env.SEARCH_FAST_LANE_CONCURRENCY = "0"; else delete process.env.SEARCH_FAST_LANE_CONCURRENCY;
      try {
        resetSearchLimiterForTests({ ...main, maxConcurrency: 6 });
        const waits: { light: boolean; waitMs: number; lane: string }[] = [];
        const runs = Array.from({ length: 32 }, (_, index) => {
          const light = index % 3 !== 0;
          const started = Date.now();
          return withSearchLanes<Setup, void>(undefined, { tenant: `org:${index % 4}` }, {
            setup: async () => { await sleep(8); return { light }; },
            isLight: (setup) => setup.light,
            run: async () => { await sleep(light ? 20 : 300); },
            onAdmitted: (report) => waits.push({ light, waitMs: report.fastWaitMs + report.mainWaitMs, lane: report.lane }),
          }).then(() => ({ light, totalMs: Date.now() - started }));
        });
        await vi.advanceTimersByTimeAsync(10_000);
        const done = await Promise.all(runs);
        const p = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]!;
        const light = done.filter((entry) => entry.light).map((entry) => entry.totalMs);
        return {
          lightCount: light.length,
          lightP50: p(light, 0.5), lightP90: p(light, 0.9),
          lightQueued: waits.filter((entry) => entry.light && entry.waitMs > 50).length,
          heavyMaxWait: Math.max(...waits.filter((entry) => !entry.light).map((entry) => entry.waitMs)),
          mainLane: waits.filter((entry) => entry.lane === "main").length,
        };
      } finally {
        if (previous === undefined) delete process.env.SEARCH_FAST_LANE_CONCURRENCY; else process.env.SEARCH_FAST_LANE_CONCURRENCY = previous;
        vi.useRealTimers();
      }
    };
    const before = await simulate(false);
    const after = await simulate(true);
    console.info("[limiter-simulation]", JSON.stringify({ before, after }));
    expect(before.lightQueued).toBeGreaterThan(10);
    expect(after.lightQueued).toBe(0);
    expect(after.lightP90).toBeLessThan(before.lightP90);
    // Heavy searches wait no longer than before (they only gain slots the light ones used to hold).
    expect(after.heavyMaxWait).toBeLessThanOrEqual(before.heavyMaxWait);
    expect(after.mainLane).toBe(32 - after.lightCount);
  });
});
