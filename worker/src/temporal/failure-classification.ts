/**
 * Activity failure classes (OP-07, OP-08). Activity-side only: never imported
 * by workflow code.
 *
 * - interruption: the machine is leaving (deploy, autoscaler scale-in, the
 *   WORKER_MAX_RUNTIME recycle). Retryable after a short delay on another
 *   worker; never counts toward STAGE_ORDINARY_ATTEMPTS. A worker killed
 *   outright (SIGKILL after kill_timeout) runs no code: Temporal's heartbeat
 *   timeout retries it, and because ordinary failures are counted from stage
 *   checkpoints rather than `info.attempt`, that attempt costs nothing either.
 *   Transient network and database errors (ECONNRESET, 57P01, connection
 *   terminated) are interruptions too: they must not consume ordinary attempts.
 * - cancelled: Temporal asked this activity to stop (run cancel). Rethrown as is.
 * - throttled: provider 429/5xx that outlasted in-process retries.
 * - hung: a command or stage exceeded its wall-clock or progress budget.
 *   Non-retryable; the run dead-letters at once (HUNG_WORK_MARKER).
 * - ordinary: everything else; non-retryable once the stage has recorded
 *   STAGE_ORDINARY_ATTEMPTS ordinary failures.
 */

import { ApplicationFailure, CancelledFailure } from "@temporalio/common";

import { findHungWorkError } from "../lib/hung-work.js";
import { findProviderRetryableError } from "../lib/provider-retry.js";
import { isTransientNetworkError } from "../lib/transient-errors.js";
import { isWorkerShuttingDown } from "../lib/worker-lifecycle.js";

export type ActivityErrorClass = "interruption" | "cancelled" | "throttled" | "hung" | "ordinary";

/** Temporal ApplicationFailure type for infrastructure interruptions. */
export const WORKER_INTERRUPTED = "WorkerInterrupted";
/** Temporal ApplicationFailure type for hung work (non-retryable). */
export const HUNG_WORK_TIMEOUT = "HungWorkTimeout";
/** Retry quickly: the interrupted work resumes from checkpoints on another worker. */
export const INTERRUPTION_RETRY_DELAY_MS = 2_000;

const SHUTDOWN_MESSAGES = ["WORKER_SHUTDOWN", "Worker is shutting down", "activity did not complete in time"];

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : typeof value === "string" ? value : "";
}

export function isShutdownMessage(message: string): boolean {
  return SHUTDOWN_MESSAGES.some((needle) => message === needle || message.includes(needle));
}

export function classifyActivityError(
  error: unknown,
  context: { signal?: AbortSignal; shuttingDown?: () => boolean } = {},
): ActivityErrorClass {
  const reason: unknown = context.signal?.aborted ? context.signal.reason : undefined;
  const shuttingDown = (context.shuttingDown ?? isWorkerShuttingDown)();
  if (shuttingDown || isShutdownMessage(messageOf(reason)) || isShutdownMessage(messageOf(error))) return "interruption";
  if (reason instanceof CancelledFailure || error instanceof CancelledFailure) return "cancelled";
  if (findHungWorkError(error)) return "hung";
  if (findProviderRetryableError(error)) return "throttled";
  // A dropped socket or restarted database is the infrastructure failing, not the document:
  // retry without spending an ordinary attempt (Temporal's maximumAttempts still bounds it).
  if (isTransientNetworkError(error, { includeTimeouts: false })) return "interruption";
  return "ordinary";
}

function asApplicationFailure(error: unknown, type: string, nonRetryable: boolean, extra: { nextRetryDelay?: number; details?: unknown[] } = {}): ApplicationFailure {
  const message = error instanceof Error ? error.message : String(error);
  return ApplicationFailure.create({
    type,
    message,
    nonRetryable,
    ...(extra.nextRetryDelay !== undefined ? { nextRetryDelay: extra.nextRetryDelay } : {}),
    ...(extra.details ? { details: extra.details } : {}),
    cause: error instanceof Error ? error : undefined,
  });
}

/** Infrastructure interruption: retryable, short delay, never an ordinary attempt. */
export function interruptionFailure(error: unknown): ApplicationFailure {
  return asApplicationFailure(error, WORKER_INTERRUPTED, false, { nextRetryDelay: INTERRUPTION_RETRY_DELAY_MS });
}

/** Hung work: one timeout is final. */
export function hungWorkFailure(error: unknown): ApplicationFailure {
  const hung = findHungWorkError(error) ?? error;
  return asApplicationFailure(hung, HUNG_WORK_TIMEOUT, true);
}
