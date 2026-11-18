/**
 * Bounds for credential lookups (lib/route-credentials.ts), kept apart:
 * acquiring a pooled connection may take at most LOOKUP_ACQUIRE_TIMEOUT_MS,
 * and the statement itself runs under a database-side statement_timeout of
 * LOOKUP_STATEMENT_TIMEOUT_MS, so Postgres cancels it however the client
 * fares. A hard timer also rejects the caller on its own (a 57014-style
 * LookupTimeoutError), so a lookup is bounded even when the cancel path fails.
 */
export const LOOKUP_ACQUIRE_TIMEOUT_MS = 5_000;
export const LOOKUP_STATEMENT_TIMEOUT_MS = 3_000;

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
