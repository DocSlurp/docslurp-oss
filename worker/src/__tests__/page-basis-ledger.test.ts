import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, defaultPipelineFeatures, PAGE_READ_METRICS, pageCredits } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadFixtureDocument } from "../test/load-document.js";

import { StaleExecutionError } from "../db/execution-ownership.js";
import { isDocumentLevelFailure } from "../lib/document-failure.js";
import { setSpendCheckConfig, SpendCheckUnavailableError } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { extraCreditsForMeasuredPages } from "../lib/office-page-count.js";
import { PageBasis, UnfundedPagesError } from "../pipeline/page-basis.js";
import { recordPageProgress } from "../pipeline/run-ledger.js";
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
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'One', 'one', 'u1', 8, 100000), ('o2', 'Low', 'low', 'u1', 8, 3), ('o3', 'Mixed', 'mixed', 'u1', 8, 3);
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'L'), ('w3', 'o3', 'u1', 'M');
    insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values (100, 'run1', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 6, 6),
             (100, 'run2', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 1, 1),
             (100, 'run-low', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 2, 2),
             (100, 'run-mixed', 'o3', 'u1', 'w3', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 2, 2);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, intake_page_count) values
      ('pdf', 'o1', 'u1', 'w1', 'run1', 'a.pdf', 'application/pdf', 'raw/a', 'processing', 3, 'assumed', 3),
      ('docx', 'o1', 'u1', 'w1', 'run1', 'b.docx', '${DOCX}', 'raw/b', 'processing', 1, 'assumed', 1),
      ('tiff', 'o1', 'u1', 'w1', 'run1', 'c.tiff', 'image/tiff', 'raw/c', 'processing', 1, 'assumed', 1),
      ('failed', 'o1', 'u1', 'w1', 'run1', 'd.pdf', 'application/pdf', 'raw/d', 'failed', 1, 'assumed', 1),
      ('other-run', 'o1', 'u1', 'w1', 'run2', 'e.pdf', 'application/pdf', 'raw/e', 'processing', 1, 'assumed', 1),
      ('low-a', 'o2', 'u1', 'w2', 'run-low', 'f.docx', '${DOCX}', 'raw/f', 'processing', 1, 'assumed', 1),
      ('low-b', 'o2', 'u1', 'w2', 'run-low', 'g.docx', '${DOCX}', 'raw/g', 'processing', 1, 'assumed', 1),
      ('mixed-text', 'o3', 'u1', 'w3', 'run-mixed', 'm.txt', 'text/plain', 'raw/m', 'processing', 1, 'assumed', 1),
      ('mixed-docx', 'o3', 'u1', 'w3', 'run-mixed', 'm.docx', '${DOCX}', 'raw/md', 'processing', 1, 'assumed', 1);
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
  const state = WorkflowState.create(await store.loadRun(runId), await Promise.all(documentIds.map(async (id) => (await loadFixtureDocument(store, id))!)));
  await store.hydrateState(state);
  state.executionGeneration = state.run.executionGeneration; // Model the current workflow activity input.
  return state;
}

describe("PostgresPageBasisLedger writes: the run's own, non-deduplicated document only", () => {
  it("never writes another run's document, a deduplicated copy or a missing one", async () => {
    const ledger = store.pageBasisLedger;
    const generation = (await store.loadRun("run1")).executionGeneration;
    for (const id of ["other-run", "copy", "missing"]) {
      expect(await ledger.setPageCount("run1", id, 99, generation)).toBe(false);
      expect(await ledger.setBillingPages("run1", id, 99, "text-rule")).toBe(false);
    }
    expect(await row("other-run")).toMatchObject({ page_count: 1, billing_pages: null });
    expect(await row("copy")).toMatchObject({ page_count: 3, billing_pages: null });
  }, 60_000);
});

describe("PageBasis over Postgres", () => {
  it("refuses a measurement after execution replacement, cancellation or completion", async () => {
    const batch = await activity("run2", ["other-run"]);
    const record = () => batch.pageBasis.record(batch.documents[0]!, { kind: "page-count", pages: 17 });
    for (const change of ["execution_generation = 'next'", "control_state = 'cancel_requested'", "status = 'completed'"]) {
      await db.exec(`update project_runs set ${change} where id = 'run2'`);
      try {
        await expect(record()).rejects.toBeInstanceOf(StaleExecutionError);
        if (change.startsWith("execution_generation")) {
          const retry = await activity("run2", ["other-run"]);
          expect(retry.run.executionGeneration).toBe("next");
          retry.executionGeneration = "previous";
          await expect(retry.pageBasis.record(retry.documents[0]!, { kind: "page-count", pages: 17 })).rejects.toBeInstanceOf(StaleExecutionError);
        }
        expect((await row("other-run"))?.page_count).toBe(1);
        expect((await store.loadRun("run2")).pagesTotal).toBe(1);
      } finally {
        await db.query("update project_runs set execution_generation = $1, control_state = null, status = 'processing' where id = 'run2'", [batch.executionGeneration]);
      }
    }
    expect(isDocumentLevelFailure(new StaleExecutionError())).toBe(false);
  });

  it("publishes first-pass measurements before the extraction shard loads, even across retries and stale checkpoints", async () => {
    const original = await activity("run2", ["other-run"]);
    const batch = await activity("run2", ["other-run"]);
    batch.beginShard(["other-run"]);
    const count = async (pages: number) => {
      await batch.pageBasis.record(batch.documents[0]!, { kind: "page-count", pages });
    };
    await count(13);
    const drain = await activity("run2", ["other-run"]);
    expect(drain.run.pagesTotal).toBe(13);
    drain.beginShard(["other-run"]);
    for (let pageNumber = 1; pageNumber <= 13; pageNumber++) {
      recordPageProgress(drain, { documentId: "other-run", stageName: "extract-markdown", pageNumber, pageCount: 13, status: "completed" });
    }
    await store.updateProgress(drain);
    await count(13);
    await store.updateProgress(original);
    expect(await store.loadRun("run2")).toMatchObject({ pagesTotal: 13, pagesProcessed: 13 });
    await count(6);
    await store.updateProgress(batch);
    expect(await store.loadRun("run2")).toMatchObject({ pagesTotal: 6, pagesProcessed: 6 });
    await count(1);
  }, 60_000);

  it("a hydrated state's page basis records a counted page count, and the run-wide reads see it", async () => {
    const state = await activity("run1", ["pdf"]);
    const pdf = state.documents[0]!;
    await state.pageBasis.record(pdf, { kind: "page-count", pages: 10 });
    expect(await row("pdf")).toMatchObject({ page_count: 10, page_count_source: "counted" });
    expect(pdf).toMatchObject({ pageCount: 10, pageCountSource: "counted" });
    // One run-wide sum: the PDF's 7 Fast pages and the TIFF's 29 uncharged frames; the failed document, the deduplicated copy
    // and another run's are not counted, and the excluded document is left for the caller.
    await db.exec(`update documents set page_count = 30 where id in ('tiff', 'failed', 'other-run', 'copy')`);
    expect(await store.pageBasisLedger.runMeasurements("run1", "none", PAGE_READ_METRICS)).toEqual({ fastPages: 7, ocrFrames: 29, documentChargedPages: 0 });
    expect(await store.pageBasisLedger.runMeasurements("run1", "pdf", PAGE_READ_METRICS)).toEqual({ fastPages: 0, ocrFrames: 29, documentChargedPages: 0 });
    await db.exec(`update documents set page_count = 1 where id in ('tiff', 'failed', 'other-run')`);
    await db.exec(`update documents set page_count = 3 where id = 'copy'`);
  }, 60_000);

  it("records an Office count as billing pages and leaves page_count alone", async () => {
    const state = await activity("run1", ["docx"]);
    await state.pageBasis.record(state.documents[0]!, { kind: "billing-pages", pages: 40, method: "text-rule", format: "office-word" });
    expect(await row("docx")).toMatchObject({ page_count: 1, billing_pages: 40, billing_pages_method: "text-rule" });
    expect((await store.pageBasisLedger.runMeasurements("run1", "pdf", PAGE_READ_METRICS)).fastPages).toBe(39);
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

  it("one run-wide sum whatever the order: a text raise then an Office count that each fit the balance alone pause the run", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    try {
      const state = await activity("run-mixed", ["mixed-text", "mixed-docx"]);
      const docxPages = 500;
      let textPages = 2;
      while (pageCredits("fast", textPages) < 2.5) textPages += 1;
      const docxOwes = extraCreditsForMeasuredPages(defaultPipelineFeatures, 1, docxPages, "text-rule");
      expect(pageCredits("fast", textPages - 1)).toBeLessThan(3);
      expect(docxOwes).toBeLessThan(3);
      await state.pageBasis.record(state.documents[0]!, { kind: "page-count", pages: textPages });
      await expect(state.pageBasis.record(state.documents[1]!, { kind: "billing-pages", pages: docxPages, method: "text-rule", format: "office-word" }))
        .rejects.toBeInstanceOf(UnfundedPagesError);
      const [run] = (await db.query<{ control_state: string | null }>(`select control_state from project_runs where id = 'run-mixed'`)).rows;
      expect(run!.control_state).toBe("paused");
    } finally {
      setSpendCheckConfig(null);
    }
  }, 60_000);

  it("charged frames count only page numbers inside the image, as the completion fee does (council R2)", async () => {
    await db.exec(`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, intake_page_count)
      values ('img10', 'o1', 'u1', 'w1', 'run2', 't.tif', 'IMAGE/TIFF', 'raw/t10', 'processing', 10, 'counted', 1)`);
    for (const page of ["100", "101", "abc", "0", "-1", "1.0", "1", "2"]) {
      await db.exec(`insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, metadata, org_id)
        values ('junk-${page}', 'u1', 'run2', 'docslurp', 'ocr', '${BILLABLE_UNIT_METRICS.ocrPage}', 1, 'page', 0, '{"documentId":"img10","pageNumber":"${page}"}', 'o1')`);
    }
    // Pages 1 and 2 are charged; 8 frames past them stay owed (an upper-case MIME type is still an image).
    expect(await store.pageBasisLedger.runMeasurements("run2", null, PAGE_READ_METRICS)).toMatchObject({ ocrFrames: 8 });
    expect(await store.pageBasisLedger.runMeasurements("run2", "img10", PAGE_READ_METRICS)).toMatchObject({ ocrFrames: 0, documentChargedPages: 2 });
    await db.exec(`delete from usage_events where run_id = 'run2'; delete from documents where id = 'img10'`);
  }, 60_000);

  it("a refused charge is stored on the paused run for the resume sweep, and the larger refusal is kept (council R2)", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    try {
      await db.exec(`update project_runs set control_state = null, pause_reason = null, spend_pause_credits = null where id = 'run-low'`);
      const run = { id: "run-low", orgId: "o2", projectId: "w2", userId: "u1" };
      await expect(store.pageBasisLedger.checkCharge(run, 7.25)).resolves.toMatchObject({ paused: true });
      const stored = async () => Number((await db.query<{ c: string }>(`select spend_pause_credits::text as c from project_runs where id = 'run-low'`)).rows[0]!.c);
      expect(await stored()).toBeCloseTo(7.25);
      await expect(store.pageBasisLedger.checkCharge(run, 9.5)).resolves.toMatchObject({ paused: false, blocked: true });
      expect(await stored()).toBeCloseTo(9.5);
      await expect(store.pageBasisLedger.checkCharge(run, 4)).resolves.toMatchObject({ blocked: true });
      expect(await stored()).toBeCloseTo(9.5);
      await expect(store.pageBasisLedger.checkCharge(run, Number.NaN)).rejects.toBeInstanceOf(SpendCheckUnavailableError);
    } finally {
      setSpendCheckConfig(null);
    }
  }, 60_000);

  it("stays fast on a large run: 2,000 documents and 60,000 usage events (council R2 performance)", async () => {
    await db.exec(`
      insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
        values (100, 'run-big', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 2001, 2001);
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, intake_page_count)
        select 'big'||g, 'o1', 'u1', 'w1', 'run-big', 'x.txt', 'text/plain', 'raw/big'||g, 'processing', 5, 'counted', 1 from generate_series(1, 2000) g;
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, intake_page_count)
        values ('big-img', 'o1', 'u1', 'w1', 'run-big', 'b.tif', 'image/tiff', 'raw/bigimg', 'processing', 40, 'counted', 1);
      insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, metadata, org_id)
        select 'big-e'||g, 'u1', 'run-big', 'docslurp', 'm', case when g % 3 = 0 then '${BILLABLE_UNIT_METRICS.ocrPage}' else 'embedding' end, 1, 'page', 0,
          jsonb_build_object('documentId', case when g % 1000 = 0 then 'big-img' else 'big'||(g % 2000 + 1) end, 'pageNumber', (g % 5 + 1)::text), 'o1'
        from generate_series(1, 60000) g;
    `);
    const started = Date.now();
    for (let i = 0; i < 5; i += 1) await store.pageBasisLedger.runMeasurements("run-big", "big1", PAGE_READ_METRICS);
    const perCall = (Date.now() - started) / 5;
    process.stdout.write(`[page-basis-ledger] run_measured_pages ${perCall.toFixed(1)} ms per call (PGlite, 2,001 documents, 60,000 events, no ANALYZE)\n`);
    expect(await store.pageBasisLedger.runMeasurements("run-big", "big1", PAGE_READ_METRICS)).toMatchObject({ fastPages: 1999 * 4 });
    expect(perCall).toBeLessThan(1_000);
  }, 180_000);

  it("refuses (retryable) a charge for a run with no organization, and never pauses or skips", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    try {
      const run = { ...(await store.loadRun("run2")), orgId: null };
      const document = (await loadFixtureDocument(store, "other-run"))!;
      const pageBasis = new PageBasis({ run, executionGeneration: run.executionGeneration, usageLedger: { pendingBillableCents: 0 } }, store.pageBasisLedger);
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
