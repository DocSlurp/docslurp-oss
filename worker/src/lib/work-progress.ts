/**
 * Real-progress signals for stage heartbeats (OP-08).
 *
 * A stage heartbeat used to fire on a timer, so a hung parser or a dead
 * provider socket kept its Temporal activity alive (and its slot billed) for
 * the full 4 h start-to-close timeout. Stage Execution now runs each stage
 * inside a tracker; subprocess monitors (CPU activity), AI and embedding calls
 * report progress here, and the stage's own counters (documents, pages,
 * tokens) count too. The heartbeat stops and the stage is aborted as hung
 * once nothing has progressed for WORKER_STAGE_STALL_TIMEOUT_MS.
 *
 * Also hosts the bounded timeouts for subprocesses and provider requests.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export class ProgressTracker {
  lastProgressAt: number;
  lastLabel = "start";

  constructor(private readonly now: () => number = Date.now) {
    this.lastProgressAt = now();
  }

  note(label: string): void {
    this.lastProgressAt = this.now();
    this.lastLabel = label;
  }

  idleMs(): number {
    return this.now() - this.lastProgressAt;
  }
}

const storage = new AsyncLocalStorage<ProgressTracker>();

export function runWithProgressTracker<T>(tracker: ProgressTracker, fn: () => Promise<T>): Promise<T> {
  return storage.run(tracker, fn);
}

/** Report forward progress to the enclosing stage, if any. Cheap; call freely. */
export function noteWorkProgress(label: string): void {
  storage.getStore()?.note(label);
}

function positiveEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** No progress for this long fails the stage as hung. Default 30 min. */
export function resolveStageStallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveEnv(env, "WORKER_STAGE_STALL_TIMEOUT_MS", 30 * 60_000);
}

/**
 * Wall-clock budget for one parser command:
 * base + pages x per-page, capped at the hard max. Unknown page counts get
 * the hard max. Defaults: 300 s + 15 s/page, at most 90 min (the stage
 * start-to-close timeout is 4 h).
 */
export function resolveCommandTimeoutMs(pages: number | null | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const base = positiveEnv(env, "WORKER_COMMAND_TIMEOUT_BASE_MS", 300_000);
  const perPage = positiveEnv(env, "WORKER_COMMAND_TIMEOUT_PER_PAGE_MS", 15_000);
  const max = positiveEnv(env, "WORKER_COMMAND_TIMEOUT_MAX_MS", 90 * 60_000);
  if (!pages || !Number.isFinite(pages) || pages <= 0) return max;
  return Math.min(max, base + Math.ceil(pages) * perPage);
}

/** Per-request ceiling for worker AI provider calls. Default 5 min. */
export function resolveAiRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveEnv(env, "WORKER_AI_REQUEST_TIMEOUT_MS", 5 * 60_000);
}

/** The caller's signal plus a request timeout (AbortSignal.timeout). */
export function withRequestTimeout(signal: AbortSignal | undefined, timeoutMs = resolveAiRequestTimeoutMs()): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
