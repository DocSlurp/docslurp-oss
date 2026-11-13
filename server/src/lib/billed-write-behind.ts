/**
 * Billed writes a request may answer before they commit.
 *
 * A search's unit charge and its usage events are idempotent inserts (stable
 * ids, `on conflict (id) do nothing`), so they can commit after the response.
 * What is answered but not yet written is invisible to spend checks and lost
 * if the process dies, so it is capped per process:
 * SEARCH_WRITE_BEHIND_MAX_CREDITS (default 10 credits = $0.10; 0 writes every
 * billed insert before the response). Past the cap a request waits for its
 * own write, as before.
 *
 * A deferred write that fails keeps holding its credits and is retried (same
 * id, backoff up to 30 s, about ten minutes) until it commits, so transient
 * failures cannot recycle the allowance: once unwritten charges fill the cap,
 * every later request writes before it answers. Integrity errors (SQLSTATE 23)
 * and exhausted retries are reported as lost. At most
 * SEARCH_WRITE_BEHIND_MAX_PENDING writes of any cost are deferred at once.
 * Shutdown (drainBilledWriteBehind) retries what is left without waiting.
 */

const DEFAULT_MAX_CREDITS = 10;
const RETRY_DELAYS_MS = [250, 1_000, 5_000, 30_000];
/** About ten minutes of retries; then the write is reported as lost and its credits are released. */
const MAX_ATTEMPTS = 25;

/**
 * Writes (any cost) allowed to run after their response: SEARCH_WRITE_BEHIND_MAX_PENDING, default 200, the
 * session write-behind backlog limit. Zero-credit inserts are bounded by it too.
 */
function maxPendingWrites(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SEARCH_WRITE_BEHIND_MAX_PENDING);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 200;
}

/** Integrity violations (SQLSTATE class 23: foreign key, check, not null) fail the same way on every retry. */
function permanentFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("23");
}

let lostWrites = 0;
/** Deferred writes given up on (permanent error or retries exhausted) since start. */
export function billedWriteBehindLost(): number {
  return lostWrites;
}

export function billedWriteBehindMaxCredits(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.SEARCH_WRITE_BEHIND_MAX_CREDITS ?? "").trim();
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CREDITS;
}

let deferredCredits = 0;
let draining = false;
const pending = new Set<Promise<void>>();
const wakers = new Set<() => void>();

/** Credits answered but not yet committed in this process (failed writes awaiting retry included). */
export function billedWriteBehindCredits(): number {
  return deferredCredits;
}

/** Billed writes still running (or waiting to retry) after their response. */
export function billedWriteBehindPending(): number {
  return pending.size;
}

function retryDelay(attempt: number): Promise<void> {
  if (draining) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const wake = () => { clearTimeout(timer); wakers.delete(wake); resolve(); };
    const timer = setTimeout(wake, RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
    timer.unref?.();
    wakers.add(wake);
  });
}

export interface BilledWriteOptions {
  /** Reports each failed attempt (the write itself must throw on failure so it can be retried). */
  onError?: (error: unknown, attempt: number) => void;
}

/**
 * Start `write`. Within the cap this returns at once (`done`) with the write
 * running and retried until it commits (`settled`); past the cap `done`
 * resolves after one attempt settles, failed or not, as an inline write did
 * before. Never rejects.
 */
export function writeBehindWithinCap(credits: number, write: () => Promise<void>, options: BilledWriteOptions = {}): { done: Promise<void>; settled: Promise<void> } {
  const cost = Number.isFinite(credits) && credits > 0 ? credits : 0;
  const maxCredits = billedWriteBehindMaxCredits();
  // A cap of 0 never defers, even a zero-credit write; the pending count bounds zero-credit writes otherwise.
  if (maxCredits === 0 || deferredCredits + cost > maxCredits || pending.size >= maxPendingWrites()) {
    const settled = write().catch((error) => { options.onError?.(error, 0); });
    return { done: settled, settled };
  }
  deferredCredits += cost;
  const settled = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await write();
        return;
      } catch (error) {
        options.onError?.(error, attempt);
        // Integrity errors never succeed; retries end after MAX_ATTEMPTS; shutdown gives two more tries.
        if (permanentFailure(error) || attempt + 1 >= MAX_ATTEMPTS || (draining && attempt >= 2)) {
          lostWrites += 1;
          console.error(`[billed-write-behind] gave up on a deferred billed write after ${attempt + 1} attempt(s) (${permanentFailure(error) ? "permanent error" : "retries exhausted"}); lost=${lostWrites}`);
          return;
        }
        await retryDelay(attempt);
      }
    }
  })().finally(() => { deferredCredits = Math.max(0, deferredCredits - cost); });
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
  return { done: Promise.resolve(), settled };
}

/** Shutdown and tests: retry at once and wait until every deferred billed write has settled. */
export async function drainBilledWriteBehind(): Promise<void> {
  draining = true;
  try {
    for (const wake of [...wakers]) wake();
    while (pending.size > 0) await Promise.all([...pending]);
  } finally {
    draining = false;
  }
}
