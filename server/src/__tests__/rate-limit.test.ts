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
const { paidOrgs, paidUsers, orgRateLimitProfile, userRateLimitProfile } = vi.hoisted(() => {
  const paidOrgs = new Set<string>();
  const paidUsers = new Set<string>();
  return {
    paidOrgs,
    paidUsers,
    orgRateLimitProfile: vi.fn(async (orgId: string) => (paidOrgs.has(orgId) ? "paid" : "free")),
    userRateLimitProfile: vi.fn(async (userId: string) => (paidUsers.has(userId) ? "paid" : "free")),
  };
});
vi.mock("../services/rate-limit-plan.js", () => ({ orgRateLimitProfile, userRateLimitProfile, resetRateLimitPlanCache: () => undefined }));

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
  app.get("/v1/ok", (c) => c.json({ ok: true }));
  return app;
}

function actorForApiKey(keyId: string, rateLimitRpm: number | null = null, extra: Partial<Extract<RequestActor, { type: "apiKey" }>["apiKey"]> = {}): RequestActor {
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
    // Generic limiter assertions exercise unbilled copy. The hosted billing
    // links group below explicitly enables Stripe and verifies decorated copy.
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("DOCSLURP_BILL_")) vi.stubEnv(key, "false");
    }
    vi.stubEnv("API_RATE_LIMIT_REDIS_REST_URL", "");
    vi.stubEnv("API_RATE_LIMIT_REDIS_REST_TOKEN", "");
    vi.stubEnv("API_RATE_LIMIT_REDIS_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("REDIS_URL", "");
    apiKeySpendCents.mockReset().mockResolvedValue(0);
    apiKeyPagesToday.mockReset().mockResolvedValue(0);
    paidOrgs.clear();
    paidOrgs.add("org-paid");
    paidUsers.clear();
    orgRateLimitProfile.mockClear();
    userRateLimitProfile.mockClear();
    resetApiRateLimitBuckets();
  });

  it("returns 429 with retry metadata after the per-identity window is exhausted", async () => {
    const app = buildIpLimitedApp(() => currentTime);

    expect((await app.request("/v1/ok", { headers: { "x-forwarded-for": "203.0.113.10" } })).status).toBe(200);
    const second = await app.request("/v1/ok", { headers: { "x-forwarded-for": "203.0.113.10" } });
    expect(second.status).toBe(200);
    expect(second.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(second.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(second.headers.get("RateLimit-Policy")).toBe('"free-read";q=2;w=1, "ip-burst";q=200;w=10');
    expect(second.headers.get("RateLimit")).toBe('"free-read";r=0;t=2, "ip-burst";r=198;t=9');

    const limited = await app.request("/v1/ok", { headers: { "x-forwarded-for": "203.0.113.10" } });

    expect(limited.status).toBe(429);
    // Denied requests count against an IP, so the wait covers this one too.
    expect(limited.headers.get("Retry-After")).toBe("2");
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "rate_limited", message: "Too many requests", details: { retryAfterSeconds: 2 } },
    });
  });

  it("keeps Retry-After and rate-limit headers on the envelope 429", async () => {
    const app = buildIpLimitedApp(() => currentTime);
    const headers = { "x-forwarded-for": "203.0.113.20" };
    await app.request("/v1/ok", { headers });
    await app.request("/v1/ok", { headers });
    const limited = await app.request("/v1/ok", { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("2");
    expect(limited.headers.get("RateLimit-Policy")).toContain('"free-read"');
    expect(limited.headers.get("RateLimit")).toContain('"free-read";r=0');
    expect(limited.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it.each(["/compat/algolia/1/indexes/ws/query", "/oauth/mcp/token", "/v1/chat/completions", "/v1/mcp"])(
    "keeps the flat { error, code } 429 body on the protocol surface %s", async (path) => {
      const app = new Hono();
      app.use("*", createApiRateLimit({ windowMs: 1_000, maxRequests: 1, keyPrefix: "protocol", now: () => currentTime }));
      app.all("*", (c) => c.json({ ok: true }));
      const headers = { "x-forwarded-for": "203.0.113.21" };
      await app.request(path, { headers });
      const limited = await app.request(path, { headers });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBeTruthy();
      await expect(limited.json()).resolves.toMatchObject({ error: "Too many requests", code: "rate_limited" });
    });

  it("resets counts after the sliding window expires", async () => {
    const app = buildIpLimitedApp(() => currentTime);

    await app.request("/v1/ok", { headers: { "x-forwarded-for": "203.0.113.11" } });
    await app.request("/v1/ok", { headers: { "x-forwarded-for": "203.0.113.11" } });
    // The weighted previous window has fully aged out one window later.
    currentTime = 3_001;

    const response = await app.request("/v1/ok", { headers: { "x-forwarded-for": "203.0.113.11" } });

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
    app.get("/v1/ok", (c) => c.json({ ok: true }));

    const limited = await app.request("/v1/ok", { headers: { "x-forwarded-for": "203.0.113.12" } });

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
    app.get("/v1/ok", (c) => c.json({ ok: true }));

    expect((await app.request("/v1/ok")).status).toBe(200);
    expect((await app.request("/v1/ok")).status).toBe(200);
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
    await expect(limitedSearch.json()).resolves.toMatchObject({ error: { code: "rate_limited", details: { category: "search", policy: "free-search" } } });

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
    const freeApp = buildActorLimitedApp(actorForApiKey("free-key"), () => currentTime);
    const paidApp = buildActorLimitedApp(actorForApiKey("paid-key", 1_000, { orgId: "org-paid" }), () => currentTime);
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

    // A key without an rpm cap gets the plan's full table.
    expect(free.headers.get("X-RateLimit-Limit")).toBe("240");
    expect(free.headers.get("RateLimit-Policy")).toContain('"free-search";q=240');
    expect(paid.headers.get("X-RateLimit-Limit")).toBe("600");
    expect(paid.headers.get("RateLimit-Policy")).toContain('"paid-search"');
    expect(selfHosted.headers.get("X-RateLimit-Limit")).toBe("6000");
    expect(selfHosted.headers.get("RateLimit-Policy")).toContain('"self-hosted-read"');
  });

  it("never lets the legacy global API_RATE_LIMIT_MAX_REQUESTS override category policies", async () => {
    vi.stubEnv("API_RATE_LIMIT_MAX_REQUESTS", "600");
    vi.stubEnv("API_RATE_LIMIT_WINDOW_MS", "1000");
    const freeApp = buildActorLimitedApp(actorForApiKey("legacy-free-key", 1_000), () => currentTime);
    const paidApp = buildActorLimitedApp(actorForApiKey("legacy-paid-key", 1_000, { orgId: "org-paid" }), () => currentTime);
    const ipApp = new Hono();
    ipApp.use("*", createApiRateLimit({ profile: "ip", keyPrefix: "legacy-ip", now: () => currentTime }));
    ipApp.post("/v1/ingest", (c) => c.json({ ok: true }));

    const free = await freeApp.request("/v1/ingest", { method: "POST" });
    const paid = await paidApp.request("/v1/search");
    const ip = await ipApp.request("/v1/ingest", { method: "POST", headers: { "x-forwarded-for": "203.0.113.40" } });

    expect(free.headers.get("RateLimit-Policy")).toContain('"free-upload";q=60;w=60');
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

  it("does not count the dashboard bootstrap read against the actor's limit", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("requestActor", actorForApiKey("shell-exempt-key", 1));
      await next();
    });
    app.use("/v1/*", apiActorRateLimit);
    app.get("/dashboard/bootstrap", (c) => c.json({ ok: true }));
    app.get("/v1/search", (c) => c.json({ ok: true }));

    for (let index = 0; index < 3; index += 1) expect((await app.request("/dashboard/bootstrap")).status).toBe(200);
    expect((await app.request("/v1/search")).status).toBe(200);
    expect((await app.request("/v1/search")).status).toBe(429);
  });

  it("approximates a rolling window by weighting the previous fixed window", async () => {
    const app = buildIpLimitedApp(() => currentTime);
    const headers = { "x-forwarded-for": "203.0.113.20" };
    currentTime = 1_000;
    expect((await app.request("/v1/ok", { headers })).status).toBe(200);
    expect((await app.request("/v1/ok", { headers })).status).toBe(200);

    // 25% into the next window, 75% of the previous window's 2 requests still count.
    currentTime = 2_250;
    const limited = await app.request("/v1/ok", { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("1");

    // Denied IP traffic still counts, so this window holds the 429 above. At 60% into
    // the window after, 40% of it (0.4 of a request) remains, leaving room again.
    currentTime = 3_600;
    expect((await app.request("/v1/ok", { headers })).status).toBe(200);
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
    await expect(burst.json()).resolves.toMatchObject({ error: { code: "ip_temporarily_blocked", details: { retryAfterSeconds: 30 } } });

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
    await expect(jailed.json()).resolves.toMatchObject({ error: { code: "ip_temporarily_blocked", details: { retryAfterSeconds: 900 } } });
  });

  it("ignores spoofed left-hand X-Forwarded-For hops", async () => {
    const app = buildIpLimitedApp(() => currentTime);
    expect((await app.request("/v1/ok", { headers: { "x-forwarded-for": "1.1.1.1, 203.0.113.30" } })).status).toBe(200);
    expect((await app.request("/v1/ok", { headers: { "x-forwarded-for": "2.2.2.2, 203.0.113.30" } })).status).toBe(200);
    expect((await app.request("/v1/ok", { headers: { "x-forwarded-for": "3.3.3.3, 203.0.113.30" } })).status).toBe(429);
  });

  it("enforces a key's custom request windows across categories", async () => {
    const actor = actorForApiKey("custom-key", 1_000, { orgId: "org-paid", rateLimits: [{ metric: "requests", limit: 2, windowSeconds: 3_600 }] });
    const app = buildActorLimitedApp(actor, () => currentTime);

    const first = await app.request("/v1/search");
    expect(first.headers.get("RateLimit-Policy")).toBe('"paid-search";q=600;w=60, "key-requests-1h";q=2;w=3600');
    expect(first.headers.get("RateLimit")).toBe('"paid-search";r=599;t=59, "key-requests-1h";r=1;t=3599');
    expect(first.headers.get("X-RateLimit-Limit")).toBe("2");
    expect((await app.request("/v1/documents")).status).toBe(200);

    const limited = await app.request("/v1/documents");
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: "rate_limited", details: { policy: "key-requests-1h" } } });
  });

  it("blocks cost-incurring requests once a key's spend window is exhausted", async () => {
    apiKeySpendCents.mockResolvedValue(512.4);
    const actor = actorForApiKey("spend-key", 60, { rateLimits: [{ metric: "spend", limit: 500, windowSeconds: 86_400 }] });
    const app = buildActorLimitedApp(actor, () => currentTime);

    const search = await app.request("/v1/search");
    expect(search.status).toBe(429);
    await expect(search.json()).resolves.toMatchObject({ error: { code: "spend_limit_exceeded", details: { limitCents: 500, policy: "key-spend-1d" } } });
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
    await expect(upload.json()).resolves.toMatchObject({ error: { code: "daily_page_limit", details: { category: "upload" } } });
    expect((await app.request("/v1/search")).status).toBe(200);
  });

  describe("plan-based profiles", () => {
    function sessionApp(userId: string) {
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("requestActor", { type: "session", userId, sessionId: `session-${userId}`, user: { id: userId, email: "", name: "User" } });
        await next();
      });
      app.use("*", createApiRateLimit({ identity: "actor", keyPrefix: "session-plan", now: () => currentTime }));
      app.post("/v1/chat", (c) => c.json({ ok: true }));
      return app;
    }

    it("gives a paid organization's default key the full paid table", async () => {
      const app = buildActorLimitedApp(actorForApiKey("paid-default", null, { orgId: "org-paid" }), () => currentTime);
      const search = await app.request("/v1/search");
      expect(search.headers.get("RateLimit-Policy")).toContain('"paid-search";q=600;w=60');
      expect(orgRateLimitProfile).toHaveBeenCalledWith("org-paid", currentTime);
    });

    it("gives a Free organization's default key search 240 and chat 60 a minute", async () => {
      const app = buildActorLimitedApp(actorForApiKey("free-default"), () => currentTime);
      app.post("/v1/chat", (c) => c.json({ ok: true }));
      expect((await app.request("/v1/search")).headers.get("RateLimit-Policy")).toBe('"free-search";q=240;w=60');
      expect((await app.request("/v1/chat", { method: "POST" })).headers.get("RateLimit-Policy")).toBe('"free-chat-ai";q=60;w=60');
    });

    it("lets an explicit key rpm cap every category below the plan", async () => {
      const app = buildActorLimitedApp(actorForApiKey("capped", 30, { orgId: "org-paid" }), () => currentTime);
      app.post("/v1/chat", (c) => c.json({ ok: true }));
      expect((await app.request("/v1/search")).headers.get("RateLimit-Policy")).toBe('"paid-search";q=30;w=60');
      expect((await app.request("/v1/chat", { method: "POST" })).headers.get("RateLimit-Policy")).toBe('"paid-chat-ai";q=30;w=60');
      const zero = buildActorLimitedApp(actorForApiKey("zero-cap", 0), () => currentTime);
      expect((await zero.request("/v1/search")).headers.get("RateLimit-Policy")).toBe('"free-search";q=240;w=60');
    });

    it("keeps a free organization on the free table even when its key's rpm is raised", async () => {
      const app = buildActorLimitedApp(actorForApiKey("free-raised", 10_000), () => currentTime);
      const search = await app.request("/v1/search");
      expect(search.headers.get("RateLimit-Policy")).toContain('"free-search";q=240;w=60');
      const read = await app.request("/v1/documents");
      expect(read.headers.get("RateLimit-Policy")).toContain('"free-read";q=600;w=60');
      const upload = await app.request("/v1/ingest", { method: "POST" });
      expect(upload.headers.get("RateLimit-Policy")).toContain('"free-upload";q=60;w=60');
    });

    it("uses the raised Free numbers for chat and writes", async () => {
      const free = sessionApp("free-user");
      const chat = await free.request("/v1/chat", { method: "POST" });
      expect(chat.headers.get("RateLimit-Policy")).toBe('"free-chat-ai";q=60;w=60');
    });

    it("gives a session the paid table when any of the user's organizations is paid", async () => {
      paidUsers.add("paid-user");
      const chat = await sessionApp("paid-user").request("/v1/chat", { method: "POST" });
      expect(chat.headers.get("RateLimit-Policy")).toBe('"paid-chat-ai";q=120;w=60');
      expect(userRateLimitProfile).toHaveBeenCalledWith("paid-user", currentTime);
    });

    it("still honors per-profile env overrides and API_RATE_LIMIT_DEFAULT_PROFILE=paid", async () => {
      vi.stubEnv("API_RATE_LIMIT_FREE_SEARCH_MAX", "7");
      const free = buildActorLimitedApp(actorForApiKey("override-free", 1_000), () => currentTime);
      expect((await free.request("/v1/search")).headers.get("RateLimit-Policy")).toContain('"free-search";q=7;w=60');
      vi.stubEnv("API_RATE_LIMIT_DEFAULT_PROFILE", "paid");
      const forced = buildActorLimitedApp(actorForApiKey("override-forced", 1_000), () => currentTime);
      expect((await forced.request("/v1/search")).headers.get("RateLimit-Policy")).toContain('"paid-search";q=600;w=60');
    });

    it("never looks up a plan on self-hosted deployments", async () => {
      vi.stubEnv("DOCSLURP_DEPLOYMENT_MODE", "self-hosted");
      const app = buildActorLimitedApp(actorForApiKey("self-hosted-key", 10_000), () => currentTime);
      expect((await app.request("/v1/search")).headers.get("RateLimit-Policy")).toContain('"self-hosted-search";q=1800;w=60');
      expect(orgRateLimitProfile).not.toHaveBeenCalled();
    });
  });

  describe("limit links", () => {
    beforeEach(() => {
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_links");
      vi.stubEnv("APP_URL", "https://docslurp.io");
    });

    it("tells a starter caller that buying credits raises the limits, with links and a Link header", async () => {
      const app = buildActorLimitedApp(actorForApiKey("free-links", 1), () => currentTime);
      await app.request("/v1/search");
      const limited = await app.request("/v1/search");
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Link")).toBe('<https://docslurp.io/app/billing>; rel="payment", <https://docslurp.io/app/billing#bl-topup>; rel="payment"; title="Buy credits", <https://docslurp.io/docs/http#rate-limits-and-headers>; rel="help"');
      const body = await limited.json() as { error: { message: string; details: Record<string, unknown> } };
      expect(body.error.message).toBe("Starter rate limit reached. Accounts that have bought credits get higher limits: buy credits at https://docslurp.io/app/billing#bl-topup, or wait for Retry-After and try again.");
      expect(body.error.details).toMatchObject({
        account: "starter", policy: "free-search",
        links: {
          billing: "https://docslurp.io/app/billing",
          buyCredits: "https://docslurp.io/app/billing#bl-topup",
          docs: "https://docslurp.io/docs/http#rate-limits-and-headers",
        },
      });
    });

    it("links funded-org limits to the docs without the buy-credits nudge", async () => {
      const app = buildActorLimitedApp(actorForApiKey("paid-links", 1, { orgId: "org-paid" }), () => currentTime);
      await app.request("/v1/search");
      const body = await (await app.request("/v1/search")).json() as { error: { message: string; details: { account: string } } };
      expect(body.error.details.account).toBe("funded");
      expect(body.error.message).toBe("Please wait a moment before trying again. Rate limits: https://docslurp.io/docs/http#rate-limits-and-headers");
    });

    it("links key spend and daily page limits to the API key settings", async () => {
      apiKeySpendCents.mockResolvedValue(600);
      const spend = buildActorLimitedApp(actorForApiKey("spend-links", 60, { rateLimits: [{ metric: "spend", limit: 500, windowSeconds: 86_400 }] }), () => currentTime);
      const spent = await (await spend.request("/v1/search")).json() as { error: { message: string; details: { links: Record<string, string> } } };
      expect(spent.error.details.links.apiKeys).toBe("https://docslurp.io/app/api-keys");
      expect(spent.error.message).toContain("https://docslurp.io/app/api-keys");

      apiKeyPagesToday.mockResolvedValue(10);
      const pages = buildActorLimitedApp(actorForApiKey("pages-links", 60, { rateLimitPpd: 10 }), () => currentTime);
      const capped = await (await pages.request("/v1/ingest", { method: "POST" })).json() as { error: { code: string; details: { links: Record<string, string> } } };
      expect(capped.error).toMatchObject({ code: "daily_page_limit", details: { links: { apiKeys: "https://docslurp.io/app/api-keys", buyCredits: "https://docslurp.io/app/billing#bl-topup" } } });
    });

    it("only links the docs for IP-level limits", async () => {
      const headers = { "x-forwarded-for": "203.0.113.90" };
      const ipApp = new Hono();
      ipApp.use("*", createApiRateLimit({ profile: "ip", maxRequests: 1, keyPrefix: "ip-links", now: () => currentTime }));
      ipApp.get("/v1/ok", (c) => c.json({ ok: true }));
      await ipApp.request("/v1/ok", { headers });
      const body = await (await ipApp.request("/v1/ok", { headers })).json() as { error: { details: { links: Record<string, string> } } };
      expect(body.error.details.links).toEqual({ docs: "https://docslurp.io/docs/http#rate-limits-and-headers" });
    });

    it("keeps links on protocol surfaces' flat 429 body", async () => {
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("requestActor", actorForApiKey("protocol-links", 1));
        await next();
      });
      app.use("*", createApiRateLimit({ identity: "actor", keyPrefix: "protocol-links", now: () => currentTime }));
      app.all("*", (c) => c.json({ ok: true }));
      await app.request("/v1/chat/completions", { method: "POST" });
      const limited = await app.request("/v1/chat/completions", { method: "POST" });
      await expect(limited.json()).resolves.toMatchObject({ code: "rate_limited", account: "starter", links: { buyCredits: "https://docslurp.io/app/billing#bl-topup" } });
    });

    it("omits links on self-hosted deployments and on deployments without billing", async () => {
      vi.stubEnv("DOCSLURP_DEPLOYMENT_MODE", "self-hosted");
      const selfHosted = buildActorLimitedApp(actorForApiKey("self-hosted-links", 1), () => currentTime);
      await selfHosted.request("/v1/search");
      const limited = await selfHosted.request("/v1/search");
      expect(limited.headers.get("Link")).toBeNull();
      const body = await limited.json() as { error: { message: string; details: Record<string, unknown> } };
      expect(body.error.message).toBe("Too many requests");
      expect(body.error.details.links).toBeUndefined();

      vi.stubEnv("DOCSLURP_DEPLOYMENT_MODE", "");
      vi.stubEnv("STRIPE_SECRET_KEY", "");
      const unbilled = buildActorLimitedApp(actorForApiKey("unbilled-links", 1), () => currentTime);
      await unbilled.request("/v1/search");
      const unbilledBody = await (await unbilled.request("/v1/search")).json() as { error: { details: Record<string, unknown> } };
      expect(unbilledBody.error.details.links).toBeUndefined();
    });
  });

  it("classifies upload, search, chat/AI, read-only, write, and webhook endpoints", () => {
    expect(classifyRateLimitCategory("POST", "/v1/ingest/bulk")).toBe("upload");
    expect(classifyRateLimitCategory("POST", "/v1/uploads/bulk")).toBe("upload");
    expect(classifyRateLimitCategory("POST", "/v1/uploads/direct/sessions")).toBe("upload");
    expect(classifyRateLimitCategory("GET", "/v1/search")).toBe("search");
    expect(classifyRateLimitCategory("POST", "/v1/search/chat")).toBe("chat-ai");
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
    expect((await app.request("/v1/ok", { headers: edge("203.0.113.1") })).status).toBe(200);
    expect((await app.request("/v1/ok", { headers: edge("203.0.113.1") })).status).toBe(200);
    expect((await app.request("/v1/ok", { headers: edge("203.0.113.1") })).status).toBe(429);
    expect((await app.request("/v1/ok", { headers: edge("203.0.113.2") })).status).toBe(200);
  });

  it("cannot be evaded by rotating a spoofed CF-Connecting-IP on a direct request", async () => {
    const app = buildIpLimitedApp(() => 1_000);
    const direct = (spoof: string) => ({ "fly-client-ip": "198.51.100.7", "cf-connecting-ip": spoof });
    expect((await app.request("/v1/ok", { headers: direct("1.1.1.1") })).status).toBe(200);
    expect((await app.request("/v1/ok", { headers: direct("1.1.1.2") })).status).toBe(200);
    expect((await app.request("/v1/ok", { headers: direct("1.1.1.3") })).status).toBe(429);
  });
});
