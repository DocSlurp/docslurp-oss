import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { createClient } from "redis";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestActor } from "../lib/request-actor.js";
import {
  acquireChatSlots,
  chatConcurrencyLimit,
  chatTurnsInFlight,
  createRedisChatSlotBackend,
  resetChatConcurrency,
  type ChatSlotBackend,
} from "../middleware/chat-concurrency.js";

// Cluster-wide chat slots against a real Redis. Skipped without CHAT_CONCURRENCY_TEST_REDIS_URL.
const redisUrl = process.env.CHAT_CONCURRENCY_TEST_REDIS_URL ?? "";

const backends: ChatSlotBackend[] = [];
/** A separate client per call: what a second API process holds. */
function processBackend(): ChatSlotBackend {
  const backend = createRedisChatSlotBackend(redisUrl);
  backends.push(backend);
  return backend;
}

function serverKeyActor(keyId: string): RequestActor {
  return {
    type: "apiKey", userId: "user-1",
    apiKey: { keyId, userId: "user-1", orgId: "org-1", keyType: "server", allowedDomains: [], scopes: ["search", "chat"],
      rateLimitRpm: null, rateLimitPpd: 10_000, rateLimits: [], projectIds: [] },
  };
}

describe.skipIf(!redisUrl)("cluster-wide chat slots (Redis)", () => {
  const inspect = createClient({ url: redisUrl });
  beforeEach(async () => {
    if (!inspect.isOpen) await inspect.connect();
    resetChatConcurrency();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await Promise.all(backends.map((backend) => backend.close?.()));
    if (inspect.isOpen) await inspect.quit();
  });

  it("shares one cap between two processes and frees a slot on release", async () => {
    const tag = randomUUID();
    const counters = [{ key: `key:${tag}`, cap: 2, tag }];
    const a = processBackend(), b = processBackend();
    const first = await acquireChatSlots(counters, 60_000, a);
    const second = await acquireChatSlots(counters, 60_000, b);
    expect(typeof first).toBe("object");expect(typeof second).toBe("object");
    expect(await acquireChatSlots(counters, 60_000, a)).toBe("full");
    expect(await acquireChatSlots(counters, 60_000, b)).toBe("full");
    // Nothing was counted per process.
    expect(chatTurnsInFlight(`key:${tag}`)).toBe(0);
    if (typeof first === "object") first.release();
    await vi.waitFor(async () => expect(typeof await acquireChatSlots(counters, 60_000, b)).toBe("object"));
  });

  it("takes every counter of a turn or none: a refused visitor takes no key slot", async () => {
    const tag = randomUUID();
    const key = { key: `key:${tag}`, cap: 5, tag };
    const visitor = { key: `key:${tag}:ip:203.0.113.9`, cap: 1, tag };
    const backend = processBackend();
    expect(typeof await acquireChatSlots([key, visitor], 60_000, backend)).toBe("object");
    expect(await acquireChatSlots([key, visitor], 60_000, backend)).toBe("full");
    expect(await inspect.zCard(`api:chat-inflight:{${tag}}:key:${tag}`)).toBe(1);
  });

  it("frees the slot of a process that died holding it once its lease expires", async () => {
    const tag = randomUUID();
    const counters = [{ key: `key:${tag}`, cap: 1, tag }];
    // The crashed process took a lease and never released it (no local timer either).
    expect(await processBackend().acquire(counters, 400, randomUUID())).toBe(true);
    const survivor = processBackend();
    expect(await survivor.acquire(counters, 60_000, randomUUID())).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await survivor.acquire(counters, 60_000, randomUUID())).toBe(true);
    // The key itself expires after its latest lease, so idle keys do not accumulate.
    expect(await inspect.pTTL(`api:chat-inflight:{${tag}}:key:${tag}`)).toBeGreaterThan(0);
  });

  it("releases a shared slot when the client aborts its stream", async () => {
    vi.stubEnv("REDIS_URL", redisUrl);
    for (const name of ["API_RATE_LIMIT_REDIS_REST_URL", "API_RATE_LIMIT_REDIS_REST_TOKEN", "API_RATE_LIMIT_REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) vi.stubEnv(name, "");
    vi.stubEnv("API_CHAT_MAX_CONCURRENT_PER_SERVER_KEY", "1");
    const tag = randomUUID();
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("requestActor", serverKeyActor(tag)); await next(); });
    app.use("*", chatConcurrencyLimit);
    app.post("/v1/chat", () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
    } }), { headers: { "Content-Type": "text/event-stream" } }));
    const init = (ip: string) => ({ method: "POST", headers: { "x-forwarded-for": ip } });
    const open = await app.request("/v1/chat", init("203.0.113.40"));
    expect(open.status).toBe(200);
    expect(await inspect.zCard(`api:chat-inflight:{${tag}}:key:${tag}`)).toBe(1);
    expect((await app.request("/v1/chat", init("203.0.113.41"))).status).toBe(429);
    await open.body!.cancel();
    await vi.waitFor(async () => expect(await inspect.zCard(`api:chat-inflight:{${tag}}:key:${tag}`)).toBe(0));
    expect(chatTurnsInFlight(`key:${tag}`)).toBe(0);
    const next = await app.request("/v1/chat", init("203.0.113.41"));
    expect(next.status).toBe(200);
    await next.body!.cancel();
  });
});
