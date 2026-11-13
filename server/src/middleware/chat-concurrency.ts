import { createHash, randomUUID } from "node:crypto";

import type { Context, MiddlewareHandler } from "hono";
import { createClient } from "redis";

import { middlewareErrorResponse } from "../lib/api-error.js";
import { requestIp } from "../lib/request-context.js";
import { classifyRateLimitCategory, rateLimitAddress } from "../lib/rate-limit-keys.js";

import { chatTurnTimeBudget } from "../services/chat-turn-deadline.js";

/**
 * In-flight cap on AI chat turns (`chat-ai` routes, streaming included) per
 * API key, and per visitor (IP, or IPv6 /64) inside a browser (client) key.
 * Visitors behind one NAT or office address share the per-visitor cap.
 *
 * The request-rate limits count turns as they start; a turn can then run up to
 * its deadline and an SSE stream stays open the whole time, so a key at its
 * rate limit could still hold hundreds of concurrent model turns. A slot is
 * held until the response body finishes or is cancelled, the handler throws,
 * or the hard deadline (turn deadline + grace) passes, whichever comes first,
 * so a client that stops reading cannot hold a slot past the turn.
 *
 * Counts are cluster-wide when the limiter's Redis is configured
 * (API_RATE_LIMIT_REDIS_URL, REDIS_URL or the Upstash REST pair): each slot is
 * a lease in a Redis sorted set, taken and checked in one atomic script and
 * expiring on Redis time at the hard deadline, so a crashed process cannot hold
 * slots forever. Without Redis, counts are per process. When Redis is
 * configured but unreachable, production refuses capped turns (fail closed: a
 * per-process count would multiply the cap by the number of instances);
 * development and tests fall back to the per-process count.
 *
 * Defaults: browser keys 16 per key and 3 per visitor; server keys 64 per key
 * (backend batch callers; a bound on runaway loops, not a quota), and any key
 * can set its own with a `concurrent` rate-limit rule. Sessions (the
 * first-party app) are not capped here. 0 disables a cap.
 */
const DEFAULTS = { perClientKey: 16, perServerKey: 64, perClientVisitor: 3 };
/** Grace after the turn deadline before a slot is reclaimed regardless of the stream. */
const RELEASE_GRACE_MS = 15_000;
/** A slot decision never waits longer than this on Redis. */
const REDIS_TIMEOUT_MS = 2_000;
/** After a Redis failure, skip it this long so an outage costs one timeout, not one per request. */
const BACKEND_RETRY_MS = 5_000;

function readCap(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** One counter: `key` is the logical name, `tag` the API key id every counter of one turn shares (one Redis Cluster slot). */
export type ChatSlotCounter = { key: string; cap: number; tag: string };

/** A shared (cross-process) slot store. Throws when the backend cannot answer. */
export interface ChatSlotBackend {
  /** Atomically takes one lease on every counter, or none when any is full. */
  acquire(counters: ChatSlotCounter[], holdMs: number, lease: string): Promise<boolean>;
  release(counters: ChatSlotCounter[], lease: string): Promise<void>;
  close?(): Promise<void>;
}

/**
 * KEYS: counters. ARGV: hold ms, lease id, then one cap per key. Leases are
 * scored by their expiry on Redis's clock (never the caller's), expired leases
 * are dropped before counting, and the key itself expires after its latest lease.
 */
const ACQUIRE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local hold = tonumber(ARGV[1])
for i, key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
  local cap = tonumber(ARGV[2 + i])
  if cap > 0 and redis.call('ZCARD', key) >= cap then return 0 end
end
for i, key in ipairs(KEYS) do
  redis.call('ZADD', key, now + hold, ARGV[2])
  redis.call('PEXPIRE', key, hold)
end
return 1
`;
const RELEASE_SCRIPT = `
for i, key in ipairs(KEYS) do redis.call('ZREM', key, ARGV[1]) end
return 1
`;
const sha = (script: string) => createHash("sha1").update(script).digest("hex");
const ACQUIRE_SHA = sha(ACQUIRE_SCRIPT);
const RELEASE_SHA = sha(RELEASE_SCRIPT);

function redisKey(counter: ChatSlotCounter): string {
  // Hash tag on the key id: every counter of one turn lives on one cluster slot.
  return `${process.env.API_RATE_LIMIT_KEY_PREFIX ?? "api"}:chat-inflight:{${counter.tag}}:${counter.key}`;
}

function scriptCall(script: "acquire" | "release", counters: ChatSlotCounter[], args: string[]): { sha: string; source: string; tail: string[] } {
  const keys = counters.map(redisKey);
  return script === "acquire"
    ? { sha: ACQUIRE_SHA, source: ACQUIRE_SCRIPT, tail: [String(keys.length), ...keys, ...args] }
    : { sha: RELEASE_SHA, source: RELEASE_SCRIPT, tail: [String(keys.length), ...keys, ...args] };
}

const isNoScript = (error: unknown) => error instanceof Error && error.message.includes("NOSCRIPT");

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Redis chat-slot call timed out")), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// No offline queue: a disconnected Redis fails at once instead of queueing behind a reconnect loop.
const createSlotRedisClient = (url: string) => createClient({ url, disableOfflineQueue: true,
  socket: { connectTimeout: REDIS_TIMEOUT_MS, reconnectStrategy: (retries: number) => Math.min(1_000 * 2 ** retries, 30_000) } });
type SlotRedisClient = ReturnType<typeof createSlotRedisClient>;

/** A node-redis backend (the limiter's REDIS_URL / API_RATE_LIMIT_REDIS_URL). */
export function createRedisChatSlotBackend(url: string): ChatSlotBackend {
  let client: SlotRedisClient | null = null;
  let connecting: Promise<SlotRedisClient> | null = null;
  let errorLogged = false;
  const connect = async (): Promise<SlotRedisClient> => {
    if (client?.isOpen) return client;
    connecting ??= (async () => {
      const next = createSlotRedisClient(url);
      next.on("error", (error) => {
        // Errors can carry connection details: log the message once, never the URL.
        if (!errorLogged) { errorLogged = true; console.error("[chat-concurrency] Redis client error:", error instanceof Error ? error.message : String(error)); }
      });
      try {
        await next.connect();
      } catch (error) {
        next.destroy();
        throw error;
      }
      client = next;errorLogged = false;
      return next;
    })().finally(() => { connecting = null; });
    return await connecting;
  };
  const run = async (call: { sha: string; source: string; tail: string[] }) => {
    const redis = await connect();
    try {
      return await redis.sendCommand(["EVALSHA", call.sha, ...call.tail]);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      return await redis.sendCommand(["EVAL", call.source, ...call.tail]);
    }
  };
  return {
    async acquire(counters, holdMs, lease) {
      const result: unknown = await withTimeout(run(scriptCall("acquire", counters, [String(holdMs), lease, ...counters.map((c) => String(c.cap))])), REDIS_TIMEOUT_MS);
      if (result !== 0 && result !== 1) throw new Error("Redis returned an invalid chat-slot result");
      return result === 1;
    },
    async release(counters, lease) {
      await withTimeout(run(scriptCall("release", counters, [lease])), REDIS_TIMEOUT_MS);
    },
    async close() {
      const current = client;client = null;
      if (current?.isOpen) await current.quit().catch(() => current.destroy());
    },
  };
}

/** An Upstash REST backend (the limiter's other shared store). */
function createUpstashChatSlotBackend(url: string, token: string): ChatSlotBackend {
  const send = async (command: string[]) => {
    const response = await fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command), signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({})) as { result?: unknown; error?: string };
    if (payload.error) throw new Error(payload.error);
    if (!response.ok) throw new Error(`Upstash Redis returned ${response.status}`);
    return payload.result;
  };
  const run = async (call: { sha: string; source: string; tail: string[] }) => {
    try {
      return await send(["EVALSHA", call.sha, ...call.tail]);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      return await send(["EVAL", call.source, ...call.tail]);
    }
  };
  return {
    async acquire(counters, holdMs, lease) {
      const result = Number(await run(scriptCall("acquire", counters, [String(holdMs), lease, ...counters.map((c) => String(c.cap))])));
      if (result !== 0 && result !== 1) throw new Error("Redis returned an invalid chat-slot result");
      return result === 1;
    },
    async release(counters, lease) {
      await run(scriptCall("release", counters, [lease]));
    },
  };
}

let configuredBackend: { signature: string; backend: ChatSlotBackend | null } | undefined;

/** The shared backend the limiter's environment names, or null when none is configured. */
function sharedBackend(): ChatSlotBackend | null {
  const restUrl = process.env.API_RATE_LIMIT_REDIS_REST_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim();
  const restToken = process.env.API_RATE_LIMIT_REDIS_REST_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const redisUrl = process.env.API_RATE_LIMIT_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
  const signature = restUrl && restToken ? `rest:${restUrl}` : redisUrl ? `redis:${redisUrl}` : "";
  if (configuredBackend?.signature === signature) return configuredBackend.backend;
  void configuredBackend?.backend?.close?.().catch(() => undefined);
  const backend = restUrl && restToken ? createUpstashChatSlotBackend(restUrl, restToken) : redisUrl ? createRedisChatSlotBackend(redisUrl) : null;
  configuredBackend = { signature, backend };
  return backend;
}

const inFlight = new Map<string, number>();

/** Per-process counting: no Redis configured, or Redis down outside production. */
function acquireLocal(counters: ChatSlotCounter[]): (() => void) | null {
  if (counters.some(({ key, cap }) => cap > 0 && (inFlight.get(key) ?? 0) >= cap)) return null;
  for (const { key } of counters) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  return () => {
    for (const { key } of counters) {
      const next = (inFlight.get(key) ?? 1) - 1;
      if (next <= 0) inFlight.delete(key); else inFlight.set(key, next);
    }
  };
}

let retryBackendAt = 0;
let failureLogged = false;

/** One shared acquisition: a release, a full cap, or a backend that cannot answer. */
async function acquireShared(backend: ChatSlotBackend, counters: ChatSlotCounter[], holdMs: number): Promise<(() => void) | "full" | "unavailable"> {
  // After a failure, skip the backend for a while: an outage costs one timeout, not one per request.
  if (Date.now() < retryBackendAt) return "unavailable";
  const lease = randomUUID();
  try {
    if (!await backend.acquire(counters, holdMs, lease)) return "full";
  } catch (error) {
    retryBackendAt = Date.now() + BACKEND_RETRY_MS;
    // The script may have run before the failure surfaced (a timeout): drop that lease if it did.
    void backend.release(counters, lease).catch(() => undefined);
    if (!failureLogged) {
      failureLogged = true;
      console.error("[chat-concurrency] Redis backend failed:", error instanceof Error ? error.message : String(error));
    }
    return "unavailable";
  }
  if (failureLogged) {
    failureLogged = false;
    console.warn("[chat-concurrency] Redis backend recovered; chat slots are shared again");
  }
  // A failed release leaves the lease to expire on Redis time at the hard deadline.
  return () => {
    void backend.release(counters, lease).catch((error) => {
      console.error("[chat-concurrency] slot release failed:", error instanceof Error ? error.message : String(error));
    });
  };
}

/** Outcome of taking a slot: a release, a full cap, or a configured shared store that cannot answer (refuse). */
export type ChatSlotAcquisition = { release: () => void } | "full" | "unavailable";

/**
 * Takes one slot on every counter, cluster-wide through `backend` when one is
 * configured. Production never falls back to per-process counting while a
 * configured backend is down. The release is idempotent and also runs by
 * itself after `holdMs`.
 */
export async function acquireChatSlots(counters: ChatSlotCounter[], holdMs: number, backend: ChatSlotBackend | null = sharedBackend()): Promise<ChatSlotAcquisition> {
  let releaseNow: (() => void) | null;
  if (!backend) {
    releaseNow = acquireLocal(counters);
  } else {
    const shared = await acquireShared(backend, counters, holdMs);
    if (shared === "full") return "full";
    if (shared === "unavailable") {
      if (process.env.NODE_ENV === "production") {
        console.error("[chat-concurrency] refused: Redis is configured but unavailable (per-process counting would multiply the cap by the instance count)");
        return "unavailable";
      }
      releaseNow = acquireLocal(counters);
    } else {
      releaseNow = shared;
    }
  }
  if (!releaseNow) return "full";
  const releaseSlot = releaseNow;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(deadline);
    releaseSlot();
  };
  const deadline = setTimeout(release, holdMs);
  deadline.unref?.();
  return { release };
}

/** The response with `release` called once its body is fully sent or cancelled (or at once when it has none). */
function releaseWhenDone(c: Context, release: () => void): void {
  const body = c.res.body;
  // A JSON answer (or an error) is complete when the handler returns; only an
  // event stream keeps working while the client reads it.
  if (!body || c.error || !/text\/event-stream/i.test(c.res.headers.get("Content-Type") ?? "")) {
    release();
    return;
  }
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  c.res = new Response(stream, { status: c.res.status, statusText: c.res.statusText, headers: c.res.headers });
}

export function chatConcurrencyKeys(c: Context): ChatSlotCounter[] {
  const actor = c.get("requestActor");
  if (actor?.type !== "apiKey") return [];
  const client = actor.apiKey.keyType !== "server";
  const own = (actor.apiKey.rateLimits ?? []).find((rule) => rule.metric === "concurrent")?.limit;
  const perKey = own ?? (client
    ? readCap("API_CHAT_MAX_CONCURRENT_PER_KEY", DEFAULTS.perClientKey)
    : readCap("API_CHAT_MAX_CONCURRENT_PER_SERVER_KEY", DEFAULTS.perServerKey));
  const tag = actor.apiKey.keyId;
  const keys = [{ key: `key:${tag}`, cap: perKey, tag }];
  if (client) {
    // No client address: one shared "unknown" visitor, never an uncapped one.
    const ip = requestIp(c);
    keys.push({ key: `key:${tag}:ip:${ip ? rateLimitAddress(ip) : "unknown"}`, cap: readCap("API_CHAT_MAX_CONCURRENT_PER_CLIENT_VISITOR", DEFAULTS.perClientVisitor), tag });
  }
  return keys.filter(({ cap }) => cap > 0);
}

/** How long a slot may be held: the turn deadline plus grace. */
export function chatSlotHoldMs(): number {
  return chatTurnTimeBudget().turnDeadlineMs + RELEASE_GRACE_MS;
}

/**
 * Takes a slot for a chat turn outside the HTTP middleware (the MCP `chat`
 * tool, answer-generating search). Null when a cap is full or the shared store
 * cannot answer in production; otherwise call the release when the turn ends.
 */
export async function acquireChatSlot(c: Context): Promise<{ release: () => void } | null | "uncapped"> {
  const keys = chatConcurrencyKeys(c);
  if (keys.length === 0) return "uncapped";
  const slot = await acquireChatSlots(keys, chatSlotHoldMs());
  return typeof slot === "string" ? null : slot;
}

declare module "hono" {
  interface ContextVariableMap {
    chatConcurrencyCounted: boolean;
  }
}

const RETRY_AFTER_SECONDS = 5;

/** `limited` shapes the 429 for protocol surfaces (the OpenAI-compatible route); default is the API error envelope. */
export function createChatConcurrencyLimit(limited?: (c: Context) => Response): MiddlewareHandler {
  return async (c, next) => {
    if (c.get("chatConcurrencyCounted") || classifyRateLimitCategory(c.req.method, c.req.path) !== "chat-ai") return next();
    const keys = chatConcurrencyKeys(c);
    if (keys.length === 0) return next();
    const slot = await acquireChatSlots(keys, chatSlotHoldMs());
    if (typeof slot === "string") {
      // A full cap and an unreachable shared store both refuse (fail closed); only the log tells them apart.
      c.header("Retry-After", String(RETRY_AFTER_SECONDS));
      return limited?.(c) ?? middlewareErrorResponse(c, 429, "rate_limited", "Too many chat requests in progress for this key; wait for one to finish", {
        category: "chat-ai", policy: "chat-concurrency", retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }
    c.set("chatConcurrencyCounted", true);
    try {
      await next();
    } catch (error) {
      slot.release();
      throw error;
    }
    releaseWhenDone(c, slot.release);
  };
}

export const chatConcurrencyLimit: MiddlewareHandler = createChatConcurrencyLimit();

/** Test hook: per-process in-flight turns for a counter key. */
export function chatTurnsInFlight(key: string): number {
  return inFlight.get(key) ?? 0;
}

export function resetChatConcurrency(): void {
  inFlight.clear();
  retryBackendAt = 0;
  failureLogged = false;
}
