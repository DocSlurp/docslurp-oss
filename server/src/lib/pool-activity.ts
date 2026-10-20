/**
 * In-flight demand and completed work on one postgres.js pool.
 *
 * A saturated pool and a pool wedged on silently dead sockets look the same to
 * a single probe query queued behind them: both time out. They differ in
 * progress. A saturated pool keeps completing queries (slowly, from the
 * caller's view, because of queueing); a wedged pool completes none. The
 * watchdog (services/db-watchdog.ts) reads `stalledForMs` for that signal.
 *
 * "In flight" counts queries from the moment they are awaited, so it includes
 * queries still waiting for a free connection.
 */
export interface PoolActivitySnapshot {
  inFlight: number;
  completed: number;
  /** How long queries have been in flight with none completing; 0 when idle or progressing. */
  stalledForMs: number;
}

export class PoolActivity {
  private inFlight = 0;
  private completed = 0;
  private lastProgressAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.lastProgressAt = now();
  }

  /** Hook for instrumentPostgres: marks one query in flight; the returned function settles it (idempotent). */
  readonly start = (): (() => void) => {
    // Demand arriving at an idle pool starts the stall clock now, not at the last completion.
    if (this.inFlight === 0) this.lastProgressAt = this.now();
    this.inFlight++;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.inFlight--;
      this.completed++;
      this.lastProgressAt = this.now();
    };
  };

  snapshot(now: number = this.now()): PoolActivitySnapshot {
    return {
      inFlight: this.inFlight,
      completed: this.completed,
      stalledForMs: this.inFlight > 0 ? Math.max(0, now - this.lastProgressAt) : 0,
    };
  }
}
