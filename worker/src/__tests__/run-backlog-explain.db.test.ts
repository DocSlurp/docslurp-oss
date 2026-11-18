import postgres from "postgres";
import { expect, it } from "vitest";
import { startMigratedPostgres } from "../test/migrated-postgres.js";
/**
 * The run backlog hint (queuedRunPageTasks) and the compute spend read (computeSpendCents) on seeded tables, with
 * normal planner settings: each is index-served and never scans page_work_tasks, project_runs or usage_events.
 */
it("both reads use indexes, no sequential scan, on seeded tables", async () => {
  const pg = await startMigratedPostgres();
  const sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql.unsafe(`INSERT INTO "user" (id,name,email) VALUES ('u','U','u@example.test');
    INSERT INTO organizations (id,name,slug,created_by_user_id) VALUES ('o','O','o','u');
    INSERT INTO projects (id,org_id,user_id,name) VALUES ('p','o','u','P');
    SET session_replication_role = replica;
    INSERT INTO project_runs (id,org_id,user_id,project_id,kind,status,stage) SELECT 'r'||g,'o','u','p','bulk-upload','completed','completed' FROM generate_series(1,200) g;
    INSERT INTO documents (id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status) SELECT 'd'||g,'o','u','p','r'||g,'a','application/pdf','k','completed' FROM generate_series(1,200) g;
    INSERT INTO page_work_tasks (run_id,document_id,page_number,status) SELECT 'r'||(g%200+1),'d'||(g%200+1),g/200+1, CASE WHEN g%7=0 THEN 'queued' ELSE 'completed' END FROM generate_series(0,199999) g;
    INSERT INTO usage_events (id,user_id,org_id,project_id,run_id,provider,model,metric,amount,unit,cost_cents,created_at)
      SELECT 'e'||g,'u','o','p','r'||(g%200+1), CASE WHEN g%50=0 THEN 'host-x' ELSE 'llm' END, 'm', CASE WHEN g%50=0 THEN 'sandbox_compute' ELSE 'tokens' END, 1,'cent',1, now() - (g||' seconds')::interval FROM generate_series(1,200000) g;
    SET session_replication_role = origin; ANALYZE page_work_tasks; ANALYZE usage_events; ANALYZE project_runs;`);
  const q1 = await sql.unsafe(`explain select count(*)::int from (select 1 from page_work_tasks t where t.run_id='r5' and t.status='queued' and exists (select 1 from project_runs r where r.id='r5' and r.org_id='o') limit 100000) q`);
  const plan1 = q1.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
  expect(plan1).not.toMatch(/Seq Scan/);
  expect(plan1).toMatch(/Index (Only )?Scan using page_work_tasks_(status_run|pending)_idx on page_work_tasks/);
  expect(plan1).toMatch(/Index (Only )?Scan using \w+ on project_runs/);
  const q2 = await sql.unsafe(`explain select coalesce(sum(greatest(cost_cents,0)),0) from usage_attribution where metric='sandbox_compute' and provider='host-x' and model='m' and created_at > now() - interval '1 hour'`);
  const plan2 = q2.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
  expect(plan2).not.toMatch(/Seq Scan/);
  expect(plan2).toMatch(/Index Scan using usage_events_sandbox_compute_created_idx on usage_events/);
  await sql.end(); await pg.stop();
}, 300_000);
