import { afterEach, describe, expect, it } from "vitest";

import {
  ConcurrencyLimiter,
  SearchCapacityError,
  resetSearchLimiterForTests,
  resolveSearchLimiterOptions,
  searchLimiterStats,
  withSearchSlot,
} from "../search/search-limiter.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => resetSearchLimiterForTests());

describe("search limiter", () => {
  it("derives its default from the pool size and honours env overrides", () => {
    // Flag off: one FIFO queue and no per-turn cap, as before fair admission.
    expect(resolveSearchLimiterOptions({})).toEqual({ maxConcurrency: 6, maxQueue: 200, queueTimeoutMs: 30_000, maxSlotsPerGroup: 0, fairTenants: false });
    expect(resolveSearchLimiterOptions({ DATABASE_POOL_MAX: "40" }).maxConcurrency).toBe(13);
    expect(resolveSearchLimiterOptions({ DATABASE_POOL_MAX: "3" }).maxConcurrency).toBe(2);
    expect(resolveSearchLimiterOptions({ SEARCH_MAX_CONCURRENCY: "0", SEARCH_QUEUE_MAX: "5", SEARCH_QUEUE_TIMEOUT_MS: "1000" }))
      .toEqual({ maxConcurrency: 0, maxQueue: 5, queueTimeoutMs: 1_000, maxSlotsPerGroup: 0, fairTenants: false });
  });

  it("turns fair admission on with SEARCH_LANCEDB_NATIVE or SEARCH_FAIR_ADMISSION", () => {
    expect(resolveSearchLimiterOptions({ SEARCH_LANCEDB_NATIVE: "1" })).toMatchObject({ maxSlotsPerGroup: 2, fairTenants: true });
    expect(resolveSearchLimiterOptions({ SEARCH_FAIR_ADMISSION: "true" })).toMatchObject({ maxSlotsPerGroup: 2, fairTenants: true });
    expect(resolveSearchLimiterOptions({ SEARCH_LANCEDB_NATIVE: "1", SEARCH_FAIR_ADMISSION: "0" })).toMatchObject({ maxSlotsPerGroup: 0, fairTenants: false });
    // A per-workspace trial does not change process-wide admission.
    expect(resolveSearchLimiterOptions({ SEARCH_LANCEDB_NATIVE_WORKSPACES: "w1" })).toMatchObject({ maxSlotsPerGroup: 0, fairTenants: false });
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
