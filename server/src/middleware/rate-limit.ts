import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { apiKeyRateLimitPolicyName, publicApiErrorMessage, type ApiErrorCode, type ApiKeyRateLimitRule } from "@docslurp/shared";
import type { Context, MiddlewareHandler } from "hono";
import { createClient } from "redis";
import { middlewareErrorResponse } from "../lib/api-error.js";
import { isSelfHostedDeployment, withUpgradeLinks } from "../lib/upgrade-links.js";

import { requestIp } from "../lib/request-context.js";
import { apiKeyPagesToday } from "../services/api-key-usage.js";
import { apiKeySpendCents } from "../services/usage-attribution.js";

/**
 * API rate limiting.
 *
 * Counters use a sliding-window counter: two fixed-window integers per limit,
 * with the previous window weighted by how much of it still overlaps the
 * rolling window. That is O(1) memory per identity and limit (the old
 * sorted-set log stored one member per request), within ~1% of an exact
 * sliding log. Every limit that applies to one identity is evaluated and
 * consumed in a single atomic Lua call, so a request costs one Redis round
 * trip per identity (IP, then API key or user).
 *
 * Layers, in order:
 *  1. Per IP: a temporary block (penalty box), a short burst window and the
 *     IP's per-category limit. Bursts over the burst limit and repeated invalid
 *     credentials put the IP in the penalty box.
 *  2. Per API key or user: the per-category limit of the org's table (capped by the key's
 *     requests-per-minute when one is set), the key's custom request windows, its daily page
 *     cap for uploads and its spend windows for cost-incurring requests. Every
 *     account shares one table whatever its billing state; a key's own settings
 *     only lower it.
 *
 * Responses carry the IETF `RateLimit-Policy` / `RateLimit` fields
 * (draft-ietf-httpapi-ratelimit-headers) for every policy that applied, plus
 * the widely used `X-RateLimit-Limit/Remaining/Reset` for the tightest one.
 * Every 429 on a hosted deployment carries `details.links` (billing, docs) and
 * a `Link` header.
 */

/** A rate-limit decision must never wait on a slow or unreachable Redis: fall back instead. */
const REDIS_TIMEOUT_MS = 2_000;
/** How long the limiter stays on the in-process fallback after a Redis failure before trying Redis again. */
const BACKEND_RETRY_MS = 5_000;
// Infer the concrete RESP version selected by redis instead of the generic factory.
// No offline queue: while disconnected, commands fail at once (and fall back to
// the in-process limiter) instead of queueing behind a reconnect loop.
const createRateLimitRedisClient = (url: string) => createClient({
  url,
  disableOfflineQueue: true,
  socket: { connectTimeout: REDIS_TIMEOUT_MS, reconnectStrategy: (retries: number) => Math.min(1_000 * 2 ** retries, 30_000) },
});
type RedisClient = ReturnType<typeof createRateLimitRedisClient>;

type RateLimitIdentityMode = "ip" | "actor";
export type RateLimitCategory = "upload" | "search" | "chat-ai" | "read" | "write" | "webhook";
export type RateLimitProfile = "ip" | "account" | "self-hosted";

export type RateLimitOptions = {
  windowMs?: number;
  maxRequests?: number;
  keyPrefix?: string;
  enabled?: boolean;
  now?: () => number;
  identity?: RateLimitIdentityMode;
  profile?: RateLimitProfile;
  store?: RateLimitStore;
};

type CategoryLimit = {
  windowMs: number;
  maxRequests: number;
};

type RateLimitPolicy = Record<RateLimitCategory, CategoryLimit>;

/** One counter to check and consume. Keys of one call must share a hash tag. */
export type RateLimitCounter = {
  key: string;
  limit: number;
  windowMs: number;
  /** Penalty-box duration applied to the identity when this counter is exceeded. */
  penaltyMs?: number;
};

export type RateLimitConsumeInput = {
  /** Penalty-box key for the identity; a live block denies before any counting. */
  blockKey: string;
  counters: RateLimitCounter[];
  now: number;
  /** Count denied requests too, so sustained floods stay limited. */
  countDenied: boolean;
};

export type RateLimitConsumeResult = {
  /** Remaining penalty-box time; when > 0 nothing was counted. */
  blockedMs: number;
  /** Index of the first exceeded counter, or -1. */
  denied: number;
  /** Fixed-window counts before this request, per counter. */
  windows: Array<{ previous: number; current: number }>;
  /** Whether this request was added to the counters. */
  counted: boolean;
};

export interface RateLimitStore {
  consume(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult>;
  reset?(): void | Promise<void>;
}

type PolicyState = {
  name: string;
  limit: number;
  remaining: number;
  resetSeconds: number;
  windowSeconds: number;
};

declare module "hono" {
  interface ContextVariableMap {
    rateLimitPolicies: PolicyState[];
    /** Set when a presented API key was refused with 403 (search-compat adapters): counts as an auth failure. */
    apiKeyRejected: boolean;
  }
}

const DEFAULT_WINDOW_MS = 60_000;

const defaultPolicies: Record<RateLimitProfile, RateLimitPolicy> = {
  ip: {
    upload: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 90 },
    search: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 240 },
    "chat-ai": { windowMs: DEFAULT_WINDOW_MS, maxRequests: 90 },
    read: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 1_200 },
    write: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 300 },
    webhook: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 600 },
  },
  // One table for every account, whatever its billing state: abuse protection
  // only. Spend stays bounded by credits and budgets, and the IP layer and
  // per-key caps still apply.
  account: {
    upload: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 120 },
    search: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 600 },
    "chat-ai": { windowMs: DEFAULT_WINDOW_MS, maxRequests: 120 },
    read: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 1_500 },
    write: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 600 },
    webhook: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 600 },
  },
  "self-hosted": {
    upload: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 600 },
    search: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 1_800 },
    "chat-ai": { windowMs: DEFAULT_WINDOW_MS, maxRequests: 600 },
    read: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 6_000 },
    write: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 1_800 },
    webhook: { windowMs: DEFAULT_WINDOW_MS, maxRequests: 1_800 },
  },
};

/** Suspicious-traffic defaults; each is overridable by env and disabled with 0. */
const IP_GUARD_DEFAULTS = {
  burstMax: 200,
  burstWindowMs: 10_000,
  burstPenaltyMs: 60_000,
  authFailureMax: 20,
  authFailureWindowMs: 5 * 60_000,
  authFailurePenaltyMs: 15 * 60_000,
};

/** Categories that can incur spend; reads keep working after a spend limit. */
const SPEND_LIMITED_CATEGORIES = new Set<RateLimitCategory>(["upload", "search", "chat-ai"]);
const SPEND_CACHE_TTL_MS = 10_000;

// KEYS[1] = penalty-box key (holds the block's expiry in ms), KEYS[2..] = counter bases.
// ARGV = now, countDenied, then (limit, windowMs, penaltyMs) per counter.
// Returns { blockedMs, deniedIndex (1-based, 0 = allowed), counted, prev1, curr1, prev2, curr2, ... }.
const SLIDING_WINDOW_SCRIPT = `
local now = tonumber(ARGV[1])
local blockedUntil = tonumber(redis.call('GET', KEYS[1]) or '0')
if blockedUntil > now then return { blockedUntil - now, 0, 0 } end
local countDenied = ARGV[2] == '1'
local out = { 0, 0, 0 }
local current = {}
local denied = 0
for i = 2, #KEYS do
  local base = 3 + (i - 2) * 3
  local limit = tonumber(ARGV[base])
  local window = tonumber(ARGV[base + 1])
  local bucket = math.floor(now / window)
  local currKey = KEYS[i] .. ':' .. bucket
  local curr = tonumber(redis.call('GET', currKey) or '0')
  local prev = tonumber(redis.call('GET', KEYS[i] .. ':' .. (bucket - 1)) or '0')
  local overlap = 1 - (now - bucket * window) / window
  if denied == 0 and prev * overlap + curr + 1 > limit then denied = i - 1 end
  current[i] = currKey
  out[#out + 1] = prev
  out[#out + 1] = curr
end
if denied == 0 or countDenied then
  for i = 2, #KEYS do
    redis.call('INCR', current[i])
    redis.call('PEXPIRE', current[i], tonumber(ARGV[3 + (i - 2) * 3 + 1]) * 2)
  end
  out[3] = 1
end
if denied > 0 then
  local penalty = tonumber(ARGV[3 + (denied - 1) * 3 + 2])
  if penalty > 0 then redis.call('SET', KEYS[1], tostring(now + penalty), 'PX', penalty) end
end
out[2] = denied
return out
`;
const SLIDING_WINDOW_SHA = createHash("sha1").update(SLIDING_WINDOW_SCRIPT).digest("hex");

function scriptArgs(input: RateLimitConsumeInput): { keys: string[]; args: string[] } {
  return {
    keys: [input.blockKey, ...input.counters.map((counter) => counter.key)],
    args: [
      String(input.now),
      input.countDenied ? "1" : "0",
      ...input.counters.flatMap((counter) => [String(counter.limit), String(counter.windowMs), String(counter.penaltyMs ?? 0)]),
    ],
  };
}

function parseScriptResult(result: unknown, counterCount: number): RateLimitConsumeResult {
  if (!Array.isArray(result) || result.length < 3) throw new Error("Redis returned an invalid rate limit result");
  const values = result.map(Number);
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Redis returned non-numeric rate limit values");
  const [blockedMs, denied, counted] = values as [number, number, number];
  if (blockedMs > 0) return { blockedMs, denied: -1, counted: false, windows: [] };
  const windows = Array.from({ length: counterCount }, (_, index) => ({
    previous: values[3 + index * 2] ?? 0,
    current: values[4 + index * 2] ?? 0,
  }));
  return { blockedMs: 0, denied: denied - 1, counted: counted === 1, windows };
}

/** Default cap on in-process limiter entries (~200 bytes each, so roughly 40 MB at the cap). */
export const MEMORY_STORE_DEFAULT_MAX_ENTRIES = 200_000;

/**
 * The per-process limiter. It is bounded: when it holds `maxEntries`, expired
 * entries are swept and then the oldest-written entries are evicted (Map
 * insertion order; every write re-inserts its key). Eviction can forget an
 * idle counter early, never disable limiting, and is logged.
 */
class InMemorySlidingWindowStore implements RateLimitStore {
  private values = new Map<string, { value: number; expiresAt: number }>();
  private lastSweepAt = 0;
  private evictionLogged = false;
  private lastCapSweepAt = 0;

  constructor(private readonly maxEntries = memoryStoreMaxEntries()) {}

  get size(): number {
    return this.values.size;
  }

  private write(key: string, entry: { value: number; expiresAt: number }, now: number): void {
    this.values.delete(key);
    if (this.values.size >= this.maxEntries) {
      // A full sweep is O(entries): at most once a second, so a flood at the cap stays cheap.
      if (now - this.lastCapSweepAt >= 1_000) {
        this.lastCapSweepAt = now;
        for (const [existing, value] of this.values) if (value.expiresAt <= now) this.values.delete(existing);
      }
      let evicted = 0;
      for (const existing of this.values.keys()) {
        if (this.values.size < this.maxEntries) break;
        this.values.delete(existing);
        evicted++;
      }
      if (evicted > 0 && !this.evictionLogged) {
        this.evictionLogged = true;
        console.warn(`[rate-limit] in-memory limiter reached ${this.maxEntries} entries; evicting the oldest counters (set API_RATE_LIMIT_MEMORY_MAX_ENTRIES or configure Redis)`);
      }
    }
    this.values.set(key, entry);
  }

  async consume(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult> {
    const { now } = input;
    this.sweep(now);
    const blockedMs = this.ttl(input.blockKey, now);
    if (blockedMs > 0) return { blockedMs, denied: -1, counted: false, windows: [] };

    let denied = -1;
    const keys: string[] = [];
    const windows = input.counters.map((counter, index) => {
      const bucket = Math.floor(now / counter.windowMs);
      const current = this.read(`${counter.key}:${bucket}`, now);
      const previous = this.read(`${counter.key}:${bucket - 1}`, now);
      const overlap = 1 - (now - bucket * counter.windowMs) / counter.windowMs;
      if (denied < 0 && previous * overlap + current + 1 > counter.limit) denied = index;
      keys.push(`${counter.key}:${bucket}`);
      return { previous, current };
    });

    const counted = denied < 0 || input.countDenied;
    if (counted) {
      input.counters.forEach((counter, index) => {
        const key = keys[index]!;
        this.write(key, { value: this.read(key, now) + 1, expiresAt: now + counter.windowMs * 2 }, now);
      });
    }
    const penaltyMs = denied >= 0 ? input.counters[denied]?.penaltyMs ?? 0 : 0;
    if (penaltyMs > 0) this.write(input.blockKey, { value: 1, expiresAt: now + penaltyMs }, now);
    return { blockedMs: 0, denied, counted, windows };
  }

  private read(key: string, now: number): number {
    const entry = this.values.get(key);
    return entry && entry.expiresAt > now ? entry.value : 0;
  }

  private ttl(key: string, now: number): number {
    const entry = this.values.get(key);
    return entry && entry.expiresAt > now ? entry.expiresAt - now : 0;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < DEFAULT_WINDOW_MS) return;
    this.lastSweepAt = now;
    for (const [key, entry] of this.values) if (entry.expiresAt <= now) this.values.delete(key);
  }

  reset(): void {
    this.values.clear();
    this.lastSweepAt = 0;
    this.evictionLogged = false;
  }
}

function memoryStoreMaxEntries(): number {
  const parsed = Number(process.env.API_RATE_LIMIT_MEMORY_MAX_ENTRIES?.trim());
  return Number.isInteger(parsed) && parsed >= 1_000 ? parsed : MEMORY_STORE_DEFAULT_MAX_ENTRIES;
}

/** Falls back to the in-process store, logging once, when the backend fails. */
abstract class FallbackStore implements RateLimitStore {
  private fallbackWarningLogged = false;

  constructor(private readonly fallback: RateLimitStore) {}

  protected abstract evaluate(keys: string[], args: string[]): Promise<unknown>;

  /** After a failure, skip the backend until this time so an outage costs one timeout, not one per request. */
  private retryBackendAt = 0;

  async consume(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult> {
    if (Date.now() < this.retryBackendAt) return await this.fallback.consume(input);
    try {
      const { keys, args } = scriptArgs(input);
      const result = parseScriptResult(await this.evaluate(keys, args), input.counters.length);
      if (this.fallbackWarningLogged) {
        this.fallbackWarningLogged = false;
        console.warn("[rate-limit] Redis backend recovered; shared limits restored");
      }
      return result;
    } catch (error) {
      // Never fail open: a Redis outage degrades to the per-process limiter,
      // which still enforces every limit (per instance).
      this.retryBackendAt = Date.now() + BACKEND_RETRY_MS;
      if (!this.fallbackWarningLogged) {
        this.fallbackWarningLogged = true;
        console.error("[rate-limit] Redis backend failed; falling back to the per-process in-memory limiter (limits now apply per instance):", error instanceof Error ? error.message : String(error));
      }
      return await this.fallback.consume(input);
    }
  }

  async reset(): Promise<void> {
    await this.fallback.reset?.();
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.includes("NOSCRIPT");
}

class RedisSlidingWindowStore extends FallbackStore {
  private client: RedisClient | null = null;
  private connectPromise: Promise<RedisClient> | null = null;
  private clientErrorLogged = false;

  constructor(private readonly url: string, fallback: RateLimitStore) {
    super(fallback);
  }

  protected async evaluate(keys: string[], args: string[]): Promise<unknown> {
    return await withTimeout(this.evaluateOnce(keys, args), REDIS_TIMEOUT_MS, "Redis rate-limit call timed out");
  }

  private async evaluateOnce(keys: string[], args: string[]): Promise<unknown> {
    const client = await this.connect();
    const tail = [String(keys.length), ...keys, ...args];
    try {
      return await client.sendCommand(["EVALSHA", SLIDING_WINDOW_SHA, ...tail]);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      return await client.sendCommand(["EVAL", SLIDING_WINDOW_SCRIPT, ...tail]);
    }
  }

  private async connect(): Promise<RedisClient> {
    if (this.client?.isOpen) return this.client;
    if (!this.connectPromise) {
      const client = createRateLimitRedisClient(this.url);
      client.on("error", (error) => {
        if (!this.clientErrorLogged) {
          this.clientErrorLogged = true;
          console.error("[rate-limit] Redis client error:", error);
        }
      });
      this.connectPromise = client.connect().then(() => {
        this.client = client;
        this.clientErrorLogged = false;
        return client;
      }).finally(() => {
        this.connectPromise = null;
      });
    }
    return await this.connectPromise;
  }
}

class UpstashRedisSlidingWindowStore extends FallbackStore {
  constructor(private readonly url: string, private readonly token: string, fallback: RateLimitStore) {
    super(fallback);
  }

  protected async evaluate(keys: string[], args: string[]): Promise<unknown> {
    const tail = [String(keys.length), ...keys, ...args];
    try {
      return await this.send(["EVALSHA", SLIDING_WINDOW_SHA, ...tail]);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      return await this.send(["EVAL", SLIDING_WINDOW_SCRIPT, ...tail]);
    }
  }

  private async send(command: string[]): Promise<unknown> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(2_000),
    });
    const payload = await response.json().catch(() => ({})) as { result?: unknown; error?: string };
    if (payload.error) throw new Error(payload.error);
    if (!response.ok) throw new Error(`Upstash Redis returned ${response.status}`);
    return payload.result;
  }
}

/** Standalone stores, for tests and tools; the middleware picks one from env. */
export function createMemoryRateLimitStore(options: { maxEntries?: number } = {}): RateLimitStore & { readonly size: number } {
  return new InMemorySlidingWindowStore(options.maxEntries);
}

export function createRedisRateLimitStore(url: string, fallback: RateLimitStore = createMemoryRateLimitStore()): RateLimitStore {
  return new RedisSlidingWindowStore(url, fallback);
}

const memoryStore = new InMemorySlidingWindowStore();
let defaultStore: RateLimitStore | null = null;
let memoryFallbackWarningLogged = false;
const spendCache = new Map<string, { cents: number; expiresAt: number; pending?: Promise<number> }>();

function readPositiveOptionalInt(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Non-negative env integer; 0 disables the guard it configures. */
function readGuardInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function envName(value: string): string {
  return value.replace(/-/g, "_").toUpperCase();
}

function isContainerRuntime(): boolean {
  return existsSync("/.dockerenv");
}

function rewriteDockerRedisHostname(rawUrl: string): string {
  if (isContainerRuntime()) return rawUrl;
  try {
    const url = new URL(rawUrl);
    if (url.hostname === "redis") {
      url.hostname = "localhost";
      return url.toString();
    }
  } catch {
    return rawUrl;
  }
  return rawUrl;
}

function rateLimitEnabled(): boolean {
  const normalized = process.env.API_RATE_LIMIT_ENABLED?.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized ?? "");
}

/** API_RATE_LIMIT_DEFAULT_PROFILE=paid gives every account the paid table (internal or single-tenant hosts). */
function getDefaultStore(): RateLimitStore {
  if (defaultStore) return defaultStore;

  const restUrl = process.env.API_RATE_LIMIT_REDIS_REST_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim();
  const restToken = process.env.API_RATE_LIMIT_REDIS_REST_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const redisUrl = process.env.API_RATE_LIMIT_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();

  if (restUrl && restToken) {
    defaultStore = new UpstashRedisSlidingWindowStore(restUrl, restToken, memoryStore);
    return defaultStore;
  }
  if (redisUrl) {
    defaultStore = new RedisSlidingWindowStore(rewriteDockerRedisHostname(redisUrl), memoryStore);
    return defaultStore;
  }

  defaultStore = memoryStore;
  if (!memoryFallbackWarningLogged && (process.env.NODE_ENV === "production" || isSelfHostedDeployment())) {
    memoryFallbackWarningLogged = true;
    console.warn(
      "[rate-limit] Redis is not configured; using per-process in-memory API rate limits. "
        + "Set API_RATE_LIMIT_REDIS_URL or API_RATE_LIMIT_REDIS_REST_URL/API_RATE_LIMIT_REDIS_REST_TOKEN for shared limits.",
    );
  }
  return defaultStore;
}

export type RateLimitBackend = "upstash-rest" | "redis" | "memory" | "disabled";

/** Which limiter backend this process uses, from env names only (never values). */
export function rateLimitBackend(): RateLimitBackend {
  if (!rateLimitEnabled()) return "disabled";
  const restUrl = process.env.API_RATE_LIMIT_REDIS_REST_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim();
  const restToken = process.env.API_RATE_LIMIT_REDIS_REST_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (restUrl && restToken) return "upstash-rest";
  if (process.env.API_RATE_LIMIT_REDIS_URL?.trim() || process.env.REDIS_URL?.trim()) return "redis";
  return "memory";
}

/**
 * Startup log for the limiter backend. The in-memory fallback is loud: its
 * limits apply per instance, so N instances allow N times each limit, and a
 * deploy resets them. Disabled limiting is an error in production.
 */
export function logRateLimitBackendAtStartup(log: Pick<Console, "log" | "warn" | "error"> = console): RateLimitBackend {
  const backend = rateLimitBackend();
  if (backend === "disabled") {
    (process.env.NODE_ENV === "production" ? log.error : log.warn)("[rate-limit] backend=disabled: API_RATE_LIMIT_ENABLED turns off every API rate limit");
  } else if (backend === "memory") {
    log.warn(`[rate-limit] backend=memory: Redis is not configured, so API rate limits are per-process (each instance enforces every limit on its own; N instances allow N times the limit, and restarts reset counters). Bounded at ${memoryStoreMaxEntries()} entries. Set API_RATE_LIMIT_REDIS_URL or API_RATE_LIMIT_REDIS_REST_URL/API_RATE_LIMIT_REDIS_REST_TOKEN for shared limits.`);
  } else {
    log.log(`[rate-limit] backend=${backend} (shared limits; falls back to the per-process limiter on Redis errors)`);
  }
  return backend;
}

function safeIdentityPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9:._-]/g, "_");
}

/**
 * The address a per-IP limit counts. IPv6 clients usually control a whole /64,
 * so an IPv6 address counts as its /64 prefix; rotating addresses inside it
 * does not escape the limit. IPv4 (and IPv4-mapped IPv6) count as the address.
 */
export function rateLimitAddress(ip: string): string {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!value.includes(":") || value.includes(".")) return value;
  const [head = "", tail] = value.split("::", 2);
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function requestIdentity(c: Context, identity: RateLimitIdentityMode): string | null {
  if (identity === "actor") {
    const actor = c.get("requestActor");
    if (actor?.type === "apiKey") return `api-key:${actor.apiKey.keyId}`;
    if (actor?.type === "session") return `user:${actor.userId}`;
    return null;
  }
  const ip = requestIp(c);
  return `ip:${ip ? rateLimitAddress(ip) : "unknown"}`;
}

/**
 * Per-visitor limits inside one browser (client) key, keyed by key and IP: a
 * publishable key is shared by every visitor of the customer's site, so one
 * visitor must not be able to use up the whole key's budget. 0 disables a
 * category (`API_RATE_LIMIT_CLIENT_VISITOR_<CATEGORY>_MAX`).
 */
const CLIENT_VISITOR_DEFAULTS: Record<RateLimitCategory, number> = {
  "chat-ai": 20, search: 120, upload: 30, read: 300, write: 60, webhook: 60,
};

function clientVisitorLimit(category: RateLimitCategory): number {
  return readGuardInt(`API_RATE_LIMIT_CLIENT_VISITOR_${envName(category)}_MAX`, CLIENT_VISITOR_DEFAULTS[category]);
}

export function classifyRateLimitCategory(method: string, path: string): RateLimitCategory {
  const normalizedPath = path.replace(/\/+$/, "") || "/";
  const normalizedMethod = method.toUpperCase();

  if (normalizedPath.startsWith("/webhooks/")) return "webhook";
  if ((normalizedPath.startsWith("/v1/ingest") || normalizedPath === "/v1/uploads" || normalizedPath.startsWith("/v1/uploads/"))) return "upload";
  if (
    normalizedPath.startsWith("/v1/search/chat")
    || normalizedPath === "/v1/chat"
    || normalizedPath === "/v1/chat/completions"
    || /^\/v1\/workspaces\/[^/]+\/chat(?:\/|$)/.test(normalizedPath)
  ) {
    return "chat-ai";
  }
  if (
    normalizedPath.startsWith("/v1/search")
    || normalizedPath.startsWith("/v1/web/")
    || normalizedPath.startsWith("/v1/suggest")
    // Every search-compat adapter (Algolia, Meilisearch, Typesense, Pagefind) is a search.
    || normalizedPath === "/compat" || normalizedPath.startsWith("/compat/")
    || normalizedPath.startsWith("/v1/mcp")
    || /^\/v1\/workspaces\/[^/]+\/search(?:\/|$)/.test(normalizedPath)
  ) {
    return "search";
  }
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return "read";
  return "write";
}

function envOverrideLimit(profile: RateLimitProfile, category: RateLimitCategory): Partial<CategoryLimit> {
  const profileName = envName(profile);
  const categoryName = envName(category);
  const profileMax = readPositiveOptionalInt(process.env[`API_RATE_LIMIT_${profileName}_${categoryName}_MAX`]);
  const profileWindow = readPositiveOptionalInt(process.env[`API_RATE_LIMIT_${profileName}_${categoryName}_WINDOW_MS`]);
  const categoryMax = readPositiveOptionalInt(process.env[`API_RATE_LIMIT_${categoryName}_MAX`]);
  const categoryWindow = readPositiveOptionalInt(process.env[`API_RATE_LIMIT_${categoryName}_WINDOW_MS`]);
  return {
    maxRequests: profileMax ?? categoryMax ?? undefined,
    windowMs: profileWindow ?? categoryWindow ?? undefined,
  };
}

/**
 * The limit table for a request: the middleware's own profile (IP layer),
 * self-hosted, or the one table every account shares. Billing state never
 * picks the table. A key's `rateLimitRpm` only caps it (resolveLimit).
 */
function resolveProfile(configuredProfile: RateLimitProfile | undefined): RateLimitProfile {
  if (configuredProfile) return configuredProfile;
  if (isSelfHostedDeployment()) return "self-hosted";
  return "account";
}

function resolveLimit(
  c: Context,
  category: RateLimitCategory,
  profile: RateLimitProfile,
  options: RateLimitOptions,
): CategoryLimit {
  // Explicit middleware options win. The legacy global env pair
  // (API_RATE_LIMIT_MAX_REQUESTS / _WINDOW_MS) is only a last-resort fallback
  // for a category with no policy: it used to override every category policy,
  // which flattened the per-profile table to one number in production.
  const policy: CategoryLimit | undefined = defaultPolicies[profile]?.[category];
  const override = envOverrideLimit(profile, category);
  let maxRequests = options.maxRequests ?? override.maxRequests ?? policy?.maxRequests
    ?? readPositiveOptionalInt(process.env.API_RATE_LIMIT_MAX_REQUESTS) ?? defaultPolicies.account.read.maxRequests;
  const windowMs = options.windowMs ?? override.windowMs ?? policy?.windowMs
    ?? readPositiveOptionalInt(process.env.API_RATE_LIMIT_WINDOW_MS) ?? DEFAULT_WINDOW_MS;

  const actor = c.get("requestActor");
  // A key's requests-per-minute is an optional cap: only an explicit value lowers the plan's limit.
  const keyCap = actor?.type === "apiKey" ? actor.apiKey.rateLimitRpm : null;
  if (options.identity === "actor" && typeof keyCap === "number" && keyCap > 0) {
    maxRequests = Math.min(maxRequests, keyCap);
  }

  return { maxRequests: Math.max(1, maxRequests), windowMs: Math.max(1, windowMs) };
}

/** A sliding-window estimate for a counter after this request. */
function counterState(
  name: string,
  counter: RateLimitCounter,
  window: { previous: number; current: number },
  counted: boolean,
  now: number,
): PolicyState & { retryAfterSeconds: number } {
  const { limit, windowMs } = counter;
  const bucketStart = Math.floor(now / windowMs) * windowMs;
  const elapsed = (now - bucketStart) / windowMs;
  const current = window.current + (counted ? 1 : 0);
  const estimate = window.previous * (1 - elapsed) + current;

  // When does one more request fit (estimate + 1 <= limit)?
  let waitMs: number;
  if (estimate + 1 <= limit) {
    waitMs = 0;
  } else if (current + 1 <= limit && window.previous > 0) {
    const fraction = 1 - (limit - 1 - current) / window.previous;
    waitMs = Math.max(0, (fraction - elapsed) * windowMs);
  } else {
    const nextFraction = current > 0 ? Math.max(0, 1 - (limit - 1) / current) : 0;
    waitMs = bucketStart + windowMs - now + nextFraction * windowMs;
  }

  const windowEndSeconds = Math.max(1, Math.ceil((bucketStart + windowMs - now) / 1000));
  const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
  return {
    name,
    limit,
    remaining: Math.max(0, Math.floor(limit - estimate)),
    resetSeconds: waitMs > 0 ? retryAfterSeconds : windowEndSeconds,
    windowSeconds: Math.max(1, Math.round(windowMs / 1000)),
    retryAfterSeconds,
  };
}

function quote(name: string): string {
  return `"${name.replace(/["\\]/g, "")}"`;
}

/** Writes RateLimit-Policy/RateLimit for every policy so far, and X-RateLimit-* for the tightest. */
function writePolicyHeaders(c: Context, states: PolicyState[]): void {
  const policies = [...(c.get("rateLimitPolicies") ?? []).filter((existing) => !states.some((state) => state.name === existing.name)), ...states];
  c.set("rateLimitPolicies", policies);
  if (policies.length === 0) return;

  c.header("RateLimit-Policy", policies.map((policy) => `${quote(policy.name)};q=${policy.limit};w=${policy.windowSeconds}`).join(", "));
  c.header("RateLimit", policies.map((policy) => `${quote(policy.name)};r=${policy.remaining};t=${policy.resetSeconds}`).join(", "));

  const tightest = policies.reduce((best, policy) =>
    policy.remaining < best.remaining || (policy.remaining === best.remaining && policy.resetSeconds > best.resetSeconds) ? policy : best);
  c.header("X-RateLimit-Limit", String(tightest.limit));
  c.header("X-RateLimit-Remaining", String(tightest.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + tightest.resetSeconds));
}

type RateLimitCode = Extract<ApiErrorCode, "rate_limited" | "spend_limit_exceeded" | "daily_page_limit" | "ip_temporarily_blocked">;

/**
 * 429 in the error envelope (the legacy `{ error, code }` body on protocol
 * surfaces) with `Retry-After`, plus billing links and the copy that
 * points at them on hosted deployments.
 */
function tooManyRequests(c: Context, code: RateLimitCode, message: string, details: { retryAfterSeconds: number } & Record<string, unknown>): Response {
  c.header("Retry-After", String(details.retryAfterSeconds));
  const linked = withUpgradeLinks(code, details) ?? details;
  return middlewareErrorResponse(c, 429, code, linked.links ? publicApiErrorMessage(code, linked) : message, linked);
}

function blockedResponse(c: Context, blockedMs: number): Response {
  return tooManyRequests(c, "ip_temporarily_blocked", "Too many requests from this network; try again later", {
    retryAfterSeconds: Math.max(1, Math.ceil(blockedMs / 1000)),
  });
}

/** `scope` splits one policy into sub-buckets (for example per visitor IP) without putting it in the public policy name. */
type NamedCounter = RateLimitCounter & { name: string; scope?: string };

async function consumeCounters(
  c: Context,
  args: { identity: string; keyPrefix: string; counters: NamedCounter[]; now: number; countDenied: boolean; store: RateLimitStore; category: RateLimitCategory; profile: RateLimitProfile },
): Promise<Response | null> {
  // The identity is a hash tag, so every key of one call lives on one Redis Cluster slot.
  const base = `${args.keyPrefix}:{${safeIdentityPart(args.identity)}}`;
  const counters = args.counters.map((counter) => ({
    ...counter,
    key: `${base}:${counter.name}${counter.scope ? `:${safeIdentityPart(counter.scope)}` : ""}:${counter.windowMs}`,
  }));
  const result = await args.store.consume({ blockKey: `${base}:block`, counters, now: args.now, countDenied: args.countDenied });
  if (result.blockedMs > 0) return blockedResponse(c, result.blockedMs);

  const states = counters.map((counter, index) =>
    counterState(counter.name, counter, result.windows[index] ?? { previous: 0, current: 0 }, result.counted, args.now));
  writePolicyHeaders(c, states);

  if (result.denied >= 0) {
    const state = states[result.denied]!;
    const penaltyMs = counters[result.denied]?.penaltyMs ?? 0;
    if (penaltyMs > 0) return blockedResponse(c, penaltyMs);
    return tooManyRequests(c, "rate_limited", "Too many requests", {
      category: args.category, policy: state.name, retryAfterSeconds: state.retryAfterSeconds,
    });
  }
  return null;
}


function keyPrefixFor(options: RateLimitOptions): string {
  return options.keyPrefix ?? process.env.API_RATE_LIMIT_KEY_PREFIX ?? "api";
}

async function checkRateLimit(c: Context, options: RateLimitOptions): Promise<Response | null> {
  if (options.enabled === false || !rateLimitEnabled()) return null;

  const identityMode = options.identity ?? "ip";
  const identity = requestIdentity(c, identityMode);
  if (!identity) return null;

  const now = (options.now ?? Date.now)();
  const category = classifyRateLimitCategory(c.req.method, c.req.path);
  const profile = resolveProfile(options.profile);
  const limit = resolveLimit(c, category, profile, options);
  const store = options.store ?? getDefaultStore();
  const counters: NamedCounter[] = [{ name: `${profile}-${category}`, key: "", limit: limit.maxRequests, windowMs: limit.windowMs }];

  if (identityMode === "ip") {
    // Unattributable traffic (internal calls, health checks) shares one bucket; never jail it.
    const burstMax = requestIp(c) ? readGuardInt("API_RATE_LIMIT_IP_BURST_MAX", IP_GUARD_DEFAULTS.burstMax) : 0;
    if (burstMax > 0) {
      counters.push({
        name: "ip-burst",
        key: "",
        limit: burstMax,
        windowMs: readGuardInt("API_RATE_LIMIT_IP_BURST_WINDOW_MS", IP_GUARD_DEFAULTS.burstWindowMs) || IP_GUARD_DEFAULTS.burstWindowMs,
        penaltyMs: readGuardInt("API_RATE_LIMIT_IP_BURST_PENALTY_MS", IP_GUARD_DEFAULTS.burstPenaltyMs),
      });
    }
    // Count denied IP traffic so a flood cannot slip through at the limit's edge.
    return await consumeCounters(c, { identity, keyPrefix: keyPrefixFor(options), counters, now, countDenied: true, store, category, profile });
  }

  const actor = c.get("requestActor");
  const apiKey = actor?.type === "apiKey" ? actor.apiKey : null;
  if (apiKey) {
    for (const rule of apiKey.rateLimits ?? []) {
      if (rule.metric !== "requests") continue;
      counters.push({ name: apiKeyRateLimitPolicyName(rule), key: "", limit: rule.limit, windowMs: rule.windowSeconds * 1000 });
    }
    // Browser keys: one visitor (IP) gets only a share of the key's budget.
    const ip = requestIp(c);
    const visitorLimit = apiKey.keyType !== "server" ? clientVisitorLimit(category) : 0;
    if (ip && visitorLimit > 0) {
      counters.push({ name: `client-visitor-${category}`, scope: rateLimitAddress(ip), key: "", limit: visitorLimit, windowMs: DEFAULT_WINDOW_MS });
    }
    const quota = await checkApiKeyQuotas(c, apiKey, category, now);
    if (quota) return quota;
  }
  return await consumeCounters(c, { identity, keyPrefix: keyPrefixFor(options), counters, now, countDenied: false, store, category, profile });
}

type ApiKeyQuotaSubject = {
  keyId: string;
  rateLimitPpd: number;
  rateLimits?: ApiKeyRateLimitRule[];
};

/** Daily page cap (uploads) and spend windows (cost-incurring categories). */
async function checkApiKeyQuotas(c: Context, apiKey: ApiKeyQuotaSubject, category: RateLimitCategory, now: number): Promise<Response | null> {
  if (category === "upload" && apiKey.rateLimitPpd > 0) {
    const pages = await apiKeyPagesToday(apiKey.keyId, now);
    if (pages >= apiKey.rateLimitPpd) {
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      return tooManyRequests(c, "daily_page_limit", `This API key has used its ${apiKey.rateLimitPpd.toLocaleString("en-US")} pages for today`, {
        category,
        retryAfterSeconds: Math.max(1, Math.ceil((midnight.getTime() - now) / 1000)),
      });
    }
  }

  const spendRules = (apiKey.rateLimits ?? []).filter((rule) => rule.metric === "spend");
  if (spendRules.length === 0) return null;
  const spends = await Promise.all(spendRules.map(async (rule) => ({
    rule,
    cents: await cachedSpendCents(apiKey.keyId, rule.windowSeconds, now),
  })));
  const tightest = spends.reduce((best, spend) =>
    spend.rule.limit - spend.cents < best.rule.limit - best.cents ? spend : best);
  const remaining = Math.max(0, tightest.rule.limit - tightest.cents);
  c.header(
    "X-DocSlurp-Spend",
    `${quote(apiKeyRateLimitPolicyName(tightest.rule))};q=${tightest.rule.limit};r=${Math.floor(remaining)};w=${tightest.rule.windowSeconds};u=usd-cents`,
  );

  const exceeded = spends.find((spend) => spend.cents >= spend.rule.limit);
  if (exceeded && SPEND_LIMITED_CATEGORIES.has(category)) {
    return tooManyRequests(c, "spend_limit_exceeded", `This API key reached its $${(exceeded.rule.limit / 100).toFixed(2)} spend limit for the current window`, {
      category,
      policy: apiKeyRateLimitPolicyName(exceeded.rule),
      spentCents: Math.round(exceeded.cents * 100) / 100,
      limitCents: exceeded.rule.limit,
      // Spend leaves a rolling window gradually; re-check after the cache refresh.
      retryAfterSeconds: Math.min(exceeded.rule.windowSeconds, 60),
    });
  }
  return null;
}

/** Attributed spend, cached per process for a few seconds with single-flight refreshes. */
async function cachedSpendCents(keyId: string, windowSeconds: number, now: number): Promise<number> {
  const cacheKey = `${keyId}:${windowSeconds}`;
  const cached = spendCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.cents;
  if (cached?.pending) return await cached.pending;

  const pending = apiKeySpendCents(keyId, new Date(now - windowSeconds * 1000));
  spendCache.set(cacheKey, { cents: cached?.cents ?? 0, expiresAt: 0, pending });
  try {
    const cents = await pending;
    spendCache.set(cacheKey, { cents, expiresAt: now + SPEND_CACHE_TTL_MS });
    return cents;
  } catch (error) {
    spendCache.delete(cacheKey);
    console.error("[rate-limit] spend lookup failed; allowing request:", error instanceof Error ? error.message : String(error));
    return 0;
  }
}

/** Bearer keys plus the key headers search-compat adapters accept. */
function presentsApiCredential(c: Context): boolean {
  return Boolean(
    c.req.header("authorization")?.startsWith("Bearer ")
      || c.req.header("x-api-key")
      || c.req.header("x-algolia-api-key")
      || c.req.header("x-typesense-api-key"),
  );
}

/** Repeated invalid credentials from one IP look like key guessing; jail the IP. */
async function recordAuthFailure(c: Context, options: RateLimitOptions): Promise<void> {
  const max = readGuardInt("API_RATE_LIMIT_AUTH_FAILURE_MAX", IP_GUARD_DEFAULTS.authFailureMax);
  if (max === 0 || !requestIp(c)) return;
  const identity = requestIdentity(c, "ip")!;
  const base = `${keyPrefixFor(options)}:{${safeIdentityPart(identity)}}`;
  const windowMs = readGuardInt("API_RATE_LIMIT_AUTH_FAILURE_WINDOW_MS", IP_GUARD_DEFAULTS.authFailureWindowMs) || IP_GUARD_DEFAULTS.authFailureWindowMs;
  await (options.store ?? getDefaultStore()).consume({
    blockKey: `${base}:block`,
    counters: [{
      key: `${base}:auth-failures:${windowMs}`,
      limit: max,
      windowMs,
      penaltyMs: readGuardInt("API_RATE_LIMIT_AUTH_FAILURE_PENALTY_MS", IP_GUARD_DEFAULTS.authFailurePenaltyMs),
    }],
    now: (options.now ?? Date.now)(),
    countDenied: true,
  });
}

export function resetApiRateLimitBuckets(): void {
  memoryStore.reset();
  defaultStore?.reset?.();
  defaultStore = null;
  memoryFallbackWarningLogged = false;
  spendCache.clear();
}

export async function enforceAuthenticatedApiRateLimit(c: Context): Promise<Response | null> {
  if (!c.get("requestActor") || c.get("rateLimitActorChecked")) return null;
  c.set("rateLimitActorChecked", true);
  return await checkRateLimit(c, { identity: "actor" });
}

export function createApiRateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const limited = await checkRateLimit(c, options);
    if (limited) return limited;
    await next();

    const authFailed = c.res.status === 401 || (c.res.status === 403 && c.get("apiKeyRejected") === true);
    if ((options.identity ?? "ip") === "ip" && authFailed && presentsApiCredential(c)
      && options.enabled !== false && rateLimitEnabled()) {
      try {
        await recordAuthFailure(c, options);
      } catch (error) {
        console.error("[rate-limit] auth failure tracking failed:", error instanceof Error ? error.message : String(error));
      }
    }
  };
}

export const apiIpRateLimit = createApiRateLimit({
  identity: "ip",
  profile: "ip",
  keyPrefix: process.env.API_RATE_LIMIT_KEY_PREFIX ?? "api-ip",
});

export const apiActorRateLimit: MiddlewareHandler = async (c, next) => {
  const limited = await enforceAuthenticatedApiRateLimit(c);
  if (limited) return limited;
  await next();
};

export const apiRateLimit = apiIpRateLimit;
