import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createMemoryRateLimitStore,
  createRedisRateLimitStore,
  type RateLimitConsumeInput,
  type RateLimitStore,
} from "../middleware/rate-limit.js";

// Runs the Lua sliding-window script against a real Redis and checks it agrees
// with the in-process store step for step. Skipped without RATE_LIMIT_TEST_REDIS_URL.
const redisUrl = process.env.RATE_LIMIT_TEST_REDIS_URL ?? "";

/** A store that throws instead of silently falling back, so script errors fail the test. */
const failingFallback: RateLimitStore = {
  consume: async () => {
    throw new Error("Redis evaluation failed and fell back to memory");
  },
};

describe.skipIf(!redisUrl)("Redis sliding-window rate limit store", () => {
  it("matches the in-memory store for windows, denials and penalties", async () => {
    const redis = createRedisRateLimitStore(redisUrl, failingFallback);
    const memory = createMemoryRateLimitStore();
    const base = `rl-test:{${randomUUID()}}`;
    const input = (now: number, countDenied: boolean): RateLimitConsumeInput => ({
      blockKey: `${base}:block`,
      now,
      countDenied,
      counters: [
        { key: `${base}:category:1000`, limit: 3, windowMs: 1_000 },
        { key: `${base}:burst:400`, limit: 2, windowMs: 400, penaltyMs: 1_500 },
      ],
    });

    // Real Redis expires keys on wall-clock time, so keep the simulated clock near now.
    const start = Math.ceil(Date.now() / 1_000) * 1_000 + 1_000;
    const steps: Array<[number, boolean]> = [
      [0, false], [10, false], [20, false], [450, false], [460, true],
      [900, false], [1_100, true], [1_200, false], [2_100, false],
    ];
    for (const [offset, countDenied] of steps) {
      const fromRedis = await redis.consume(input(start + offset, countDenied));
      const fromMemory = await memory.consume(input(start + offset, countDenied));
      // Only the Redis store marks its answer shared; the per-process store leaves it unset.
      expect(fromMemory.shared, `step +${offset}ms`).toBeUndefined();
      expect(fromRedis, `step +${offset}ms`).toEqual({ ...fromMemory, shared: true });
    }
  });

  it("matches the in-memory store across weighted windows without penalties", async () => {
    const redis = createRedisRateLimitStore(redisUrl, failingFallback);
    const memory = createMemoryRateLimitStore();
    const base = `rl-test:{${randomUUID()}}`;
    const start = Math.ceil(Date.now() / 1_000) * 1_000 + 1_000;
    let denials = 0;
    for (let offset = 0; offset < 2_000; offset += 70) {
      const input: RateLimitConsumeInput = {
        blockKey: `${base}:block`,
        now: start + offset,
        countDenied: offset % 3 === 0,
        counters: [
          { key: `${base}:a:500`, limit: 4, windowMs: 500 },
          { key: `${base}:b:1000`, limit: 9, windowMs: 1_000 },
        ],
      };
      const fromRedis = await redis.consume(input);
      const fromMemory = await memory.consume(input);
      expect(fromMemory.shared, `step +${offset}ms`).toBeUndefined();
      expect(fromRedis, `step +${offset}ms`).toEqual({ ...fromMemory, shared: true });
      if (fromRedis.denied >= 0) denials += 1;
    }
    expect(denials).toBeGreaterThan(3);
  });

  it("re-loads the script after SCRIPT FLUSH", async () => {
    const { createClient } = await import("redis");
    const client = createClient({ url: redisUrl });
    await client.connect();
    try {
      await client.sendCommand(["SCRIPT", "FLUSH"]);
      const store = createRedisRateLimitStore(redisUrl, failingFallback);
      const result = await store.consume({
        blockKey: `rl-test:{${randomUUID()}}:block`,
        now: Date.now(),
        countDenied: false,
        counters: [{ key: `rl-test:{${randomUUID()}}:x`, limit: 1, windowMs: 1_000 }],
      });
      expect(result).toMatchObject({ blockedMs: 0, denied: -1, counted: true, shared: true });
    } finally {
      await client.quit();
    }
  });
});
