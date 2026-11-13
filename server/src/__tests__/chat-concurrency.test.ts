import { createServer } from "node:net";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestActor } from "../lib/request-actor.js";
import {
  acquireChatSlots,
  assertChatConcurrencyBackend,
  chatConcurrencyLimit,
  chatTurnsInFlight,
  createRedisChatSlotBackend,
  DURABLE_REDIS_CHAT_SLOT_PREFIX,
  resetChatConcurrency,
  resolveChatSlotBackendConfig,
  type ChatSlotBackend,
} from "../middleware/chat-concurrency.js";

const counters = [{ key: "key:down", cap: 1, tag: "down" }];
const failing: ChatSlotBackend = {
  acquire: vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }),
  release: vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }),
};

/** A loopback port with nothing listening. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function serverKeyActor(keyId: string): RequestActor {
  return {
    type: "apiKey", userId: "user-1",
    apiKey: { keyId, userId: "user-1", orgId: "org-1", keyType: "server", allowedDomains: [], scopes: ["search", "chat"],
      rateLimitRpm: null, rateLimitPpd: 10_000, rateLimits: [], projectIds: [] },
  };
}

const SHARED_VARIABLES = ["API_RATE_LIMIT_REDIS_URL", "REDIS_URL", "API_RATE_LIMIT_REDIS_REST_URL", "API_RATE_LIMIT_REDIS_REST_TOKEN",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "MASTRA_REDIS_URL", "CHAT_CONCURRENCY_LOCAL_ONLY"];

describe("chat slots when the shared Redis is down", () => {
  beforeEach(() => {
    resetChatConcurrency();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("refuses in production instead of counting per process (fail closed)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await acquireChatSlots(counters, 60_000, failing)).toBe("unavailable");
    // During the retry backoff the backend is skipped, and the turn is still refused.
    expect(await acquireChatSlots(counters, 60_000, failing)).toBe("unavailable");
    expect(failing.acquire).toHaveBeenCalledTimes(1);
    expect(chatTurnsInFlight("key:down")).toBe(0);
  });

  it("falls back to per-process counting outside production, still enforcing the cap", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const slot = await acquireChatSlots(counters, 60_000, failing);
    expect(typeof slot).toBe("object");
    expect(chatTurnsInFlight("key:down")).toBe(1);
    expect(await acquireChatSlots(counters, 60_000, failing)).toBe("full");
    if (typeof slot === "object") slot.release();
    expect(chatTurnsInFlight("key:down")).toBe(0);
  });

  it("answers 503 chat_capacity_unavailable in production with a real client pointed at an unreachable Redis, and never hangs past its timeout", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const name of SHARED_VARIABLES) vi.stubEnv(name, "");
    vi.stubEnv("REDIS_URL", `redis://127.0.0.1:${await closedPort()}`);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("requestActor", serverKeyActor("srv-down")); await next(); });
    app.use("*", chatConcurrencyLimit);
    app.post("/v1/chat", (c) => c.json({ ok: true }));
    const started = Date.now();
    const response = await app.request("/v1/chat", { method: "POST" });
    // Not a 429: the caller is under its cap; the slot store is what failed.
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: {
      code: "chat_capacity_unavailable", message: "Chat is temporarily unavailable. Please try again in a few seconds.",
      details: { policy: "chat-concurrency", retryAfterSeconds: 5 },
    } });
    // The raw Redis error stays in the logs.
    expect(text).not.toMatch(/ECONNREFUSED|redis|127\.0\.0\.1|Too many chat requests/i);
    expect(Date.now() - started).toBeLessThan(3_000);
    // One alertable line per refusal, including refusals inside the retry backoff.
    const refusals = () => vi.mocked(console.error).mock.calls.filter(([line]) => line === "[chat-concurrency] status=refused reason=backend-unavailable").length;
    expect(refusals()).toBe(1);
    expect((await app.request("/v1/chat", { method: "POST" })).status).toBe(503);
    expect(refusals()).toBe(2);
    // Sessions and uncapped keys never touch the shared store.
    vi.stubEnv("API_CHAT_MAX_CONCURRENT_PER_SERVER_KEY", "0");
    expect((await app.request("/v1/chat", { method: "POST" })).status).toBe(200);
  });

  it("keeps 429 rate_limited for a full cap", async () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const name of SHARED_VARIABLES) vi.stubEnv(name, "");
    vi.stubEnv("API_CHAT_MAX_CONCURRENT_PER_SERVER_KEY", "1");
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("requestActor", serverKeyActor("srv-full")); await next(); });
    app.use("*", chatConcurrencyLimit);
    app.post("/v1/chat", () => new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } }));
    const open = await app.request("/v1/chat", { method: "POST" });
    const refused = await app.request("/v1/chat", { method: "POST" });
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "rate_limited", details: { policy: "chat-concurrency" } } });
    await open.body!.cancel();
  });

  it("rejects, never resolves a slot, when the Redis backend cannot be reached", async () => {
    const port = await closedPort();
    const backend = createRedisChatSlotBackend(`redis://127.0.0.1:${port}`);
    await expect(backend.acquire(counters, 1_000, "lease")).rejects.toThrow();
    await backend.close?.();
  });
});

describe("chat slot backend at startup", () => {
  const production = (extra: Record<string, string | undefined> = {}) => ({ NODE_ENV: "production", ...extra });
  beforeEach(() => {
    resetChatConcurrency();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("refuses to start in production with no shared backend, naming the variables", () => {
    const warn = vi.fn();
    expect(() => assertChatConcurrencyBackend(production(), { warn })).toThrow(
      /API_RATE_LIMIT_REDIS_URL, REDIS_URL, API_RATE_LIMIT_REDIS_REST_URL with API_RATE_LIMIT_REDIS_REST_TOKEN .*MASTRA_REDIS_URL.*CHAT_CONCURRENCY_LOCAL_ONLY=1/);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { API_RATE_LIMIT_REDIS_REST_URL: "https://redis.example.com" },
    { API_RATE_LIMIT_REDIS_REST_TOKEN: "token" },
    { UPSTASH_REDIS_REST_URL: "https://redis.example.com" },
    // Half a pair is a misconfiguration even when another backend would be picked.
    { UPSTASH_REDIS_REST_TOKEN: "token", MASTRA_REDIS_URL: "redis://durable:6379" },
  ])("refuses to start in production with half of a REST pair: %o", (half) => {
    const error = (() => { try { assertChatConcurrencyBackend(production(half), { warn: vi.fn() }); } catch (e) { return e as Error; } })();
    expect(error?.message).toMatch(/half configured.*API_RATE_LIMIT_REDIS_REST_URL and API_RATE_LIMIT_REDIS_REST_TOKEN/);
    // Names variables only, never their values.
    expect(error?.message).not.toMatch(/redis\.example\.com|token"|durable:6379/);
  });

  it("starts in production with CHAT_CONCURRENCY_LOCAL_ONLY=1, warns once and counts per process", async () => {
    const warn = vi.fn();
    expect(assertChatConcurrencyBackend(production({ CHAT_CONCURRENCY_LOCAL_ONLY: "1" }), { warn })).toBe("local");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/^\[chat-concurrency\] backend=local: .*per process/);
    vi.stubEnv("NODE_ENV", "production");
    for (const name of SHARED_VARIABLES) vi.stubEnv(name, "");
    vi.stubEnv("CHAT_CONCURRENCY_LOCAL_ONLY", "1");
    const counters = [{ key: "key:local-only", cap: 1, tag: "local-only" }];
    const slot = await acquireChatSlots(counters, 60_000);
    expect(typeof slot).toBe("object");
    expect(chatTurnsInFlight("key:local-only")).toBe(1);
    expect(await acquireChatSlots(counters, 60_000)).toBe("full");
    if (typeof slot === "object") slot.release();
  });

  it("refuses turns in production when a host skipped the startup check and nothing is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const name of SHARED_VARIABLES) vi.stubEnv(name, "");
    expect(await acquireChatSlots([{ key: "key:unconfigured", cap: 1, tag: "unconfigured" }], 60_000)).toBe("unavailable");
    expect(chatTurnsInFlight("key:unconfigured")).toBe(0);
    expect(console.error).toHaveBeenCalledWith("[chat-concurrency] status=refused reason=backend-not-configured");
  });

  it("uses the durable-chat Redis when it is the only one configured, under its own key prefix", () => {
    const env = production({ MASTRA_REDIS_URL: "redis://durable:6379" });
    expect(assertChatConcurrencyBackend(env, { warn: vi.fn() })).toBe("shared");
    expect(resolveChatSlotBackendConfig(env)).toEqual({ kind: "redis", url: "redis://durable:6379", source: "MASTRA_REDIS_URL", keyPrefix: DURABLE_REDIS_CHAT_SLOT_PREFIX });
  });

  it("resolves the REST pair, API_RATE_LIMIT_REDIS_URL, REDIS_URL, then MASTRA_REDIS_URL (the rate limiter's order)", () => {
    const all = { API_RATE_LIMIT_REDIS_URL: "redis://limiter:6379", REDIS_URL: "redis://plain:6379",
      API_RATE_LIMIT_REDIS_REST_URL: "https://rest.example.com", API_RATE_LIMIT_REDIS_REST_TOKEN: "t", MASTRA_REDIS_URL: "redis://durable:6379" };
    expect(resolveChatSlotBackendConfig(all)).toEqual({ kind: "rest", url: "https://rest.example.com", token: "t" });
    const noRest = { ...all, API_RATE_LIMIT_REDIS_REST_URL: "", API_RATE_LIMIT_REDIS_REST_TOKEN: "" };
    expect(resolveChatSlotBackendConfig(noRest)).toMatchObject({ kind: "redis", source: "API_RATE_LIMIT_REDIS_URL" });
    expect(resolveChatSlotBackendConfig({ ...noRest, API_RATE_LIMIT_REDIS_URL: "" })).toMatchObject({ kind: "redis", source: "REDIS_URL" });
    expect(resolveChatSlotBackendConfig({ MASTRA_REDIS_URL: "redis://durable:6379", UPSTASH_REDIS_REST_URL: "https://rest.example.com" })).toMatchObject({ source: "MASTRA_REDIS_URL" });
    expect(resolveChatSlotBackendConfig({})).toEqual({ kind: "none" });
  });

  it("keeps the per-process fallback outside production", () => {
    expect(assertChatConcurrencyBackend({ NODE_ENV: "development" }, { warn: vi.fn() })).toBe("local");
    expect(assertChatConcurrencyBackend({ NODE_ENV: "test", UPSTASH_REDIS_REST_URL: "https://rest.example.com" }, { warn: vi.fn() })).toBe("local");
  });
});
