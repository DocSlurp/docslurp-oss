import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestActor } from "../lib/request-actor.js";
import type { RateLimitStore } from "../middleware/rate-limit.js";

const { apiKeySpendCents, apiKeyPagesToday } = vi.hoisted(() => ({
  apiKeySpendCents: vi.fn(async () => 0),
  apiKeyPagesToday: vi.fn(async () => 0),
}));
vi.mock("../services/usage-attribution.js", () => ({ apiKeySpendCents }));
vi.mock("../services/api-key-usage.js", () => ({ apiKeyPagesToday }));

const {
  apiActorRateLimit,
  classifyRateLimitCategory,
  createApiRateLimit,
  enforceAuthenticatedApiRateLimit,
  resetApiRateLimitBuckets,
} = await import("../middleware/rate-limit.js");

function buildIpLimitedApp(now: () => number) {
  const app = new Hono();
  app.use("*", createApiRateLimit({
    windowMs: 1_000,
    maxRequests: 2,
    keyPrefix: "test",
    now,
  }));
  app.get("/ok", (c) => c.json({ ok: true }));
  return app;
}

function actorForApiKey(keyId: string, rateLimitRpm = 60, extra: Partial<Extract<RequestActor, { type: "apiKey" }>["apiKey"]> = {}): RequestActor {
  return {
    type: "apiKey",
    userId: "user-1",
    apiKey: {
      keyId,
      userId: "user-1",
      orgId: "org-1",
      keyType: "server",
      allowedDomains: [],
      scopes: ["search"],
      rateLimitRpm,
      rateLimitPpd: 10_000,
      rateLimits: [], workspaceIds: [],
      ...extra,
    },
  };
}

function buildActorLimitedApp(actor: RequestActor, now: () => number) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("requestActor", actor);
    if (actor.type === "apiKey") {
      c.set("apiKey", actor.apiKey);
      c.set("sessionUser", { id: actor.userId, email: "", name: "API key" });
    }
    await next();
  });
  app.use("*", createApiRateLimit({
    identity: "actor",
    keyPrefix: "actor-test",
    now,
  }));
  app.get("/v1/search", (c) => c.json({ ok: true }));
  app.get("/v1/documents", (c) => c.json({ ok: true }));
  app.post("/v1/ingest", (c) => c.json({ ok: true }));
  return app;
}

describe("api rate limit middleware", () => {
  let currentTime = 1_000;

  beforeEach(() => {
    currentTime = 1_000;
    vi.unstubAllEnvs();
    vi.stubEnv("API_RATE_LIMIT_REDIS_REST_URL", "");
    vi.stubEnv("API_RATE_LIMIT_REDIS_REST_TOKEN", "");
    vi.stubEnv("API_RATE_LIMIT_REDIS_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("REDIS_URL", "");
    apiKeySpendCents.mockReset().mockResolvedValue(0);
    apiKeyPagesToday.mockReset().mockResolvedValue(0);
    resetApiRateLimitBuckets();
  });

  it("returns 429 with retry metadata after the per-identity window is exhausted", async () => {
    const app = buildIpLimitedApp(() => currentTime);

    expect((await app.request("/ok", { headers: { "x-forwarded-for": "203.0.113.10" } })).status).toBe(200);
    const second = await app.request("/ok", { headers: { "x-forwarded-for": "203.0.113.10" } });
    expect(second.status).toBe(200);
    expect(second.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(second.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(second.headers.get("RateLimit-Policy")).toBe('"free-read";q=2;w=1, "ip-burst";q=200;w=10');
    expect(second.headers.get("RateLimit")).toBe('"free-read";r=0;t=2, "ip-burst";r=198;t=9');

    const limited = await app.request("/ok", { headers: { "x-forwarded-for": "203.0.113.10" } });

    expect(limited.status).toBe(429);
    // Denied requests count against an IP, so the wait covers this one too.
    expect(limited.headers.get("Retry-After")).toBe("2");
    await expect(limited.json()).resolves.toMatchObject({
      error: "Too many requests",
      code: "rate_limited",
      retryAfterSeconds: 2,
    });
  });

  it("resets counts after the sliding window expires", async () => {
    const app = buildIpLimitedApp(() => currentTime);

    await app.request("/ok", { headers: { "x-forwarded-for": "203.0.113.11" } });
    await app.request("/ok", { headers: { "x-forwarded-for": "203.0.113.11" } });
    // The weighted previous window has fully aged out one window later.
    currentTime = 3_001;

    const response = await app.request("/ok", { headers: { "x-forwarded-for": "203.0.113.11" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("1");
  });

  it("evaluates every limit for an identity in one store call", async () => {
    const consume = vi.fn<RateLimitStore["consume"]>(async (input) => ({
      blockedMs: 0,
      denied: 0,
      counted: true,
      windows: input.counters.map(() => ({ previous: 0, current: 2 })),
    }));
    const app = new Hono();
    app.use("*", createApiRateLimit({
      windowMs: 1_000,
      maxRequests: 2,
      keyPrefix: "shared",
      now: () => currentTime,
      store: { consume },
    }));
    app.get("/ok", (c) => c.json({ ok: true }));

    const limited = await app.request("/ok", { headers: { "x-forwarded-for": "203.0.113.12" } });

    expect(limited.status).toBe(429);
    expect(consume).toHaveBeenCalledTimes(1);
    const input = consume.mock.calls[0]![0];
    expect(input.blockKey).toBe("shared:{ip:203.0.113.12}:block");
    expect(input.counters.map((counter) => counter.key)).toEqual([
      "shared:{ip:203.0.113.12}:free-read:1000",
      "shared:{ip:203.0.113.12}:ip-burst:10000",
    ]);
  });

  it("can be disabled by configuration", async () => {
    const consume = vi.fn<RateLimitStore["consume"]>();
    const app = new Hono();
    app.use("*", createApiRateLimit({
      enabled: false,
      windowMs: 1_000,
      maxRequests: 1,
      store: { consume },
    }));
    app.get("/ok", (c) => c.json({ ok: true }));

    expect((await app.request("/ok")).status).toBe(200);
    expect((await app.request("/ok")).status).toBe(200);
    expect(consume).not.toHaveBeenCalled();
  });

  it("keeps separate buckets for search and read-only endpoints", async () => {
    vi.stubEnv("API_RATE_LIMIT_SEARCH_MAX", "1");
    const app = new Hono();
    app.use("*", createApiRateLimit({
      keyPrefix: "category-test",
      now: () => currentTime,
    }));
    app.get("/v1/search", (c) => c.json({ ok: true }));
    app.get("/v1/documents", (c) => c.json({ ok: true }));

    const headers = { "x-forwarded-for": "203.0.113.13" };
    expect((await app.request("/v1/search", { headers })).status).toBe(200);

    const limitedSearch = await app.request("/v1/search", { headers });
    expect(limitedSearch.status).toBe(429);
    await expect(limitedSearch.json()).resolves.toMatchObject({ category: "search", policy: "free-search" });

    const read = await app.request("/v1/documents", { headers });
    expect(read.status).toBe(200);
    expect(read.headers.get("RateLimit-Policy")).toContain('"free-read"');
  });

  it("limits authenticated API keys by key id instead of shared IP", async () => {
    const firstKeyApp = buildActorLimitedApp(actorForApiKey("key-1", 1), () => currentTime);
    const secondKeyApp = buildActorLimitedApp(actorForApiKey("key-2", 1), () => currentTime);
    const headers = { "x-forwarded-for": "203.0.113.14" };

    expect((await firstKeyApp.request("/v1/search", { headers })).status).toBe(200);

    const limited = await firstKeyApp.request("/v1/search", { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(limited.headers.get("RateLimit-Policy")).toBe('"free-search";q=1;w=60');

    const otherKey = await secondKeyApp.request("/v1/search", { headers });
    expect(otherKey.status).toBe(200);
    expect(otherKey.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("uses distinct free, paid, and self-hosted limit profiles", async () => {
    const freeApp = buildActorLimitedApp(actorForApiKey("free-key", 60), () => currentTime);
    const paidApp = buildActorLimitedApp(actorForApiKey("paid-key", 1_000), () => currentTime);
    const selfHostedApp = new Hono();
    selfHostedApp.use("*", async (c, next) => {
      c.set("requestActor", {
        type: "session",
        userId: "user-1",
        sessionId: "session-1",
        user: { id: "user-1", email: "user@example.com", name: "User" },
      });
      await next();
    });
    selfHostedApp.use("*", createApiRateLimit({
      identity: "actor",
      profile: "self-hosted",
      keyPrefix: "profile-test",
      now: () => currentTime,
    }));
    selfHostedApp.get("/v1/documents", (c) => c.json({ ok: true }));

    const free = await freeApp.request("/v1/search");
    const paid = await paidApp.request("/v1/search");
    const selfHosted = await selfHostedApp.request("/v1/documents");

    expect(free.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(free.headers.get("RateLimit-Policy")).toContain('"free-search"');
    expect(paid.headers.get("X-RateLimit-Limit")).toBe("600");
    expect(paid.headers.get("RateLimit-Policy")).toContain('"paid-search"');
    expect(selfHosted.headers.get("X-RateLimit-Limit")).toBe("6000");
    expect(selfHosted.headers.get("RateLimit-Policy")).toContain('"self-hosted-read"');
  });

  it("never lets the legacy global API_RATE_LIMIT_MAX_REQUESTS override category policies", async () => {
    vi.stubEnv("API_RATE_LIMIT_MAX_REQUESTS", "600");
    vi.stubEnv("API_RATE_LIMIT_WINDOW_MS", "1000");
    const freeApp = buildActorLimitedApp(actorForApiKey("legacy-free-key", 60), () => currentTime);
    const paidApp = buildActorLimitedApp(actorForApiKey("legacy-paid-key", 1_000), () => currentTime);
    const ipApp = new Hono();
    ipApp.use("*", createApiRateLimit({ profile: "ip", keyPrefix: "legacy-ip", now: () => currentTime }));
    ipApp.post("/v1/ingest", (c) => c.json({ ok: true }));

    const free = await freeApp.request("/v1/ingest", { method: "POST" });
    const paid = await paidApp.request("/v1/search");
    const ip = await ipApp.request("/v1/ingest", { method: "POST", headers: { "x-forwarded-for": "203.0.113.40" } });

    expect(free.headers.get("RateLimit-Policy")).toContain('"free-upload";q=20;w=60');
    expect(paid.headers.get("RateLimit-Policy")).toContain('"paid-search";q=600;w=60');
    expect(ip.headers.get("RateLimit-Policy")).toContain('"ip-upload";q=90;w=60');
  });

  it("does not double-count actor limits when the auth middleware already checked them", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("requestActor", actorForApiKey("dedupe-key", 1));
      await next();
    });
    app.use("*", apiActorRateLimit);
    app.use("*", apiActorRateLimit);
    app.get("/v1/search", (c) => c.json({ ok: true }));

    const response = await app.request("/v1/search");

    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("does not count the dashboard shell read against the actor's limit", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("requestActor", actorForApiKey("shell-exempt-key", 1));
      await next();
    });
    app.use("*", apiActorRateLimit);
    app.get("/v1/shell", (c) => c.json({ ok: true }));
    app.get("/v1/search", (c) => c.json({ ok: true }));

    for (let index = 0; index < 3; index += 1) expect((await app.request("/v1/shell")).status).toBe(200);
    expect((await app.request("/v1/search")).status).toBe(200);
    expect((await app.request("/v1/search")).status).toBe(429);
  });

  it("approximates a rolling window by weighting the previous fixed window", async () => {
    const app = buildIpLimitedApp(() => currentTime);
    const headers = { "x-forwarded-for": "203.0.113.20" };
    currentTime = 1_000;
    expect((await app.request("/ok", { headers })).status).toBe(200);
    expect((await app.request("/ok", { headers })).status).toBe(200);

    // 25% into the next window, 75% of the previous window's 2 requests still count.
    currentTime = 2_250;
    const limited = await app.request("/ok", { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("1");

    // Denied IP traffic still counts, so this window holds the 429 above. At 60% into
    // the window after, 40% of it (0.4 of a request) remains, leaving room again.
    currentTime = 3_600;
    expect((await app.request("/ok", { headers })).status).toBe(200);
  });

  it("puts an IP in the penalty box after a suspicious burst", async () => {
    vi.stubEnv("API_RATE_LIMIT_IP_BURST_MAX", "3");
    vi.stubEnv("API_RATE_LIMIT_IP_BURST_WINDOW_MS", "10000");
    vi.stubEnv("API_RATE_LIMIT_IP_BURST_PENALTY_MS", "30000");
    const app = new Hono();
    app.use("*", createApiRateLimit({ profile: "ip", keyPrefix: "burst", now: () => currentTime }));
    app.get("/v1/documents", (c) => c.json({ ok: true }));
    const headers = { "x-forwarded-for": "198.51.100.7" };

    for (let i = 0; i < 3; i += 1) expect((await app.request("/v1/documents", { headers })).status).toBe(200);
    const burst = await app.request("/v1/documents", { headers });
    expect(burst.status).toBe(429);
    await expect(burst.json()).resolves.toMatchObject({ code: "ip_temporarily_blocked", retryAfterSeconds: 30 });

    // Still blocked after the burst window, until the penalty expires.
    currentTime += 20_000;
    expect((await app.request("/v1/documents", { headers })).status).toBe(429);
    currentTime += 11_000;
    expect((await app.request("/v1/documents", { headers })).status).toBe(200);
    // Other IPs are unaffected.
    expect((await app.request("/v1/documents", { headers: { "x-forwarded-for": "198.51.100.8" } })).status).toBe(200);
  });

  it("never jails traffic without a client IP", async () => {
    vi.stubEnv("API_RATE_LIMIT_IP_BURST_MAX", "2");
    const app = new Hono();
    app.use("*", createApiRateLimit({ profile: "ip", keyPrefix: "no-ip", now: () => currentTime }));
    app.get("/v1/documents", (c) => c.json({ ok: true }));

    for (let i = 0; i < 5; i += 1) expect((await app.request("/v1/documents")).status).toBe(200);
  });

  it("jails an IP that keeps presenting invalid API keys", async () => {
    vi.stubEnv("API_RATE_LIMIT_AUTH_FAILURE_MAX", "2");
    const app = new Hono();
    app.use("*", createApiRateLimit({ profile: "ip", keyPrefix: "auth-fail", now: () => currentTime }));
    app.get("/v1/documents", (c) => c.json({ error: "Unauthorized" }, 401));
    const headers = { "x-forwarded-for": "198.51.100.9", authorization: "Bearer dslp_priv_guess" };

    expect((await app.request("/v1/documents", { headers })).status).toBe(401);
    expect((await app.request("/v1/documents", { headers })).status).toBe(401);
    expect((await app.request("/v1/documents", { headers })).status).toBe(401);
    const jailed = await app.request("/v1/documents", { headers });
    expect(jailed.status).toBe(429);
    await expect(jailed.json()).resolves.toMatchObject({ code: "ip_temporarily_blocked", retryAfterSeconds: 900 });
  });

  it("ignores spoofed left-hand X-Forwarded-For hops", async () => {
    const app = buildIpLimitedApp(() => currentTime);
    expect((await app.request("/ok", { headers: { "x-forwarded-for": "1.1.1.1, 203.0.113.30" } })).status).toBe(200);
    expect((await app.request("/ok", { headers: { "x-forwarded-for": "2.2.2.2, 203.0.113.30" } })).status).toBe(200);
    expect((await app.request("/ok", { headers: { "x-forwarded-for": "3.3.3.3, 203.0.113.30" } })).status).toBe(429);
  });

  it("enforces a key's custom request windows across categories", async () => {
    const actor = actorForApiKey("custom-key", 1_000, { rateLimits: [{ metric: "requests", limit: 2, windowSeconds: 3_600 }] });
    const app = buildActorLimitedApp(actor, () => currentTime);

    const first = await app.request("/v1/search");
    expect(first.headers.get("RateLimit-Policy")).toBe('"paid-search";q=600;w=60, "key-requests-1h";q=2;w=3600');
    expect(first.headers.get("RateLimit")).toBe('"paid-search";r=599;t=59, "key-requests-1h";r=1;t=3599');
    expect(first.headers.get("X-RateLimit-Limit")).toBe("2");
    expect((await app.request("/v1/documents")).status).toBe(200);

    const limited = await app.request("/v1/documents");
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ code: "rate_limited", policy: "key-requests-1h" });
  });

  it("blocks cost-incurring requests once a key's spend window is exhausted", async () => {
    apiKeySpendCents.mockResolvedValue(512.4);
    const actor = actorForApiKey("spend-key", 60, { rateLimits: [{ metric: "spend", limit: 500, windowSeconds: 86_400 }] });
    const app = buildActorLimitedApp(actor, () => currentTime);

    const search = await app.request("/v1/search");
    expect(search.status).toBe(429);
    await expect(search.json()).resolves.toMatchObject({ code: "spend_limit_exceeded", limitCents: 500, policy: "key-spend-1d" });
    expect(search.headers.get("X-DocSlurp-Spend")).toBe('"key-spend-1d";q=500;r=0;w=86400;u=usd-cents');

    // Reads stay available, and the spend lookup is cached between requests.
    expect((await app.request("/v1/documents")).status).toBe(200);
    expect(apiKeySpendCents).toHaveBeenCalledTimes(1);
    expect(apiKeySpendCents).toHaveBeenCalledWith("spend-key", new Date(currentTime - 86_400_000));
  });

  it("returns 429 instead of 401 when an upload exceeds the daily page cap", async () => {
    apiKeyPagesToday.mockResolvedValue(10);
    const app = buildActorLimitedApp(actorForApiKey("pages-key", 60, { rateLimitPpd: 10 }), () => currentTime);

    const upload = await app.request("/v1/ingest", { method: "POST" });
    expect(upload.status).toBe(429);
    await expect(upload.json()).resolves.toMatchObject({ code: "daily_page_limit" });
    expect((await app.request("/v1/search")).status).toBe(200);
  });

  it("classifies upload, search, chat/AI, read-only, write, and webhook endpoints", () => {
    expect(classifyRateLimitCategory("POST", "/v1/ingest/bulk")).toBe("upload");
    expect(classifyRateLimitCategory("GET", "/v1/search")).toBe("search");
    expect(classifyRateLimitCategory("POST", "/v1/search/chat")).toBe("chat-ai");
    expect(classifyRateLimitCategory("POST", "/v1/search/batch")).toBe("search");
    expect(classifyRateLimitCategory("POST", "/v1/chat")).toBe("chat-ai");
    expect(classifyRateLimitCategory("POST", "/v1/chat/completions")).toBe("chat-ai");
    expect(classifyRateLimitCategory("POST", "/v1/workspaces/ws-1/chat")).toBe("chat-ai");
    expect(classifyRateLimitCategory("GET", "/v1/documents/doc-1")).toBe("read");
    expect(classifyRateLimitCategory("PATCH", "/v1/workspaces/ws-1")).toBe("write");
    expect(classifyRateLimitCategory("POST", "/webhooks/stripe")).toBe("webhook");
  });
});


describe("deferred route authentication", () => {
  it("does not mark anonymous requests as actor-limited before route auth", async () => {
    resetApiRateLimitBuckets();
    const app = new Hono();
    app.use("*", apiActorRateLimit);
    app.use("*", async (c, next) => {
      expect(c.get("rateLimitActorChecked")).not.toBe(true);
      c.set("requestActor", actorForApiKey("late-auth", 1));
      const limited = await enforceAuthenticatedApiRateLimit(c);
      if (limited) return limited;
      await next();
    });
    app.post("/v1/chat/completions", (c) => c.json({ ok: true }));
    expect((await app.request("/v1/chat/completions", { method: "POST" })).status).toBe(200);
    expect((await app.request("/v1/chat/completions", { method: "POST" })).status).toBe(429);
  });
});

describe("IP limiter behind Cloudflare on Fly", () => {
  beforeEach(() => {
    resetApiRateLimitBuckets();
    vi.stubEnv("FLY_APP_NAME", "docslurp-app");
    vi.stubEnv("TRUSTED_PROXIES", "cloudflare");
  });
  afterEach(() => vi.unstubAllEnvs());

  const edge = (visitor: string, extra: Record<string, string> = {}) => ({ "fly-client-ip": "104.16.1.1", "cf-connecting-ip": visitor, ...extra });

  it("keys on the visitor behind a shared Cloudflare edge, so one busy edge does not throttle others", async () => {
    const app = buildIpLimitedApp(() => 1_000);
    expect((await app.request("/ok", { headers: edge("203.0.113.1") })).status).toBe(200);
    expect((await app.request("/ok", { headers: edge("203.0.113.1") })).status).toBe(200);
    expect((await app.request("/ok", { headers: edge("203.0.113.1") })).status).toBe(429);
    expect((await app.request("/ok", { headers: edge("203.0.113.2") })).status).toBe(200);
  });

  it("cannot be evaded by rotating a spoofed CF-Connecting-IP on a direct request", async () => {
    const app = buildIpLimitedApp(() => 1_000);
    const direct = (spoof: string) => ({ "fly-client-ip": "198.51.100.7", "cf-connecting-ip": spoof });
    expect((await app.request("/ok", { headers: direct("1.1.1.1") })).status).toBe(200);
    expect((await app.request("/ok", { headers: direct("1.1.1.2") })).status).toBe(200);
    expect((await app.request("/ok", { headers: direct("1.1.1.3") })).status).toBe(429);
  });
});
