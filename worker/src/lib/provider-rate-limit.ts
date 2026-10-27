/**
 * Fleet-wide provider rate limiting (tokens and requests per minute).
 *
 * One OpenAI key throttles at a fixed TPM no matter how many workers share it.
 * Without coordination, 72 workers each retry into the same limit. This module
 * keeps one token bucket per provider+model for the whole fleet, plus a fair
 * per-org sub-bucket, in a shared store (Redis over TCP, or Upstash REST):
 *
 * - **Buckets.** A reservation ("debt") token bucket: a caller whose request
 *   fits within `MAX_RESERVE_MS` of refill reserves its tokens at once (the
 *   bucket may go negative) and sleeps until they mature. Later callers see the
 *   debt, so waits queue in arrival order and nobody polls in a tight loop.
 * - **Fairness.** Each org gets `rate * min(1, orgShareFactor / activeOrgs)`,
 *   where `activeOrgs` counts orgs that asked within the active window. One org
 *   alone gets the whole limit; N busy orgs get roughly 1/N each.
 * - **AIMD.** A 429 multiplies a shared rate factor by `decrease` (at most once
 *   per `decreaseCooldownMs`, so 72 workers seeing the same 429 burst cut it
 *   once), and the factor recovers linearly. A provider `Retry-After` pauses
 *   the whole fleet for that provider+model until it passes.
 * - **Fallback.** If the shared store fails, the limiter degrades to the same
 *   algorithm in process memory, scaled by `localShare`, and retries the shared
 *   store after a cooldown.
 *
 * The in-memory store and the Lua script implement the same algorithm; tests
 * cover the memory store everywhere and the Lua script when Redis is reachable.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { setOpenRouterProviderPolicyResolver } from "@docslurp/shared";

import { pushPerfMetric } from "./perf-context.js";
import { ProviderRetryableError, backoffDelayMs } from "./provider-retry.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ProviderRateRule {
  /** Pattern such as `openai:text-embedding-*`, `openrouter:*` or `*`. */
  pattern: string;
  tokensPerMinute: number;
  requestsPerMinute: number;
}

export interface ProviderRateLimitConfig {
  enabled: boolean;
  rules: ProviderRateRule[];
  /** Bucket capacity, as milliseconds of refill. */
  burstMs: number;
  /** Longest a caller waits in total before failing retryably to Temporal. */
  maxWaitMs: number;
  /** Fraction of the configured limit each process uses when the shared store is down. */
  localShare: number;
  orgShareFactor: number;
  activeOrgWindowMs: number;
  decrease: number;
  minFactor: number;
  /** Linear recovery of the AIMD factor, per minute. */
  recoverPerMinute: number;
  decreaseCooldownMs: number;
  /** Longest fleet-wide pause a single Retry-After can impose. */
  maxPauseMs: number;
  keyPrefix: string;
}

/** OpenAI throttled text-embedding-3-small at about 3 M TPM in the 2026-10-09 load test. */
export const DEFAULT_PROVIDER_RATE_RULES = "openai:text-embedding-*=tpm:2500000";

const MAX_RESERVE_MS = 15_000;

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * Parses `AI_RATE_LIMITS`: `;`-separated `pattern=dim:value,dim:value` entries,
 * where dim is `tpm` or `rpm`, e.g.
 * `openai:text-embedding-*=tpm:2500000,rpm:5000;openrouter:*=rpm:3000`.
 * `none` disables every rule.
 */
export function parseProviderRateRules(spec: string): ProviderRateRule[] {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "off") return [];
  const rules: ProviderRateRule[] = [];
  for (const entry of trimmed.split(";")) {
    const [rawPattern, rawLimits] = entry.split("=");
    const pattern = rawPattern?.trim().toLowerCase();
    if (!pattern || !rawLimits) continue;
    let tokensPerMinute = 0;
    let requestsPerMinute = 0;
    for (const part of rawLimits.split(",")) {
      const [dim, value] = part.split(":").map((piece) => piece.trim().toLowerCase());
      const parsed = Number(value?.replace(/_/g, ""));
      if (!Number.isFinite(parsed) || parsed < 0) continue;
      if (dim === "tpm") tokensPerMinute = parsed;
      else if (dim === "rpm") requestsPerMinute = parsed;
    }
    if (tokensPerMinute > 0 || requestsPerMinute > 0) rules.push({ pattern, tokensPerMinute, requestsPerMinute });
  }
  return rules;
}

export function readProviderRateLimitConfig(env: NodeJS.ProcessEnv = process.env): ProviderRateLimitConfig {
  const enabledRaw = env.AI_RATE_LIMIT_ENABLED?.trim().toLowerCase();
  return {
    enabled: !["0", "false", "off", "no"].includes(enabledRaw ?? ""),
    rules: parseProviderRateRules(env.AI_RATE_LIMITS ?? DEFAULT_PROVIDER_RATE_RULES),
    burstMs: envNumber(env, "AI_RATE_LIMIT_BURST_MS", 2_000, 100),
    maxWaitMs: envNumber(env, "AI_RATE_LIMIT_MAX_WAIT_MS", 120_000, 0),
    localShare: Math.min(1, envNumber(env, "AI_RATE_LIMIT_LOCAL_SHARE", 1, 0.001)),
    orgShareFactor: envNumber(env, "AI_RATE_LIMIT_ORG_SHARE_FACTOR", 1.5, 0.01),
    activeOrgWindowMs: envNumber(env, "AI_RATE_LIMIT_ACTIVE_ORG_WINDOW_MS", 10_000, 100),
    decrease: Math.min(1, envNumber(env, "AI_RATE_LIMIT_DECREASE", 0.7, 0.01)),
    minFactor: Math.min(1, envNumber(env, "AI_RATE_LIMIT_MIN_FACTOR", 0.1, 0.001)),
    recoverPerMinute: envNumber(env, "AI_RATE_LIMIT_RECOVER_PER_MINUTE", 0.2, 0),
    decreaseCooldownMs: envNumber(env, "AI_RATE_LIMIT_DECREASE_COOLDOWN_MS", 5_000, 0),
    maxPauseMs: envNumber(env, "AI_RATE_LIMIT_MAX_PAUSE_MS", 60_000, 0),
    keyPrefix: env.AI_RATE_LIMIT_KEY_PREFIX?.trim() || "ai-rl",
  };
}

/** Exact match wins, then the longest `prefix*`, then `provider:*`, then `*`. */
export function matchProviderRateRule(rules: ProviderRateRule[], provider: string, model: string): ProviderRateRule | null {
  const id = `${provider}:${model}`.toLowerCase();
  let best: ProviderRateRule | null = null;
  let bestScore = -1;
  for (const rule of rules) {
    let score = -1;
    if (rule.pattern === id) score = Number.MAX_SAFE_INTEGER;
    else if (rule.pattern.endsWith("*") && id.startsWith(rule.pattern.slice(0, -1))) score = rule.pattern.length;
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Store contract and algorithm
// ---------------------------------------------------------------------------

export interface BucketRequest {
  key: string;
  perMinute: number;
  cost: number;
  /** Org sub-buckets scale by the fair share. */
  org: boolean;
}

export interface ConsumeInput {
  metaKey: string;
  activeOrgsKey: string;
  orgId: string | null;
  now: number;
  maxReserveMs: number;
  burstMs: number;
  orgShareFactor: number;
  activeOrgWindowMs: number;
  /** Factor recovery per millisecond. */
  recoverPerMs: number;
  buckets: BucketRequest[];
}

export interface ConsumeResult {
  /** Wait before sending (when reserved) or before asking again (when not). */
  waitMs: number;
  reserved: boolean;
  factor: number;
  activeOrgs: number;
}

export interface PenalizeInput {
  metaKey: string;
  now: number;
  decrease: number;
  minFactor: number;
  recoverPerMs: number;
  cooldownMs: number;
  retryAfterMs: number;
  maxPauseMs: number;
}

export interface ProviderRateStore {
  readonly kind: string;
  consume(input: ConsumeInput): Promise<ConsumeResult>;
  /** Adds `delta` tokens back (or takes them, when negative) without waiting. */
  adjust(keys: string[], delta: number): Promise<void>;
  penalize(input: PenalizeInput): Promise<{ factor: number; pauseUntil: number }>;
}

interface BucketState { tokens: number; ts: number }
interface MetaState { factor: number; factorAt: number; pauseUntil: number }

/** Process-local store; the reference implementation of the Lua script below. */
export class MemoryProviderRateStore implements ProviderRateStore {
  readonly kind = "memory";
  private readonly buckets = new Map<string, BucketState>();
  private readonly meta = new Map<string, MetaState>();
  private readonly active = new Map<string, Map<string, number>>();

  /** Scales every limit, e.g. to this process's share of a fleet. */
  constructor(private readonly scale = 1) {}

  private effectiveFactor(meta: MetaState | undefined, now: number, recoverPerMs: number): number {
    if (!meta) return 1;
    return Math.min(1, meta.factor + recoverPerMs * Math.max(0, now - meta.factorAt));
  }

  async consume(input: ConsumeInput): Promise<ConsumeResult> {
    const meta = this.meta.get(input.metaKey);
    const factor = this.effectiveFactor(meta, input.now, input.recoverPerMs);
    if (meta && meta.pauseUntil > input.now) {
      return { waitMs: meta.pauseUntil - input.now, reserved: false, factor, activeOrgs: 0 };
    }
    let activeOrgs = 1;
    if (input.orgId) {
      const orgs = this.active.get(input.activeOrgsKey) ?? new Map<string, number>();
      orgs.set(input.orgId, input.now);
      for (const [org, seen] of orgs) if (seen < input.now - input.activeOrgWindowMs) orgs.delete(org);
      this.active.set(input.activeOrgsKey, orgs);
      activeOrgs = Math.max(1, orgs.size);
    }
    const orgShare = Math.min(1, input.orgShareFactor / activeOrgs);
    const next: Array<[string, BucketState]> = [];
    let wait = 0;
    for (const bucket of input.buckets) {
      let rate = (bucket.perMinute * this.scale * factor) / 60_000;
      if (bucket.org) rate *= orgShare;
      rate = Math.max(rate, 1e-9);
      const capacity = Math.max(rate * input.burstMs, 1);
      const state = this.buckets.get(bucket.key);
      let tokens = state ? Math.min(capacity, state.tokens + rate * Math.max(0, input.now - state.ts)) : capacity;
      const need = Math.min(bucket.cost, capacity);
      if (tokens < need) wait = Math.max(wait, (need - tokens) / rate);
      tokens -= bucket.cost;
      next.push([bucket.key, { tokens, ts: input.now }]);
    }
    if (wait > input.maxReserveMs) {
      return { waitMs: Math.ceil(wait), reserved: false, factor, activeOrgs };
    }
    for (const [key, state] of next) this.buckets.set(key, state);
    return { waitMs: Math.ceil(wait), reserved: true, factor, activeOrgs };
  }

  async adjust(keys: string[], delta: number): Promise<void> {
    for (const key of keys) {
      const state = this.buckets.get(key);
      if (state) state.tokens += delta;
    }
  }

  async penalize(input: PenalizeInput): Promise<{ factor: number; pauseUntil: number }> {
    const meta = this.meta.get(input.metaKey) ?? { factor: 1, factorAt: 0, pauseUntil: 0 };
    let factor = this.effectiveFactor(meta, input.now, input.recoverPerMs);
    if (input.now - meta.factorAt >= input.cooldownMs) {
      factor = Math.max(input.minFactor, factor * input.decrease);
      meta.factor = factor;
      meta.factorAt = input.now;
    }
    if (input.retryAfterMs > 0) {
      meta.pauseUntil = Math.max(meta.pauseUntil, input.now + Math.min(input.retryAfterMs, input.maxPauseMs));
    }
    this.meta.set(input.metaKey, meta);
    return { factor, pauseUntil: meta.pauseUntil };
  }
}

// KEYS[1] meta hash (f, ft, pause), KEYS[2] active-org zset, KEYS[3..] buckets.
// ARGV: now, maxReserveMs, recoverPerMs, activeWindowMs, orgId, orgShareFactor, burstMs,
//       then (perMinute, cost, isOrg) per bucket.
// Returns { waitMs, reserved, factor (string), activeOrgs }.
export const CONSUME_SCRIPT = `
local now = tonumber(ARGV[1])
local maxReserve = tonumber(ARGV[2])
local recover = tonumber(ARGV[3])
local activeWindow = tonumber(ARGV[4])
local org = ARGV[5]
local shareFactor = tonumber(ARGV[6])
local burstMs = tonumber(ARGV[7])
local meta = redis.call('HMGET', KEYS[1], 'f', 'ft', 'pause')
local f = tonumber(meta[1] or '1')
local ft = tonumber(meta[2] or '0')
local pause = tonumber(meta[3] or '0')
local factor = 1
if meta[1] then factor = math.min(1, f + recover * math.max(0, now - ft)) end
if pause > now then return { math.ceil(pause - now), 0, tostring(factor), 0 } end
local active = 1
if org ~= '' then
  redis.call('ZADD', KEYS[2], now, org)
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - activeWindow)
  redis.call('PEXPIRE', KEYS[2], activeWindow * 2)
  active = math.max(1, redis.call('ZCARD', KEYS[2]))
end
local orgShare = math.min(1, shareFactor / active)
local wait = 0
local nextTokens = {}
for i = 3, #KEYS do
  local base = 8 + (i - 3) * 3
  local rate = tonumber(ARGV[base]) * factor / 60000
  if ARGV[base + 2] == '1' then rate = rate * orgShare end
  if rate < 1e-9 then rate = 1e-9 end
  local cost = tonumber(ARGV[base + 1])
  local capacity = math.max(rate * burstMs, 1)
  local st = redis.call('HMGET', KEYS[i], 't', 'ts')
  local tokens = capacity
  if st[1] then tokens = math.min(capacity, tonumber(st[1]) + rate * math.max(0, now - tonumber(st[2]))) end
  local need = math.min(cost, capacity)
  if tokens < need then
    local w = (need - tokens) / rate
    if w > wait then wait = w end
  end
  nextTokens[i] = tokens - cost
end
if wait > maxReserve then return { math.ceil(wait), 0, tostring(factor), active } end
for i = 3, #KEYS do
  redis.call('HSET', KEYS[i], 't', tostring(nextTokens[i]), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[i], 600000)
end
return { math.ceil(wait), 1, tostring(factor), active }
`;

// KEYS = buckets; ARGV[1] = delta. Only adjusts buckets that still exist.
export const ADJUST_SCRIPT = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('HINCRBYFLOAT', KEYS[i], 't', ARGV[1]) end
end
return 1
`;

// KEYS[1] meta; ARGV: now, decrease, minFactor, recoverPerMs, cooldownMs, retryAfterMs, maxPauseMs.
export const PENALIZE_SCRIPT = `
local now = tonumber(ARGV[1])
local meta = redis.call('HMGET', KEYS[1], 'f', 'ft', 'pause')
local factor = 1
local ft = tonumber(meta[2] or '0')
if meta[1] then factor = math.min(1, tonumber(meta[1]) + tonumber(ARGV[4]) * math.max(0, now - ft)) end
if now - ft >= tonumber(ARGV[5]) then
  factor = math.max(tonumber(ARGV[3]), factor * tonumber(ARGV[2]))
  redis.call('HSET', KEYS[1], 'f', tostring(factor), 'ft', tostring(now))
end
local pause = tonumber(meta[3] or '0')
local retryAfter = tonumber(ARGV[6])
if retryAfter > 0 then
  local candidate = now + math.min(retryAfter, tonumber(ARGV[7]))
  if candidate > pause then pause = candidate end
  redis.call('HSET', KEYS[1], 'pause', tostring(pause))
end
redis.call('PEXPIRE', KEYS[1], 3600000)
return { tostring(factor), tostring(pause) }
`;

type SendCommand = (command: string[]) => Promise<unknown>;

/** Redis-backed store over any transport that can send a raw command. */
export class RedisProviderRateStore implements ProviderRateStore {
  readonly kind: string;
  private readonly shas = new Map<string, string>();

  constructor(private readonly send: SendCommand, kind = "redis") {
    this.kind = kind;
  }

  private async evaluate(script: string, keys: string[], args: string[]): Promise<unknown> {
    const tail = [String(keys.length), ...keys, ...args];
    const sha = this.shas.get(script);
    if (sha) {
      try {
        return await this.send(["EVALSHA", sha, ...tail]);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("NOSCRIPT"))) throw error;
      }
    }
    const result = await this.send(["EVAL", script, ...tail]);
    const { createHash } = await import("node:crypto");
    this.shas.set(script, createHash("sha1").update(script).digest("hex"));
    return result;
  }

  async consume(input: ConsumeInput): Promise<ConsumeResult> {
    const keys = [input.metaKey, input.activeOrgsKey, ...input.buckets.map((bucket) => bucket.key)];
    const args = [
      String(input.now), String(input.maxReserveMs), String(input.recoverPerMs), String(input.activeOrgWindowMs),
      input.orgId ?? "", String(input.orgShareFactor), String(input.burstMs),
      ...input.buckets.flatMap((bucket) => [String(bucket.perMinute), String(bucket.cost), bucket.org ? "1" : "0"]),
    ];
    const result = await this.evaluate(CONSUME_SCRIPT, keys, args);
    if (!Array.isArray(result) || result.length < 4) throw new Error("unexpected rate-limit script result");
    return {
      waitMs: Number(result[0]),
      reserved: Number(result[1]) === 1,
      factor: Number(result[2]),
      activeOrgs: Number(result[3]),
    };
  }

  async adjust(keys: string[], delta: number): Promise<void> {
    if (!keys.length || !Number.isFinite(delta) || delta === 0) return;
    await this.evaluate(ADJUST_SCRIPT, keys, [String(delta)]);
  }

  async penalize(input: PenalizeInput): Promise<{ factor: number; pauseUntil: number }> {
    const result = await this.evaluate(PENALIZE_SCRIPT, [input.metaKey], [
      String(input.now), String(input.decrease), String(input.minFactor), String(input.recoverPerMs),
      String(input.cooldownMs), String(input.retryAfterMs), String(input.maxPauseMs),
    ]);
    if (!Array.isArray(result) || result.length < 2) throw new Error("unexpected rate-limit script result");
    return { factor: Number(result[0]), pauseUntil: Number(result[1]) };
  }
}

/** Uses the shared store; on failure, the local store until `retryAfterMs` passes. */
export class FallbackProviderRateStore implements ProviderRateStore {
  private downUntil = 0;
  private warned = false;

  constructor(
    private readonly primary: ProviderRateStore,
    private readonly fallback: ProviderRateStore,
    private readonly now: () => number = Date.now,
    private readonly retryAfterMs = 30_000,
  ) {}

  get kind(): string {
    return this.now() < this.downUntil ? `${this.fallback.kind} (fallback)` : this.primary.kind;
  }

  private async attempt<T>(run: (store: ProviderRateStore) => Promise<T>): Promise<T> {
    if (this.now() >= this.downUntil) {
      try {
        const result = await run(this.primary);
        if (this.warned) {
          console.warn(`[ai-rate-limit] shared store ${this.primary.kind} recovered`);
          this.warned = false;
        }
        return result;
      } catch (error) {
        this.downUntil = this.now() + this.retryAfterMs;
        if (!this.warned) {
          this.warned = true;
          console.error(`[ai-rate-limit] shared store ${this.primary.kind} failed; using process-local limits:`, error);
        }
      }
    }
    return await run(this.fallback);
  }

  consume(input: ConsumeInput): Promise<ConsumeResult> {
    return this.attempt((store) => store.consume(input));
  }

  adjust(keys: string[], delta: number): Promise<void> {
    return this.attempt((store) => store.adjust(keys, delta));
  }

  penalize(input: PenalizeInput): Promise<{ factor: number; pauseUntil: number }> {
    return this.attempt((store) => store.penalize(input));
  }
}

function upstashSender(url: string, token: string): SendCommand {
  return async (command) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(2_000),
    });
    const payload = (await response.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (payload.error) throw new Error(payload.error);
    if (!response.ok) throw new Error(`Upstash Redis returned ${response.status}`);
    return payload.result;
  };
}

function redisTcpSender(rawUrl: string): SendCommand {
  type Client = { isOpen: boolean; connect(): Promise<unknown>; sendCommand(args: string[]): Promise<unknown>; on(event: string, cb: (error: unknown) => void): unknown };
  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;
  const connect = async (): Promise<Client> => {
    if (client?.isOpen) return client;
    if (!connecting) {
      connecting = (async () => {
        const { createClient } = await import("redis");
        const created = createClient({
          url: rawUrl,
          socket: { connectTimeout: 2_000, reconnectStrategy: (retries: number) => Math.min(retries * 500, 5_000) },
        }) as unknown as Client;
        created.on("error", () => { /* surfaced through command failures */ });
        await created.connect();
        client = created;
        return created;
      })().finally(() => {
        connecting = null;
      });
    }
    return await connecting;
  };
  return async (command) => {
    // The initial connect keeps retrying in the background; never let a caller wait on it.
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        connect().then((active) => active.sendCommand(command)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("redis command timed out")), 2_000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

function rewriteDockerRedisHostname(rawUrl: string): string {
  if (existsSync("/.dockerenv")) return rawUrl;
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

/** Shared store from env (REST first, then TCP), wrapped with a local fallback. */
export function createProviderRateStoreFromEnv(env: NodeJS.ProcessEnv = process.env, config = readProviderRateLimitConfig(env)): ProviderRateStore {
  const local = new MemoryProviderRateStore(config.localShare);
  const restUrl = env.AI_RATE_LIMIT_REDIS_REST_URL || env.API_RATE_LIMIT_REDIS_REST_URL || env.UPSTASH_REDIS_REST_URL;
  const restToken = env.AI_RATE_LIMIT_REDIS_REST_TOKEN || env.API_RATE_LIMIT_REDIS_REST_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const tcpUrl = env.AI_RATE_LIMIT_REDIS_URL || env.API_RATE_LIMIT_REDIS_URL || env.REDIS_URL;
  if (restUrl?.trim() && restToken?.trim()) {
    return new FallbackProviderRateStore(new RedisProviderRateStore(upstashSender(restUrl.trim(), restToken.trim()), "upstash"), local);
  }
  if (tcpUrl?.trim()) {
    return new FallbackProviderRateStore(new RedisProviderRateStore(redisTcpSender(rewriteDockerRedisHostname(tcpUrl.trim())), "redis"), local);
  }
  return local;
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

const scopeStorage = new AsyncLocalStorage<{ orgId: string | null; allowChinaProviders: boolean }>();

/**
 * Attributes provider calls inside `fn` to an org for the fair-share buckets,
 * and carries the org's China-provider policy to OpenRouter requests.
 */
export function runWithProviderRateScope<T>(scope: { orgId: string | null | undefined; allowChinaProviders?: boolean }, fn: () => Promise<T>): Promise<T> {
  return scopeStorage.run({ orgId: scope.orgId ?? null, allowChinaProviders: scope.allowChinaProviders !== false }, fn);
}

/** The current job's provider policy; undefined outside a job scope. */
export function currentProviderPolicy(): { allowChinaProviders: boolean } | undefined {
  const scope = scopeStorage.getStore();
  return scope ? { allowChinaProviders: scope.allowChinaProviders } : undefined;
}

// Worker OpenRouter requests (text, vision, embeddings) read the job's policy.
setOpenRouterProviderPolicyResolver(currentProviderPolicy);

export function currentProviderRateOrg(): string | null {
  return scopeStorage.getStore()?.orgId ?? null;
}

export interface ProviderRateLease {
  readonly waitedMs: number;
  /** Corrects the token reservation with the provider-reported usage. */
  settle(actualTokens: number | null | undefined): void;
}

const NOOP_LEASE: ProviderRateLease = { waitedMs: 0, settle: () => {} };

export interface AcquireInput {
  provider: string;
  model: string;
  tokens: number;
  orgId?: string | null;
  signal?: AbortSignal;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hashTag(value: string): string {
  return value.replace(/[{}\s]/g, "_");
}

export class ProviderRateLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(
    readonly store: ProviderRateStore,
    readonly config: ProviderRateLimitConfig,
    deps: { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; random?: () => number } = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? abortableSleep;
    this.random = deps.random ?? Math.random;
  }

  private keys(provider: string, model: string, orgId: string | null) {
    const base = `${this.config.keyPrefix}:{${hashTag(`${provider}:${model}`.toLowerCase())}}`;
    return {
      meta: `${base}:meta`,
      activeOrgs: `${base}:orgs`,
      globalTokens: `${base}:g:tpm`,
      globalRequests: `${base}:g:rpm`,
      orgTokens: orgId ? `${base}:o:${hashTag(orgId)}:tpm` : null,
      orgRequests: orgId ? `${base}:o:${hashTag(orgId)}:rpm` : null,
    };
  }

  rule(provider: string, model: string): ProviderRateRule | null {
    if (!this.config.enabled) return null;
    return matchProviderRateRule(this.config.rules, provider, model);
  }

  /**
   * Waits for fleet capacity, then returns a lease. Throws ProviderRetryableError
   * when capacity does not free up within `maxWaitMs`, so Temporal retries later.
   */
  async acquire(input: AcquireInput): Promise<ProviderRateLease> {
    const rule = this.rule(input.provider, input.model);
    if (!rule) return NOOP_LEASE;
    const orgId = input.orgId === undefined ? currentProviderRateOrg() : input.orgId;
    const keys = this.keys(input.provider, input.model, orgId);
    const tokens = Math.max(1, Math.round(input.tokens));
    const buckets: BucketRequest[] = [];
    if (rule.tokensPerMinute > 0) {
      buckets.push({ key: keys.globalTokens, perMinute: rule.tokensPerMinute, cost: tokens, org: false });
      if (keys.orgTokens) buckets.push({ key: keys.orgTokens, perMinute: rule.tokensPerMinute, cost: tokens, org: true });
    }
    if (rule.requestsPerMinute > 0) {
      buckets.push({ key: keys.globalRequests, perMinute: rule.requestsPerMinute, cost: 1, org: false });
      if (keys.orgRequests) buckets.push({ key: keys.orgRequests, perMinute: rule.requestsPerMinute, cost: 1, org: true });
    }
    const tokenKeys = buckets.filter((bucket) => bucket.key.endsWith(":tpm")).map((bucket) => bucket.key);

    const startedAt = this.now();
    for (;;) {
      const result = await this.store.consume({
        metaKey: keys.meta,
        activeOrgsKey: keys.activeOrgs,
        orgId,
        now: this.now(),
        maxReserveMs: MAX_RESERVE_MS,
        burstMs: this.config.burstMs,
        orgShareFactor: this.config.orgShareFactor,
        activeOrgWindowMs: this.config.activeOrgWindowMs,
        recoverPerMs: this.config.recoverPerMinute / 60_000,
        buckets,
      });
      const elapsed = this.now() - startedAt;
      if (result.reserved) {
        if (result.waitMs > 0) await this.sleep(result.waitMs, input.signal);
        const waitedMs = this.now() - startedAt;
        this.observeWait(input, waitedMs, result);
        return {
          waitedMs,
          settle: (actual) => {
            if (!tokenKeys.length || typeof actual !== "number" || !Number.isFinite(actual)) return;
            const delta = tokens - Math.max(0, actual);
            // Skip the round trip when the estimate was within 10%.
            if (Math.abs(delta) <= tokens * 0.1) return;
            this.store.adjust(tokenKeys, delta).catch(() => {});
          },
        };
      }
      if (elapsed + result.waitMs > this.config.maxWaitMs) {
        throw new ProviderRetryableError(
          `fleet rate limit for ${input.provider}:${input.model} needs ${result.waitMs} ms more after waiting ${elapsed} ms`,
          input.provider,
          429,
          result.waitMs,
          1,
        );
      }
      // Not reserved: ask again after part of the wait, jittered so callers spread out.
      const pause = Math.max(50, Math.min(result.waitMs, MAX_RESERVE_MS) * (0.5 + this.random() * 0.5));
      await this.sleep(Math.round(pause), input.signal);
    }
  }

  /** Records a provider 429: AIMD decrease plus a fleet pause for Retry-After. */
  async reportThrottle(input: { provider: string; model: string; retryAfterMs: number | null }): Promise<void> {
    const rule = this.rule(input.provider, input.model);
    if (!rule) return;
    const keys = this.keys(input.provider, input.model, null);
    const result = await this.store.penalize({
      metaKey: keys.meta,
      now: this.now(),
      decrease: this.config.decrease,
      minFactor: this.config.minFactor,
      recoverPerMs: this.config.recoverPerMinute / 60_000,
      cooldownMs: this.config.decreaseCooldownMs,
      retryAfterMs: input.retryAfterMs ?? 0,
      maxPauseMs: this.config.maxPauseMs,
    }).catch(() => null);
    if (result) {
      console.warn(
        `[ai-rate-limit] throttled provider=${input.provider} model=${input.model} factor=${result.factor.toFixed(3)} ` +
          `pause_ms=${Math.max(0, result.pauseUntil - this.now())} store=${this.store.kind}`,
      );
    }
  }

  private observeWait(input: AcquireInput, waitedMs: number, result: ConsumeResult): void {
    if (waitedMs < 250) return;
    pushPerfMetric({
      metric: "provider-rate-limit-wait",
      value: waitedMs,
      unit: "ms",
      tags: [input.provider, input.model],
      metadata: { factor: result.factor, activeOrgs: result.activeOrgs, store: this.store.kind },
    });
    if (waitedMs >= 2_000) {
      console.log(
        `[ai-rate-limit] waited provider=${input.provider} model=${input.model} wait_ms=${waitedMs} ` +
          `factor=${result.factor.toFixed(3)} active_orgs=${result.activeOrgs} store=${this.store.kind}`,
      );
    }
  }
}

let defaultLimiter: ProviderRateLimiter | null = null;

export function providerRateLimiter(): ProviderRateLimiter {
  if (!defaultLimiter) {
    const config = readProviderRateLimitConfig();
    defaultLimiter = new ProviderRateLimiter(createProviderRateStoreFromEnv(process.env, config), config);
  }
  return defaultLimiter;
}

export function setProviderRateLimiterForTests(limiter: ProviderRateLimiter | null): void {
  defaultLimiter = limiter;
}

/**
 * Runs `attempt` under the fleet limiter with provider retries: each attempt
 * reserves capacity first, a 429 feeds AIMD and Retry-After to the fleet, and
 * exhausted retries throw ProviderRetryableError for Temporal.
 */
export async function runWithProviderRateLimit<T>(
  options: {
    provider: string;
    model: string;
    tokens: number;
    label: string;
    signal?: AbortSignal;
    maxRetries: number;
    maxInlineWaitMs?: number;
    limiter?: ProviderRateLimiter;
    random?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    classify: (error: unknown) => ProviderRetryableError | null;
    actualTokens?: (result: T) => number | null | undefined;
  },
  attempt: () => Promise<T>,
): Promise<T> {
  const limiter = options.limiter ?? providerRateLimiter();
  const random = options.random ?? Math.random;
  const pause = options.sleep ?? abortableSleep;
  const maxInlineWaitMs = options.maxInlineWaitMs ?? 60_000;
  for (let index = 0; ; index++) {
    const lease = await limiter.acquire({ provider: options.provider, model: options.model, tokens: options.tokens, signal: options.signal });
    try {
      const result = await attempt();
      lease.settle(options.actualTokens?.(result));
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const retryable = options.classify(error);
      if (!retryable) throw error;
      if (retryable.status === 429) {
        await limiter.reportThrottle({ provider: options.provider, model: options.model, retryAfterMs: retryable.retryAfterMs });
      }
      const tooLong = retryable.retryAfterMs !== null && retryable.retryAfterMs > maxInlineWaitMs;
      if (index >= options.maxRetries || tooLong) {
        throw new ProviderRetryableError(
          `${options.label} failed after ${index + 1} attempt(s): ${retryable.message}`.slice(0, 500),
          options.provider,
          retryable.status,
          retryable.retryAfterMs,
          index + 1,
        );
      }
      const delayMs = Math.min(maxInlineWaitMs, Math.max(retryable.retryAfterMs ?? 0, backoffDelayMs(index, random)));
      console.warn(
        `[provider-retry] provider=${options.provider} label="${options.label}" attempt=${index + 1} ` +
          `status=${retryable.status ?? "network"} delay_ms=${delayMs}`,
      );
      await pause(delayMs, options.signal);
    }
  }
}
