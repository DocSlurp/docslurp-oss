import { availableParallelism } from "node:os";

/**
 * Documents processed at once when WORKER_DOC_CONCURRENCY is unset: about one per two cores, at most 4.
 * Adaptive tuning and the resource-based activity slots still back off under memory or CPU pressure,
 * so this is a ceiling, not a promise. Production pins 4 documents and 8 activity slots.
 */
export function defaultDocConcurrency(cpuCount: number = availableParallelism()): number {
  return Math.min(4, Math.max(1, Math.floor(cpuCount / 2)));
}

function readInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Activity slots (concurrent Temporal activities) per worker: WORKER_ACTIVITY_CONCURRENCY, else twice the
 * default document concurrency. The one resolved value that the worker's slots, the autoscaler's
 * slots-per-machine fallback and the per-slot compute-cost share must all agree on.
 */
export function resolveActivityConcurrency(
  env: NodeJS.ProcessEnv = process.env,
  cpuCount: number = availableParallelism(),
): number {
  return Math.max(1, readInteger(env.WORKER_ACTIVITY_CONCURRENCY, defaultDocConcurrency(cpuCount) * 2));
}
