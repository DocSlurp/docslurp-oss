import { createServer } from "node:net";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestActor } from "../lib/request-actor.js";
import {
  acquireChatSlots,
  chatConcurrencyLimit,
  chatTurnsInFlight,
  createRedisChatSlotBackend,
  resetChatConcurrency,
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

  it("answers 429 in production with a real client pointed at an unreachable Redis, and never hangs past its timeout", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const name of ["API_RATE_LIMIT_REDIS_REST_URL", "API_RATE_LIMIT_REDIS_REST_TOKEN", "API_RATE_LIMIT_REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) vi.stubEnv(name, "");
    vi.stubEnv("REDIS_URL", `redis://127.0.0.1:${await closedPort()}`);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("requestActor", serverKeyActor("srv-down")); await next(); });
    app.use("*", chatConcurrencyLimit);
    app.post("/v1/chat", (c) => c.json({ ok: true }));
    const started = Date.now();
    const response = await app.request("/v1/chat", { method: "POST" });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "rate_limited", details: { policy: "chat-concurrency" } } });
    expect(Date.now() - started).toBeLessThan(3_000);
    // Sessions and uncapped keys never touch the shared store.
    vi.stubEnv("API_CHAT_MAX_CONCURRENT_PER_SERVER_KEY", "0");
    expect((await app.request("/v1/chat", { method: "POST" })).status).toBe(200);
  });

  it("rejects, never resolves a slot, when the Redis backend cannot be reached", async () => {
    const port = await closedPort();
    const backend = createRedisChatSlotBackend(`redis://127.0.0.1:${port}`);
    await expect(backend.acquire(counters, 1_000, "lease")).rejects.toThrow();
    await backend.close?.();
  });
});
