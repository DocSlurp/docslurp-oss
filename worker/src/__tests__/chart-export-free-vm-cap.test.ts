import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { chartExportFreeVmCap } from "../db/chart-export-free-vm-cap.js";
import { Store } from "../db/store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Council M1: free-tier chart-export VM runs are unbilled, so each organization may start at most N per clock hour,
 * across every worker. A document's answer is stored once (retries and restarts reuse it), and one tenant can never
 * spend or read another tenant's cap.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let port: number;
const stores: Store[] = [];
const DOCUMENTS = 10;

function worker(): Store {
  const store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  stores.push(store);
  return store;
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  const documents = (org: string, run: string, project: string) => Array.from({ length: DOCUMENTS }, (_, index) =>
    `('${run}-d${index}', '${org}', 'u1', '${project}', '${run}', 'd${index}.json', 'application/json', 'raw/${run}/d${index}', 'processing', 1)`).join(",");
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000), ('o2', 'Other', 'other', 'u1', 8, 100000);
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W1'), ('w2', 'o2', 'u1', 'W2');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('r1', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'vision-extract', '{}', ${DOCUMENTS}, ${DOCUMENTS}),
             ('r2', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'vision-extract', '{}', ${DOCUMENTS}, ${DOCUMENTS});
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values ${documents("o1", "r1", "w1")}, ${documents("o2", "r2", "w2")};
  `);
  const served = await serveOnRandomPort(db, { maxConnections: 8 });
  server = served.server;
  port = served.port;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  for (const store of stores) await store.close();
  await server?.stop();
  await db?.close();
});

describe("per-org hourly cap on free chart-export VM runs (Postgres, shared by workers)", () => {
  it("never grants more than the cap in one org-hour across concurrent workers; other orgs are unaffected", { timeout: 60_000 }, async () => {
    const workers = [worker(), worker(), worker()];
    const grants = await Promise.all(Array.from({ length: DOCUMENTS }, (_, index) =>
      workers[index % workers.length]!.reserveChartExportFreeVmRun({ orgId: "o1", runId: "r1", documentId: `r1-d${index}`, perHour: 4 })));
    expect(grants.filter(Boolean)).toHaveLength(4);
    // A retry gets the same answer back without spending the cap again.
    for (let index = 0; index < DOCUMENTS; index += 1) {
      expect(await workers[0]!.reserveChartExportFreeVmRun({ orgId: "o1", runId: "r1", documentId: `r1-d${index}`, perHour: 4 })).toBe(grants[index]);
    }
    const [hour] = await db.query<{ used: number }>(`select used from chart_export_free_vm_hours where org_id = 'o1'`).then((r) => r.rows);
    expect(Number(hour!.used)).toBe(4);
    // Another tenant has its own cap.
    expect(await workers[1]!.reserveChartExportFreeVmRun({ orgId: "o2", runId: "r2", documentId: "r2-d0", perHour: 4 })).toBe(true);
  });

  it("refuses a document that is not the run's, or a run claimed under another org, and reserves nothing", async () => {
    const store = worker();
    await expect(store.reserveChartExportFreeVmRun({ orgId: "o1", runId: "r1", documentId: "r2-d1", perHour: 100 })).rejects.toThrow(/does not belong/);
    await expect(store.reserveChartExportFreeVmRun({ orgId: "o2", runId: "r1", documentId: "r1-d1", perHour: 100 })).rejects.toThrow(/does not belong/);
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from chart_export_free_vm_grants where document_id = 'r2-d1'`);
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("a cap of 0 stops free VM runs; the env value is parsed strictly", async () => {
    expect(await worker().reserveChartExportFreeVmRun({ orgId: "o2", runId: "r2", documentId: "r2-d9", perHour: 0 })).toBe(false);
    expect(chartExportFreeVmCap({})).toBe(200);
    expect(chartExportFreeVmCap({ DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR: "0" })).toBe(0);
    expect(chartExportFreeVmCap({ DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR: "-5" })).toBe(200);
    expect(chartExportFreeVmCap({ DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR: "lots" })).toBe(200);
  });
});
