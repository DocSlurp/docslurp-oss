/**
 * A caller giving up (Stop pressed, client disconnect, request signal aborted)
 * is an outcome, not a failure. Anything that carries a timeout, including a
 * turn deadline wrapping the abort, is a real failure and stays one.
 */
const REAL_FAILURE_NAMES = new Set(["TimeoutError", "ChatTurnDeadlineError"]);

/**
 * `signal` is the caller's own request signal. Servers abort it with whatever
 * reason the transport supplies (often a bare string), and the abort surfaces
 * as that exact value, so an error that *is* the signal's reason is a cancel.
 */
export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted && error === signal.reason) return !(error instanceof Error && REAL_FAILURE_NAMES.has(error.name));
  let sawAbort = false;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (REAL_FAILURE_NAMES.has(current.name)) return false;
    if (current.name === "AbortError") sawAbort = true;
    current = current.cause;
  }
  return sawAbort;
}
