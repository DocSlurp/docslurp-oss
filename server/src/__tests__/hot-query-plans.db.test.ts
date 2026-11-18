import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * 0198: queries that run on every scrape, alert tick, run creation, document delete or budgeted spend check read the
 * large tables (project_runs, usage_events, performance_log, page_work_tasks, project_run_events) through indexes,
 * never a sequential scan of their history. The real functions run against a seeded database; each statement they
 * send is captured (postgres.js `debug`) and EXPLAINed with its parameters.
 */
// A real Postgres (TEST_DATABASE_URL, scripts/run-database-tests.mjs) gets a larger history; the in-memory PGlite
// fallback a smaller one that still makes a full scan the expensive plan.
const external = process.env.TEST_DATABASE_URL;
const RUNS = external ? 400_000 : 40_000;
const EVENTS = external ? 800_000 : 80_000;
const BIG = /Seq Scan on (project_runs|usage_events|performance_log|page_work_tasks|project_run_events|documents)\b/;

let sql: postgres.Sql;
let captured: Array<{ text: string; params: unknown[] }> = [];
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const pg = external ? null : await startMigratedPostgres();
  stop = pg?.stop;
  const url = external ?? pg!.url;
  // One connection (the PGlite fallback serves one); every statement it sends is recorded.
  sql = postgres(url, {
    max: 1, prepare: false, onnotice: () => {},
    debug: (_connection, text, params) => { captured.push({ text, params: params as unknown[] }); },
  });
  vi.doMock("../db.js", () => ({ sql }));

  await sql.unsafe(`
    INSERT INTO "user" (id,name,email) VALUES ('hq-user','H','hq@example.test');
    INSERT INTO organizations (id,name,slug,created_by_user_id) SELECT 'hq-o' || g, 'O', 'hq-o' || g, 'hq-user' FROM generate_series(0, 199) g;
    INSERT INTO projects (id,org_id,user_id,name,slug) SELECT 'hq-p' || g, 'hq-o' || (g % 200), 'hq-user', 'P', 'hq-p' || g FROM generate_series(0, 999) g;
  `);
  // History bulk loaded without row triggers (realtime revisions, spend, capacity) to keep the seed fast; rows arrive
  // in created_at order, as in production.
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO project_runs (id, org_id, user_id, project_id, kind, status, stage, created_at, updated_at)
    SELECT 'hq-r' || g, 'hq-o' || (g % 200), 'hq-user', 'hq-p' || (g % 1000), 'bulk-upload',
      CASE WHEN g % 10 = 0 THEN 'failed' ELSE 'completed' END, 'completed',
      now() - ((${RUNS} - g) * 20 || ' seconds')::interval, now() - ((${RUNS} - g) * 20 || ' seconds')::interval
    FROM generate_series(1, ${RUNS}) g;
    INSERT INTO project_runs (id, org_id, user_id, project_id, kind, status, stage, monthly_reservation_cents, lease_expires_at, created_at)
    SELECT 'hq-live' || g, 'hq-o' || (g % 5), 'hq-user', 'hq-p' || (g % 5), 'bulk-upload',
      CASE WHEN g % 2 = 0 THEN 'queued' ELSE 'processing' END, 'extract', 100, now() + interval '1 minute', now() - (g || ' minutes')::interval
    FROM generate_series(1, 20) g;
    INSERT INTO documents (id, user_id, org_id, project_id, run_id, filename, mime_type, source_key, status, created_at)
    SELECT 'hq-d' || g, 'hq-user', 'hq-o' || (g % 200), 'hq-p' || (g % 1000), 'hq-r' || g, 'f.pdf', 'application/pdf', 'k/' || g, 'completed',
      now() - ((${RUNS} - g) * 20 || ' seconds')::interval
    FROM generate_series(1, ${RUNS}) g;
    INSERT INTO page_work_tasks (run_id, document_id, page_number, status)
    SELECT 'hq-r' || g, 'hq-d' || g, 1, 'completed' FROM generate_series(1, ${RUNS}) g;
    INSERT INTO project_run_events (id, user_id, run_id, document_id, event_type, created_at)
    SELECT 'hq-e' || g, 'hq-user', 'hq-r' || (g / 2 + 1), 'hq-d' || (g / 2 + 1), 'progress', now() - ((${EVENTS} - g) * 10 || ' seconds')::interval
    FROM generate_series(1, ${EVENTS}) g;
    INSERT INTO usage_events (id, user_id, org_id, project_id, run_id, document_id, provider, model, metric, amount, unit, cost_cents, metadata, created_at)
    SELECT 'hq-u' || g, 'hq-user', 'hq-o' || (g % 200),
      CASE WHEN g % 50 = 7 THEN NULL ELSE 'hq-p' || (g % 1000) END,
      CASE WHEN g % 3 = 0 THEN NULL ELSE 'hq-r' || (g / 2 + 1) END,
      CASE WHEN g % 3 = 1 THEN 'hq-d' || (g / 2 + 1) END,
      (ARRAY['a','b','c'])[g % 3 + 1], 'm' || (g % 5), 'embedding', 1, 'tokens', 0.5,
      CASE WHEN g % 50 = 7 THEN jsonb_build_object('projectIds', jsonb_build_array('hq-p1','hq-p2'))
        WHEN g % 3 = 0 THEN '{}'::jsonb ELSE jsonb_build_object('runId', 'hq-r' || (g / 2 + 1)) END,
      now() - ((${EVENTS} - g) * 15 || ' seconds')::interval
    FROM generate_series(1, ${EVENTS}) g;
    INSERT INTO performance_log (id, user_id, scope, stage_name, metric, value, unit, created_at)
    SELECT 'hq-pl' || g, 'hq-user', 'stage', (ARRAY['extract-markdown','index'])[g % 2 + 1],
      CASE WHEN g % 2 = 0 THEN 'stage-duration' ELSE 'rss' END, g % 5000, CASE WHEN g % 2 = 0 THEN 'ms' ELSE 'MiB' END,
      now() - ((${EVENTS} - g) * 15 || ' seconds')::interval
    FROM generate_series(1, ${EVENTS}) g;
    SET session_replication_role = origin;
    UPDATE organizations SET monthly_budget_cents = 100000 WHERE id = 'hq-o1';
    UPDATE projects SET monthly_budget_cents = 50000 WHERE id = 'hq-p1';
    ANALYZE;
  `);
}, 600_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

async function plan(text: string, params: unknown[]): Promise<string> {
  const rows = await sql.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${text}`, params as never[]);
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/** Runs `work`, then EXPLAINs every SELECT it sent. */
async function plansOf(work: () => Promise<unknown>): Promise<Array<{ text: string; plan: string }>> {
  captured = [];
  await work();
  const selects = [...captured].filter((query) => /^\s*(select|with)\b/i.test(query.text));
  const plans: Array<{ text: string; plan: string }> = [];
  for (const query of selects) plans.push({ text: query.text, plan: await plan(query.text, query.params) });
  return plans;
}

function expectNoBigSeqScan(plans: Array<{ text: string; plan: string }>): void {
  for (const { text, plan } of plans) {
    expect(plan, `${text.replace(/\s+/g, " ").slice(0, 160)}\n${plan}`).not.toMatch(BIG);
  }
}

describe("hot query plans (0198)", () => {
  it("/metrics reads active runs, recent stage timings and recent cost through indexes", async () => {
    const { buildPrometheusPayload } = await import("../routes/health.js");
    const plans = await plansOf(() => buildPrometheusPayload());
    expect(plans.some(({ text }) => /from project_runs/.test(text))).toBe(true);
    expect(plans.some(({ text }) => /from performance_log/.test(text))).toBe(true);
    expect(plans.some(({ text }) => /from usage_attribution/.test(text))).toBe(true);
    expectNoBigSeqScan(plans);
  }, 120_000);

  it("the alert evaluator's queue snapshot reads only active runs", async () => {
    const { readQueueSnapshot } = await import("../services/alerts/alert-evaluator.js");
    const plans = await plansOf(() => readQueueSnapshot());
    expect(plans.some(({ text }) => /from project_runs/.test(text))).toBe(true);
    expectNoBigSeqScan(plans);
  }, 120_000);

  it("a budgeted spend check reads the month of one org and project through the stamped prefilters", async () => {
    const { loadSpendStatus } = await import("../services/billing/spend-guard.js");
    const plans = await plansOf(() => loadSpendStatus("hq-o1", "hq-p1"));
    expect(plans.some(({ text }) => /usage_attribution/.test(text))).toBe(true);
    expectNoBigSeqScan(plans);
  }, 120_000);

  it("run-keyed and document-keyed usage reads, and foreign-key checks of a document delete, use indexes", async () => {
    const statements: Array<[string, unknown[]]> = [
      // pending_monthly_capacity, run readmission, run cost panels (source_run_id = coalesce(run_id, metadata->>'runId')).
      ["select coalesce(sum(cost_cents), 0) from usage_attribution where source_run_id = $1", ["hq-r77"]],
      ["select coalesce(sum(cents), 0) from pending_monthly_capacity where org_id = $1", ["hq-o1"]],
      // What the foreign keys to documents run per deleted document.
      ["select 1 from usage_events where document_id = $1", ["hq-d77"]],
      ["select 1 from project_run_events where document_id = $1", ["hq-d77"]],
      ["select 1 from page_work_tasks where document_id = $1", ["hq-d77"]],
      // Provider cost loss and the budget sweep: a window across every organization.
      ["select count(*) from usage_attribution where created_at >= now() - interval '7 hours'", []],
      ["delete from performance_log where created_at < now() - interval '1000 days'", []],
    ];
    for (const [text, params] of statements) {
      const explained = await plan(text, params);
      expect(explained, `${text}\n${explained}`).not.toMatch(BIG);
      expect(explained, `${text}\n${explained}`).toMatch(/Index|Bitmap/);
    }
    // Per-page and per-stage tables (unseeded here): their document foreign key leads an index, so the check a document
    // delete runs is an index probe at any size.
    const unindexed = await sql<{ child: string }[]>`
      select c.conrelid::regclass::text as child
      from pg_constraint c
      where c.contype = 'f' and c.confrelid = 'documents'::regclass and array_length(c.conkey, 1) = 1
        and c.conrelid::regclass::text in ('usage_events', 'project_run_events', 'page_work_tasks', 'page_stage_states',
          'document_run_stage_states', 'document_summaries')
        and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])`;
    expect(unindexed).toEqual([]);
  }, 120_000);

  it("run admission skips the monthly sums without a cap and still refuses a run over one", async () => {
    // No cap on hq-o3 or hq-p3: the insert is admitted.
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, monthly_reservation_cents)
      values ('hq-new', 'hq-o3', 'hq-user', 'hq-p3', 'bulk-upload', 'queued', 'quarantine', 100)`;
    // hq-o1 has a 100000 cent cap; a reservation above it is refused with the organization error.
    await expect(sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, monthly_reservation_cents)
      values ('hq-over', 'hq-o1', 'hq-user', 'hq-p201', 'bulk-upload', 'queued', 'quarantine', 200000)`)
      .rejects.toMatchObject({ code: "P4021" });
    // hq-p1 has a 50000 cent cap under the same org: the project error.
    await expect(sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, monthly_reservation_cents)
      values ('hq-over-p', 'hq-o1', 'hq-user', 'hq-p1', 'bulk-upload', 'queued', 'quarantine', 60000)`)
      .rejects.toMatchObject({ code: "P4022" });
    // A bad reservation is still refused before anything else.
    await expect(sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, monthly_reservation_cents)
      values ('hq-zero', 'hq-o3', 'hq-user', 'hq-p3', 'bulk-upload', 'queued', 'quarantine', 0)`)
      .rejects.toThrow(/Invalid monthly capacity/);
  }, 120_000);
});
