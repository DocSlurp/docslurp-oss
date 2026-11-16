import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, defaultPipelineFeatures, TEST_PAGE_CREDITS } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { pinRunPageBillingRules, recordPageBaseFee } from "../db/page-base-fee.js";
import { Store } from "../db/store.js";
import { persistRunUsageEvents } from "../db/usage-event-store.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/*
 * Page read charges settle in the database (migration 0185): OCR and Rich reads of one page recorded by different
 * activities (separate ledgers, as every stage activity and every restart builds a fresh one), and across the deploy,
 * charge the page once in its dearest class. A worker from before the OCR class cannot settle a run that has OCR charges.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
const t = TEST_PAGE_CREDITS;
const pipeline = JSON.stringify({ ...defaultPipelineFeatures, quality: "auto" });

beforeAll(async () => {
  db = await createMigratedDatabase();
  const runs = ["r-ab", "r-ba", "r-old", "r-fast", "r-plain"];
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000);
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total) values
      ${runs.map((id) => `('${id}', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'embed', '${pipeline}', 1, 3)`).join(",")};
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source) values
      ${runs.map((id) => `('d-${id}', 'o1', 'u1', 'w', '${id}', 'scan.pdf', 'application/pdf', 'raw/${id}', 'completed', 3, 'counted')`).join(",")};
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

const sql = () => (store as unknown as { sql: Parameters<typeof persistRunUsageEvents>[0]["client"] }).sql;

/** One activity: a fresh state and ledger for the run, its reads, then its checkpoint (written twice: a retry). */
async function activity(runId: string, reads: (state: WorkflowState) => void): Promise<void> {
  const state = WorkflowState.create(await store.loadRun(runId), []);
  reads(state);
  const batch = state.usageLedger.checkpoint();
  await persistRunUsageEvents({ client: sql(), state, usageEvents: batch.events });
  await persistRunUsageEvents({ client: sql(), state, usageEvents: batch.events });
  batch.commit();
}

const ocr = (documentId: string, pageNumber: number) => (state: WorkflowState) =>
  state.usageLedger.chargeOcrPage({ documentId, pageNumber, readBy: "page-ocr" });
const vision = (documentId: string, pageNumber: number) => (state: WorkflowState) => state.usageLedger.record({
  provider: "openrouter", model: "vision", metric: "page-analysis", inputTokens: 100, outputTokens: 100, costCents: 0,
  metadata: { documentId, pageNumber } });

async function pageCharges(runId: string) {
  const { rows } = await db.query<{ id: string; metric: string; cost: number; upgrade_of: string | null }>(
    `select id, metric, cost_cents::float8 as cost, metadata ->> 'upgradeOf' as upgrade_of from usage_events
     where run_id = $1 and metric like 'ingest-page-%' order by id`, [runId]);
  return rows;
}
const spent = async (runId: string) =>
  Number((await db.query<{ s: string }>(`select spent_cents::text as s from project_runs where id = $1`, [runId])).rows[0]!.s);

describe("page read charges settle across activities", () => {
  it("OCR in one activity, vision in a later one: the Rich charge is the Rich price minus the OCR charge, once", async () => {
    await activity("r-ab", ocr("d-r-ab", 1));
    await activity("r-ab", vision("d-r-ab", 1));
    // A retried vision activity (a fresh ledger again) changes nothing.
    await activity("r-ab", vision("d-r-ab", 1));
    expect(await pageCharges("r-ab")).toEqual([
      { id: "ocr:r-ab:d-r-ab:1", metric: BILLABLE_UNIT_METRICS.ocrPage, cost: t.ocr, upgrade_of: null },
      { id: "rich:r-ab:d-r-ab:1", metric: BILLABLE_UNIT_METRICS.richPage, cost: expect.closeTo(t.rich - t.ocr, 9), upgrade_of: "ocr:r-ab:d-r-ab:1" },
    ]);
    expect(await spent("r-ab")).toBeCloseTo(t.rich, 9);
  });

  it("vision in one activity, OCR in a later one: no OCR charge", async () => {
    await activity("r-ba", vision("d-r-ba", 1));
    await activity("r-ba", ocr("d-r-ba", 1));
    await activity("r-ba", ocr("d-r-ba", 1));
    expect((await pageCharges("r-ba")).map((row) => [row.id, row.cost])).toEqual([["rich:r-ba:d-r-ba:1", t.rich]]);
    expect(await spent("r-ba")).toBeCloseTo(t.rich, 9);
    // Completion: page 1 is Rich, pages 2 and 3 Fast.
    const state = WorkflowState.create(await store.loadRun("r-ba"), []);
    pinRunPageBillingRules(state);
    expect(await recordPageBaseFee(sql(), state)).toMatchObject({ fastPages: 2, ocrPages: 0, richPages: 1 });
  });

  it("a Rich charge from before the deploy (old id, no OCR class) covers a later OCR read of the page", async () => {
    await db.exec(`insert into usage_events (id, user_id, run_id, org_id, project_id, provider, model, metric, amount, unit, cost_cents, metadata)
      values ('rich:r-old:d-r-old:2', 'u1', 'r-old', 'o1', 'w', 'docslurp', 'price-card', 'ingest-page-rich', 1, 'page', ${t.rich},
        '{"billable": true, "unitCharge": true, "documentId": "d-r-old", "pageNumber": 2, "readBy": "page-ocr"}')`);
    await activity("r-old", ocr("d-r-old", 2));
    expect((await pageCharges("r-old")).map((row) => row.id)).toEqual(["rich:r-old:d-r-old:2"]);
    // A page of the same document no Rich read covers still charges OCR; another run's charges are never consulted.
    await activity("r-old", ocr("d-r-old", 3));
    await activity("r-plain", ocr("d-r-old", 2));
    expect((await pageCharges("r-old")).map((row) => row.id)).toEqual(["ocr:r-old:d-r-old:3", "rich:r-old:d-r-old:2"]);
    expect((await pageCharges("r-plain")).map((row) => row.id)).toEqual(["ocr:r-plain:d-r-old:2"]);
  });

  it("refuses a Fast charge from a worker that predates the OCR class for a run with OCR charges", async () => {
    await activity("r-fast", ocr("d-r-fast", 1));
    const old = (runId: string, id: string) => db.query(`insert into usage_events (id, user_id, run_id, org_id, project_id, provider, model, metric, amount, unit, cost_cents, metadata)
      values ($1, 'u1', $2, 'o1', 'w', 'docslurp', 'price-card', 'ingest-page-fast', 3, 'page', 0.015, '{"billable": true, "unitCharge": true}')`, [id, runId]);
    await expect(old("r-fast", "fast:r-fast")).rejects.toThrow(/predates it/);
    // The current worker's completion charge carries its rules version and is accepted: page 1 OCR, pages 2-3 Fast.
    const state = WorkflowState.create(await store.loadRun("r-fast"), []);
    pinRunPageBillingRules(state);
    expect(await recordPageBaseFee(sql(), state)).toMatchObject({ fastPages: 2, ocrPages: 1, richPages: 0 });
    // A run without OCR charges is unaffected: an old worker may still settle it.
    await db.exec(`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('r-legacy', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'embed', '${pipeline}', 0, 0)`);
    await expect(old("r-legacy", "fast:r-legacy")).resolves.toBeDefined();
  });
});
