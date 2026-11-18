import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Every query the activity summary, upload-session progress and the reconciler's due-session sweep run is an
 * index read, never a scan of run or session history: seeded with many finished runs and confirmed sessions, the
 * plan of each captured statement has no Seq Scan on project_runs, project_corpus_stats or upload_sessions.
 */
const external = process.env.TEST_DATABASE_URL;
const FINISHED_RUNS = external ? 1_000_000 : 100_000;
const OLD_SESSIONS = external ? 200_000 : 50_000;

let real: postgres.Sql;
let stop: (() => Promise<void>) | undefined;
const captured: Array<{ strings: TemplateStringsArray; values: unknown[] }> = [];

/** The service's sql, recording each statement before running it. */
function recordingSql(sql: postgres.Sql) {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.push({ strings, values });
    return sql(strings, ...(values as never[]));
  };
  return Object.assign(tag, { array: sql.array.bind(sql), json: sql.json.bind(sql), unsafe: sql.unsafe.bind(sql), begin: sql.begin.bind(sql) });
}

/** EXPLAIN a captured statement; fragments (nested sql``) are not used by these services' reads. */
async function plan(entry: { strings: TemplateStringsArray; values: unknown[] }): Promise<string> {
  const text = entry.strings.reduce((out, part, index) => `${out}$${index}${part}`);
  const values = entry.values.map(value => (value && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value));
  const rows = await real.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${text}`, values as never[]);
  return rows.map(row => row["QUERY PLAN"]).join("\n");
}

function statementsMatching(fragment: string) {
  return captured.filter(entry => entry.strings.join("?").includes(fragment));
}

beforeAll(async () => {
  const pg = external ? null : await startMigratedPostgres();
  stop = pg?.stop;
  real = postgres(external ?? pg!.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql: recordingSql(real) }));
  await real.unsafe(`
    INSERT INTO "user" (id,name,email) VALUES ('pl-user','P','pl@example.test');
    INSERT INTO organizations (id,name,slug,created_by_user_id,personal_owner_user_id) VALUES ('pl-org','A','pl-org','pl-user','pl-user'), ('pl-other','B','pl-other','pl-user',null);
    INSERT INTO org_memberships (org_id,user_id,role) VALUES ('pl-org','pl-user','owner');
    INSERT INTO projects (id,org_id,user_id,name) VALUES ('pl-p','pl-org','pl-user','P'), ('pl-q','pl-other','pl-user','Q');
    SET session_replication_role = replica;
    INSERT INTO project_runs (id, org_id, user_id, project_id, kind, status, stage, total_documents, processed_documents,
      pages_total, pages_processed, created_at, updated_at)
    SELECT 'pl-done-' || g, CASE WHEN g % 2 = 0 THEN 'pl-org' ELSE 'pl-other' END, 'pl-user',
      CASE WHEN g % 2 = 0 THEN 'pl-p' ELSE 'pl-q' END, 'direct-upload', CASE WHEN g % 10 = 0 THEN 'failed' ELSE 'completed' END,
      'completed', 3, 3, 40, 40, now() - (g * 30 || ' seconds')::interval, now() - (g * 30 || ' seconds')::interval
    FROM generate_series(1, ${FINISHED_RUNS}) g;
    INSERT INTO upload_sessions (id, user_id, org_id, status, next_reconcile_at, expires_at, created_at)
    SELECT 'pl-sess-' || g, 'pl-user', 'pl-org', 'confirmed', now() - interval '30 days', now() - interval '29 days', now() - interval '30 days'
    FROM generate_series(1, ${OLD_SESSIONS}) g;
    INSERT INTO projects (id, org_id, user_id, name, slug) SELECT 'pl-many-' || g, 'pl-other', 'pl-user', 'M' || g, 'pl-many-' || g FROM generate_series(1, 20000) g;
    INSERT INTO project_corpus_stats (project_id, completed_run_pages_processed, completed_run_runtime_ms)
      SELECT 'pl-many-' || g, 100, 60000 FROM generate_series(1, 20000) g ON CONFLICT (project_id) DO NOTHING;
    SET session_replication_role = origin;
    INSERT INTO project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, total_documents,
      processed_documents, pages_total, pages_processed, worker_started_at, created_at) VALUES
      (1, 'pl-sess-1', 'pl-org', 'pl-user', 'pl-p', 'direct-upload', 'processing', 'extract', 4, 1, 80, 20, now() - interval '5 minutes', now() - interval '6 minutes'),
      (1, 'pl-queued', 'pl-org', 'pl-user', 'pl-p', 'direct-upload', 'queued', 'quarantine', 2, 0, 30, 0, null, now() - interval '1 minute');
    INSERT INTO project_corpus_stats (project_id, completed_run_pages_processed, completed_run_runtime_ms) VALUES ('pl-p', 6000, 3600000)
      ON CONFLICT (project_id) DO UPDATE SET completed_run_pages_processed = 6000, completed_run_runtime_ms = 3600000;
    ANALYZE project_runs; ANALYZE upload_sessions; ANALYZE project_corpus_stats;
  `);
}, 600_000);

afterAll(async () => {
  await real?.end();
  await stop?.();
});

describe("activity summary, upload progress and reconciler reads use indexes", () => {
  it("summary: active runs, recently completed and project history", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const summary = await import("../services/run-activity-summary.js");
    captured.length = 0;
    const result = await summary.computeOrgActivitySummary({ orgId: "pl-org", projectIds: ["pl-p"] });
    expect(result.inProgress.runs).toBe(1);
    expect(result.queued.runs).toBe(1);

    const active = await plan(statementsMatching("status in ('queued', 'processing')")[0]!);
    expect(active).toMatch(/Index (Only )?Scan using project_runs_org_active_idx/);
    expect(active).not.toMatch(/Seq Scan/);

    // Bounded by organization, project and a one-day creation window; any of those indexes serves it.
    const recent = await plan(statementsMatching("status = 'completed'")[0]!);
    expect(recent).toMatch(/Index (Only )?Scan (using|on) \w*runs_\w+/);
    expect(recent).not.toMatch(/Seq Scan on project_runs/);

    const history = await plan(statementsMatching("from project_corpus_stats")[0]!);
    expect(history).not.toMatch(/Seq Scan on project_corpus_stats/);

    const org = await summary.activitySummaryOrgIdForUser("pl-user");
    expect(org).toBe("pl-org");
    const orgPlan = await plan(statementsMatching("from organizations o")[0]!);
    expect(orgPlan).not.toMatch(/Seq Scan on org_memberships/);
  }, 120_000);

  it("upload-session progress reads its own run by primary key", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sessions = await import("../services/direct-upload-session.js");
    captured.length = 0;
    const progress = await sessions.directUploadSessionProgress({
      session: { id: "pl-sess-1", user_id: "pl-user", org_id: "pl-org", status: "confirmed", project_id: "pl-p", project_name: null, template_key: null, pipeline: null },
      files: [],
    });
    expect(progress.run?.id).toBe("pl-sess-1");
    const progressPlan = await plan(statementsMatching("from project_runs r")[0]!);
    expect(progressPlan).toMatch(/Index (Only )?Scan using project_runs_pkey/);
    expect(progressPlan).not.toMatch(/Seq Scan/);
  }, 120_000);

  it("the due-session sweep reads two index ranges, never every session", async () => {
    const { reconcileDirectUploads } = await import("../services/direct-upload-reconciler.js");
    captured.length = 0;
    await reconcileDirectUploads();
    const sweep = await plan(statementsMatching("from upload_sessions")[0]!);
    expect(sweep).toMatch(/upload_sessions_reconcile_idx/);
    expect(sweep).toMatch(/upload_sessions_initializing_expiry_idx/);
    expect(sweep).not.toMatch(/Seq Scan on upload_sessions/);
  }, 120_000);
});
