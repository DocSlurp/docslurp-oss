/**
 * Process-wide "this worker is going away" flag.
 *
 * Set on SIGTERM/SIGINT (Fly deploys, autoscaler scale-in) and when
 * WORKER_MAX_RUNTIME triggers the periodic recycle. Activities that fail
 * after it is set failed because the machine is leaving, not because the
 * document is bad, so they are classified as infrastructure interruptions
 * (temporal/failure-classification.ts) whatever error surfaced: an aborted
 * subprocess, a closed DB pool or Temporal's WORKER_SHUTDOWN cancellation.
 */

let shutdown: { reason: string; at: number } | null = null;

export function markWorkerShuttingDown(reason: string, now = Date.now()): void {
  if (!shutdown) shutdown = { reason, at: now };
}

export function workerShutdownState(): { reason: string; at: number } | null {
  return shutdown;
}

export function isWorkerShuttingDown(): boolean {
  return shutdown !== null;
}

/** Tests only. */
export function resetWorkerShutdownForTests(): void {
  shutdown = null;
}
