import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMigratedPostgres } from "../test/migrated-postgres.js";
import { queuedRunPageTasks } from "../db/page-task-store.js";
import { computeSpendCents } from "../db/compute-fleet-store.js";

let sql: ReturnType<typeof postgres>, stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startMigratedPostgres();
  stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user" (id, name, email) values ('u1', 'U', 'u1@example.com')`;
  for (const org of ["org-a", "org-b"]) {
    await sql`insert into organizations (id, name, slug, created_by_user_id) values (${org}, ${org}, ${org}, 'u1')`;
    await sql`insert into projects (id, org_id, user_id, name) values (${`p-${org}`}, ${org}, 'u1', 'P')`;
    await sql`insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline)
      values (100, ${`run-${org}`}, ${org}, 'u1', ${`p-${org}`}, 'bulk-upload', 'processing', 'vision-extract', '{}')`;
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status)
      values (${`doc-${org}`}, ${org}, 'u1', ${`p-${org}`}, ${`run-${org}`}, 'a.pdf', 'application/pdf', 'k', 'processing')`;
  }
  const tasks = (org: string, statuses: string[]) => statuses.map((status, i) => ({ run_id: `run-${org}`, document_id: `doc-${org}`, page_number: i + 1, status }));
  await sql`insert into page_work_tasks ${sql([...tasks("org-a", ["queued", "queued", "queued", "processing", "completed"]), ...tasks("org-b", ["queued"])], "run_id", "document_id", "page_number", "status")}`;
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

describe("run backlog store", () => {
  it("counts only the run's queued page tasks", async () => {
    expect(await queuedRunPageTasks(sql, { orgId: "org-a", runId: "run-org-a" })).toBe(3);
    expect(await queuedRunPageTasks(sql, { orgId: "org-b", runId: "run-org-b" })).toBe(1);
  });

  it("reads 0 for a run of another organization or an unknown run", async () => {
    expect(await queuedRunPageTasks(sql, { orgId: "org-b", runId: "run-org-a" })).toBe(0);
    expect(await queuedRunPageTasks(sql, { orgId: "org-a", runId: "missing" })).toBe(0);
  });

  it("refuses an empty or oversized scope", async () => {
    await expect(queuedRunPageTasks(sql, { orgId: "", runId: "run-org-a" })).rejects.toThrow("Invalid run backlog scope");
    await expect(queuedRunPageTasks(sql, { orgId: "org-a", runId: "x".repeat(201) })).rejects.toThrow("Invalid run backlog scope");
  });

  it("is served by the (run_id, status) index", async () => {
    await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const plan = await tx.unsafe(`explain select 1 from page_work_tasks t where t.run_id = 'run-org-a' and t.status = 'queued'`);
      expect(JSON.stringify(plan)).toMatch(/page_work_tasks_(pending|status_run)_idx|page_work_tasks_pkey/);
    });
  });
});

describe("compute spend", () => {
  beforeAll(async () => {
    const event = (org: string, provider: string, model: string, metric: string, cents: number, ageSeconds: number) =>
      sql`insert into usage_events (id, user_id, org_id, project_id, run_id, provider, model, metric, amount, unit, cost_cents, created_at)
        values (gen_random_uuid()::text, 'u1', ${org}, ${`p-${org}`}, ${`run-${org}`}, ${provider}, ${model}, ${metric}, ${cents}, 'cent', ${cents},
          now() - (${ageSeconds} * interval '1 second'))`;
    await event("org-a", "host-x", "reader-1", "sandbox_compute", 10, 60);
    await event("org-b", "host-x", "reader-1", "sandbox_compute", 5.5, 1800);
    await event("org-a", "host-x", "reader-1", "sandbox_compute", 100, 7200);
    await event("org-a", "host-x", "reader-2", "sandbox_compute", 40, 60);
    await event("org-a", "host-y", "reader-1", "sandbox_compute", 40, 60);
    await event("org-a", "host-x", "reader-1", "pages", 40, 60);
  });

  it("sums one provider and model's sandbox compute across organizations within the window", async () => {
    expect(await computeSpendCents(sql, { provider: "host-x", model: "reader-1", sinceSeconds: 3600 })).toBeCloseTo(15.5);
    expect(await computeSpendCents(sql, { provider: "host-x", model: "reader-1", sinceSeconds: 600 })).toBeCloseTo(10);
    expect(await computeSpendCents(sql, { provider: "host-z", model: "reader-1", sinceSeconds: 3600 })).toBe(0);
  });

  it("refuses an invalid query", async () => {
    for (const query of [{ provider: "", model: "m", sinceSeconds: 60 }, { provider: "p'; drop", model: "m", sinceSeconds: 60 },
      { provider: "p", model: "m", sinceSeconds: 0 }, { provider: "p", model: "m", sinceSeconds: 86_401 }, { provider: "p", model: "m", sinceSeconds: 1.5 }]) {
      await expect(computeSpendCents(sql, query)).rejects.toThrow("Invalid compute spend query");
    }
  });

  it("is served by the sandbox compute partial index", async () => {
    await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const plan = await tx.unsafe(`explain select coalesce(sum(cost_cents), 0) from usage_attribution
        where metric = 'sandbox_compute' and provider = 'host-x' and model = 'reader-1' and created_at > now() - interval '1 hour'`);
      expect(JSON.stringify(plan)).toContain("usage_events_sandbox_compute_created_idx");
    });
  });
});
