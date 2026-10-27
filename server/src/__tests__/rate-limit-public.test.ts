import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestActor } from "../lib/request-actor.js";

const { apiKeySpendCents, apiKeyPagesToday } = vi.hoisted(() => ({
  apiKeySpendCents: vi.fn(async () => 0),
  apiKeyPagesToday: vi.fn(async () => 0),
}));
vi.mock("../services/usage-attribution.js", () => ({ apiKeySpendCents }));
vi.mock("../services/api-key-usage.js", () => ({ apiKeyPagesToday }));

const {
  classifyRateLimitCategory, createApiRateLimit, createMemoryRateLimitStore, createRedisRateLimitStore,
  logRateLimitBackendAtStartup, rateLimitAddress, resetApiRateLimitBuckets,
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
    expect(rateLimitAddress("::ffff:203.0.113.9")).toBe("::ffff:203.0.113.9");
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

describe("in-memory limiter fallback", () => {
  it("stays bounded under a flood of identities and keeps limiting", async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 1_000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 3_000; i++) {
      await store.consume({ blockKey: `b:${i}`, counters: [{ key: `k:${i}`, limit: 5, windowMs: 60_000 }], now: 1_000, countDenied: true });
    }
    expect(store.size).toBeLessThanOrEqual(1_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("evicting the oldest counters"));
    // A hot identity is still limited: eviction never turns limiting off.
    const hot = () => store.consume({ blockKey: "b:hot", counters: [{ key: "k:hot", limit: 2, windowMs: 60_000 }], now: 2_000, countDenied: false });
    expect((await hot()).denied).toBe(-1);
    expect((await hot()).denied).toBe(-1);
    expect((await hot()).denied).toBe(0);
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
    const { app } = concurrencyApp(keyActor("server", "srv-1"));
    const open = await app.request("/v1/chat", from("203.0.113.80"));
    expect(open.status).toBe(200);
    expect((await app.request("/v1/chat", from("203.0.113.81"))).status).toBe(429);
    await open.body!.cancel();
    expect(chatTurnsInFlight("key:srv-1")).toBe(0);
    expect((await app.request("/v1/chat", from("203.0.113.81"))).status).toBe(200);
  });
});
