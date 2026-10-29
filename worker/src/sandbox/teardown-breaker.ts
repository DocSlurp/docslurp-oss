import { latchedTeardownError } from "./session-context.js";
import { findQuarantinedSourceError } from "./source-quarantine.js";
import {
  isCommandTeardownError,
  onUnverifiedTeardown,
  teardownTimings,
  unverifiedTeardownCount,
  type CommandTeardownError,
  type TeardownTimings,
} from "./teardown.js";

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
 * the `[worker-command] status=teardown-unverified` log lines (org, workspace, run, document,
 * stage) first. The activity in which the teardown failed always ends as a non-retryable teardown
 * failure, even if a stage swallowed or replaced the error (activity-interceptor.ts latches it),
 * and the document's source hash is denylisted fleet-wide (source-quarantine.ts), so a hostile
 * document cannot walk the fleet quarantining one worker after another. Raising the limit trades
 * that safety for capacity and is meant for debugging only.
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
 * Call `listener` once, synchronously, when the breaker opens (or at once if it already is), with
 * the teardown failure that opened it when there is one.
 * Returns an unsubscribe.
 */
export function onTeardownBreakerOpen(
  listener: (state: TeardownBreakerState, error?: CommandTeardownError) => void,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  let fired = false;
  const check = (_count?: number, error?: CommandTeardownError) => {
    const state = teardownBreakerState(env);
    if (fired || !state.open) return;
    fired = true;
    unsubscribe();
    listener(state, error);
  };
  const unsubscribe = onUnverifiedTeardown(check);
  check();
  return unsubscribe;
}

export function findWorkerQuarantinedError(error: unknown): WorkerQuarantinedError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current instanceof WorkerQuarantinedError) return current;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return null;
}

/**
 * For catches that fall back to another parser, skip optional work or retry: a command teardown
 * failure (in the error, or already latched on this activity), a quarantined worker and a
 * quarantined source are never something to fall back from or retry here. Rethrows the teardown
 * failure itself, so the stage reports it rather than whatever came after.
 */
export function rethrowIfTeardown(error: unknown): void {
  const teardown = findCommandTeardownError(error) ?? latchedTeardownError();
  if (teardown) throw teardown;
  if (findWorkerQuarantinedError(error) || findQuarantinedSourceError(error)) throw error;
}

/**
 * Temporal's shutdownForceTime for a worker: the drain grace, then time for the cancelled
 * activities' commands to be torn down and verified, plus a margin.
 */
export function workerShutdownForceMs(graceMs: number, timings: TeardownTimings = teardownTimings()): number {
  return graceMs + timings.verifyMs + 10_000;
}

/** When a quarantined worker exits no matter what: after Temporal's own force deadline. */
export function quarantineForceExitMs(graceMs: number, timings: TeardownTimings = teardownTimings()): number {
  return workerShutdownForceMs(graceMs, timings) + 30_000;
}

/**
 * Once the breaker opened, the process must end, even if a drain or a shutdown step hangs: a
 * quarantined machine is only recovered by a restart. The timer is deliberately not unref'd, so
 * nothing can let the process linger past it (or exit 0 before it); a normal quarantine exit calls
 * `process.exit(1)` first.
 */
export function scheduleQuarantineForceExit(
  delayMs: number,
  deps: { exit?: (code: number) => void; log?: (line: string) => void } = {},
): NodeJS.Timeout {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((line: string) => console.error(line));
  return setTimeout(() => {
    log(`[worker-fatal] reason=teardown-unverified phase=force exiting=1 detail=${JSON.stringify(`worker still running ${delayMs} ms after quarantine`)}`);
    exit(1);
  }, delayMs);
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
