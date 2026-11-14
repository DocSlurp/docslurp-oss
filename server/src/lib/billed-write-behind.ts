/**
 * Billed writes a request may answer before they commit.
 *
 * A search's unit charge and its usage events are idempotent inserts (stable
 * ids, `on conflict (id) do nothing`), so they can commit after the response.
 * What is answered but not yet written is invisible to spend checks and lost
 * if the process dies, so it is capped per organization (the billed account)
 * in each process: SEARCH_WRITE_BEHIND_MAX_CREDITS (default 10 credits =
 * $0.10; 0 writes every billed insert before the response). Past its org's cap
 * a request waits for its own write, as before. Each org has its own
 * allowance, so one org's unwritten or failing charges never make another
 * org's searches wait. A write without an org is never deferred.
 *
 * A deferred write that fails keeps holding its credits and is retried (same
 * id, backoff up to 30 s, about ten minutes) until it commits, so transient
 * failures cannot recycle the allowance: once an org's unwritten charges fill
 * its cap, every later request of that org writes before it answers.
 * Integrity errors (SQLSTATE 23) and exhausted retries are reported as lost,
 * and their credits stay held against that org's cap until the process
 * restarts, so one org's lost charges never total more than its cap.
 *
 * Counts: at most SEARCH_WRITE_BEHIND_MAX_PENDING writes of any cost are
 * deferred per org, and SEARCH_WRITE_BEHIND_MAX_PENDING_TOTAL across the
 * process (a memory bound only; past it a request writes before it answers).
 * Shutdown (drainBilledWriteBehind) retries what is left without waiting.
 */

const DEFAULT_MAX_CREDITS = 10;
const RETRY_DELAYS_MS = [250, 1_000, 5_000, 30_000];
/** About ten minutes of retries; then the write is reported as lost and its credits stay held (loss debt). */
const MAX_ATTEMPTS = 25;

/** Writes (any cost) one org may have running after their response: SEARCH_WRITE_BEHIND_MAX_PENDING, default 200. */
function maxPendingWrites(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SEARCH_WRITE_BEHIND_MAX_PENDING);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 200;
}

/** Process-wide memory bound on deferred writes: SEARCH_WRITE_BEHIND_MAX_PENDING_TOTAL, default 5000. */
function maxPendingWritesTotal(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SEARCH_WRITE_BEHIND_MAX_PENDING_TOTAL);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 5_000;
}

/** Integrity violations (SQLSTATE class 23: foreign key, check, not null) fail the same way on every retry. */
function permanentFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("23");
}

interface OrgAllowance {
  /** Credits answered but not committed: running, awaiting retry, or abandoned (loss debt). */
  credits: number;
  /** Deferred writes still running or waiting to retry. */
  pending: number;
  /** Credits of abandoned writes (included in `credits`), held until the process restarts. */
  lostCredits: number;
}

const allowances = new Map<string, OrgAllowance>();
let lostWrites = 0;
let draining = false;
const pending = new Set<Promise<void>>();
const wakers = new Set<() => void>();

function allowanceFor(orgId: string): OrgAllowance {
  let allowance = allowances.get(orgId);
  if (!allowance) {
    allowance = { credits: 0, pending: 0, lostCredits: 0 };
    allowances.set(orgId, allowance);
  }
  return allowance;
}

function releaseIfIdle(orgId: string, allowance: OrgAllowance): void {
  if (allowance.pending === 0 && allowance.credits === 0 && allowances.get(orgId) === allowance) allowances.delete(orgId);
}

/** Tests only: forget loss debt (a restart does this in production). */
export function resetBilledWriteBehindForTests(): void {
  lostWrites = 0;
  allowances.clear();
}

/** Deferred writes given up on (permanent error or retries exhausted) since start. */
export function billedWriteBehindLost(): number {
  return lostWrites;
}

export function billedWriteBehindMaxCredits(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.SEARCH_WRITE_BEHIND_MAX_CREDITS ?? "").trim();
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CREDITS;
}

/** Credits answered but not yet committed in this process, for one org or all of them (failed and lost writes included). */
export function billedWriteBehindCredits(orgId?: string): number {
  if (orgId !== undefined) return allowances.get(orgId)?.credits ?? 0;
  let total = 0;
  for (const allowance of allowances.values()) total += allowance.credits;
  return total;
}

/** Billed writes still running (or waiting to retry) after their response, for one org or all of them. */
export function billedWriteBehindPending(orgId?: string): number {
  return orgId === undefined ? pending.size : allowances.get(orgId)?.pending ?? 0;
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
  /** The organization billed by this write. Its allowance decides whether the write may defer; without one it never does. */
  orgId: string | null | undefined;
  /** Reports each failed attempt (the write itself must throw on failure so it can be retried). */
  onError?: (error: unknown, attempt: number) => void;
}

/**
 * Start `write`. Within the org's cap this returns at once (`done`) with the
 * write running and retried until it commits (`settled`); past it `done`
 * resolves after one attempt settles, failed or not, as an inline write did
 * before. Never rejects.
 */
export function writeBehindWithinCap(credits: number, write: () => Promise<void>, options: BilledWriteOptions): { done: Promise<void>; settled: Promise<void> } {
  const cost = Number.isFinite(credits) && credits > 0 ? credits : 0;
  const maxCredits = billedWriteBehindMaxCredits();
  const orgId = options.orgId?.trim() || null;
  const current = orgId ? allowances.get(orgId) : undefined;
  // No org: nothing to bill the deferral against, so write first. A cap of 0 never defers, even a zero-credit write.
  if (!orgId || maxCredits === 0 || (current?.credits ?? 0) + cost > maxCredits
    || (current?.pending ?? 0) >= maxPendingWrites() || pending.size >= maxPendingWritesTotal()) {
    const settled = write().catch((error) => { options.onError?.(error, 0); });
    return { done: settled, settled };
  }
  const allowance = allowanceFor(orgId);
  allowance.credits += cost;
  allowance.pending += 1;
  const settled = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await write();
        return false;
      } catch (error) {
        options.onError?.(error, attempt);
        // Integrity errors never succeed; retries end after MAX_ATTEMPTS; shutdown gives two more tries.
        if (permanentFailure(error) || attempt + 1 >= MAX_ATTEMPTS || (draining && attempt >= 2)) {
          lostWrites += 1;
          // Loss debt: an abandoned write's credits stay counted against its org until the process restarts, so
          // that org's lost charges never total more than its cap; once they fill it its requests write first.
          allowance.lostCredits += cost;
          console.error(`[billed-write-behind] gave up on a deferred billed write after ${attempt + 1} attempt(s) (${permanentFailure(error) ? "permanent error" : "retries exhausted"}); lost=${lostWrites} orgLostCredits=${allowance.lostCredits}`);
          return true;
        }
        await retryDelay(attempt);
      }
    }
  })().then((abandoned) => {
    allowance.pending -= 1;
    if (!abandoned) allowance.credits = Math.max(0, allowance.credits - cost);
    // Fractional cents leave float residue: with nothing in flight only the loss debt remains.
    if (allowance.pending === 0) allowance.credits = allowance.lostCredits;
    releaseIfIdle(orgId, allowance);
  });
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
