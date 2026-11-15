import { sql as defaultSql } from "../db.js";

type Sql = typeof defaultSql;

type CounterTotals = {
  search_sessions: number; search_result_count: number; zero_result_searches: number;
  search_duration_count: number; search_duration_ms: number; chat_turns: number;
};

export type ProjectActivityStatsDrift = {
  projectId: string;
  /** False for counter rows left behind for a project that no longer exists. */
  projectExists: boolean;
  stored: CounterTotals;
  actual: CounterTotals;
};

/** Projects compared per sweep. The comparison reads all of their search and chat history, so the sample is small. */
const SAMPLE = 20;
/** A sampled comparison that runs longer than this is cancelled and its projects are left to the ops script. */
const STATEMENT_TIMEOUT_MS = 5_000;

function checkIntervalMs(): number {
  const value = Number(process.env.PROJECT_ACTIVITY_STATS_DRIFT_CHECK_INTERVAL_MS ?? 600_000);
  return Number.isFinite(value) && value >= 0 ? value : 600_000;
}

/** Where this process's pass over the projects has reached; it wraps around at the end. */
let cursor = "";
let lastRunAt = 0;
let running = false;

/**
 * Compares stored project_activity_stats counters with search and chat history (migration 0165,
 * project_activity_stats_drift()). `projectIds` limits the comparison to those projects; without it every project
 * is compared, which reads all history: maintenance only, never a request path. Read-only and lock-free.
 */
export async function findProjectActivityStatsDrift(
  options: { sql?: Sql; projectIds?: string[] } = {},
): Promise<ProjectActivityStatsDrift[]> {
  const sql = options.sql ?? defaultSql;
  const rows = await sql<{ project_id: string; project_exists: boolean; stored: CounterTotals; actual: CounterTotals }[]>`
    select project_id, project_exists, stored, actual
    from project_activity_stats_drift(${options.projectIds ?? null}::text[])
  `;
  return rows.map((row) => ({ projectId: row.project_id, projectExists: row.project_exists, stored: row.stored, actual: row.actual }));
}

/**
 * Maintenance sweep: every PROJECT_ACTIVITY_STATS_DRIFT_CHECK_INTERVAL_MS (default 10 minutes; 0 disables) compares
 * the counters of the next few projects with their history and logs any difference. Nothing but a bypassed trigger
 * (session_replication_role = replica, DISABLE TRIGGER, a manual fix, a partial restore) makes them differ, and
 * nothing else would report it: the project list would show the wrong totals indefinitely.
 *
 * It only reports drift. The repair, rebuild_project_activity_stats(), holds writers out of search and chat history
 * while it runs, so an operator starts it (docs/self-host/operations.md). The sweep does fold the sampled projects'
 * spare counter rows into one (compact_project_activity_stats(), which changes no total). Returns the drifting
 * projects found.
 */
export async function sweepProjectActivityStatsDrift(
  options: { sql?: Sql; sample?: number; force?: boolean } = {},
): Promise<ProjectActivityStatsDrift[]> {
  const interval = checkIntervalMs();
  if (running || (!options.force && (interval === 0 || Date.now() - lastRunAt < interval))) return [];
  const sql = options.sql ?? defaultSql;
  running = true;
  lastRunAt = Date.now();
  try {
    const sample = options.sample ?? SAMPLE;
    let projects = await sql<{ id: string }[]>`select id from projects where id > ${cursor} order by id limit ${sample}`;
    if (projects.length === 0 && cursor !== "") {
      cursor = "";
      projects = await sql<{ id: string }[]>`select id from projects order by id limit ${sample}`;
    }
    if (projects.length === 0) return [];
    cursor = projects.length < sample ? "" : projects[projects.length - 1]!.id;
    const projectIds = projects.map((project) => project.id);
    let drift: ProjectActivityStatsDrift[];
    try {
      drift = await sql.begin(async (tx) => {
        await tx.unsafe(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        return await findProjectActivityStatsDrift({ sql: tx as unknown as Sql, projectIds });
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "57014") throw error;
      // The busiest projects are the ones whose history is slow to read and whose rows most need folding,
      // so a cancelled check still compacts them.
      console.warn(`[project-activity-stats] drift check of ${projectIds.length} projects (${projectIds[0]} … ${projectIds.at(-1)}) cancelled after ${STATEMENT_TIMEOUT_MS}ms; run the full check from server/db/project-activity-stats.mjs`);
      drift = [];
    }
    // Fold the rows a burst of concurrent writers left for these projects (reads sum a project's rows). It locks
    // only rows no writer holds and waits for nothing.
    await sql`select compact_project_activity_stats(${projectIds}::text[])`;
    if (drift.length > 0) {
      const detail = drift.slice(0, 5)
        .map((row) => `${row.projectId} stored=${JSON.stringify(row.stored)} actual=${JSON.stringify(row.actual)}`).join("; ");
      console.error(`[project-activity-stats] counter drift in ${drift.length} of ${projectIds.length} sampled projects: ${detail}. Repair with server/db/project-activity-stats.mjs --rebuild (docs/self-host/operations.md)`);
    }
    return drift;
  } finally {
    running = false;
  }
}
