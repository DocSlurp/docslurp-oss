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

/**
 * Stable codes for a failed provider request. Error messages built here carry the code and the HTTP status only: a
 * provider's (or a tenant-run model server's) response text can quote anything, so it goes to the worker log
 * (`[provider-error]`) and never into an error message, which may be stored on runs, stages, manifests and usage rows.
 */
export type ProviderErrorCode =
  | "rate-limited"
  | "overloaded"
  | "server-error"
  | "timeout"
  | "network-error"
  | "routing-excluded"
  | "quota-exhausted"
  | "auth-refused"
  | "payment-required"
  | "redirect-refused"
  | "not-found"
  | "bad-request"
  | "http-error";

/** The `ProviderErrorCode` for an HTTP status (no body is read). */
export function providerErrorCodeForStatus(status: number): ProviderErrorCode {
  if (status === 429) return "rate-limited";
  if (status === 503 || status === 529) return "overloaded";
  if (status === 408 || status === 504) return "timeout";
  if (status === 402) return "payment-required";
  if (status === 401 || status === 403) return "auth-refused";
  if (status === 404) return "not-found";
  if (status === 400 || status === 422) return "bad-request";
  if (status >= 500) return "server-error";
  return "http-error";
}

/** `<code> (<status>)`, or the code alone: the only failure detail an error message built from a response carries. */
export function providerErrorSummary(code: ProviderErrorCode, status: number | null): string {
  return status === null ? code : `${code} (${status})`;
}

/** The code for a request that got no response: `timeout` for a timeout, else `network-error`. */
export function providerNetworkErrorCode(error: unknown): ProviderErrorCode {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return name === "TimeoutError" || /time(d)? ?out/i.test(message) ? "timeout" : "network-error";
}

/**
 * True when a fetch failed because the response was a redirect and the request refused to follow it
 * (`redirect: "error"`). Judged on the error and its causes.
 */
export function isRefusedRedirectError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth += 1) {
    const message = current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (/unexpected redirect|redirect mode is set to error|redirect count exceeded/i.test(message)) return true;
  }
  return false;
}

/**
 * A provider answered with a redirect that the request refused to follow: never retried (the same request gets the
 * same redirect), and the message carries the code only.
 */
export class ProviderRedirectRefusedError extends Error {
  readonly code = "redirect-refused" as const;
  readonly retryable = false;
  constructor(label: string, readonly provider: string) {
    super(`${label} failed: redirect-refused`);
    this.name = "ProviderRedirectRefusedError";
  }
}

/** Logs a provider's response text for operators (worker log and traces only), bounded and JSON-quoted. */
export function logProviderErrorDetail(provider: string, label: string, code: ProviderErrorCode | "invalid-json", status: number | null, detail: string): void {
  console.warn(
    `[provider-error] provider=${provider} label="${label}" code=${code} status=${status ?? "none"} ` +
      `detail=${JSON.stringify(detail.replace(/\s+/g, " ").slice(0, 500))}`,
  );
}

export class ProviderRetryableError extends Error {
  readonly retryable = true;
  readonly code: ProviderErrorCode;
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null,
    readonly attempts: number,
    code?: ProviderErrorCode,
  ) {
    super(message);
    this.name = "ProviderRetryableError";
    this.code = code ?? (status === null ? "network-error" : providerErrorCodeForStatus(status));
  }
}

/**
 * A provider answered with an error status that retrying cannot fix (400/401/403/404, quota). The message carries
 * `code` and `status` only; the response text was logged where the error was built. `statusCode` mirrors `status`
 * for callers that classify AI SDK errors by it.
 */
export class ProviderRequestError extends Error {
  readonly code: ProviderErrorCode;
  readonly statusCode: number;
  constructor(label: string, readonly provider: string, readonly status: number, code?: ProviderErrorCode) {
    const resolved = code ?? providerErrorCodeForStatus(status);
    super(`${label} failed: ${providerErrorSummary(resolved, status)}`);
    this.name = "ProviderRequestError";
    this.code = resolved;
    this.statusCode = status;
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
  /** Observe each HTTP error before retries consume it; true means billing evidence exists. */
  onHttpError?: (response: Response) => Promise<boolean>;
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
  unbilled(kind: "throttle" | "cancelled" | "routing", detail?: { provider: string; status: number }): Promise<boolean>;
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
 * A request no provider could serve under its routing constraints (`isRoutingExclusion`: a `max_price` ceiling or a host
 * allowlist excluded every host). Nothing was billed; retrying the same request cannot help.
 */
export class ProviderRoutingExclusionError extends Error {
  readonly code: ProviderErrorCode = "routing-excluded";
  /** `_detail` (the response body) is not kept: the caller logs it (`[provider-routing-exclusion]`). */
  constructor(readonly status: number, _detail?: string) {
    super(`no provider meets the request's routing constraints: ${providerErrorSummary("routing-excluded", status)}`);
    this.name = "ProviderRoutingExclusionError";
  }
}

/** Find a ProviderRoutingExclusionError in an error or its causes. */
export function findProviderRoutingExclusion(error: unknown): ProviderRoutingExclusionError | null {
  for (let current = error, depth = 0; current && depth < 8; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (current instanceof ProviderRoutingExclusionError) return current;
  }
  return null;
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
    let code: ProviderErrorCode;
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
        // Never follows a redirect: these requests carry a provider key or go to a tenant-set endpoint, and a redirect
        // would resend the key and body to a host nobody checked.
        return await doFetch(url, { ...init, redirect: "error", signal: withRequestTimeout(options.signal) });
      }, options.signal);
      noteWorkProgress(`provider:${options.provider}`);
      const billedError = !response.ok && options.onHttpError ? await options.onHttpError(response.clone()) : false;
      if (response.ok || !isRetryableStatus(response.status)) {
        if (lease) options.rateLimit?.onLease?.(lease);
        return response;
      }
      status = response.status;
      const body = await response.text().catch(() => "");
      if (isRoutingExclusion(status, body)) {
        // No provider meets the request's routing constraints (max_price included): retrying cannot help, and
        // handing it back as a throttle would loop in Temporal. Counted as a failure and returned to the caller.
        // Logged: on vision it means max_price (its image cap included) excluded every pinned provider.
        console.warn(
          `[provider-routing-exclusion] provider=${options.provider} label="${options.label}" status=${status} ` +
            `detail=${JSON.stringify(body.slice(0, 200))}`,
        );
        // Nothing was billed: the request leaves the page bound, the breaker and the org count (never a failure).
        if (options.gate) await options.gate.unbilled("routing", { provider: options.provider, status });
        if (lease) options.rateLimit?.onLease?.(lease);
        return new Response(body, { status, headers: response.headers });
      }
      // A rate limit or overload is refused before acceptance: it leaves the guard's counts.
      if (isUnbilledThrottleStatus(status) && !billedError && options.gate) {
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
      code = providerErrorCodeForStatus(status);
      logProviderErrorDetail(options.provider, options.label, code, status, body);
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
      if (isRefusedRedirectError(error)) {
        logProviderErrorDetail(options.provider, options.label, "redirect-refused", null, error instanceof Error ? error.message : String(error));
        throw new ProviderRedirectRefusedError(options.label, options.provider);
      }
      code = providerNetworkErrorCode(error);
      logProviderErrorDetail(options.provider, options.label, code, null, error instanceof Error ? error.message : String(error));
    }

    const exhausted = attempt >= maxRetries || allowanceSpent;
    const tooLong = retryAfterMs !== null && retryAfterMs > maxInlineWaitMs;
    if (exhausted || tooLong) {
      throw new ProviderRetryableError(
        `${options.label} failed after ${attempt + 1} attempt(s): ${providerErrorSummary(code, status)}`,
        options.provider,
        status,
        retryAfterMs,
        attempt + 1,
        code,
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
    const code = providerErrorCodeForStatus(status);
    logProviderErrorDetail(provider, label, code, status, `${error instanceof Error ? error.message : String(error)} ${body}`);
    return new ProviderRetryableError(`${label} failed: ${providerErrorSummary(code, status)}`, provider, status, parseRetryAfterMs(headers), 1, code);
  }
  return null;
}

/**
 * An AI SDK error (APICallError, or a RetryError wrapping one) that carries an HTTP status, as a coded
 * `ProviderRequestError` whose message holds no response text (that is logged here). Errors without a status (a
 * dropped connection, our own checks) are returned unchanged: their text is local, not the remote's.
 */
export function toProviderRequestError(error: unknown, provider: string, label: string): unknown {
  if (error instanceof ProviderRequestError || isProviderRetryableError(error)) return error;
  const candidates: unknown[] = [error, (error as { lastError?: unknown } | null)?.lastError, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const status = (candidate as { statusCode?: unknown }).statusCode;
    if (typeof status !== "number") continue;
    const body = String((candidate as { responseBody?: unknown }).responseBody ?? "");
    const code = status === 429 && isQuotaExhaustedBody(body) ? "quota-exhausted" : providerErrorCodeForStatus(status);
    logProviderErrorDetail(provider, label, code, status, `${error instanceof Error ? error.message : String(error)} ${body}`);
    return new ProviderRequestError(label, provider, status, code);
  }
  return error;
}
