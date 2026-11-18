import { authLookupPoolMax, authLookupSql, LOOKUP_STATEMENT_TIMEOUT_MS, type AuthLookupSql } from "./auth-lookup-pool.js";

/**
 * Bounds for credential lookups (lib/route-credentials.ts), kept apart:
 * a connection of the dedicated lookup pool (lib/auth-lookup-pool.ts) within
 * LOOKUP_ACQUIRE_TIMEOUT_MS, then the statement under that pool's database-side
 * statement_timeout (LOOKUP_STATEMENT_TIMEOUT_MS, a startup parameter), so
 * Postgres cancels it however the client fares. A hard timer also rejects the
 * caller on its own (a 57014-style LookupTimeoutError), so a lookup is bounded
 * even when the cancel path fails. A lookup is one round trip.
 */
export const LOOKUP_ACQUIRE_TIMEOUT_MS = 5_000;
export { LOOKUP_STATEMENT_TIMEOUT_MS };

/** A credential lookup that ran out of time acquiring a connection or executing (57014-style, retryable). */
export class LookupTimeoutError extends Error {
  readonly code = "57014";
  constructor(readonly phase: "acquire" | "execute") {
    super(phase === "acquire" ? "credential lookup could not acquire a database connection in time" : "credential lookup statement timed out");
    this.name = "LookupTimeoutError";
  }
}

/**
 * `promise`, or a LookupTimeoutError after `ms`. On timeout `onLate` runs on
 * the value if it still arrives (to release a connection), and `onTimeout` runs
 * at once (a best-effort cancel); neither can reject the caller or go unhandled.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  phase: LookupTimeoutError["phase"],
  hooks: { onLate?: (value: T) => void; onTimeout?: () => unknown } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { void Promise.resolve(hooks.onTimeout?.()).catch(() => {}); } catch { /* best effort */ }
      reject(new LookupTimeoutError(phase));
    }, ms);
    promise.then(
      (value) => {
        if (done) { try { hooks.onLate?.(value); } catch { /* best effort */ } return; }
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * One slot per lookup-pool connection, held until the statement settles, so a
 * waiting lookup is waiting for a connection and LOOKUP_ACQUIRE_TIMEOUT_MS
 * bounds exactly that (postgres.js would otherwise queue it without a bound).
 */
let slotsInUse = 0;
const slotWaiters: Array<() => void> = [];

function takeSlot(): Promise<void> {
  if (slotsInUse < authLookupPoolMax()) {
    slotsInUse++;
    return Promise.resolve();
  }
  return new Promise((resolve) => { slotWaiters.push(resolve); });
}

function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next) next();
  else slotsInUse--;
}

/** Lookup-pool connections held by lookups right now (tests and diagnostics). */
export function lookupSlotsInUse(): number {
  return slotsInUse;
}

type PendingLookup<T> = PromiseLike<T> & { cancel?: () => unknown };

/**
 * Run one credential-lookup statement on the dedicated pool: a connection
 * within LOOKUP_ACQUIRE_TIMEOUT_MS (a slot that arrives late is handed back),
 * then the statement, which Postgres cancels at LOOKUP_STATEMENT_TIMEOUT_MS,
 * raced against a hard timer of `timeoutMs` (at most that bound) plus 500 ms
 * that rejects on its own and tries a best-effort cancel whose failure is caught.
 */
export async function boundedLookup<T>(run: (sql: AuthLookupSql) => PendingLookup<T>, timeoutMs = LOOKUP_STATEMENT_TIMEOUT_MS): Promise<T> {
  await withDeadline(takeSlot(), LOOKUP_ACQUIRE_TIMEOUT_MS, "acquire", { onLate: releaseSlot });
  let query: PendingLookup<T>;
  try {
    query = run(authLookupSql());
  } catch (error) {
    releaseSlot();
    throw error;
  }
  const settled = Promise.resolve(query);
  // The slot returns when the statement ends (Postgres ends it at the latest at statement_timeout).
  settled.then(releaseSlot, releaseSlot);
  const bound = Math.min(Math.max(1, timeoutMs), LOOKUP_STATEMENT_TIMEOUT_MS) + 500;
  return await withDeadline(settled, bound, "execute", { onTimeout: () => query.cancel?.() });
}
