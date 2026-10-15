/**
 * Process-level pool for LanceDB table maintenance (optimize, index refresh, cleanup).
 *
 * Maintenance used to run inline: the index stage awaited optimize() before the document
 * could complete. It now runs here, off the critical path, with these guarantees:
 *
 *  - Every accepted task is referenced by the pool until it settles; nothing is a bare
 *    fire-and-forget promise. Failures are caught and logged, never unhandled.
 *  - At most one run per key (table) at a time. A request for a key that is queued is
 *    coalesced into it; a request for a key that is running queues exactly one follow-up.
 *  - At most `concurrency` keys run at once (optimize is CPU- and IO-heavy).
 *  - drain() (worker graceful shutdown) stops intake, keeps starting queued tasks until its
 *    deadline, waits for running ones, and reports what it had to leave behind.
 *
 * The pool is a latency device, not the record of what is due: the queued write path keeps
 * its maintenance counters and lease in Postgres (vector_index_tables), so a task dropped by
 * a crash or a drain timeout is picked up again by the next drainer of that table or by the
 * maintenance leader's sweep.
 */

export type PoolTask = () => Promise<unknown>;

type Entry = {
  task: PoolTask;
  waiters: Array<() => void>;
};

export type PoolDrainResult = {
  /** True when every accepted task finished before the deadline. */
  completed: boolean;
  /** Keys still running at the deadline (the process exits under them). */
  running: string[];
  /** Keys queued but never started. */
  dropped: string[];
};

export type KeyedTaskPoolOptions = {
  concurrency: number;
  name?: string;
  log?: (message: string) => void;
};

export class KeyedTaskPool {
  private readonly concurrency: number;
  private readonly name: string;
  private readonly log: (message: string) => void;
  /** Keys waiting for a free slot, FIFO, with the latest task for that key. */
  private readonly queued = new Map<string, Entry>();
  /** Running keys and their settle promises. */
  private readonly running = new Map<string, Promise<void>>();
  /** Follow-up runs requested while a key was running. */
  private readonly followUps = new Map<string, Entry>();
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(options: KeyedTaskPoolOptions) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency));
    this.name = options.name ?? "pool";
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /**
   * Accept a task without waiting for it. Returns false (and runs nothing) once the pool is
   * closing; callers with durable state simply leave it due for the next attempt.
   */
  schedule(key: string, task: PoolTask): boolean {
    return this.enqueue(key, task, null);
  }

  /**
   * Accept a task and resolve once a run of this key that started after the request has
   * settled. Never rejects; resolves immediately when the pool is closing.
   */
  request(key: string, task: PoolTask): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.enqueue(key, task, resolve)) resolve();
    });
  }

  stats(): { running: number; queued: number; closed: boolean } {
    return { running: this.running.size, queued: this.queued.size + this.followUps.size, closed: this.closed };
  }

  /** Resolve when nothing is running or queued (tests and benchmarks). */
  idle(): Promise<void> {
    if (this.running.size === 0 && this.queued.size === 0 && this.followUps.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Stop accepting tasks and wait up to `timeoutMs` for accepted ones. Queued tasks keep
   * starting until the deadline; whatever is left is reported, and waiters are released.
   */
  async drain(timeoutMs: number): Promise<PoolDrainResult> {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      this.idle().then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
      }),
    ]);
    clearTimeout(timer);
    const dropped = [...new Set([...this.queued.keys(), ...this.followUps.keys()])];
    for (const entry of [...this.queued.values(), ...this.followUps.values()]) for (const wake of entry.waiters) wake();
    this.queued.clear();
    this.followUps.clear();
    const running = [...this.running.keys()];
    if (timedOut || dropped.length > 0) {
      this.log(
        `[${this.name}] drain timed_out=${timedOut} running=${running.length} dropped=${dropped.length}` +
          (running.length || dropped.length ? ` keys=${[...running, ...dropped].join(",").slice(0, 500)}` : ""),
      );
    }
    return { completed: !timedOut && dropped.length === 0, running, dropped };
  }

  private enqueue(key: string, task: PoolTask, waiter: (() => void) | null): boolean {
    if (this.closed) return false;
    const target = this.running.has(key) ? this.followUps : this.queued;
    const existing = target.get(key);
    if (existing) {
      existing.task = task;
      if (waiter) existing.waiters.push(waiter);
    } else {
      target.set(key, { task, waiters: waiter ? [waiter] : [] });
    }
    this.pump();
    return true;
  }

  private pump(): void {
    // Draining keeps starting queued work; only intake stops.
    for (const [key, entry] of this.queued) {
      if (this.running.size >= this.concurrency) return;
      if (this.running.has(key)) continue;
      this.queued.delete(key);
      this.start(key, entry);
    }
  }

  private start(key: string, entry: Entry): void {
    const settled = Promise.resolve()
      .then(entry.task)
      .then(
        () => undefined,
        (error: unknown) => {
          this.log(`[${this.name}] task failed key=${key}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
        },
      )
      .finally(() => {
        this.running.delete(key);
        for (const wake of entry.waiters) wake();
        const followUp = this.followUps.get(key);
        if (followUp) {
          this.followUps.delete(key);
          // Re-queue behind keys already waiting so one hot table cannot starve the rest.
          const queued = this.queued.get(key);
          if (queued) {
            queued.task = followUp.task;
            queued.waiters.push(...followUp.waiters);
          } else {
            this.queued.set(key, followUp);
          }
        }
        this.pump();
        if (this.running.size === 0 && this.queued.size === 0 && this.followUps.size === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const wake of waiters) wake();
        }
      });
    this.running.set(key, settled);
  }
}

/** LANCEDB_MAINTENANCE_CONCURRENCY: tables maintained at once per worker process (default 1, max 8). */
export function lanceMaintenanceConcurrency(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.LANCEDB_MAINTENANCE_CONCURRENCY);
  return Number.isFinite(value) && value >= 1 ? Math.min(8, Math.floor(value)) : 1;
}

/** LANCEDB_MAINTENANCE_SWEEP_INTERVAL_MS: leader sweep period (default 60 s, at least 5 s; 0 disables). */
export function lanceMaintenanceSweepIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.LANCEDB_MAINTENANCE_SWEEP_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 60_000;
  return value === 0 ? 0 : Math.max(5_000, Math.floor(value));
}

/** LANCEDB_MAINTENANCE_DRAIN_TIMEOUT_MS: how long shutdown waits for maintenance (default 30 s). */
export function lanceMaintenanceDrainTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.LANCEDB_MAINTENANCE_DRAIN_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 30_000;
}

let processPool: KeyedTaskPool | null = null;

/** The worker process's LanceDB maintenance pool (created on first use). */
export function lanceMaintenancePool(): KeyedTaskPool {
  processPool ??= new KeyedTaskPool({ concurrency: lanceMaintenanceConcurrency(), name: "lancedb-maintenance" });
  return processPool;
}

/** Graceful shutdown: finish (or report) maintenance before the process exits. */
export async function drainLanceMaintenancePool(timeoutMs = lanceMaintenanceDrainTimeoutMs()): Promise<PoolDrainResult> {
  if (!processPool) return { completed: true, running: [], dropped: [] };
  return await processPool.drain(timeoutMs);
}

/** Tests only. */
export function resetLanceMaintenancePoolForTests(pool: KeyedTaskPool | null = null): void {
  processPool = pool;
}
