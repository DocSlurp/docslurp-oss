import { isCommandTeardownError, onUnverifiedTeardown, unverifiedTeardownCount, type CommandTeardownError } from "./teardown.js";

/**
 * Worker-wide circuit breaker on unverified command teardowns.
 *
 * A command whose teardown could not be verified (CommandTeardownError) may have left processes
 * running on this machine: parsers holding customer bytes and CPU, outside any slot. Raster
 * commands keep their semaphore slot poisoned, but every other parser (pandoc, LibreOffice,
 * tesseract, local-artifact adapters) runs in an activity slot that Temporal frees as soon as the
 * activity fails. So once `WORKER_UNVERIFIED_TEARDOWN_LIMIT` (default 1) such commands happened in
 * this process, the worker is quarantined:
 *
 * - the activity interceptor refuses every new activity (retryable, so it runs on another worker),
 * - /health reports 503 `quarantined`,
 * - the worker stops polling, drains in-flight activities (they retry elsewhere as interruptions)
 *   and exits non-zero (`[worker-fatal] reason=teardown-unverified`).
 *
 * Recovery: restart the machine or container, not just the process. A fresh VM or container has
 * no stray processes; on Fly the restart policy boots a new VM after the non-zero exit. Investigate
 * the `[worker-command] status=teardown-unverified` log lines (run, document, stage) first. An
 * activity that fails with a CommandTeardownError is not retried (failure-classification.ts), so a
 * hostile document cannot walk the fleet quarantining one worker after another through that path.
 * Raising the limit trades that safety for capacity and is meant for debugging only.
 */

export interface TeardownBreakerState {
  open: boolean;
  count: number;
  limit: number;
}

export function unverifiedTeardownLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.WORKER_UNVERIFIED_TEARDOWN_LIMIT);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

export function teardownBreakerState(env: NodeJS.ProcessEnv = process.env): TeardownBreakerState {
  const count = unverifiedTeardownCount();
  const limit = unverifiedTeardownLimit(env);
  return { open: count >= limit, count, limit };
}

/** The new activity a quarantined worker refuses (retryable on another worker). */
export class WorkerQuarantinedError extends Error {
  constructor(state: TeardownBreakerState) {
    super(
      `worker quarantined: ${state.count} command teardown(s) could not be verified (limit ${state.limit}); ` +
        "refusing new activities until the machine restarts",
    );
    this.name = "WorkerQuarantinedError";
  }
}

export function assertTeardownBreakerClosed(env: NodeJS.ProcessEnv = process.env): void {
  const state = teardownBreakerState(env);
  if (state.open) throw new WorkerQuarantinedError(state);
}

/**
 * Call `listener` once, synchronously, when the breaker opens (or at once if it already is).
 * Returns an unsubscribe.
 */
export function onTeardownBreakerOpen(listener: (state: TeardownBreakerState) => void, env: NodeJS.ProcessEnv = process.env): () => void {
  let fired = false;
  const check = () => {
    const state = teardownBreakerState(env);
    if (fired || !state.open) return;
    fired = true;
    unsubscribe();
    listener(state);
  };
  const unsubscribe = onUnverifiedTeardown(check);
  check();
  return unsubscribe;
}

/** The CommandTeardownError anywhere in an error's cause chain. */
export function findCommandTeardownError(error: unknown): CommandTeardownError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && seen.size < 8) {
    if (isCommandTeardownError(current)) return current;
    seen.add(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return null;
}
