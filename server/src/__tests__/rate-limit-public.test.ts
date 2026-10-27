import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestActor } from "../lib/request-actor.js";

const { apiKeySpendCents, apiKeyPagesToday } = vi.hoisted(() => ({
  apiKeySpendCents: vi.fn(async () => 0),
  apiKeyPagesToday: vi.fn(async () => 0),
}));
vi.mock("../services/usage-attribution.js", () => ({ apiKeySpendCents }));
vi.mock("../services/api-key-usage.js", () => ({ apiKeyPagesToday }));
const { reportPublicError } = vi.hoisted(() => ({ reportPublicError: vi.fn(() => "We couldn’t complete that request.") }));
vi.mock("../lib/public-errors.js", () => ({ reportPublicError }));

const {
  classifyRateLimitCategory, createApiRateLimit, createMemoryRateLimitStore, createRedisRateLimitStore,
  logRateLimitBackendAtStartup, rateLimitAddress, rateLimitPrefixes, resetApiRateLimitBuckets,
} = await import("../middleware/rate-limit.js");
const { chatConcurrencyLimit, chatTurnsInFlight, resetChatConcurrency } = await import("../middleware/chat-concurrency.js");

function keyActor(keyType: "server" | "client", keyId = `${keyType}-key`): RequestActor {
  return {
    type: "apiKey", userId: "user-1",
    apiKey: { keyId, userId: "user-1", orgId: "org-1", keyType, allowedDomains: keyType === "client" ? ["example.com"] : [], scopes: ["search", "chat"],
      rateLimitRpm: null, rateLimitPpd: 10_000, rateLimits: [], workspaceIds: [] },
  };
}

function actorApp(actor: RequestActor, store = createMemoryRateLimitStore()) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("requestActor", actor); await next(); });
  app.use("*", createApiRateLimit({ identity: "actor", keyPrefix: "public-test", now: () => 1_000, store }));
  app.post("/v1/chat", (c) => c.json({ ok: true }));
  app.get("/compat/meilisearch/indexes/ws/search", (c) => c.json({ ok: true }));
  return app;
}

const from = (ip: string) => ({ method: "POST", headers: { "x-forwarded-for": ip } });

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const name of ["API_RATE_LIMIT_REDIS_REST_URL", "API_RATE_LIMIT_REDIS_REST_TOKEN", "API_RATE_LIMIT_REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "REDIS_URL", "STRIPE_SECRET_KEY"]) vi.stubEnv(name, "");
  resetApiRateLimitBuckets();
  resetChatConcurrency();
});
afterEach(() => vi.unstubAllEnvs());

describe("public (browser) key limits", () => {
  it("limits each visitor of a client key on chat, so one visitor cannot use up the whole key", async () => {
    vi.stubEnv("API_RATE_LIMIT_CLIENT_VISITOR_CHAT_AI_MAX", "3");
    const app = actorApp(keyActor("client"));
    for (let i = 0; i < 3; i++) expect((await app.request("/v1/chat", from("203.0.113.5"))).status).toBe(200);
    const limited = await app.request("/v1/chat", from("203.0.113.5"));
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: "rate_limited", details: { policy: "client-visitor-chat-ai" } } });
    // The visitor's IP never appears in public policy names.
    expect(limited.headers.get("RateLimit-Policy")).not.toContain("203.0.113.5");
    // Another visitor of the same key still gets through.
    expect((await app.request("/v1/chat", from("203.0.113.6"))).status).toBe(200);
  });

  it("does not split a server key's budget per IP", async () => {
    vi.stubEnv("API_RATE_LIMIT_CLIENT_VISITOR_CHAT_AI_MAX", "1");
    const app = actorApp(keyActor("server"));
    expect((await app.request("/v1/chat", from("203.0.113.5"))).status).toBe(200);
    expect((await app.request("/v1/chat", from("203.0.113.5"))).status).toBe(200);
  });

  it("counts an IPv6 visitor as its /64, so rotating addresses inside it does not escape the limit", async () => {
    vi.stubEnv("API_RATE_LIMIT_CLIENT_VISITOR_CHAT_AI_MAX", "2");
    const app = actorApp(keyActor("client"));
    expect((await app.request("/v1/chat", from("2001:db8:1:2::1"))).status).toBe(200);
    expect((await app.request("/v1/chat", from("2001:db8:1:2:aaaa::2"))).status).toBe(200);
    expect((await app.request("/v1/chat", from("2001:0db8:0001:0002:ffff:1:2:3"))).status).toBe(429);
    expect((await app.request("/v1/chat", from("2001:db8:1:3::1"))).status).toBe(200);
  });

  it("normalizes addresses for per-IP limits", () => {
    expect(rateLimitAddress("2001:DB8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitAddress("[2001:db8:1:2:3:4:5:6]")).toBe("2001:db8:1:2::/64");
    expect(rateLimitAddress("203.0.113.9")).toBe("203.0.113.9");
    // An IPv4-mapped address counts as the IPv4 address, so both forms share a bucket.
    expect(rateLimitAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitAddress("0:0:0:0:0:ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitAddress("not-an-ip")).toBe("not-an-ip");
  });

  it("classifies every search-compat adapter as search, so search limits and key spend windows apply", () => {
    for (const path of ["/compat/algolia/1/indexes/ws/query", "/compat/meilisearch/indexes/ws/search", "/compat/typesense/multi_search", "/compat/pagefind/ws/search"]) {
      expect(classifyRateLimitCategory("POST", path), path).toBe("search");
    }
  });

  it("jails an IP that keeps presenting invalid keys to the compat adapters (403 refusals)", async () => {
    vi.stubEnv("API_RATE_LIMIT_AUTH_FAILURE_MAX", "2");
    const app = new Hono();
    app.use("*", createApiRateLimit({ profile: "ip", keyPrefix: "compat-auth", now: () => 1_000 }));
    app.get("/compat/meilisearch/indexes/ws/search", (c) => { c.set("apiKeyRejected", true); return c.json({ error: "Invalid API key" }, 403); });
    const headers = { "x-forwarded-for": "198.51.100.44", authorization: "Bearer dslp_pub_guess" };
    for (let i = 0; i < 3; i++) expect((await app.request("/compat/meilisearch/indexes/ws/search", { headers })).status).toBe(403);
    expect((await app.request("/compat/meilisearch/indexes/ws/search", { headers })).status).toBe(429);
  });
});

describe("key spend windows", () => {
  it("fails closed when the spend lookup errors: a reviewed 503, the raw cause to telemetry only", async () => {
    const actor = keyActor("client");
    if (actor.type === "apiKey") actor.apiKey.rateLimits = [{ metric: "spend", limit: 500, windowSeconds: 86_400 }];
    const cause = new Error("connection to 10.0.0.5:5432 refused (password authentication failed for docslurp_app)");
    apiKeySpendCents.mockRejectedValue(cause);
    const app = actorApp(actor);
    const refused = await app.request("/v1/chat", from("203.0.113.90"));
    expect(refused.status).toBe(503);
    expect(refused.headers.get("Retry-After")).toBe("5");
    const body = await refused.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "unavailable" } });
    expect(body).not.toContain("10.0.0.5");
    expect(body).not.toContain("docslurp_app");
    expect(reportPublicError).toHaveBeenCalledWith(cause, expect.objectContaining({ operation: "rate-limit.spend-lookup" }));
    // Not cached as zero: the next request looks again, and passes once the lookup works.
    apiKeySpendCents.mockResolvedValue(10);
    expect((await app.request("/v1/chat", from("203.0.113.90"))).status).toBe(200);
  });

  it("lets reads through when the spend lookup errors (reads never spend)", async () => {
    const actor = keyActor("server");
    if (actor.type === "apiKey") actor.apiKey.rateLimits = [{ metric: "spend", limit: 500, windowSeconds: 86_400 }];
    apiKeySpendCents.mockRejectedValue(new Error("db down"));
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("requestActor", actor); await next(); });
    app.use("*", createApiRateLimit({ identity: "actor", keyPrefix: "spend-read", now: () => 1_000 }));
    app.get("/v1/documents", (c) => c.json({ ok: true }));
    expect((await app.request("/v1/documents")).status).toBe(200);
  });
});

describe("in-memory limiter fallback", () => {
  const v6 = (prefix48: string, i: number) => `${prefix48}:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`;
  const ipConsume = (store: ReturnType<typeof createMemoryRateLimitStore>, ip: string, now = 1_000, limit = 5, penaltyMs = 0) =>
    store.consume({ blockKey: `b:${ip}`, counters: [{ key: `k:${ip}`, limit, windowMs: 60_000, penaltyMs, prefixes: rateLimitPrefixes(ip) }], now, countDenied: true });

  it("refuses new identities at capacity without resetting a live exhausted budget", async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 1_000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await ipConsume(store, "203.0.113.9", 1_000, 1);
    for (let i = 0; i < 3_000; i++) await ipConsume(store, `198.51.${i >> 8}.${i & 255}`);
    expect(store.size).toBe(1_000);
    expect((await ipConsume(store, "203.0.113.9", 2_000, 1)).denied).toBe(0);
    expect((await ipConsume(store, "203.0.113.10", 2_000)).full).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without evicting live limits"));
    expect((await ipConsume(store, "203.0.113.10", 180_000)).full).toBeUndefined();
    warn.mockRestore();
  });

  it("reserves all new counters atomically and preserves existing counters", async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 1_000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 999; i++) await ipConsume(store, `198.51.${i >> 8}.${i & 255}`);
    const result = await store.consume({ blockKey: "new", now: 1_000, countDenied: true,
      counters: ["one", "two"].map(key => ({ key, limit: 1, windowMs: 60_000 })) });
    expect(result).toMatchObject({ full: true, counted: false });
    expect(store.size).toBe(999);
    warn.mockRestore();
  });

  it("reserves prefix capacity for every new counter before changing any state", async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 1_000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 99; i++) await ipConsume(store, v6("2001:db8:aaaa", i));
    const result = await store.consume({ blockKey: "new", now: 1_000, countDenied: true,
      counters: ["prefix-one", "prefix-two"].map(key => ({ key, limit: 1, windowMs: 60_000, prefixes: rateLimitPrefixes(v6("2001:db8:aaaa", 100)) })) });
    expect(result).toMatchObject({ full: true, counted: false });
    expect(store.size).toBe(99);
    expect((await ipConsume(store, v6("2001:db8:aaaa", 0), 1_000, 1)).denied).toBe(0);
    warn.mockRestore();
  });

  it("caps one IPv6 /48's share, so its flood can't lock out new visitors from elsewhere", async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 10_000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let refused = 0;
    // 20,000 /64s inside one /48 (and many /56s): twice the whole store.
    for (let i = 0; i < 20_000; i++) if ((await ipConsume(store, v6("2001:db8:aaaa", i))).full) refused++;
    expect(refused).toBeGreaterThan(19_000);
    expect(store.size).toBeLessThanOrEqual(200);
    // Visitors from other networks still get new counters and are limited normally.
    for (let i = 0; i < 50; i++) expect((await ipConsume(store, v6(`2001:db8:${(i + 1).toString(16)}`, 1))).full).toBeUndefined();
    expect((await ipConsume(store, "203.0.113.50")).denied).toBe(-1);
    warn.mockRestore();
  });

  it("never un-jails an identity under a /48 flood or a counter flood (reviewer repros)", async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 1_000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await ipConsume(store, "198.51.100.66", 1_000, 1, 900_000);
    expect((await ipConsume(store, "198.51.100.66", 1_000, 1, 900_000)).denied).toBe(0);
    for (let i = 0; i < 5_000; i++) await ipConsume(store, v6("2001:db8:bbbb", i), 2_000);
    for (let i = 0; i < 1_200; i++) await ipConsume(store, `192.0.${i >> 8}.${i & 255}`, 2_000);
    expect((await ipConsume(store, "198.51.100.66", 3_000)).blockedMs).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("preserves even the soonest-expiring live jail when the block map fills", async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 4_000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const jail = (id: string, penaltyMs: number, now = 1_000) => store.consume({ blockKey: `b:${id}`, counters: [{ key: `k:${id}`, limit: 1, windowMs: 60_000, penaltyMs }], now, countDenied: true });
    await jail("victim", 600_000); await jail("victim", 600_000);
    for (let i = 0; i < 1_500; i++) { await jail(`attacker-${i}`, 900_000); await jail(`attacker-${i}`, 900_000); }
    expect(store.blockCount).toBe(1_000);
    expect((await jail("victim", 600_000, 2_000)).blockedMs).toBe(599_000);
    expect((await jail("new", 900_000, 2_000)).full).toBe(true);
    expect((await jail("new", 900_000, 1_000_000)).full).toBeUndefined();
    warn.mockRestore();
  });

  it("falls back to the per-process limiter when Redis is unreachable, and still denies over-limit bursts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createRedisRateLimitStore("redis://127.0.0.1:1", createMemoryRateLimitStore());
    const consume = () => store.consume({ blockKey: "b:redis", counters: [{ key: "k:redis", limit: 2, windowMs: 60_000 }], now: 1_000, countDenied: false });
    const started = Date.now();
    expect((await consume()).denied).toBe(-1);
    expect((await consume()).denied).toBe(-1);
    expect((await consume()).denied).toBe(0);
    // One bounded timeout at most, then the breaker skips Redis.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("falling back to the per-process in-memory limiter"), expect.anything());
    error.mockRestore();
  }, 15_000);

  it("logs the backend loudly at startup: memory is per-instance, disabled is an error in production", () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(logRateLimitBackendAtStartup(log)).toBe("memory");
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/backend=memory.*per-process.*N instances allow N times/));
    vi.stubEnv("API_RATE_LIMIT_REDIS_URL", "redis://redis.internal:6379");
    expect(logRateLimitBackendAtStartup(log)).toBe("redis");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("API_RATE_LIMIT_ENABLED", "false");
    expect(logRateLimitBackendAtStartup(log)).toBe("disabled");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("backend=disabled"));
  });
});

describe("chat concurrency", () => {
  function concurrencyApp(actor: RequestActor) {
    const gates: Array<() => void> = [];
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("requestActor", actor); await next(); });
    app.use("*", chatConcurrencyLimit);
    // A streaming answer that stays open until the test releases it.
    app.post("/v1/chat", () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
      gates.push(() => controller.close());
    } }), { headers: { "Content-Type": "text/event-stream" } }));
    return { app, gates };
  }

  it("caps open chat streams per visitor of a client key and frees the slot when a stream ends", async () => {
    vi.stubEnv("API_CHAT_MAX_CONCURRENT_PER_CLIENT_VISITOR", "2");
    const { app, gates } = concurrencyApp(keyActor("client", "pub-1"));
    const first = await app.request("/v1/chat", from("203.0.113.70"));
    const second = await app.request("/v1/chat", from("203.0.113.70"));
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await app.request("/v1/chat", from("203.0.113.70"));
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBe("5");
    await expect(third.json()).resolves.toMatchObject({ error: { code: "rate_limited", details: { policy: "chat-concurrency" } } });
    // Another visitor of the same key is not blocked by this one.
    expect((await app.request("/v1/chat", from("203.0.113.71"))).status).toBe(200);
    gates[0]!();
    await first.text();
    expect(chatTurnsInFlight("key:pub-1:ip:203.0.113.70")).toBe(1);
    expect((await app.request("/v1/chat", from("203.0.113.70"))).status).toBe(200);
  });

  it("caps open chat streams per key and releases on client cancel", async () => {
    vi.stubEnv("API_CHAT_MAX_CONCURRENT_PER_KEY", "1");
    const { app } = concurrencyApp(keyActor("client", "pub-cancel"));
    const open = await app.request("/v1/chat", from("203.0.113.80"));
    expect(open.status).toBe(200);
    expect((await app.request("/v1/chat", from("203.0.113.81"))).status).toBe(429);
    await open.body!.cancel();
    expect(chatTurnsInFlight("key:pub-cancel")).toBe(0);
    expect((await app.request("/v1/chat", from("203.0.113.81"))).status).toBe(200);
  });

  it("leaves server keys uncapped by default (backend batch callers), and honours a key's own concurrent rule", async () => {
    const batch = concurrencyApp(keyActor("server", "srv-batch"));
    for (let i = 0; i < 40; i++) expect((await batch.app.request("/v1/chat", from("198.51.100.1"))).status).toBe(200);
    const own = keyActor("server", "srv-own");
    if (own.type === "apiKey") own.apiKey.rateLimits = [{ metric: "concurrent", limit: 2, windowSeconds: 1 }];
    const capped = concurrencyApp(own);
    expect((await capped.app.request("/v1/chat", from("198.51.100.2"))).status).toBe(200);
    expect((await capped.app.request("/v1/chat", from("198.51.100.2"))).status).toBe(200);
    expect((await capped.app.request("/v1/chat", from("198.51.100.2"))).status).toBe(429);
  });

  it("reclaims a slot at the hard deadline when the client stops reading", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("CHAT_AGENT_TURN_DEADLINE_MS", "1000");
      vi.stubEnv("API_CHAT_MAX_CONCURRENT_PER_CLIENT_VISITOR", "1");
      const { app } = concurrencyApp(keyActor("client", "pub-stall"));
      const stalled = await app.request("/v1/chat", from("203.0.113.120"));
      expect(stalled.status).toBe(200);
      expect((await app.request("/v1/chat", from("203.0.113.120"))).status).toBe(429);
      // Never read: the slot is released at turn deadline (1 s) + grace (15 s).
      await vi.advanceTimersByTimeAsync(16_500);
      expect(chatTurnsInFlight("key:pub-stall:ip:203.0.113.120")).toBe(0);
      expect((await app.request("/v1/chat", from("203.0.113.120"))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the slot when the handler throws", async () => {
    vi.stubEnv("API_CHAT_MAX_CONCURRENT_PER_CLIENT_VISITOR", "1");
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("requestActor", keyActor("client", "pub-throw")); await next(); });
    app.use("*", chatConcurrencyLimit);
    app.post("/v1/chat", () => { throw new Error("model provider exploded"); });
    app.onError((_error, c) => c.json({ error: "failed" }, 500));
    expect((await app.request("/v1/chat", from("203.0.113.130"))).status).toBe(500);
    expect(chatTurnsInFlight("key:pub-throw:ip:203.0.113.130")).toBe(0);
    expect((await app.request("/v1/chat", from("203.0.113.130"))).status).toBe(500);
  });

  it("counts browser-key requests without a client address in one shared visitor bucket", async () => {
    vi.stubEnv("API_RATE_LIMIT_CLIENT_VISITOR_CHAT_AI_MAX", "2");
    const app = actorApp(keyActor("client", "pub-noip"));
    expect((await app.request("/v1/chat", { method: "POST" })).status).toBe(200);
    expect((await app.request("/v1/chat", { method: "POST" })).status).toBe(200);
    expect((await app.request("/v1/chat", { method: "POST" })).status).toBe(429);
  });
});
