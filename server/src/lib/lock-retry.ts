/**
 * Lock discipline for transactions over document version chains (run creation
 * and document deletion). The chain's advisory key, the same one the
 * supersession trigger takes (`<project>:<canonical id>`), is taken first, with
 * every lock wait bounded by LOCK_TIMEOUT; row locks are then taken NOWAIT, so
 * the transaction never waits on a row while holding others and cannot cycle
 * with the trigger (which holds its completing row, then takes the key). On a
 * lock conflict (55P03) or deadlock (40P01) the whole transaction rolls back,
 * releasing every lock, and is retried after a short jittered backoff,
 * LOCK_ATTEMPTS times in all; then the caller's busy error (a retryable 503).
 */
export const LOCK_TIMEOUT = "2s";
export const LOCK_ATTEMPTS = 6;

/** The minimal tagged-template client these helpers need (postgres.js transaction or pool). */
type TaggedClient = (strings: TemplateStringsArray, ...values: never[]) => PromiseLike<unknown>;

/** A lock conflict (55P03), a deadlock (40P01), or a full shared lock table (53200, out of shared memory): retryable. */
export function isLockConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "55P03" || code === "40P01" || code === "53200";
}

/** Runs one transaction, retrying the whole of it on lock conflicts; `busy` makes the error after the last attempt. */
export async function withLockRetry<T>(transaction: () => Promise<T>, busy: () => Error): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction();
    } catch (error) {
      if (!isLockConflict(error)) throw error;
      if (attempt >= LOCK_ATTEMPTS) throw busy();
      // 50 ms doubling to 800 ms (about 1.5 s in all): long enough to outlast a worker finishing a row.
      await new Promise((resolve) => setTimeout(resolve, Math.min(800, 25 * 2 ** attempt) + Math.random() * 25));
    }
  }
}

/** Bounds every lock wait in this transaction, the advisory key's included. */
export async function boundLockWaits(client: TaggedClient): Promise<void> {
  await (client as unknown as (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>)`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`;
}

/**
 * Takes the advisory lock of each chain key (`<project>:<key>`), deduplicated and in sorted order, in one statement
 * (the same hash, hashtextextended(key, 0), as run creation and the supersession trigger). The lock function is
 * volatile, so it runs on the sorted rows in order.
 */
export async function lockChainKeys(client: TaggedClient, keys: Iterable<string>): Promise<void> {
  const sorted = [...new Set(keys)].sort();
  if (!sorted.length) return;
  const tag = client as unknown as ((s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>) & { array: (values: string[]) => unknown };
  await tag`select pg_advisory_xact_lock(hashtextextended(k, 0)) from (select unnest(${tag.array(sorted)}::text[]) as k order by k) s`;
}
