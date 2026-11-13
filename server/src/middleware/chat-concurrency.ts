import { createHash, randomUUID } from "node:crypto";

import type { Context, MiddlewareHandler } from "hono";
import { createClient } from "redis";

import { PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";

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
 * Counts are cluster-wide through a shared Redis, resolved in this order:
 * API_RATE_LIMIT_REDIS_URL, REDIS_URL, the REST pair
 * (API_RATE_LIMIT_REDIS_REST_URL + _TOKEN, or UPSTASH_REDIS_REST_URL + _TOKEN),
 * then MASTRA_REDIS_URL (the durable-chat Redis, under its own key prefix).
 * Each slot is a lease in a Redis sorted set, taken and checked in one atomic
 * script and expiring on Redis time at the hard deadline, so a crashed process
 * cannot hold slots forever.
 *
 * Production never counts per process by accident (N instances would allow N
 * times every cap): with no shared backend, or half of a REST pair, the server
 * refuses to start (assertChatConcurrencyBackend) unless
 * CHAT_CONCURRENCY_LOCAL_ONLY=1 declares a single-instance deployment. When
 * the configured backend is unreachable, production refuses capped turns with
 * 503 `chat_capacity_unavailable` (fail closed). Development and tests fall
 * back to the per-process count in both cases.
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
 * are dropped before counting, and each key expires at its latest lease expiry:
 * the highest score in the set, never this lease's own hold, so a short lease
 * cannot delete longer leases that are still live.
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
  local latest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
  redis.call('PEXPIREAT', key, math.ceil(tonumber(latest[2])))
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

/**
 * Key prefix on the durable-chat Redis. That runtime's keys are
 * `<namespace>:cache:` and `<namespace>:events`, and a namespace cannot contain
 * `{`; these keys continue with `{<key id>}`, so the two can never collide
 * whatever MASTRA_NAMESPACE is.
 */
export const DURABLE_REDIS_CHAT_SLOT_PREFIX = "docslurp-chat-slots";

const limiterKeyPrefix = () => `${process.env.API_RATE_LIMIT_KEY_PREFIX ?? "api"}:chat-inflight`;

function redisKey(counter: ChatSlotCounter, prefix: string): string {
  // Hash tag on the key id: every counter of one turn lives on one cluster slot.
  return `${prefix}:{${counter.tag}}:${counter.key}`;
}

function scriptCall(script: "acquire" | "release", counters: ChatSlotCounter[], args: string[], prefix = limiterKeyPrefix()): { sha: string; source: string; tail: string[] } {
  const keys = counters.map((counter) => redisKey(counter, prefix));
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

/** A node-redis backend. `keyPrefix` defaults to the limiter's (`<API_RATE_LIMIT_KEY_PREFIX>:chat-inflight`). */
export function createRedisChatSlotBackend(url: string, keyPrefix?: string): ChatSlotBackend {
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
      const result: unknown = await withTimeout(run(scriptCall("acquire", counters, [String(holdMs), lease, ...counters.map((c) => String(c.cap))], keyPrefix)), REDIS_TIMEOUT_MS);
      if (result !== 0 && result !== 1) throw new Error("Redis returned an invalid chat-slot result");
      return result === 1;
    },
    async release(counters, lease) {
      await withTimeout(run(scriptCall("release", counters, [lease], keyPrefix)), REDIS_TIMEOUT_MS);
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

/** Where chat slots are counted, from the environment alone (no connection is made). */
export type ChatSlotBackendConfig =
  | { kind: "redis"; url: string; source: "API_RATE_LIMIT_REDIS_URL" | "REDIS_URL" | "MASTRA_REDIS_URL"; keyPrefix?: string }
  | { kind: "rest"; url: string; token: string }
  | { kind: "none" };

type SlotEnv = Record<string, string | undefined>;

/** A REST URL without its token, or a token without its URL (either variable family). */
function halfRestPair(env: SlotEnv): boolean {
  const url = env.API_RATE_LIMIT_REDIS_REST_URL?.trim() || env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.API_RATE_LIMIT_REDIS_REST_TOKEN?.trim() || env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return Boolean(url) !== Boolean(token);
}

/**
 * The shared store for chat slots: API_RATE_LIMIT_REDIS_URL, REDIS_URL, a
 * complete REST pair, then MASTRA_REDIS_URL. Half of a REST pair selects
 * nothing (production refuses to start on it, see assertChatConcurrencyBackend).
 */
export function resolveChatSlotBackendConfig(env: SlotEnv = process.env): ChatSlotBackendConfig {
  const limiterUrl = env.API_RATE_LIMIT_REDIS_URL?.trim();
  if (limiterUrl) return { kind: "redis", url: limiterUrl, source: "API_RATE_LIMIT_REDIS_URL" };
  const redisUrl = env.REDIS_URL?.trim();
  if (redisUrl) return { kind: "redis", url: redisUrl, source: "REDIS_URL" };
  const restUrl = env.API_RATE_LIMIT_REDIS_REST_URL?.trim() || env.UPSTASH_REDIS_REST_URL?.trim();
  const restToken = env.API_RATE_LIMIT_REDIS_REST_TOKEN?.trim() || env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (restUrl && restToken) return { kind: "rest", url: restUrl, token: restToken };
  const durableUrl = env.MASTRA_REDIS_URL?.trim();
  if (durableUrl) return { kind: "redis", url: durableUrl, source: "MASTRA_REDIS_URL", keyPrefix: DURABLE_REDIS_CHAT_SLOT_PREFIX };
  return { kind: "none" };
}

/** CHAT_CONCURRENCY_LOCAL_ONLY=1: the operator declares one API instance, so per-process caps are the caps. */
export function chatConcurrencyLocalOnly(env: SlotEnv = process.env): boolean {
  return ["1", "true"].includes(env.CHAT_CONCURRENCY_LOCAL_ONLY?.trim().toLowerCase() ?? "");
}

const SHARED_BACKEND_VARIABLES = "API_RATE_LIMIT_REDIS_URL, REDIS_URL, API_RATE_LIMIT_REDIS_REST_URL with API_RATE_LIMIT_REDIS_REST_TOKEN "
  + "(or UPSTASH_REDIS_REST_URL with UPSTASH_REDIS_REST_TOKEN), or MASTRA_REDIS_URL";

/**
 * Startup check (ensureApiStartup, before any traffic). Production refuses to
 * start when chat caps would silently be per process: no shared backend, or
 * half of a REST pair. CHAT_CONCURRENCY_LOCAL_ONLY=1 is the explicit
 * single-instance opt-out and logs one warning. Returns how slots are counted.
 */
export function assertChatConcurrencyBackend(env: SlotEnv = process.env, log: Pick<Console, "warn"> = console): "shared" | "local" {
  const config = resolveChatSlotBackendConfig(env);
  if (env.NODE_ENV !== "production") return config.kind === "none" ? "local" : "shared";
  const halfPair = halfRestPair(env);
  if (!halfPair && config.kind !== "none") return "shared";
  if (chatConcurrencyLocalOnly(env)) {
    if (config.kind !== "none") return "shared";
    log.warn("[chat-concurrency] backend=local: CHAT_CONCURRENCY_LOCAL_ONLY=1, so chat concurrency caps are counted per process. "
      + "Run a single API instance, or N instances allow N times every cap.");
    return "local";
  }
  if (halfPair) {
    throw new Error("Chat concurrency: the Redis REST backend is half configured. Set both API_RATE_LIMIT_REDIS_REST_URL and "
      + "API_RATE_LIMIT_REDIS_REST_TOKEN (or both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN), or unset both. "
      + "Set CHAT_CONCURRENCY_LOCAL_ONLY=1 only for a single API instance.");
  }
  throw new Error(`Chat concurrency: no shared Redis is configured, so chat caps would be counted per process. Set one of ${SHARED_BACKEND_VARIABLES}. `
    + "Set CHAT_CONCURRENCY_LOCAL_ONLY=1 only for a single API instance.");
}

let configuredBackend: { signature: string; backend: ChatSlotBackend | null } | undefined;

/** The shared backend the environment names, or null when none is configured. */
function sharedBackend(): ChatSlotBackend | null {
  const config = resolveChatSlotBackendConfig();
  const signature = config.kind === "none" ? "" : `${config.kind}:${config.url}:${config.kind === "redis" ? config.keyPrefix ?? "" : ""}`;
  if (configuredBackend?.signature === signature) return configuredBackend.backend;
  void configuredBackend?.backend?.close?.().catch(() => undefined);
  const backend = config.kind === "rest" ? createUpstashChatSlotBackend(config.url, config.token)
    : config.kind === "redis" ? createRedisChatSlotBackend(config.url, config.keyPrefix) : null;
  configuredBackend = { signature, backend };
  return backend;
}

const inFlight = new Map<string, number>();

/** Per-process counting: outside production, or production with CHAT_CONCURRENCY_LOCAL_ONLY=1. */
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

/** One line per refused turn, with a stable prefix an alert can match. Never carries backend error text. */
function logRefusal(reason: "backend-unavailable" | "backend-not-configured"): void {
  console.error(`[chat-concurrency] status=refused reason=${reason}`);
}

/**
 * Takes one slot on every counter, cluster-wide through `backend` when one is
 * configured. Production never falls back to per-process counting: not while a
 * configured backend is down, and not when none is configured (startup refuses
 * that; this is the same refusal for a host that skipped the startup check),
 * unless CHAT_CONCURRENCY_LOCAL_ONLY=1. The release is idempotent and also runs
 * by itself after `holdMs`.
 */
export async function acquireChatSlots(counters: ChatSlotCounter[], holdMs: number, backend: ChatSlotBackend | null = sharedBackend()): Promise<ChatSlotAcquisition> {
  let releaseNow: (() => void) | null;
  if (!backend) {
    if (process.env.NODE_ENV === "production" && !chatConcurrencyLocalOnly()) {
      logRefusal("backend-not-configured");
      return "unavailable";
    }
    releaseNow = acquireLocal(counters);
  } else {
    const shared = await acquireShared(backend, counters, holdMs);
    if (shared === "full") return "full";
    if (shared === "unavailable") {
      if (process.env.NODE_ENV === "production") {
        // Per-process counting would multiply the cap by the instance count.
        logRefusal("backend-unavailable");
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
 * tool, answer-generating search). "full" when a cap is reached, "unavailable"
 * when the shared store cannot answer in production; otherwise call the
 * release when the turn ends.
 */
export async function acquireChatSlot(c: Context): Promise<{ release: () => void } | "full" | "unavailable" | "uncapped"> {
  const keys = chatConcurrencyKeys(c);
  if (keys.length === 0) return "uncapped";
  return await acquireChatSlots(keys, chatSlotHoldMs());
}

declare module "hono" {
  interface ContextVariableMap {
    chatConcurrencyCounted: boolean;
  }
}

export const CHAT_SLOT_RETRY_AFTER_SECONDS = 5;
export const CHAT_SLOTS_FULL_MESSAGE = "Too many chat requests in progress for this key; wait for one to finish";
/** Public copy for a refused turn while the slot store is down; the cause stays in the logs. */
export const CHAT_CAPACITY_UNAVAILABLE_MESSAGE = PUBLIC_ERROR_MESSAGES.chatCapacityUnavailable;

/**
 * The native refusal for a slot that was not taken. A full cap is the caller's
 * own limit (429 `rate_limited`); a slot store that cannot answer is ours
 * (503 `chat_capacity_unavailable`), so clients and alerts can tell them apart.
 */
export function chatSlotRefusedResponse(c: Context, reason: "full" | "unavailable"): Response {
  c.header("Retry-After", String(CHAT_SLOT_RETRY_AFTER_SECONDS));
  const details = { category: "chat-ai", policy: "chat-concurrency", retryAfterSeconds: CHAT_SLOT_RETRY_AFTER_SECONDS };
  return reason === "full"
    ? middlewareErrorResponse(c, 429, "rate_limited", CHAT_SLOTS_FULL_MESSAGE, details)
    : middlewareErrorResponse(c, 503, "chat_capacity_unavailable", CHAT_CAPACITY_UNAVAILABLE_MESSAGE, details);
}

/** `refused` shapes the refusal for protocol surfaces (the OpenAI-compatible route); default is the API error envelope. */
export function createChatConcurrencyLimit(refused?: (c: Context, reason: "full" | "unavailable") => Response): MiddlewareHandler {
  return async (c, next) => {
    if (c.get("chatConcurrencyCounted") || classifyRateLimitCategory(c.req.method, c.req.path) !== "chat-ai") return next();
    const keys = chatConcurrencyKeys(c);
    if (keys.length === 0) return next();
    const slot = await acquireChatSlots(keys, chatSlotHoldMs());
    if (typeof slot === "string") {
      // Both refuse (fail closed), with different statuses and codes.
      if (!refused) return chatSlotRefusedResponse(c, slot);
      c.header("Retry-After", String(CHAT_SLOT_RETRY_AFTER_SECONDS));
      return refused(c, slot);
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
