/**
 * Run failure bookkeeping rule shared by every process that fails a Run
 * (worker terminal failure, API stale-run fail-safe, Temporal reconciliation).
 *
 * Each failure increments `failure_count`, appends to a bounded failure
 * history, and moves the Run to dead-letter once the poison threshold is met.
 */

export const DEFAULT_POISON_RUN_FAILURE_THRESHOLD = 3;

/**
 * Prefix of worker failures caused by hung work (a parser past its wall-clock
 * budget, a stage with no progress). Retrying would hang again, so such a
 * failure dead-letters the Run on the first occurrence.
 */
export const HUNG_WORK_MARKER = "[hung-work]";
const FAILURE_HISTORY_LIMIT = 10;

export type RunFailureEntry = {
  at: string;
  stage: string;
  message: string;
  failureCount: number;
};

export type RunFailurePlan = {
  failureCount: number;
  deadLettered: boolean;
  stats: Record<string, unknown>;
  eventMessage: string;
  eventPayload: Record<string, unknown>;
};

export function resolvePoisonRunFailureThreshold(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.floor(parsed))
    : DEFAULT_POISON_RUN_FAILURE_THRESHOLD;
}

export function planRunFailure(input: {
  failureCount: number | null | undefined;
  stats: Record<string, unknown> | null | undefined;
  stage: string;
  message: string;
  threshold: number;
  now?: Date;
}): RunFailurePlan {
  const failureCount = Number(input.failureCount ?? 0) + 1;
  const hungWork = input.message.includes(HUNG_WORK_MARKER);
  const deadLettered = hungWork || failureCount >= Math.max(1, input.threshold);
  const current =
    input.stats && typeof input.stats === "object" && !Array.isArray(input.stats)
      ? input.stats
      : {};
  const entry: RunFailureEntry = {
    at: (input.now ?? new Date()).toISOString(),
    stage: input.stage,
    message: input.message,
    failureCount,
  };
  const history = Array.isArray(current.failureHistory) ? [...current.failureHistory] : [];
  history.push(entry);

  return {
    failureCount,
    deadLettered,
    stats: {
      ...current,
      failureHistory: history.slice(-FAILURE_HISTORY_LIMIT),
      lastFailure: entry,
      deadLettered,
    },
    eventMessage: hungWork
      ? `${input.message} (moved to dead-letter: hung work is not retried)`
      : deadLettered
        ? `${input.message} (moved to dead-letter after ${failureCount} failures)`
        : input.message,
    eventPayload: { failureCount, deadLettered, ...(hungWork ? { hungWork: true } : {}) },
  };
}
