/**
 * Provider back-pressure for AI HTTP calls (vision, embeddings).
 *
 * - `fetchWithProviderRetry` retries 429/5xx and network errors with full
 *   jitter, honouring `Retry-After` / `retry-after-ms`, and throws a typed
 *   `ProviderRetryableError` once in-process retries are exhausted so the
 *   Temporal activity fails *retryably* (with nextRetryDelay) instead of the
 *   page being skipped.
 * - `providerLimiter` bounds in-flight requests per provider per process
 *   (AI_PROVIDER_MAX_CONCURRENCY[_<PROVIDER>]). With 8 slots per machine it
 *   mostly matters for page bundles and embedding batches.
 * - With `rateLimit`, each attempt first reserves fleet-wide TPM/RPM capacity
 *   (provider-rate-limit.ts) and a 429 feeds the fleet's AIMD factor and
 *   Retry-After pause.
 *
 * Quota/billing failures (insufficient_quota, 401/402/403) are not retried:
 * waiting does not fix them.
 */

import { noteWorkProgress, withRequestTimeout } from "./work-progress.js";
import { providerRateLimiter, type ProviderRateLease, type ProviderRateLimiter } from "./provider-rate-limit.js";

export class ProviderRetryableError extends Error {
  readonly retryable = true;
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "ProviderRetryableError";
  }
}

export function isProviderRetryableError(error: unknown): error is ProviderRetryableError {
  if (error instanceof ProviderRetryableError) return true;
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "ProviderRetryableError");
}

/** Finds a ProviderRetryableError in an error's cause chain. */
export function findProviderRetryableError(error: unknown): ProviderRetryableError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (isProviderRetryableError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500
    || status === 502 || status === 503 || status === 504 || status === 529;
}

/** OpenAI reports exhausted credit as 429 insufficient_quota; retrying cannot help. */
export function isQuotaExhaustedBody(body: string): boolean {
  const text = body.toLowerCase();
  return text.includes("insufficient_quota") || text.includes("billing_hard_limit") || text.includes("credit balance");
}

/** Parses `retry-after-ms`, then `Retry-After` (delta-seconds or HTTP date). */
export function parseRetryAfterMs(
  headers: { get(name: string): string | null } | Record<string, string | undefined> | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!headers) return null;
  const read = (name: string): string | null => {
    if (typeof (headers as { get?: unknown }).get === "function") {
      return (headers as { get(name: string): string | null }).get(name);
    }
    const record = headers as Record<string, string | undefined>;
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
    return key ? record[key] ?? null : null;
  };
  const ms = Number.parseFloat(read("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const raw = read("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

/** Full-jitter exponential backoff: uniform in [0, min(maxMs, baseMs·2^attempt)], floored at baseMs/4. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random, baseMs = 1_000, maxMs = 30_000): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.max(Math.round(baseMs / 4), Math.round(random() * ceiling));
}

function readIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function providerKey(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "DEFAULT";
}

/** Derives a stable provider name from an API base URL. */
export function providerFromBaseUrl(baseUrl: string | null | undefined): string {
  if (!baseUrl) return "openai";
  try {
    const host = new URL(baseUrl).hostname;
    if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
    if (host.endsWith("openai.com")) return "openai";
    if (host.endsWith("anthropic.com")) return "anthropic";
    return host;
  } catch {
    return "custom";
  }
}

/** Process-wide in-flight cap per provider. */
export class ProviderConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly limitFor: (provider: string) => number) {}

  async run<T>(provider: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(provider, signal);
    try {
      return await task();
    } finally {
      this.release(provider);
    }
  }

  inFlight(provider: string): number {
    return this.active.get(provider) ?? 0;
  }

  private async acquire(provider: string, signal?: AbortSignal): Promise<void> {
    // An aborted caller never takes a slot, free or not.
    if (signal?.aborted) throw abortReason(signal);
    const limit = Math.max(1, this.limitFor(provider));
    if ((this.active.get(provider) ?? 0) < limit) {
      this.active.set(provider, (this.active.get(provider) ?? 0) + 1);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiters.get(provider) ?? [];
      const onAbort = () => {
        const index = queue.indexOf(grant);
        if (index >= 0) queue.splice(index, 1);
        reject(abortReason(signal));
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      queue.push(grant);
      this.waiters.set(provider, queue);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(provider: string): void {
    const next = this.waiters.get(provider)?.shift();
    if (next) {
      // Hand the slot straight to the next waiter; the active count is unchanged.
      next();
      return;
    }
    this.active.set(provider, Math.max(0, (this.active.get(provider) ?? 1) - 1));
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("aborted");
}

export const providerLimiter = new ProviderConcurrencyLimiter((provider) =>
  readIntEnv(`AI_PROVIDER_MAX_CONCURRENCY_${providerKey(provider)}`, readIntEnv("AI_PROVIDER_MAX_CONCURRENCY", 16)) || 16,
);

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ProviderRetryOptions {
  provider: string;
  /** Label used in error messages, e.g. "vision request". */
  label: string;
  signal?: AbortSignal;
  maxRetries?: number;
  /** A Retry-After longer than this is handed to Temporal instead of sleeping in-process. */
  maxInlineWaitMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  limiter?: ProviderConcurrencyLimiter;
  onRetry?: (info: { attempt: number; status: number | null; delayMs: number }) => void;
  /** Fleet-wide TPM/RPM limiting for this provider+model; `onLease` receives the successful attempt's lease. */
  rateLimit?: { model: string; tokens: number; limiter?: ProviderRateLimiter; onLease?: (lease: ProviderRateLease) => void };
  /**
   * Admission for every HTTP request, inline retries included (the vision attempt guard). `admit` runs
   * inside the concurrency limiter's task, immediately before `fetch`, and its refusal propagates as is;
   * nothing that ends before the request is sent (limiter waits, timeouts and aborts, a fleet limiter
   * refusal) is admitted or counted. `failed` marks a sent request that may have been accepted and
   * billed (5xx other than overload, a network error or timeout after sending). `unbilled` hands back a
   * request the provider refused before accepting it (429, 503/529 overload): it returns false once the
   * call's throttle allowance is spent, and the wait then goes to Temporal. A request cancelled after
   * admission but before `fetch` is handed back with `unbilled("cancelled")`.
   */
  gate?: ProviderRequestGate;
}

/** See `ProviderRetryOptions.gate`. */
export interface ProviderRequestGate {
  admit(): Promise<void>;
  failed(): void;
  unbilled(kind: "throttle" | "cancelled", detail?: { provider: string; status: number }): Promise<boolean>;
}

/**
 * Statuses a provider returns before accepting a request: rate limits and overload.
 *
 * Assumption, not verified against any provider's billing terms: 429 (rate limit) and 503/529
 * (overload) are answered before a model runs, so nothing is billed. The vision guard hands these
 * back (they leave its counts), bounded by `VISION_THROTTLE_ALLOWANCE` per call; each hand-back logs
 * `[vision-throttle-handback]` with the org, so a provider that starts billing them shows up as
 * provider spend with no matching admitted requests.
 */
export function isUnbilledThrottleStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 529;
}

/**
 * A 503 that says no provider can serve the request's routing constraints rather than that one is overloaded.
 * OpenRouter documents 503 as "There is no available model provider that meets your routing requirements"
 * (errors-and-debugging docs); its provider-selection docs say `max_price` "will prevent your request from
 * running" without naming a status. Assumption, not verified with a paid call: a `max_price` exclusion is that
 * 503, or a body naming no matching endpoints or the max price. Such a response is a failure, not a throttle.
 */
export function isRoutingExclusion(status: number, body: string): boolean {
  if (status !== 503 && status !== 404) return false;
  return /routing requirements|no endpoints found|max[_ ]price/i.test(body);
}

/**
 * fetch() with provider back-pressure. Returns the first non-retryable
 * response (callers still check `response.ok`); throws ProviderRetryableError
 * when 429/5xx/network failures outlast the retry budget.
 */
export async function fetchWithProviderRetry(url: string, init: RequestInit, options: ProviderRetryOptions): Promise<Response> {
  const maxRetries = options.maxRetries ?? readIntEnv("AI_PROVIDER_MAX_RETRIES", 4);
  const maxInlineWaitMs = options.maxInlineWaitMs ?? readIntEnv("AI_PROVIDER_MAX_INLINE_WAIT_MS", 60_000);
  const doFetch = options.fetchImpl ?? fetch;
  const pause = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const limiter = options.limiter ?? providerLimiter;

  for (let attempt = 0; ; attempt++) {
    let status: number | null = null;
    let retryAfterMs: number | null = null;
    let detail: string;
    const rateLimiter = options.rateLimit ? options.rateLimit.limiter ?? providerRateLimiter() : null;
    // Set once the gate admitted this request and it is handed to fetch: anything before is free.
    let sent = false;
    let lease: ProviderRateLease | null = null;
    let allowanceSpent = false;
    try {
      lease = rateLimiter
        ? await rateLimiter.acquire({ provider: options.provider, model: options.rateLimit!.model, tokens: options.rateLimit!.tokens, signal: options.signal })
        : null;
      // Each attempt is bounded (WORKER_AI_REQUEST_TIMEOUT_MS); a timeout is a network error and retries here.
      const response = await limiter.run(options.provider, async () => {
        // Admitted inside the limiter's task, right before sending: queue waits never consume admissions.
        if (options.signal?.aborted) throw abortReason(options.signal);
        await options.gate?.admit();
        // Cancelled while the admission was pending (a database round trip): hand it back unsent.
        if (options.signal?.aborted) {
          await options.gate?.unbilled("cancelled");
          throw abortReason(options.signal);
        }
        sent = true;
        return await doFetch(url, { ...init, signal: withRequestTimeout(options.signal) });
      }, options.signal);
      noteWorkProgress(`provider:${options.provider}`);
      if (response.ok || !isRetryableStatus(response.status)) {
        if (lease) options.rateLimit?.onLease?.(lease);
        return response;
      }
      status = response.status;
      const body = await response.text().catch(() => "");
      if (isRoutingExclusion(status, body)) {
        // No provider meets the request's routing constraints (max_price included): retrying cannot help, and
        // handing it back as a throttle would loop in Temporal. Counted as a failure and returned to the caller.
        options.gate?.failed();
        if (lease) options.rateLimit?.onLease?.(lease);
        return new Response(body, { status, headers: response.headers });
      }
      // A rate limit or overload is refused before acceptance: it leaves the guard's counts.
      if (isUnbilledThrottleStatus(status) && options.gate) {
        allowanceSpent = !(await options.gate.unbilled("throttle", { provider: options.provider, status }));
      } else options.gate?.failed();
      retryAfterMs = parseRetryAfterMs(response.headers);
      if (status === 429 && rateLimiter) {
        await rateLimiter.reportThrottle({ provider: options.provider, model: options.rateLimit!.model, retryAfterMs });
      }
      if (status === 429 && isQuotaExhaustedBody(body)) {
        // Quota exhaustion is a configuration problem; let the caller's fail-open policy decide.
        return new Response(body, { status, headers: response.headers });
      }
      detail = `${status} ${body.slice(0, 300)}`;
    } catch (error) {
      if (!sent) {
        // Never sent (limiter wait or abort, fleet limiter refusal, guard refusal): nothing to count.
        lease?.settle(0);
        throw error;
      }
      options.gate?.failed();
      if (options.signal?.aborted) throw error;
      // The fleet limiter already waited its budget; hand the wait to Temporal.
      if (isProviderRetryableError(error)) throw error;
      detail = `network error: ${error instanceof Error ? error.message : String(error)}`;
    }

    const exhausted = attempt >= maxRetries || allowanceSpent;
    const tooLong = retryAfterMs !== null && retryAfterMs > maxInlineWaitMs;
    if (exhausted || tooLong) {
      throw new ProviderRetryableError(
        `${options.label} failed after ${attempt + 1} attempt(s): ${detail}`,
        options.provider,
        status,
        retryAfterMs,
        attempt + 1,
      );
    }
    const delayMs = Math.min(maxInlineWaitMs, Math.max(retryAfterMs ?? 0, backoffDelayMs(attempt, random)));
    options.onRetry?.({ attempt: attempt + 1, status, delayMs });
    console.warn(`[provider-retry] provider=${options.provider} label="${options.label}" attempt=${attempt + 1} status=${status ?? "network"} delay_ms=${delayMs}`);
    await pause(delayMs, options.signal);
  }
}

/** Maps an AI SDK error (APICallError / RetryError) carrying a 429/5xx to ProviderRetryableError. */
export function toProviderRetryableError(error: unknown, provider: string, label: string): ProviderRetryableError | null {
  const candidates: unknown[] = [error, (error as { lastError?: unknown } | null)?.lastError, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const status = (candidate as { statusCode?: unknown }).statusCode;
    if (typeof status !== "number" || !isRetryableStatus(status)) continue;
    const body = String((candidate as { responseBody?: unknown }).responseBody ?? "");
    if (status === 429 && isQuotaExhaustedBody(body)) return null;
    const headers = (candidate as { responseHeaders?: Record<string, string> }).responseHeaders;
    const message = error instanceof Error ? error.message : String(error);
    return new ProviderRetryableError(`${label} failed: ${status} ${message}`.slice(0, 500), provider, status, parseRetryAfterMs(headers), 1);
  }
  return null;
}
