/**
 * Readiness (`GET /ready`): can this app instance serve real work?
 *
 * `/health` stays a constant liveness answer (the process is up). `/ready`
 * checks each dependency with its own timeout, all in parallel:
 *
 * - database:   `select 1`
 * - migrations: the schema has every migration this build ships
 *               (a schema *ahead* of the code is fine: that is a rollback
 *               under expand/contract, docs/releases.md#rolling-back)
 * - storage:    HEAD the object-storage bucket
 * - temporal:   DescribeNamespace on the configured namespace
 *
 * Database, migrations and storage are critical: when one fails the instance
 * cannot serve uploads, search or auth, so `/ready` returns 503 and Fly stops
 * routing to it. Temporal is not critical for routing (uploads queue durably
 * in SQL and start later), so a Temporal outage keeps 200 with `ok: false`.
 * The deploy gate requires `ok: true`, i.e. every check passing.
 */

import { sql } from "../db.js";
import { headStorageBucket } from "../lib/storage.js";
import { describeTemporalNamespace } from "../lib/temporal.js";
import { loadMigrationJournal } from "./alerts/alert-evaluator.js";

export type ReadinessCheckName = "database" | "migrations" | "storage" | "temporal";

export interface ReadinessCheck {
  name: ReadinessCheckName;
  ok: boolean;
  critical: boolean;
  latencyMs: number;
  detail: string;
}

export interface ReadinessReport {
  /** Every check passed. The deploy gate requires this. */
  ok: boolean;
  /** Every critical check passed. Drives the HTTP status (200 or 503). */
  serving: boolean;
  checks: ReadinessCheck[];
  checkedAt: string;
}

export type ProbeResult = { ok: true; detail?: string } | { ok: false; detail: string };

export interface ReadinessProbes {
  database: (signal: AbortSignal) => Promise<ProbeResult>;
  migrations: (signal: AbortSignal) => Promise<ProbeResult>;
  storage: (signal: AbortSignal) => Promise<ProbeResult>;
  temporal: (signal: AbortSignal) => Promise<ProbeResult>;
}

const CRITICAL: Record<ReadinessCheckName, boolean> = {
  database: true,
  migrations: true,
  storage: true,
  temporal: false,
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** Pure: compare the applied migrations with the journal this build ships. */
export function migrationReadiness(input: {
  journal: Array<{ tag: string; when: number }> | null;
  latestAppliedWhen: number | null;
}): ProbeResult {
  if (!input.journal) return { ok: true, detail: "migration journal not shipped with this build; skipped" };
  const head = input.journal[input.journal.length - 1];
  if (!head) return { ok: true, detail: "migration journal is empty" };
  const applied = input.latestAppliedWhen ?? 0;
  const pending = input.journal.filter((entry) => entry.when > applied);
  if (pending.length > 0) {
    return { ok: false, detail: `${pending.length} migration(s) not applied; code expects ${head.tag}` };
  }
  return applied > head.when
    ? { ok: true, detail: `schema is ahead of this build (head ${head.tag}); expected during a rollback` }
    : { ok: true, detail: `schema at ${head.tag}` };
}

export const defaultReadinessProbes: ReadinessProbes = {
  async database() {
    await sql`select 1`;
    return { ok: true };
  },
  async migrations() {
    const journal = loadMigrationJournal();
    if (!journal) return migrationReadiness({ journal: null, latestAppliedWhen: null });
    const [row] = await sql<{ latest: string | number | null }[]>`
      select max(created_at) as latest from drizzle.__drizzle_migrations
    `;
    const latest = row?.latest === null || row?.latest === undefined ? null : Number(row.latest);
    return migrationReadiness({ journal, latestAppliedWhen: latest });
  },
  async storage(signal) {
    await headStorageBucket(signal);
    return { ok: true };
  },
  async temporal() {
    await describeTemporalNamespace(readinessTimeoutMs());
    return { ok: true };
  },
};

export function readinessTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.READY_CHECK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30_000) : 2_500;
}

async function runProbe(
  name: ReadinessCheckName,
  probe: (signal: AbortSignal) => Promise<ProbeResult>,
  timeoutMs: number,
): Promise<ReadinessCheck> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`timed out after ${timeoutMs}ms`));
      resolve({ ok: false, detail: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
  });
  let result: ProbeResult;
  try {
    result = await Promise.race([
      probe(controller.signal).catch((error): ProbeResult => ({ ok: false, detail: errorMessage(error) })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
  return {
    name,
    ok: result.ok,
    critical: CRITICAL[name],
    latencyMs: Date.now() - started,
    detail: result.detail ?? "ok",
  };
}

export async function evaluateReadiness(
  probes: ReadinessProbes = defaultReadinessProbes,
  options: { timeoutMs?: number; now?: () => Date } = {},
): Promise<ReadinessReport> {
  const timeoutMs = options.timeoutMs ?? readinessTimeoutMs();
  const names = Object.keys(CRITICAL) as ReadinessCheckName[];
  const checks = await Promise.all(names.map((name) => runProbe(name, probes[name], timeoutMs)));
  return {
    ok: checks.every((check) => check.ok),
    serving: checks.every((check) => check.ok || !check.critical),
    checks,
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

let cached: { at: number; report: Promise<ReadinessReport> } | null = null;

/**
 * Fly checks, the deploy gate and humans share one evaluation per
 * READY_CACHE_MS window (default 5 s) so probes never pile up on a slow
 * dependency.
 */
export function cachedReadiness(now = Date.now()): Promise<ReadinessReport> {
  const cacheMs = Math.max(0, Number(process.env.READY_CACHE_MS ?? 5_000) || 0);
  if (cached && now - cached.at < cacheMs) return cached.report;
  const report = evaluateReadiness();
  cached = { at: now, report };
  report.catch(() => {
    if (cached?.report === report) cached = null;
  });
  return report;
}
