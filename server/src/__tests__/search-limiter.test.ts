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
    expect(resolveSearchLimiterOptions({})).toEqual({ maxConcurrency: 6, maxQueue: 200, queueTimeoutMs: 30_000 });
    expect(resolveSearchLimiterOptions({ DATABASE_POOL_MAX: "40" }).maxConcurrency).toBe(13);
    expect(resolveSearchLimiterOptions({ DATABASE_POOL_MAX: "3" }).maxConcurrency).toBe(2);
    expect(resolveSearchLimiterOptions({ SEARCH_MAX_CONCURRENCY: "0", SEARCH_QUEUE_MAX: "5", SEARCH_QUEUE_TIMEOUT_MS: "1000" }))
      .toEqual({ maxConcurrency: 0, maxQueue: 5, queueTimeoutMs: 1_000 });
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

  it("is a pass-through when disabled", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 0, maxQueue: 0, queueTimeoutMs: 100 });
    expect(await Promise.all([1, 2, 3].map((n) => limiter.run(async () => n)))).toEqual([1, 2, 3]);
  });
});
