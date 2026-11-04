import { Pool } from "pg";

export const revisionMaintenanceMetrics = { queries: 0, foldedRows: 0, failures: 0 };

/** Independent of observers, notifications and tenant writes. Each pass folds at
 * most 16 organizations × 256 committed counters, using a fair keyset cursor.
 * Its single connection has acquisition/query deadlines and is released idle.
 */
export function startRevisionMaintenance(databaseUrl: string, intervalMs = 5_000) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1,
    application_name: "docslurp-revision-maintenance",
    connectionTimeoutMillis: 500, idleTimeoutMillis: 1_000,
    statement_timeout: 1_000, query_timeout: 1_500 });
  pool.on("error", () => {
    revisionMaintenanceMetrics.failures++;
    console.error("[realtime-revisions] idle connection failed; next tick reconnects");
  });
  let cursor = "", running = false, stopped = false;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      revisionMaintenanceMetrics.queries++;
      const { rows: [row] } = await pool.query<{ next_org: string; folded_rows: number }>(
        "select * from public.realtime_compact_revisions($1)", [cursor]);
      cursor = row?.next_org ?? "";
      revisionMaintenanceMetrics.foldedRows += row?.folded_rows ?? 0;
    } catch {
      revisionMaintenanceMetrics.failures++;
      // No tenant identifiers, SQL or payloads in logs.
      console.error("[realtime-revisions] maintenance failed; next tick retries");
    } finally { running = false; }
  }
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  void tick();
  return async () => { stopped = true; clearInterval(timer); await pool.end(); };
}
