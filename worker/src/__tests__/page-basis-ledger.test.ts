import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSpendCheckConfig, SpendCheckUnavailableError } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { extraCreditsForMeasuredPages } from "../lib/office-page-count.js";
import { PageBasis, UnfundedPagesError } from "../pipeline/page-basis.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// Spend mechanics below are exact at zero: no running-job overdraft (the default lets running jobs reach -25).
process.env.RUN_CREDIT_OVERDRAFT_CREDITS = "0";

/*
 * The page basis's Postgres adapter (db/page-basis-ledger.ts) against a migrated database: writes scoped to the run's own,
 * non-deduplicated document, the run-wide reads the spend check sums, and the real balance check, through PageBasis as every
 * hydrated WorkflowState uses it (Store.hydrateState binds it).
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pipeline = JSON.stringify({ ...defaultPipelineFeatures });

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'One', 'one', 'u1', 8, 100000), ('o2', 'Low', 'low', 'u1', 8, 3);
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'L');
    insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values (100, 'run1', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 6, 6),
             (100, 'run2', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 1, 1),
             (100, 'run-low', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 2, 2);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, intake_page_count) values
      ('pdf', 'o1', 'u1', 'w1', 'run1', 'a.pdf', 'application/pdf', 'raw/a', 'processing', 3, 'assumed', 3),
      ('docx', 'o1', 'u1', 'w1', 'run1', 'b.docx', '${DOCX}', 'raw/b', 'processing', 1, 'assumed', 1),
      ('tiff', 'o1', 'u1', 'w1', 'run1', 'c.tiff', 'image/tiff', 'raw/c', 'processing', 1, 'assumed', 1),
      ('failed', 'o1', 'u1', 'w1', 'run1', 'd.pdf', 'application/pdf', 'raw/d', 'failed', 1, 'assumed', 1),
      ('other-run', 'o1', 'u1', 'w1', 'run2', 'e.pdf', 'application/pdf', 'raw/e', 'processing', 1, 'assumed', 1),
      ('low-a', 'o2', 'u1', 'w2', 'run-low', 'f.docx', '${DOCX}', 'raw/f', 'processing', 1, 'assumed', 1),
      ('low-b', 'o2', 'u1', 'w2', 'run-low', 'g.docx', '${DOCX}', 'raw/g', 'processing', 1, 'assumed', 1);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, intake_page_count, deduped_from_document_id)
      values ('copy', 'o1', 'u1', 'w1', 'run1', 'a-copy.pdf', 'application/pdf', 'raw/a', 'processing', 3, 'assumed', 3, 'pdf');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 2, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  setSpendCheckConfig(null);
  await store?.close();
  await server?.stop();
  await db?.close();
});

const row = async (id: string) => (await db.query<{ page_count: number; page_count_source: string; billing_pages: number | null; billing_pages_method: string | null }>(
  `select page_count, page_count_source, billing_pages, billing_pages_method from documents where id = '${id}'`)).rows[0];

/** A hydrated activity's state for `documentIds` of `runId`: its page basis is bound to the store's Postgres adapter. */
async function activity(runId: string, documentIds: string[]): Promise<WorkflowState> {
  const state = WorkflowState.create(await store.loadRun(runId), await Promise.all(documentIds.map(async (id) => (await store.loadDocument(id))!)));
  await store.hydrateState(state);
  return state;
}

describe("PostgresPageBasisLedger writes: the run's own, non-deduplicated document only", () => {
  it("never writes another run's document, a deduplicated copy or a missing one", async () => {
    const ledger = store.pageBasisLedger;
    for (const id of ["other-run", "copy", "missing"]) {
      expect(await ledger.setPageCount("run1", id, 99)).toBe(false);
      expect(await ledger.setBillingPages("run1", id, 99, "text-rule")).toBe(false);
    }
    expect(await row("other-run")).toMatchObject({ page_count: 1, billing_pages: null });
    expect(await row("copy")).toMatchObject({ page_count: 3, billing_pages: null });
  }, 60_000);
});

describe("PageBasis over Postgres", () => {
  it("a hydrated state's page basis records a counted page count, and the run-wide reads see it", async () => {
    const state = await activity("run1", ["pdf"]);
    const pdf = state.documents[0]!;
    await state.pageBasis.record(pdf, { kind: "page-count", pages: 10 });
    expect(await row("pdf")).toMatchObject({ page_count: 10, page_count_source: "counted" });
    expect(pdf).toMatchObject({ pageCount: 10, pageCountSource: "counted" });
    // Pages above intake: the PDF's 7; the image, the failed document and another run's are not counted.
    await db.exec(`update documents set page_count = 30 where id in ('tiff', 'failed', 'other-run')`);
    expect(await store.pageBasisLedger.measuredPagesAboveIntake("run1")).toBe(7);
    expect((await store.pageBasisLedger.countedImageFrames("run1")).map((r) => [r.documentId, r.pageCount, r.chargedPages])).toEqual([["tiff", 30, 0]]);
    await db.exec(`update documents set page_count = 1 where id in ('tiff', 'failed', 'other-run')`);
  }, 60_000);

  it("records an Office count as billing pages and leaves page_count alone", async () => {
    const state = await activity("run1", ["docx"]);
    await state.pageBasis.record(state.documents[0]!, { kind: "billing-pages", pages: 40, method: "text-rule", format: "office-word" });
    expect(await row("docx")).toMatchObject({ page_count: 1, billing_pages: 40, billing_pages_method: "text-rule" });
    expect(await store.pageBasisLedger.measuredDocuments("run1")).toEqual([{ pageCount: 1, billingPages: 40, method: "text-rule" }]);
  }, 60_000);

  it("concurrent activities of one run cannot overdraw: two Office files that each fit a 3-credit balance, recorded at once", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    try {
      const pages = 500;
      const each = extraCreditsForMeasuredPages(defaultPipelineFeatures, 1, pages, "text-rule");
      expect(each).toBeLessThan(3);
      expect(each * 2).toBeGreaterThan(3);
      const [a, b] = await Promise.all([activity("run-low", ["low-a"]), activity("run-low", ["low-b"])]);
      const outcomes = await Promise.allSettled([a, b].map((state) =>
        state.pageBasis.record(state.documents[0]!, { kind: "billing-pages", pages, method: "text-rule", format: "office-word" })));
      expect(outcomes.filter((outcome) => outcome.status === "rejected").length).toBeGreaterThanOrEqual(1);
      for (const outcome of outcomes) if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(UnfundedPagesError);
      const [run] = (await db.query<{ control_state: string | null; pause_reason: string | null }>(`select control_state, pause_reason from project_runs where id = 'run-low'`)).rows;
      expect(run).toEqual({ control_state: "paused", pause_reason: "credit_exhausted" });
    } finally {
      setSpendCheckConfig(null);
    }
  }, 60_000);

  it("refuses (retryable) a charge for a run with no organization, and never pauses or skips", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    try {
      const run = { ...(await store.loadRun("run2")), orgId: null };
      const document = (await store.loadDocument("other-run"))!;
      const pageBasis = new PageBasis({ run, usageLedger: { pendingBillableCents: 0 } }, store.pageBasisLedger);
      await expect(pageBasis.record(document, { kind: "page-count", pages: 20 })).rejects.toBeInstanceOf(SpendCheckUnavailableError);
      await expect(pageBasis.fund({ kind: "page-read", mode: "ocr", pages: 1 })).rejects.toBeInstanceOf(SpendCheckUnavailableError);
      await expect(pageBasis.affordable({ kind: "page-upgrade", from: "ocr", to: "rich" }, 1)).rejects.toBeInstanceOf(SpendCheckUnavailableError);
      const [state] = (await db.query<{ control_state: string | null }>(`select control_state from project_runs where id = 'run2'`)).rows;
      expect(state!.control_state).toBeNull();
    } finally {
      setSpendCheckConfig(null);
    }
  }, 60_000);
});
