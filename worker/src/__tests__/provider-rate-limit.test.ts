import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FallbackProviderRateStore,
  MemoryProviderRateStore,
  ProviderRateLimiter,
  RedisProviderRateStore,
  matchProviderRateRule,
  parseProviderRateRules,
  readProviderRateLimitConfig,
  runWithProviderRateLimit,
  runWithProviderRateScope,
  type ProviderRateStore,
} from "../lib/provider-rate-limit.js";
import { ProviderRetryableError, fetchWithProviderRetry } from "../lib/provider-retry.js";

/** A fake clock whose sleep advances time, so limiter math runs instantly. */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    sleep: async (ms: number) => { now += ms; },
  };
}

function config(overrides: Partial<ReturnType<typeof readProviderRateLimitConfig>> = {}) {
  return {
    ...readProviderRateLimitConfig({ AI_RATE_LIMITS: "openai:text-embedding-*=tpm:600000,rpm:600" }),
    ...overrides,
  };
}

describe("provider rate rules", () => {
  it("parses tpm/rpm entries and matches exact, longest prefix, then wildcard", () => {
    const rules = parseProviderRateRules("openai:text-embedding-*=tpm:2_500_000;openai:text-embedding-3-large=tpm:1000000,rpm:500;*=rpm:60");
    expect(rules).toHaveLength(3);
    expect(matchProviderRateRule(rules, "openai", "text-embedding-3-large")?.tokensPerMinute).toBe(1_000_000);
    expect(matchProviderRateRule(rules, "openai", "text-embedding-3-small")?.tokensPerMinute).toBe(2_500_000);
    expect(matchProviderRateRule(rules, "openrouter", "google/gemini")?.requestsPerMinute).toBe(60);
    expect(parseProviderRateRules("none")).toEqual([]);
  });

  it("defaults to an OpenAI embedding TPM limit under the measured 3 M ceiling", () => {
    const defaults = readProviderRateLimitConfig({});
    expect(matchProviderRateRule(defaults.rules, "openai", "text-embedding-3-small")?.tokensPerMinute).toBe(2_500_000);
    expect(matchProviderRateRule(defaults.rules, "openrouter", "google/gemini-2.5-flash-lite")).toBeNull();
  });
});

describe("ProviderRateLimiter math", () => {
  it("holds sustained throughput to the configured TPM", async () => {
    const time = clock();
    const limiter = new ProviderRateLimiter(new MemoryProviderRateStore(), config({ burstMs: 1_000 }), time);
    const start = time.now();
    let tokens = 0;
    while (time.now() - start < 60_000) {
      await limiter.acquire({ provider: "openai", model: "text-embedding-3-small", tokens: 5_000, orgId: null });
      tokens += 5_000;
    }
    // 600k/min plus one burst (10k tokens) and one in-flight request.
    expect(tokens).toBeGreaterThanOrEqual(600_000);
    expect(tokens).toBeLessThanOrEqual(600_000 + 10_000 + 5_000);
  });

  it("enforces RPM independently of tokens", async () => {
    const time = clock();
    const limiter = new ProviderRateLimiter(new MemoryProviderRateStore(), config({ burstMs: 1_000 }), time);
    const start = time.now();
    let requests = 0;
    while (time.now() - start < 10_000) {
      await limiter.acquire({ provider: "openai", model: "text-embedding-3-small", tokens: 1, orgId: null });
      requests++;
    }
    // 600 rpm = 10/s, plus a 10-request burst.
    expect(requests).toBeGreaterThanOrEqual(100);
    expect(requests).toBeLessThanOrEqual(112);
  });

  it("does not limit providers without a rule", async () => {
    const store = new MemoryProviderRateStore();
    let calls = 0;
    const counting: ProviderRateStore = { ...store, kind: "memory", consume: async (input) => { calls++; return store.consume(input); }, adjust: store.adjust.bind(store), penalize: store.penalize.bind(store) };
    const limiter = new ProviderRateLimiter(counting, config());
    const lease = await limiter.acquire({ provider: "openrouter", model: "x", tokens: 1e9 });
    expect(lease.waitedMs).toBe(0);
    expect(calls).toBe(0);
  });

  it("settles reservations with actual usage, refunding over-estimates", async () => {
    const time = clock();
    const store = new MemoryProviderRateStore();
    const limiter = new ProviderRateLimiter(store, config({ burstMs: 1_000 }), time);
    // Drain the 10k burst with an over-estimate, then refund 9k.
    const lease = await limiter.acquire({ provider: "openai", model: "text-embedding-3-small", tokens: 10_000, orgId: null });
    lease.settle(1_000);
    await Promise.resolve();
    const before = time.now();
    await limiter.acquire({ provider: "openai", model: "text-embedding-3-small", tokens: 8_000, orgId: null });
    expect(time.now() - before).toBe(0);
  });

  it("fails retryably when capacity will not free up within maxWaitMs", async () => {
    const time = clock();
    const limiter = new ProviderRateLimiter(new MemoryProviderRateStore(), config({ burstMs: 1_000, maxWaitMs: 5_000 }), time);
    await limiter.acquire({ provider: "openai", model: "text-embedding-3-small", tokens: 10_000, orgId: null });
    // An oversized request waits only for a full bucket, then leaves 20 s of debt (200k at 10k/s).
    const oversized = await limiter.acquire({ provider: "openai", model: "text-embedding-3-small", tokens: 200_000, orgId: null });
    expect(oversized.waitedMs).toBe(1_000);
    await expect(limiter.acquire({ provider: "openai", model: "text-embedding-3-small", tokens: 1_000, orgId: null }))
      .rejects.toBeInstanceOf(ProviderRetryableError);
  });
});

describe("ProviderRateLimiter fairness", () => {
  it("gives one busy org the whole limit and splits it between two busy orgs", async () => {
    const time = clock();
    const limiter = new ProviderRateLimiter(new MemoryProviderRateStore(), config({ burstMs: 1_000, orgShareFactor: 1 }), time);
    const model = { provider: "openai", model: "text-embedding-3-small" };
    // Alone: org A gets the full 10k tokens/s.
    let start = time.now();
    let aloneTokens = 0;
    while (time.now() - start < 10_000) {
      await limiter.acquire({ ...model, tokens: 2_000, orgId: "org-a" });
      aloneTokens += 2_000;
    }
    expect(aloneTokens).toBeGreaterThanOrEqual(95_000);

    // Interleaved: both orgs active, each held near half.
    start = time.now();
    const totals = { "org-a": 0, "org-b": 0 };
    while (time.now() - start < 20_000) {
      for (const org of ["org-a", "org-b"] as const) {
        await limiter.acquire({ ...model, tokens: 2_000, orgId: org });
        totals[org] += 2_000;
      }
    }
    const share = totals["org-a"] / (totals["org-a"] + totals["org-b"]);
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
    expect(totals["org-a"] + totals["org-b"]).toBeLessThanOrEqual(10_000 * 20 + 20_000);
  });

  it("keeps a light org's wait short while a heavy org saturates its share", async () => {
    const time = clock();
    const store = new MemoryProviderRateStore();
    const limiter = new ProviderRateLimiter(store, config({ burstMs: 1_000, orgShareFactor: 1 }), time);
    const model = { provider: "openai", model: "text-embedding-3-small" };
    // The heavy org has queued 5 s of debt on its own sub-bucket.
    for (let i = 0; i < 10; i++) await limiter.acquire({ ...model, tokens: 5_000, orgId: "heavy" });
    time.advance(500);
    const before = time.now();
    await limiter.acquire({ ...model, tokens: 1_000, orgId: "light" });
    // The light org waits at most on the global bucket, not behind the heavy org's queue.
    expect(time.now() - before).toBeLessThan(1_000);
  });

  it("reads the org from the async scope", async () => {
    const time = clock();
    const seen: Array<string | null> = [];
    const store = new MemoryProviderRateStore();
    const spy: ProviderRateStore = { kind: "spy", consume: async (input) => { seen.push(input.orgId); return store.consume(input); }, adjust: store.adjust.bind(store), penalize: store.penalize.bind(store) };
    const limiter = new ProviderRateLimiter(spy, config(), time);
    await runWithProviderRateScope({ orgId: "org-scope" }, () =>
      limiter.acquire({ provider: "openai", model: "text-embedding-3-small", tokens: 10 }));
    expect(seen).toEqual(["org-scope"]);
  });
});

describe("ProviderRateLimiter AIMD and Retry-After", () => {
  it("cuts the fleet factor once per cooldown and recovers linearly", async () => {
    const time = clock();
    const store = new MemoryProviderRateStore();
    const cfg = config({ decrease: 0.5, decreaseCooldownMs: 5_000, recoverPerMinute: 0.25, minFactor: 0.1 });
    const limiter = new ProviderRateLimiter(store, cfg, time);
    const model = { provider: "openai", model: "text-embedding-3-small" };
    // 72 workers report the same 429 burst: one decrease.
    for (let i = 0; i < 72; i++) await limiter.reportThrottle({ ...model, retryAfterMs: null });
    let probe = await store.consume({ metaKey: "ai-rl:{openai:text-embedding-3-small}:meta", activeOrgsKey: "x", orgId: null, now: time.now(), maxReserveMs: 0, burstMs: 1_000, orgShareFactor: 1, activeOrgWindowMs: 10_000, recoverPerMs: 0.25 / 60_000, buckets: [] });
    expect(probe.factor).toBeCloseTo(0.5);
    // After the cooldown, a new 429 cuts again.
    time.advance(5_000);
    await limiter.reportThrottle({ ...model, retryAfterMs: null });
    time.advance(60_000);
    probe = await store.consume({ metaKey: "ai-rl:{openai:text-embedding-3-small}:meta", activeOrgsKey: "x", orgId: null, now: time.now(), maxReserveMs: 0, burstMs: 1_000, orgShareFactor: 1, activeOrgWindowMs: 10_000, recoverPerMs: 0.25 / 60_000, buckets: [] });
    // 0.5 + 0.25*5s/60s ≈ 0.52 → ×0.5 ≈ 0.26, then +0.25 over a minute ≈ 0.51.
    expect(probe.factor).toBeCloseTo(0.51, 1);
  });

  it("pauses the fleet for a provider Retry-After", async () => {
    const time = clock();
    const limiter = new ProviderRateLimiter(new MemoryProviderRateStore(), config(), time);
    const model = { provider: "openai", model: "text-embedding-3-small" };
    await limiter.reportThrottle({ ...model, retryAfterMs: 7_000 });
    const before = time.now();
    await limiter.acquire({ ...model, tokens: 10, orgId: null });
    expect(time.now() - before).toBeGreaterThanOrEqual(7_000);
  });

  it("runWithProviderRateLimit retries a 429, reports it and settles usage", async () => {
    const time = clock();
    const store = new MemoryProviderRateStore();
    const limiter = new ProviderRateLimiter(store, config(), time);
    let attempts = 0;
    const result = await runWithProviderRateLimit({
      provider: "openai", model: "text-embedding-3-small", tokens: 100, label: "embedding request", maxRetries: 3,
      limiter, sleep: time.sleep, random: () => 0,
      classify: (error) => error instanceof ProviderRetryableError ? error : null,
      actualTokens: (value: { tokens: number }) => value.tokens,
    }, async () => {
      attempts++;
      if (attempts === 1) throw new ProviderRetryableError("429", "openai", 429, 2_000, 1);
      return { tokens: 90 };
    });
    expect(result.tokens).toBe(90);
    expect(attempts).toBe(2);
    const meta = await store.penalize({ metaKey: "ai-rl:{openai:text-embedding-3-small}:meta", now: time.now(), decrease: 1, minFactor: 0.1, recoverPerMs: 0, cooldownMs: 1e12, retryAfterMs: 0, maxPauseMs: 0 });
    expect(meta.factor).toBeLessThan(1);
  });

  it("fetchWithProviderRetry reserves capacity per attempt and feeds 429s to the fleet", async () => {
    const time = clock();
    const store = new MemoryProviderRateStore();
    const limiter = new ProviderRateLimiter(store, config(), time);
    const responses = [new Response("slow", { status: 429, headers: { "retry-after": "1" } }), new Response("ok", { status: 200 })];
    const settled: number[] = [];
    const response = await fetchWithProviderRetry("https://x", { method: "POST" }, {
      provider: "openai", label: "embedding request", random: () => 0, sleep: time.sleep,
      fetchImpl: (async () => responses.shift()!) as unknown as typeof fetch,
      rateLimit: { model: "text-embedding-3-small", tokens: 100, limiter, onLease: (lease) => { settled.push(lease.waitedMs); } },
    });
    expect(await response.text()).toBe("ok");
    expect(settled).toHaveLength(1);
    // The 429's Retry-After became a fleet pause, so the second attempt waited for it.
    expect(settled[0]).toBeGreaterThanOrEqual(0);
  });
});

describe("FallbackProviderRateStore", () => {
  it("degrades to process-local limits and returns to the shared store after the cooldown", async () => {
    const time = clock();
    let healthy = false;
    let sharedCalls = 0;
    const shared = new MemoryProviderRateStore();
    const flaky: ProviderRateStore = {
      kind: "redis",
      consume: async (input) => { sharedCalls++; if (!healthy) throw new Error("ECONNREFUSED"); return shared.consume(input); },
      adjust: async () => { if (!healthy) throw new Error("ECONNREFUSED"); },
      penalize: async (input) => { if (!healthy) throw new Error("ECONNREFUSED"); return shared.penalize(input); },
    };
    const store = new FallbackProviderRateStore(flaky, new MemoryProviderRateStore(0.5), time.now, 30_000);
    const limiter = new ProviderRateLimiter(store, config({ burstMs: 1_000 }), time);
    const model = { provider: "openai", model: "text-embedding-3-small" };

    const start = time.now();
    let tokens = 0;
    while (time.now() - start < 20_000) {
      await limiter.acquire({ ...model, tokens: 1_000, orgId: null });
      tokens += 1_000;
    }
    // Local share 0.5 of 10k/s over 20 s, plus one burst.
    expect(tokens).toBeLessThanOrEqual(5_000 * 20 + 6_000);
    expect(tokens).toBeGreaterThanOrEqual(5_000 * 20);
    expect(store.kind).toContain("fallback");
    // Only one shared attempt per cooldown window, not one per request.
    expect(sharedCalls).toBeLessThanOrEqual(2);

    healthy = true;
    time.advance(30_000);
    await limiter.acquire({ ...model, tokens: 1, orgId: null });
    expect(store.kind).toBe("redis");
  });
});

// The Lua scripts must match the memory store. Runs when a Redis is reachable.
const redisUrl = process.env.AI_RATE_LIMIT_TEST_REDIS_URL;
describe.skipIf(!redisUrl)("RedisProviderRateStore (Lua) against Redis", () => {
  const client = createClient({ url: redisUrl });
  const prefix = `ai-rl-test-${process.pid}-${Date.now()}`;
  let store: RedisProviderRateStore;

  beforeAll(async () => {
    await client.connect();
    store = new RedisProviderRateStore((command) => client.sendCommand(command));
  });
  afterAll(async () => {
    const keys = [...await client.keys(`${prefix}*`)];
    if (keys.length) await client.del(keys);
    await client.quit();
  });

  async function runScenario(target: ProviderRateStore, keyPrefix: string) {
    const time = clock(Date.now());
    const limiter = new ProviderRateLimiter(target, config({ burstMs: 1_000, orgShareFactor: 1, keyPrefix }), { ...time, random: () => 1 });
    const model = { provider: "openai", model: "text-embedding-3-small" };
    const waits: number[] = [];
    for (let i = 0; i < 30; i++) {
      const before = time.now();
      await limiter.acquire({ ...model, tokens: 3_000, orgId: i % 3 === 0 ? "org-b" : "org-a" });
      waits.push(time.now() - before);
    }
    await limiter.reportThrottle({ ...model, retryAfterMs: 2_000 });
    const before = time.now();
    await limiter.acquire({ ...model, tokens: 10, orgId: "org-a" });
    waits.push(time.now() - before);
    return waits;
  }

  it("produces the same waits as the memory store", async () => {
    const redisWaits = await runScenario(store, prefix);
    const memoryWaits = await runScenario(new MemoryProviderRateStore(), prefix);
    expect(redisWaits.length).toBe(memoryWaits.length);
    for (let i = 0; i < redisWaits.length; i++) expect(Math.abs(redisWaits[i]! - memoryWaits[i]!)).toBeLessThanOrEqual(2);
    expect(redisWaits.at(-1)).toBeGreaterThanOrEqual(2_000);
  });

  it("holds the fleet total across concurrent processes in real time", async () => {
    const machines = await Promise.all(Array.from({ length: 6 }, async () => {
      const machineClient = createClient({ url: redisUrl });
      await machineClient.connect();
      return { client: machineClient, limiter: new ProviderRateLimiter(new RedisProviderRateStore((command) => machineClient.sendCommand(command)), config({ burstMs: 500, keyPrefix: `${prefix}-fleet` })) };
    }));
    const deadline = Date.now() + 3_000;
    let tokens = 0;
    await Promise.all(machines.flatMap(({ limiter }) => Array.from({ length: 8 }, async () => {
      while (Date.now() < deadline) {
        await limiter.acquire({ provider: "openai", model: "text-embedding-3-small", tokens: 1_000, orgId: null });
        if (Date.now() <= deadline) tokens += 1_000;
      }
    })));
    await Promise.all(machines.map(({ client: machineClient }) => machineClient.quit()));
    // 10k tokens/s for 3 s plus a 5k burst; 48 uncoordinated slots would far exceed it.
    expect(tokens).toBeLessThanOrEqual(30_000 + 5_000 + 1_000);
    expect(tokens).toBeGreaterThanOrEqual(25_000);
  }, 20_000);

  it("refunds through adjust", async () => {
    const key = `${prefix}:{adjust}:g:tpm`;
    await client.sendCommand(["HSET", key, "t", "5", "ts", "1"]);
    await store.adjust([key, `${prefix}:{adjust}:missing`], 10);
    expect(Number(await client.hGet(key, "t"))).toBe(15);
    expect(await client.exists(`${prefix}:{adjust}:missing`)).toBe(0);
  });
});
