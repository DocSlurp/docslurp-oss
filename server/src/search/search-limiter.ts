import { AsyncLocalStorage } from "node:async_hooks";

import { HTTPException } from "hono/http-exception";

import { resolveDatabasePoolMax } from "../lib/api-pool.js";

/**
 * Process-wide bound on concurrent hybrid searches.
 *
 * One search issues 15-20 Postgres round trips (scope, settings, availability,
 * vector hydration, several lexical queries, page and graph stages, parent
 * text, the session transaction, zero-result diagnostics, usage), five or six
 * of them in parallel during retrieval. On 2026-10-20 ten chat agent turns
 * fanned out up to six searches each against a 10-connection pool; queries
 * queued for seconds (Postgres span p50 3.6 s, p99 21-110 s) and starved
 * everything else on the pool, health probes included.
 *
 * Excess searches now wait here, where waiting costs a promise, instead of in
 * the pool queue, where every waiting query delays auth, uploads and status
 * reads behind it. Nested searches (decompose, stepback and multi-hop
 * children run inside their parent) reuse the parent's slot, so a parent can
 * never deadlock waiting for a slot its own children need.
 *
 * Env:
 * - SEARCH_MAX_CONCURRENCY: concurrent root searches per process. Default
 *   max(2, floor(DATABASE_POOL_MAX / 3)), i.e. 6 with the default pool of 20.
 *   0 disables the limiter.
 * - SEARCH_QUEUE_MAX: searches allowed to wait (default 200); beyond it a
 *   search fails at once with 503.
 * - SEARCH_QUEUE_TIMEOUT_MS: longest wait for a slot (default 30000); then 503
 *   with Retry-After.
 */
export interface SearchLimiterOptions {
  maxConcurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
}

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return value?.trim() && Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

export function resolveSearchLimiterOptions(env: NodeJS.ProcessEnv = process.env): SearchLimiterOptions {
  const defaultConcurrency = Math.max(2, Math.floor(resolveDatabasePoolMax(env) / 3));
  return {
    maxConcurrency: readInt(env.SEARCH_MAX_CONCURRENCY, defaultConcurrency, 0, 1_000),
    maxQueue: readInt(env.SEARCH_QUEUE_MAX, 200, 0, 100_000),
    queueTimeoutMs: readInt(env.SEARCH_QUEUE_TIMEOUT_MS, 30_000, 100, 600_000),
  };
}

export class SearchCapacityError extends HTTPException {
  readonly code = "unavailable";

  constructor(message: string, retryAfterSeconds: number) {
    super(503, { message, res: new Response(message, { status: 503, headers: { "Retry-After": String(retryAfterSeconds) } }) });
    this.name = "SearchCapacityError";
  }
}

function abortError(): Error {
  return Object.assign(new Error("Search aborted while waiting for capacity"), { name: "AbortError" });
}

interface Waiter {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** FIFO counting semaphore with a bounded, time-limited queue. */
export class ConcurrencyLimiter {
  private running = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly options: SearchLimiterOptions) {}

  stats(): { running: number; queued: number; maxConcurrency: number } {
    return { running: this.running, queued: this.queue.length, maxConcurrency: this.options.maxConcurrency };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.options.maxConcurrency <= 0) return fn();
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.running < this.options.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }
    const retryAfter = Math.max(1, Math.ceil(this.options.queueTimeoutMs / 1000 / 4));
    if (this.queue.length >= this.options.maxQueue) {
      return Promise.reject(new SearchCapacityError(`Search capacity is full (${this.running} running, ${this.queue.length} queued); retry shortly`, retryAfter));
    }
    return new Promise<void>((resolve, reject) => {
      const leave = (error: Error) => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(error);
      };
      // A client that went away gives up its place in the queue.
      const onAbort = () => leave(abortError());
      const waiter: Waiter = {
        // release() hands its slot over directly, so `running` is unchanged.
        grant: () => {
          clearTimeout(waiter.timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        timer: setTimeout(() => {
          leave(new SearchCapacityError(`Search waited ${this.options.queueTimeoutMs}ms for capacity; retry shortly`, retryAfter));
        }, this.options.queueTimeoutMs),
      };
      waiter.timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next.grant();
    else this.running--;
  }
}

let limiter: ConcurrencyLimiter | null = null;
const holdsSlot = new AsyncLocalStorage<true>();

function searchLimiter(): ConcurrencyLimiter {
  return limiter ??= new ConcurrencyLimiter(resolveSearchLimiterOptions());
}

/** Run one search under the process-wide limit; nested searches reuse the caller's slot. */
export function withSearchSlot<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (holdsSlot.getStore()) return fn();
  return searchLimiter().run(() => holdsSlot.run(true, fn), signal);
}

export function searchLimiterStats(): { running: number; queued: number; maxConcurrency: number } {
  return searchLimiter().stats();
}

/** Tests: rebuild the limiter from the current env. */
export function resetSearchLimiterForTests(options?: SearchLimiterOptions): void {
  limiter = options ? new ConcurrencyLimiter(options) : null;
}
