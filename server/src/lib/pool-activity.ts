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
 *
 * The stall clock starts at the first query issued after the last completion,
 * not at the completion itself. A query that never settles (a leak) therefore
 * cannot make an idle process look wedged: with no new demand there is no
 * stall, and the next query that completes resets the clock.
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
  /** When the first query since the last completion was issued; null until one is. */
  private waitingSince: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Hook for instrumentPostgres: marks one query in flight; the returned function settles it (idempotent). */
  readonly start = (): (() => void) => {
    this.waitingSince ??= this.now();
    this.inFlight++;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.inFlight--;
      this.completed++;
      this.waitingSince = null;
    };
  };

  snapshot(now: number = this.now()): PoolActivitySnapshot {
    return {
      inFlight: this.inFlight,
      completed: this.completed,
      stalledForMs: this.inFlight > 0 && this.waitingSince !== null ? Math.max(0, now - this.waitingSince) : 0,
    };
  }
}
