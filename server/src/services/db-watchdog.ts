/**
 * Restarts the app when the database is unreachable, or when the request pool
 * is wedged on dead connections while the database is fine.
 *
 * postgres.js enables TCP keepalive only with an initial delay, so with Linux
 * defaults (75 s x 9 probes) a connection that died silently (a proxy restart,
 * a dropped path during a deploy) is noticed after more than 11 minutes, and
 * until then every query on it hangs. On 2026-10-12 that took production down
 * for ~8 minutes after a deploy while the database itself answered in 0.2 s;
 * a machine restart fixed it at once.
 *
 * The first version probed with `select 1` through the request pool. On
 * 2026-10-20 search load saturated that pool, the probe queued behind it and
 * timed out for 60 s, and the watchdog killed a healthy app: overload became
 * an outage. So the two failure modes now have separate signals:
 *
 * - Database unreachable: every DB_WATCHDOG_INTERVAL_MS a `select 1` runs on
 *   the dedicated probe connection (services/db-probe.ts), never queued behind
 *   requests. After it has failed continuously for DB_WATCHDOG_EXIT_AFTER_MS
 *   the process exits non-zero and Fly restarts the machine.
 * - Pool wedged: the pool has had queries in flight with none completing for
 *   DB_WATCHDOG_POOL_STALL_MS (lib/pool-activity.ts), the database answers the
 *   probe, and pg_stat_activity shows none of this pool's queries running.
 *   A saturated pool keeps completing queries, so it never trips this; if
 *   Postgres is still executing our queries the watchdog only warns.
 *
 * A real database outage restarts the app at the exit cadence, which costs a
 * few seconds of boot per minute and recovers by itself when the database
 * returns. Production only; DB_WATCHDOG_EXIT_AFTER_MS=0 disables it and
 * DB_WATCHDOG_POOL_STALL_MS=0 disables only the pool check.
 */
import { withBackgroundSpan } from "@docslurp/shared/observability";

import { apiPool } from "../db.js";
import type { PoolActivitySnapshot } from "../lib/pool-activity.js";
import { sharedDbProbe, type DbProbeResult } from "./db-probe.js";

export interface DbWatchdogOptions {
  intervalMs: number;
  timeoutMs: number;
  exitAfterMs: number;
  /** 0 disables the pool stall check. */
  poolStallMs: number;
}

export function resolveDbWatchdogOptions(env: NodeJS.ProcessEnv = process.env): DbWatchdogOptions {
  const num = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value?.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    intervalMs: Math.max(1_000, num(env.DB_WATCHDOG_INTERVAL_MS, 15_000)),
    timeoutMs: Math.max(500, num(env.DB_WATCHDOG_TIMEOUT_MS, 5_000)),
    exitAfterMs: num(env.DB_WATCHDOG_EXIT_AFTER_MS, 60_000),
    poolStallMs: num(env.DB_WATCHDOG_POOL_STALL_MS, 60_000),
  };
}

/** Pure decision state: when the first failure of the current streak happened, and whether to exit. */
export class DbWatchdogState {
  private failingSince: number | null = null;

  constructor(private readonly exitAfterMs: number) {}

  record(ok: boolean, now: number): { exit: boolean; failingForMs: number } {
    if (ok) {
      this.failingSince = null;
      return { exit: false, failingForMs: 0 };
    }
    this.failingSince ??= now;
    const failingForMs = now - this.failingSince;
    return { exit: this.exitAfterMs > 0 && failingForMs >= this.exitAfterMs, failingForMs };
  }
}

export interface DbWatchdogDeps {
  /** `select 1` on a connection outside the request pool. */
  probe: (timeoutMs: number) => Promise<DbProbeResult>;
  /** The request pool's in-flight demand and progress. */
  pool: () => PoolActivitySnapshot;
  /** Queries of the request pool that Postgres is executing; rejects when unknown. */
  activeBackends: (timeoutMs: number) => Promise<number>;
  now: () => number;
  log: { warn: (message: string) => void; error: (message: string) => void };
}

export type DbWatchdogVerdict =
  | { exit: false }
  | { exit: true; reason: "database_unreachable" | "pool_stalled"; message: string };

/** One watchdog check. Exported for tests; `startDbWatchdog` runs it on an interval. */
export async function checkDatabaseHealth(
  options: DbWatchdogOptions,
  state: DbWatchdogState,
  deps: DbWatchdogDeps,
): Promise<DbWatchdogVerdict> {
  const probe = await deps.probe(options.timeoutMs);
  const decision = state.record(probe.ok, deps.now());
  if (!probe.ok) {
    deps.log.warn(`[db-watchdog] database probe failed for ${Math.round(decision.failingForMs / 1000)}s: ${probe.detail}`);
    if (!decision.exit) return { exit: false };
    return {
      exit: true,
      reason: "database_unreachable",
      message: `[db-watchdog] database unreachable for ${Math.round(decision.failingForMs / 1000)}s on a dedicated connection; exiting so the machine restarts with a fresh pool`,
    };
  }

  if (options.poolStallMs <= 0 || options.exitAfterMs <= 0) return { exit: false };
  const pool = deps.pool();
  if (pool.inFlight === 0 || pool.stalledForMs < options.poolStallMs) return { exit: false };

  // The database answers, yet the pool has completed nothing for the window.
  // Ask Postgres whether it is still running this pool's queries.
  let active: number | null;
  try {
    active = await deps.activeBackends(options.timeoutMs);
  } catch {
    active = null;
  }
  const stalled = `pool has ${pool.inFlight} queries in flight and none completed for ${Math.round(pool.stalledForMs / 1000)}s`;
  if (active === 0) {
    return {
      exit: true,
      reason: "pool_stalled",
      message: `[db-watchdog] ${stalled} while the database answers in ${probe.latencyMs}ms and runs none of them; exiting so the machine restarts with a fresh pool`,
    };
  }
  deps.log.warn(`[db-watchdog] ${stalled}; database answers in ${probe.latencyMs}ms and reports ${active ?? "unknown"} active pool queries; not restarting`);
  return { exit: false };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function defaultDbWatchdogDeps(): DbWatchdogDeps {
  const probe = sharedDbProbe();
  return {
    probe: (timeoutMs) => probe.ping(timeoutMs),
    pool: () => apiPool.activity.snapshot(),
    activeBackends: (timeoutMs) => probe.activeBackends(apiPool.applicationName, timeoutMs),
    now: Date.now,
    log: console,
  };
}

export function startDbWatchdog(
  options: DbWatchdogOptions = resolveDbWatchdogOptions(),
  exit: (code: number) => void = (code) => process.exit(code),
  deps?: DbWatchdogDeps,
): void {
  if (timer || options.exitAfterMs <= 0) return;
  const resolved = deps ?? defaultDbWatchdogDeps();
  const state = new DbWatchdogState(options.exitAfterMs);
  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void withBackgroundSpan("api.db-watchdog", () => checkDatabaseHealth(options, state, resolved)).then((verdict) => {
      if (verdict.exit) {
        resolved.log.error(verdict.message);
        exit(1);
      }
    }).catch((error: unknown) => {
      resolved.log.warn(`[db-watchdog] check failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      running = false;
    });
  }, options.intervalMs);
  timer.unref?.();
}

export function stopDbWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
