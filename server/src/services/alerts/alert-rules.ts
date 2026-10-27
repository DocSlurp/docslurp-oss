/**
 * Pure alert conditions (docs/observability.md#alerting). The evaluator collects an
 * AlertObservation from the database, Temporal and this process; the rules
 * here turn it into checks without any I/O so they can be unit-tested.
 *
 * A rule returns `unknown` when its input could not be collected (for example
 * the pollers check while Temporal is down). Unknown never resolves a firing
 * alert; the dependency's own alert (temporal-unreachable,
 * database-unreachable) covers that outage instead.
 */

export type AlertSeverity = "critical" | "warning";

export type AlertId =
  | `credits-running-low:${string}`
  | `credit-resume-delayed:${string}`
  | "database-unreachable"
  | "queued-run-age"
  | "stale-leases"
  | "extract-deletion-stuck"
  | "worker-pollers-missing"
  | "worker-crash-loop"
  | "migrations-not-at-head"
  | "http-5xx-rate"
  | "temporal-unreachable";

export type AlertDetailValue = string | number | boolean | null;

export type AlertCheck =
  | {
      id: AlertId;
      state: "firing" | "ok";
      severity: AlertSeverity;
      summary: string;
      details: Record<string, AlertDetailValue>;
    }
  | { id: AlertId; state: "unknown"; reason: string };

export interface TaskQueuePollerSnapshot {
  name: string;
  type: "workflow" | "activity";
  pollers: Array<{ identity: string; lastAccessMs: number | null }>;
}

export interface MigrationSnapshot {
  appliedCount: number;
  /** Journal `when` of the newest applied migration (drizzle created_at). */
  latestAppliedWhen: number | null;
  /** Migrations shipped with this build, in journal order. */
  journal: Array<{ tag: string; when: number }>;
}

export interface QueueSnapshot {
  queueDepth: number;
  processingRuns: number;
  staleLeases: number;
  oldestQueuedRunAgeSeconds: number | null;
  /** Expired extracts the sweep has not finished deleting (services/extracts.ts). */
  extractDeletion?: { failing: number; overdue: number; oldestOverdueSeconds: number | null };
}

export interface AlertObservation {
  now: number;
  /**
   * null: not observed. `queue: null`: reachable, but fleet checks run on
   * another (leader) instance.
   */
  database:
    | { ok: true; queue: QueueSnapshot | null; migrations: MigrationSnapshot | null }
    | { ok: false; error: string }
    | null;
  temporal: { ok: true; queues: TaskQueuePollerSnapshot[] } | { ok: false; error: string } | null;
  http: { total: number; errors5xx: number; windowMs: number } | null;
}

export interface AlertThresholds {
  /** Oldest unpaused queued run older than this fires queued-run-age. */
  queuedRunAgeSeconds: number;
  /** This many processing runs with expired leases fires stale-leases. */
  staleLeases: number;
  /** Pollers last seen longer ago than this no longer count as live workers. */
  pollerStaleMs: number;
  /** Distinct worker processes per machine within the window that count as a crash loop. */
  workerRestartsPerMachine: number;
  workerRestartWindowMs: number;
  /** 5xx share of requests in the window, 0..1. */
  http5xxRate: number;
  /** Below this many requests in the window the 5xx rate is not judged. */
  http5xxMinRequests: number;
  http5xxWindowMs: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  queuedRunAgeSeconds: 900,
  staleLeases: 1,
  pollerStaleMs: 180_000,
  workerRestartsPerMachine: 3,
  workerRestartWindowMs: 15 * 60_000,
  http5xxRate: 0.05,
  http5xxMinRequests: 20,
  http5xxWindowMs: 5 * 60_000,
};

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export function resolveAlertThresholds(env: NodeJS.ProcessEnv = process.env): AlertThresholds {
  const d = DEFAULT_ALERT_THRESHOLDS;
  return {
    queuedRunAgeSeconds: readNumber(env, "ALERT_QUEUED_RUN_AGE_SECONDS", d.queuedRunAgeSeconds, 1),
    staleLeases: readNumber(env, "ALERT_STALE_LEASES", d.staleLeases, 1),
    pollerStaleMs: readNumber(env, "ALERT_POLLER_STALE_MS", d.pollerStaleMs, 1_000),
    workerRestartsPerMachine: readNumber(env, "ALERT_WORKER_RESTARTS_PER_MACHINE", d.workerRestartsPerMachine, 2),
    workerRestartWindowMs: readNumber(env, "ALERT_WORKER_RESTART_WINDOW_MS", d.workerRestartWindowMs, 60_000),
    http5xxRate: Math.min(1, readNumber(env, "ALERT_HTTP_5XX_RATE", d.http5xxRate, 0)),
    http5xxMinRequests: readNumber(env, "ALERT_HTTP_5XX_MIN_REQUESTS", d.http5xxMinRequests, 1),
    http5xxWindowMs: readNumber(env, "ALERT_HTTP_5XX_WINDOW_MS", d.http5xxWindowMs, 10_000),
  };
}

/**
 * Worker identities are `docslurp-worker-<machine>-<pid>` (worker.ts). A
 * process that restarts on the same machine comes back with a new pid, so
 * several identities per machine inside the window means a crash loop. New
 * machines from autoscaling add one identity each and do not count.
 */
export function workerMachineKey(identity: string): string {
  const match = /^(.*)-\d+$/.exec(identity);
  return match?.[1] ?? identity;
}

export class WorkerIdentityHistory {
  private readonly firstSeen = new Map<string, number>();

  observe(identities: Iterable<string>, now: number, windowMs: number): void {
    for (const identity of identities) {
      if (identity && !this.firstSeen.has(identity)) this.firstSeen.set(identity, now);
    }
    for (const [identity, seenAt] of this.firstSeen) {
      if (now - seenAt > windowMs) this.firstSeen.delete(identity);
    }
  }

  /** Distinct processes first seen per machine within the window, busiest first. */
  processesPerMachine(): Array<{ machine: string; processes: number }> {
    const counts = new Map<string, number>();
    for (const identity of this.firstSeen.keys()) {
      const machine = workerMachineKey(identity);
      counts.set(machine, (counts.get(machine) ?? 0) + 1);
    }
    return [...counts].map(([machine, processes]) => ({ machine, processes })).sort((a, b) => b.processes - a.processes);
  }
}

function livePollers(queue: TaskQueuePollerSnapshot, now: number, staleMs: number): number {
  return queue.pollers.filter((poller) => poller.lastAccessMs === null || now - poller.lastAccessMs <= staleMs).length;
}

function check(
  id: AlertId,
  firing: boolean,
  severity: AlertSeverity,
  summary: string,
  details: Record<string, AlertDetailValue>,
): AlertCheck {
  return { id, state: firing ? "firing" : "ok", severity, summary, details };
}

function unknown(id: AlertId, reason: string): AlertCheck {
  return { id, state: "unknown", reason };
}

/** Every alert this evaluator can raise, evaluated against one observation. */
export function evaluateAlertRules(
  obs: AlertObservation,
  thresholds: AlertThresholds,
  workerHistory?: WorkerIdentityHistory,
): AlertCheck[] {
  const checks: AlertCheck[] = [];
  const db = obs.database;

  if (db) {
    checks.push(check(
      "database-unreachable",
      !db.ok,
      "critical",
      db.ok ? "App database reachable" : "App database (Neon) is unreachable from the app",
      db.ok ? {} : { error: db.error },
    ));
  }

  if (db?.ok && db.queue) {
    const { queue } = db;
    const age = queue.oldestQueuedRunAgeSeconds ?? 0;
    checks.push(check(
      "queued-run-age",
      age > thresholds.queuedRunAgeSeconds,
      "critical",
      `Oldest queued run has waited ${Math.round(age)}s (threshold ${thresholds.queuedRunAgeSeconds}s)`,
      { oldestQueuedRunAgeSeconds: Math.round(age), queueDepth: queue.queueDepth, thresholdSeconds: thresholds.queuedRunAgeSeconds },
    ));
    checks.push(check(
      "stale-leases",
      queue.staleLeases >= thresholds.staleLeases,
      "warning",
      `${queue.staleLeases} processing run(s) have expired worker leases (threshold ${thresholds.staleLeases})`,
      { staleLeases: queue.staleLeases, processingRuns: queue.processingRuns, threshold: thresholds.staleLeases },
    ));

    if (queue.extractDeletion) {
      const { failing, overdue, oldestOverdueSeconds } = queue.extractDeletion;
      // Customer data past its retention window is still stored: an error, or an hour past expiry.
      const stuck = failing > 0 || (oldestOverdueSeconds ?? 0) > 3_600;
      checks.push(check(
        "extract-deletion-stuck",
        stuck,
        "critical",
        stuck
          ? `${failing} expired extract(s) failing to delete, ${overdue} overdue (oldest ${Math.round(oldestOverdueSeconds ?? 0)}s past expiry)`
          : "Expired extracts are being deleted",
        { failing, overdue, oldestOverdueSeconds: oldestOverdueSeconds === null ? null : Math.round(oldestOverdueSeconds) },
      ));
    }

    if (db.migrations) {
      const { journal, latestAppliedWhen, appliedCount } = db.migrations;
      const head = journal[journal.length - 1];
      if (!head) {
        checks.push(unknown("migrations-not-at-head", "migration journal is empty"));
      } else {
        const applied = latestAppliedWhen ?? 0;
        const pending = journal.filter((entry) => entry.when > applied);
        const ahead = applied > head.when;
        checks.push(check(
          "migrations-not-at-head",
          pending.length > 0 || ahead,
          "critical",
          ahead
            ? "Database schema is ahead of the running code (rolled back past a migration?)"
            : pending.length > 0
              ? `${pending.length} migration(s) not applied; head is ${head.tag}`
              : `Schema at head ${head.tag}`,
          {
            head: head.tag,
            appliedCount,
            pending: pending.map((entry) => entry.tag).join(",") || null,
            schemaAheadOfCode: ahead,
          },
        ));
      }
    } else {
      checks.push(unknown("migrations-not-at-head", "migration state unavailable"));
    }
  } else if (db && !db.ok) {
    for (const id of ["queued-run-age", "stale-leases", "migrations-not-at-head"] as const) {
      checks.push(unknown(id, "database unreachable"));
    }
  }

  const temporal = obs.temporal;
  if (temporal) {
    checks.push(check(
      "temporal-unreachable",
      !temporal.ok,
      "critical",
      temporal.ok ? "Temporal reachable" : "Temporal frontend is unreachable from the app",
      temporal.ok ? {} : { error: temporal.error },
    ));
  }

  if (temporal?.ok) {
    const live = temporal.queues.map((queue) => ({ queue, live: livePollers(queue, obs.now, thresholds.pollerStaleMs) }));
    const empty = live.filter((entry) => entry.live === 0);
    if (db?.ok && db.queue) {
      const pendingWork = db.queue.queueDepth + db.queue.processingRuns;
      checks.push(check(
        "worker-pollers-missing",
        pendingWork > 0 && empty.length > 0,
        "critical",
        empty.length > 0
          ? `No live worker pollers on ${empty.map((entry) => entry.queue.name).join(", ")} with ${pendingWork} run(s) waiting`
          : "Worker pollers present",
        {
          pendingRuns: pendingWork,
          queues: live.map((entry) => `${entry.queue.name}(${entry.queue.type})=${entry.live}`).join(","),
        },
      ));
    } else {
      checks.push(unknown("worker-pollers-missing", "queue depth unavailable"));
    }

    if (workerHistory) {
      workerHistory.observe(
        temporal.queues.flatMap((queue) => queue.pollers.map((poller) => poller.identity)),
        obs.now,
        thresholds.workerRestartWindowMs,
      );
      const busiest = workerHistory.processesPerMachine()[0];
      const looping = workerHistory.processesPerMachine().filter((entry) => entry.processes >= thresholds.workerRestartsPerMachine);
      checks.push(check(
        "worker-crash-loop",
        looping.length > 0,
        "critical",
        looping.length > 0
          ? `${looping.length} worker machine(s) restarted >= ${thresholds.workerRestartsPerMachine} times in ${Math.round(thresholds.workerRestartWindowMs / 60_000)} min`
          : "No worker crash loops",
        {
          machines: looping.map((entry) => `${entry.machine}=${entry.processes}`).join(",") || null,
          busiestMachineProcesses: busiest?.processes ?? 0,
        },
      ));
    }
  } else if (temporal) {
    checks.push(unknown("worker-pollers-missing", "temporal unreachable"));
    if (workerHistory) checks.push(unknown("worker-crash-loop", "temporal unreachable"));
  }

  const http = obs.http;
  if (http) {
    const rate = http.total > 0 ? http.errors5xx / http.total : 0;
    if (http.total < thresholds.http5xxMinRequests) {
      // Too little traffic to judge; a quiet window resolves a firing alert.
      checks.push(check("http-5xx-rate", false, "warning", "Too few requests to judge the 5xx rate", { total: http.total, errors5xx: http.errors5xx }));
    } else {
      checks.push(check(
        "http-5xx-rate",
        rate >= thresholds.http5xxRate,
        "warning",
        `${(rate * 100).toFixed(1)}% of ${http.total} API responses were 5xx in the last ${Math.round(http.windowMs / 60_000)} min (threshold ${(thresholds.http5xxRate * 100).toFixed(1)}%)`,
        { total: http.total, errors5xx: http.errors5xx, rate: Number(rate.toFixed(4)), threshold: thresholds.http5xxRate },
      ));
    }
  }

  return checks;
}
