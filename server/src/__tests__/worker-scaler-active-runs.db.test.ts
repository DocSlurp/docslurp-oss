import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { queryWorkerScalerSnapshot, type ScalerSql } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * 0194: the autoscaler snapshot reads only active runs (queued or processing),
 * through the partial index project_runs_org_active_idx, so its cost follows
 * live work rather than run history. The same index serves an organization's
 * active runs (org_id leading).
 */
const PARAMS = { pageFanout: 128, defaultOrgSlots: 2, loadtestMaxMachines: 125 };
// A real Postgres (TEST_DATABASE_URL, scripts/run-database-tests.mjs) gets a million finished runs; the in-memory
// PGlite fallback a smaller history that still makes a full scan the expensive plan.
const external = process.env.TEST_DATABASE_URL;
const FINISHED_RUNS = external ? 1_000_000 : 100_000;

/** Records the snapshot query's text and parameters instead of running it. */
function captureSql(): { sql: ScalerSql; text: () => string; values: () => unknown[] } {
  let captured: { strings: TemplateStringsArray; values: unknown[] } | null = null;
  const sql: ScalerSql = (strings, ...values) => {
    captured = { strings, values };
    return Promise.resolve([]);
  };
  return {
    sql,
    text: () => captured!.strings.reduce((out, part, index) => `${out}$${index}${part}`),
    values: () => captured!.values,
  };
}

describe("worker scaler snapshot over active runs (0194)", () => {
  it("reads active runs through the partial index with a million finished runs, and counts only live work", async () => {
    const pg = external ? null : await startMigratedPostgres();
    const sql = postgres(external ?? pg!.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await sql.unsafe(`
        INSERT INTO "user" (id,name,email) VALUES ('sa-user','S','sa@example.test');
        INSERT INTO organizations (id,name,slug,created_by_user_id,worker_slots) VALUES
          ('sa-org','A','sa-org','sa-user',8), ('sa-other','B','sa-other','sa-user',8);
        INSERT INTO projects (id,org_id,user_id,name) VALUES ('sa-p','sa-org','sa-user','P'), ('sa-q','sa-other','sa-user','Q');
      `);
      // Finished history, bulk loaded without row triggers (realtime revisions, spend) to keep the seed fast.
      await sql.unsafe(`
        SET session_replication_role = replica;
        INSERT INTO project_runs (id, org_id, user_id, project_id, kind, status, stage, total_documents, processed_documents,
          pages_total, pages_processed, created_at, updated_at)
        SELECT 'sa-done-' || g, CASE WHEN g % 2 = 0 THEN 'sa-org' ELSE 'sa-other' END, 'sa-user',
          CASE WHEN g % 2 = 0 THEN 'sa-p' ELSE 'sa-q' END, 'bulk-upload',
          CASE WHEN g % 10 = 0 THEN 'failed' ELSE 'completed' END, 'completed', 3, 3, 40, 40,
          now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval
        FROM generate_series(1, ${FINISHED_RUNS}) g;
        SET session_replication_role = origin;
      `);
      await sql.unsafe(`
        INSERT INTO project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, control_state, total_documents,
          processed_documents, pages_total, pages_processed, lease_expires_at, created_at) VALUES
          (100, 'sa-queued',    'sa-org',   'sa-user', 'sa-p', 'bulk-upload', 'queued',     'quarantine', null,     2, 0, 30, 0,  null,                            now() - interval '90 seconds'),
          (100, 'sa-paused',    'sa-org',   'sa-user', 'sa-p', 'bulk-upload', 'queued',     'quarantine', 'paused', 5, 0, 50, 0,  null,                            now() - interval '1 hour'),
          (100, 'sa-running',   'sa-org',   'sa-user', 'sa-p', 'bulk-upload', 'processing', 'extract',    null,     4, 1, 80, 20, now() + interval '1 minute',     now() - interval '5 minutes'),
          (100, 'sa-stale',     'sa-other', 'sa-user', 'sa-q', 'bulk-upload', 'processing', 'extract',    null,     1, 0, 10, 0,  now() - interval '1 hour',       now() - interval '2 hours'),
          (100, 'sa-blocked',   'sa-other', 'sa-user', 'sa-q', 'bulk-upload', 'blocked',    'quarantine', null,     9, 0, 90, 0,  null,                            now() - interval '3 hours');
        ANALYZE project_runs;
      `);

      const snapshot = await queryWorkerScalerSnapshot(sql as unknown as ScalerSql, PARAMS);
      expect(snapshot).toMatchObject({
        queue_depth: 1,
        queued_documents: 2,
        queued_pages: 30,
        processing_runs: 2,
        processing_documents: 4,
        processing_pages: 80,
        stale_leases: 1,
        worker_active: 1,
        pending_page_tasks: 0,
      });
      expect(snapshot).not.toHaveProperty("pages_processed_total");
      expect(Math.round(Number(snapshot.oldest_queued_run_age_seconds))).toBeGreaterThanOrEqual(89);
      expect(Math.round(Number(snapshot.oldest_queued_run_age_seconds))).toBeLessThan(600);
      const orgDemand = (typeof snapshot.org_demand === "string" ? JSON.parse(snapshot.org_demand) : snapshot.org_demand) as
        Array<{ org_key: string; demand: number }>;
      expect(Object.fromEntries(orgDemand.map((row) => [row.org_key, row.demand]))).toEqual({ "sa-org": 2 });

      // The plan reads project_runs only through indexes: no scan of the finished history.
      const captured = captureSql();
      await queryWorkerScalerSnapshot(captured.sql, PARAMS);
      const explain = async (statement: string, values: unknown[] = []) =>
        (await sql.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${statement}`, values as never[])).map((row) => row["QUERY PLAN"]).join("\n");
      const snapshotPlan = await explain(captured.text(), captured.values());
      // The planner may pick any active-status index (this one or the (status, lease) index); never the heap.
      expect(snapshotPlan).not.toMatch(/Seq Scan on project_runs/);
      expect(snapshotPlan).toMatch(/Index (Only )?Scan (using|on) project_runs_\w+/);

      // One organization's active runs: a range read of the index, covering the counters an activity summary reads.
      const orgPlan = await explain(`
        SELECT id, project_id, status, total_documents, processed_documents, pages_total, pages_processed,
          created_at, worker_started_at, updated_at
        FROM project_runs WHERE org_id = $1 AND status IN ('queued', 'processing')`, ["sa-org"]);
      expect(orgPlan).toMatch(/Index (Only )?Scan using project_runs_org_active_idx/);
      expect(orgPlan).not.toMatch(/Seq Scan on project_runs/);
    } finally {
      await sql.end();
      await pg?.stop();
    }
  }, 300_000);
});
