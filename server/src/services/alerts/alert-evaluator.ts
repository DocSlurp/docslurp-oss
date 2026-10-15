import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "../../db.js";
import { httpResponseStats } from "../../lib/http-response-stats.js";
import { describeTaskQueuePollers, workerTaskQueues } from "../../lib/temporal.js";
import { deliverAlert, resolveAlertDeliveryConfig, type AlertDeliveryConfig } from "./alert-delivery.js";
import {
  WorkerIdentityHistory,
  evaluateAlertRules,
  resolveAlertThresholds,
  type AlertCheck,
  type AlertObservation,
  type AlertThresholds,
  type MigrationSnapshot,
  type QueueSnapshot,
  type TaskQueuePollerSnapshot,
} from "./alert-rules.js";
import { AlertTracker } from "./alert-tracker.js";
import { WorkerFloorFallback } from "./worker-floor.js";

/**
 * Periodic alert evaluation inside the app process (docs/observability.md#alerting).
 *
 * Fleet-wide checks (queue age, stale leases, worker pollers and crash loops,
 * migrations, Temporal) run on one app instance at a time, elected through
 * the same `worker_maintenance_leases` row lease the worker uses. The app is
 * the evaluator because it observes the worker fleet and Temporal from the
 * outside: a crash-looping worker cannot report its own outage. The 5xx-rate
 * check is per process and runs on every instance. When the lease cannot be
 * taken because the database is down, each instance reports
 * database-unreachable itself.
 *
 * ALERT_EVALUATION_INTERVAL_MS=0 disables the loop.
 */

const LEASE_NAME = "app-alerts";

export function alertInstanceId(): string {
  return `docslurp-app-${process.env.FLY_MACHINE_ID?.trim() || hostname()}-${process.pid}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let cachedJournal: MigrationSnapshot["journal"] | null | undefined;

/** server/db/migrations/meta/_journal.json shipped with this build, or null when absent. */
export function loadMigrationJournal(starts: string[] = [process.cwd(), dirname(fileURLToPath(import.meta.url))]): MigrationSnapshot["journal"] | null {
  if (cachedJournal !== undefined) return cachedJournal;
  for (const start of starts) {
    for (let dir = start; ; dir = dirname(dir)) {
      // `server/db/...` from the repo root (the bundled app runs from /app); `db/...` from server/.
      const path = ["server/db/migrations/meta/_journal.json", "db/migrations/meta/_journal.json"]
        .map((relativePath) => resolve(dir, relativePath))
        .find((candidate) => existsSync(candidate));
      if (path) {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: Array<{ tag: string; when: number }> };
        cachedJournal = (parsed.entries ?? []).map((entry) => ({ tag: entry.tag, when: Number(entry.when) }));
        return cachedJournal;
      }
      if (dirname(dir) === dir) break;
    }
  }
  cachedJournal = null;
  return null;
}

async function readQueueSnapshot(): Promise<QueueSnapshot> {
  const [row] = await sql<{
    queue_depth: number;
    processing_runs: number;
    stale_leases: number;
    oldest_queued_run_age_seconds: number | null;
  }[]>`
    select
      count(*) filter (
        where status = 'queued' and coalesce(control_state, '') not in ('paused', 'cancelled')
      )::int as queue_depth,
      count(*) filter (
        where status = 'processing' and coalesce(control_state, '') not in ('paused', 'cancel_requested', 'cancelled')
      )::int as processing_runs,
      count(*) filter (
        where status = 'processing' and coalesce(lease_expires_at, to_timestamp(0)) < now()
      )::int as stale_leases,
      extract(epoch from (now() - min(created_at) filter (
        where status = 'queued' and coalesce(control_state, '') not in ('paused', 'cancelled')
      )))::double precision as oldest_queued_run_age_seconds
    from workspace_runs
  `;
  return {
    queueDepth: Number(row?.queue_depth ?? 0),
    processingRuns: Number(row?.processing_runs ?? 0),
    staleLeases: Number(row?.stale_leases ?? 0),
    oldestQueuedRunAgeSeconds: row?.oldest_queued_run_age_seconds === null || row?.oldest_queued_run_age_seconds === undefined
      ? null
      : Number(row.oldest_queued_run_age_seconds),
  };
}

async function readMigrationSnapshot(): Promise<MigrationSnapshot | null> {
  const journal = loadMigrationJournal();
  if (!journal) return null;
  try {
    // drizzle-kit migrate records each applied migration with created_at = journal `when`.
    const [row] = await sql<{ applied: number; latest: string | number | null }[]>`
      select count(*)::int as applied, max(created_at) as latest from drizzle.__drizzle_migrations
    `;
    return {
      appliedCount: Number(row?.applied ?? 0),
      latestAppliedWhen: row?.latest === null || row?.latest === undefined ? null : Number(row.latest),
      journal,
    };
  } catch (error) {
    console.warn(`[alert] migration state unavailable: ${errorMessage(error)}`);
    return null;
  }
}

async function readTemporalSnapshot(): Promise<AlertObservation["temporal"]> {
  try {
    const queues: TaskQueuePollerSnapshot[] = [];
    for (const queue of workerTaskQueues()) {
      queues.push({ ...queue, pollers: await describeTaskQueuePollers(queue.name, queue.type) });
    }
    return { ok: true, queues };
  } catch (error) {
    return { ok: false, error: errorMessage(error).slice(0, 300) };
  }
}

export interface AlertEvaluatorDeps {
  tryLease: (holder: string, ttlMs: number) => Promise<boolean>;
  readQueue: () => Promise<QueueSnapshot>;
  readMigrations: () => Promise<MigrationSnapshot | null>;
  readTemporal: () => Promise<AlertObservation["temporal"]>;
  readHttp: (windowMs: number, now: number) => { total: number; errors5xx: number };
  deliver: (notification: Parameters<typeof deliverAlert>[0], config: AlertDeliveryConfig) => Promise<void>;
  now: () => number;
  /** Leader only: start a worker when runs wait with no pollers (worker-floor.ts). */
  workerFloor?: (checks: AlertCheck[]) => Promise<unknown>;
}

const workerFloorFallback = new WorkerFloorFallback();

const defaultDeps: AlertEvaluatorDeps = {
  tryLease: async (holder, ttlMs) => {
    const rows = await sql`insert into worker_maintenance_leases (name, holder, expires_at, updated_at)
      values (${LEASE_NAME}, ${holder}, now() + (${ttlMs} * interval '1 millisecond'), now())
      on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at, updated_at = now()
      where worker_maintenance_leases.holder = excluded.holder or worker_maintenance_leases.expires_at < now()
      returning holder`;
    return rows.length > 0;
  },
  readQueue: readQueueSnapshot,
  readMigrations: readMigrationSnapshot,
  readTemporal: readTemporalSnapshot,
  readHttp: (windowMs, now) => httpResponseStats.window(windowMs, now),
  deliver: (notification, config) => deliverAlert(notification, config),
  now: () => Date.now(),
  workerFloor: (checks) => workerFloorFallback.evaluate(checks),
};

export interface AlertEvaluatorOptions {
  intervalMs: number;
  thresholds: AlertThresholds;
  pendingEvaluations: number;
  repeatIntervalMs: number;
  delivery: AlertDeliveryConfig;
  instance: string;
}

export function resolveAlertEvaluatorOptions(env: NodeJS.ProcessEnv = process.env): AlertEvaluatorOptions {
  const instance = alertInstanceId();
  const number = (name: string, fallback: number) => {
    const value = Number(env[name]?.trim() || Number.NaN);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    intervalMs: number("ALERT_EVALUATION_INTERVAL_MS", 60_000),
    thresholds: resolveAlertThresholds(env),
    pendingEvaluations: Math.max(1, Math.round(number("ALERT_PENDING_EVALUATIONS", 2))),
    repeatIntervalMs: number("ALERT_REPEAT_INTERVAL_MS", 4 * 60 * 60_000),
    delivery: resolveAlertDeliveryConfig(env, instance),
    instance,
  };
}

/** One evaluator per process; `tick()` is exposed for tests. */
export class AlertEvaluator {
  readonly tracker: AlertTracker;
  private readonly workerHistory = new WorkerIdentityHistory();
  private leader = false;
  private running = false;
  lastChecks: AlertCheck[] = [];
  lastEvaluatedAt: number | null = null;

  constructor(
    private readonly options: AlertEvaluatorOptions,
    private readonly deps: AlertEvaluatorDeps = defaultDeps,
  ) {
    this.tracker = new AlertTracker({ pendingEvaluations: options.pendingEvaluations, repeatIntervalMs: options.repeatIntervalMs });
  }

  isLeader(): boolean {
    return this.leader;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.deps.now();
      const ttlMs = Math.max(90_000, this.options.intervalMs * 3);
      let database: AlertObservation["database"] = null;
      let temporal: AlertObservation["temporal"] = null;
      let leader = false;
      try {
        leader = await this.deps.tryLease(this.options.instance, ttlMs);
      } catch (error) {
        database = { ok: false, error: errorMessage(error).slice(0, 300) };
      }
      if (leader !== this.leader && database === null) {
        console.log(`[alert] evaluator_leader=${leader} instance=${this.options.instance}`);
        // The new leader owns fleet alerts now; forget ours without a resolved notice.
        if (!leader) this.tracker.drop((id) => id !== "http-5xx-rate" && id !== "database-unreachable");
      }
      this.leader = leader;
      // The lease query answered, so the database is reachable even when another instance leads.
      if (database === null) database = { ok: true, queue: null, migrations: null };

      if (leader) {
        try {
          const queue = await this.deps.readQueue();
          database = { ok: true, queue, migrations: await this.deps.readMigrations() };
        } catch (error) {
          database = { ok: false, error: errorMessage(error).slice(0, 300) };
        }
        temporal = await this.deps.readTemporal();
      }

      const windowMs = this.options.thresholds.http5xxWindowMs;
      const observation: AlertObservation = {
        now,
        database,
        temporal,
        http: { ...this.deps.readHttp(windowMs, now), windowMs },
      };
      const checks = evaluateAlertRules(observation, this.options.thresholds, leader ? this.workerHistory : undefined);
      this.lastChecks = checks;
      this.lastEvaluatedAt = now;
      for (const notification of this.tracker.update(checks, now)) {
        await this.deps.deliver(notification, this.options.delivery);
      }
      if (leader && this.deps.workerFloor) {
        await this.deps.workerFloor(checks).catch(() => null);
      }
    } finally {
      this.running = false;
    }
  }
}

let evaluator: AlertEvaluator | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function currentAlertEvaluator(): AlertEvaluator | null {
  return evaluator;
}

export function startAlertEvaluator(env: NodeJS.ProcessEnv = process.env): AlertEvaluator | null {
  if (timer) return evaluator;
  const options = resolveAlertEvaluatorOptions(env);
  if (options.intervalMs === 0) return null;
  evaluator = new AlertEvaluator(options);
  const instance = evaluator;
  console.log(
    `[alert] evaluator started intervalMs=${options.intervalMs} webhook=${options.delivery.webhookUrl ? options.delivery.format : "none"} ` +
    `env=${options.delivery.environment} instance=${options.instance}`,
  );
  timer = setInterval(() => {
    instance.tick().catch((error) => console.error(`[alert] evaluation failed: ${errorMessage(error)}`));
  }, options.intervalMs);
  timer.unref?.();
  return evaluator;
}

export function stopAlertEvaluator(): void {
  if (timer) clearInterval(timer);
  timer = null;
  evaluator = null;
}
