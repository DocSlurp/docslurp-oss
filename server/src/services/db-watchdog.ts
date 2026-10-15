/**
 * Restarts the app when its database pool stops answering.
 *
 * postgres.js enables TCP keepalive only with an initial delay, so with Linux
 * defaults (75 s x 9 probes) a connection that died silently (a proxy restart,
 * a dropped path during a deploy) is noticed after more than 11 minutes, and
 * until then every query on it hangs. On 2026-10-12 that took production down
 * for ~8 minutes after a deploy while the database itself answered in 0.2 s;
 * a machine restart fixed it at once.
 *
 * Every DB_WATCHDOG_INTERVAL_MS this runs `select 1` with a short timeout.
 * After the database has failed continuously for DB_WATCHDOG_EXIT_AFTER_MS,
 * the process exits non-zero and Fly restarts the machine with a fresh pool.
 * A real database outage restarts the app at that cadence too, which costs a
 * few seconds of boot per minute and recovers by itself when the database
 * returns. Production only; DB_WATCHDOG_EXIT_AFTER_MS=0 disables it.
 */

import { sql } from "../db.js";

export interface DbWatchdogOptions {
  intervalMs: number;
  timeoutMs: number;
  exitAfterMs: number;
}

export function resolveDbWatchdogOptions(env: NodeJS.ProcessEnv = process.env): DbWatchdogOptions {
  const num = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    intervalMs: Math.max(1_000, num(env.DB_WATCHDOG_INTERVAL_MS, 15_000)),
    timeoutMs: Math.max(500, num(env.DB_WATCHDOG_TIMEOUT_MS, 5_000)),
    exitAfterMs: num(env.DB_WATCHDOG_EXIT_AFTER_MS, 60_000),
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

async function probe(timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sql`select 1`.then(() => ({ ok: true, detail: "ok" })),
      new Promise<{ ok: boolean; detail: string }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, detail: `timed out after ${timeoutMs}ms` }), timeoutMs);
      }),
    ]);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDbWatchdog(
  options: DbWatchdogOptions = resolveDbWatchdogOptions(),
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  if (timer || options.exitAfterMs <= 0) return;
  const state = new DbWatchdogState(options.exitAfterMs);
  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void probe(options.timeoutMs).then(({ ok, detail }) => {
      const decision = state.record(ok, Date.now());
      if (!ok) console.warn(`[db-watchdog] database probe failed for ${Math.round(decision.failingForMs / 1000)}s: ${detail}`);
      if (decision.exit) {
        console.error(`[db-watchdog] database unreachable for ${Math.round(decision.failingForMs / 1000)}s; exiting so the machine restarts with a fresh pool`);
        exit(1);
      }
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
