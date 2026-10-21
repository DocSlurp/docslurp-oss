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
 * - SEARCH_FAIR_ADMISSION: serve waiting searches round-robin per tenant (org,
 *   else workspace), so one tenant's fan-out cannot starve others. Defaults to
 *   the process-wide SEARCH_LANCEDB_NATIVE flag (on unless it is 0); off, the
 *   queue is one FIFO.
 * - SEARCH_MAX_SLOTS_PER_TURN: slots one chat agent turn or API batch holds at
 *   once (0 = no cap). Default 2 with fair admission, else 0.
 */
export interface SearchLimiterOptions {
  maxConcurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
  /** Slots one admission group (a chat agent turn, an API batch) may hold at once; 0 = no cap. */
  maxSlotsPerGroup?: number;
  /** Round-robin across tenants (default true); false keeps one FIFO queue. */
  fairTenants?: boolean;
}

function flag(value: string | undefined): boolean | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  return null;
}

/** SEARCH_FAIR_ADMISSION, defaulting to the process-wide SEARCH_LANCEDB_NATIVE flag (on unless 0). */
export function searchFairAdmissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env.SEARCH_FAIR_ADMISSION) ?? flag(env.SEARCH_LANCEDB_NATIVE) ?? true;
}

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return value?.trim() && Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

export function resolveSearchLimiterOptions(env: NodeJS.ProcessEnv = process.env): SearchLimiterOptions {
  const defaultConcurrency = Math.max(2, Math.floor(resolveDatabasePoolMax(env) / 3));
  const fair = searchFairAdmissionEnabled(env);
  return {
    maxConcurrency: readInt(env.SEARCH_MAX_CONCURRENCY, defaultConcurrency, 0, 1_000),
    maxQueue: readInt(env.SEARCH_QUEUE_MAX, 200, 0, 100_000),
    queueTimeoutMs: readInt(env.SEARCH_QUEUE_TIMEOUT_MS, 30_000, 100, 600_000),
    maxSlotsPerGroup: readInt(env.SEARCH_MAX_SLOTS_PER_TURN, fair ? 2 : 0, 0, 1_000),
    fairTenants: fair,
  };
}

/** Who a search is admitted for: `tenant` (org, else workspace) shares fairly; `group` (turn, batch) is capped. */
export interface SearchAdmission {
  tenant?: string | null;
  group?: string | null;
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
  tenant: string;
  group: string | null;
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

const ANONYMOUS_TENANT = "";

/**
 * Counting semaphore with a bounded, time-limited queue, fair across tenants.
 *
 * Waiters queue per tenant and freed slots go round-robin across tenants
 * (FIFO within one), so a tenant whose agents fan out many searches waits
 * behind itself, not in front of everyone else. An admission group (one chat
 * turn, one API batch) holds at most `maxSlotsPerGroup` slots; its further
 * searches wait even when slots are free, leaving them to other turns.
 */
export class ConcurrencyLimiter {
  private running = 0;
  private queued = 0;
  private readonly queues = new Map<string, Waiter[]>();
  /** Tenants with waiters, in round-robin order; the head is served next. */
  private readonly rotation: string[] = [];
  private readonly groupSlots = new Map<string, number>();

  constructor(private readonly options: SearchLimiterOptions) {}

  stats(): { running: number; queued: number; maxConcurrency: number; waitingTenants: number } {
    return { running: this.running, queued: this.queued, maxConcurrency: this.options.maxConcurrency, waitingTenants: this.rotation.length };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal, admission: SearchAdmission = {}): Promise<T> {
    if (this.options.maxConcurrency <= 0) return fn();
    const group = admission.group ?? null;
    const tenant = this.options.fairTenants === false ? ANONYMOUS_TENANT : admission.tenant ?? ANONYMOUS_TENANT;
    await this.acquire(signal, tenant, group);
    try {
      return await fn();
    } finally {
      this.release(group);
    }
  }

  private groupHasRoom(group: string | null): boolean {
    const cap = this.options.maxSlotsPerGroup ?? 0;
    return !group || cap <= 0 || (this.groupSlots.get(group) ?? 0) < cap;
  }

  private take(group: string | null): void {
    this.running++;
    if (group) this.groupSlots.set(group, (this.groupSlots.get(group) ?? 0) + 1);
  }

  private acquire(signal: AbortSignal | undefined, tenant: string, group: string | null): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    // Free slots only exist while every waiter is held back by its group cap, so taking one is fair.
    if (this.running < this.options.maxConcurrency && this.groupHasRoom(group)) {
      this.take(group);
      return Promise.resolve();
    }
    const retryAfter = Math.max(1, Math.ceil(this.options.queueTimeoutMs / 1000 / 4));
    if (this.queued >= this.options.maxQueue) {
      return Promise.reject(new SearchCapacityError(`Search capacity is full (${this.running} running, ${this.queued} queued); retry shortly`, retryAfter));
    }
    return new Promise<void>((resolve, reject) => {
      const leave = (error: Error) => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", onAbort);
        this.remove(waiter);
        reject(error);
      };
      // A client that went away gives up its place in the queue.
      const onAbort = () => leave(abortError());
      const waiter: Waiter = {
        tenant,
        group,
        // dispatch() has already counted the slot.
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
      const queue = this.queues.get(tenant);
      if (queue) queue.push(waiter);
      else {
        this.queues.set(tenant, [waiter]);
        this.rotation.push(tenant);
      }
      this.queued++;
    });
  }

  private remove(waiter: Waiter): void {
    const queue = this.queues.get(waiter.tenant);
    const index = queue?.indexOf(waiter) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    this.queued--;
    if (queue.length === 0) {
      this.queues.delete(waiter.tenant);
      const position = this.rotation.indexOf(waiter.tenant);
      if (position >= 0) this.rotation.splice(position, 1);
    }
  }

  private release(group: string | null): void {
    this.running--;
    if (group) {
      const held = (this.groupSlots.get(group) ?? 1) - 1;
      if (held <= 0) this.groupSlots.delete(group);
      else this.groupSlots.set(group, held);
    }
    this.dispatch();
  }

  /** Grant free slots round-robin over tenants, skipping waiters whose group is at its cap. */
  private dispatch(): void {
    while (this.running < this.options.maxConcurrency && this.rotation.length > 0) {
      let granted = false;
      for (let turn = 0; turn < this.rotation.length; turn++) {
        const tenant = this.rotation[turn]!;
        const queue = this.queues.get(tenant)!;
        const waiter = queue.find((candidate) => this.groupHasRoom(candidate.group));
        if (!waiter) continue;
        this.remove(waiter);
        // The served tenant goes to the back of the rotation if it still waits.
        const position = this.rotation.indexOf(tenant);
        if (position >= 0) this.rotation.push(...this.rotation.splice(position, 1));
        this.take(waiter.group);
        waiter.grant();
        granted = true;
        break;
      }
      if (!granted) return;
    }
  }
}

let limiter: ConcurrencyLimiter | null = null;
const holdsSlot = new AsyncLocalStorage<true>();
const admissionGroup = new AsyncLocalStorage<string>();

function searchLimiter(): ConcurrencyLimiter {
  return limiter ??= new ConcurrencyLimiter(resolveSearchLimiterOptions());
}

/** Searches started inside `fn` share one admission group (capped at SEARCH_MAX_SLOTS_PER_TURN slots). */
export function withSearchAdmissionGroup<T>(group: string, fn: () => T): T {
  return admissionGroup.run(group, fn);
}

export function currentSearchAdmissionGroup(): string | null {
  return admissionGroup.getStore() ?? null;
}

/** Run one search under the process-wide limit; nested searches reuse the caller's slot. */
export function withSearchSlot<T>(signal: AbortSignal | undefined, fn: () => Promise<T>, admission: SearchAdmission = {}): Promise<T> {
  if (holdsSlot.getStore()) return fn();
  return searchLimiter().run(() => holdsSlot.run(true, fn), signal, { tenant: admission.tenant, group: admission.group ?? currentSearchAdmissionGroup() });
}

export function searchLimiterStats(): { running: number; queued: number; maxConcurrency: number; waitingTenants: number } {
  return searchLimiter().stats();
}

/** Tests: rebuild the limiter from the current env. */
export function resetSearchLimiterForTests(options?: SearchLimiterOptions): void {
  limiter = options ? new ConcurrencyLimiter(options) : null;
}
