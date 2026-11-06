import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, defaultPipelineFeatures, normalizePipelineFeatures, pageCredits, splitTextIntoPagesStrict } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { extraCreditsForMeasuredPages, recordMeasuredPageCount, type PageCountResult } from "../lib/office-page-count.js";
import { featurePages } from "../pipeline/feature-charges.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * A DOCX end to end: measured at 300 pages from its extracted Markdown, which has no page breaks. The page basis (page_count)
 * stays what the text splits into, so page rows and citations survive; billing reads the measured count.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pipeline = JSON.stringify({ ...defaultPipelineFeatures });
const withFeatures = JSON.stringify(normalizePipelineFeatures({ ...defaultPipelineFeatures, graphRag: true, outputSchema: { type: "object", properties: { total: { type: "number" } } } }));

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000), ('o2', 'Poor', 'poor', 'u1', 8, 20), ('o3', 'Ten', 'ten', 'u1', 8, 110);
    insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'P'), ('w3', 'o3', 'u1', 'T');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('run1', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'embed', '${pipeline}', 1, 1),
             ('run2', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'to-canonical', '${withFeatures}', 1, 1),
             ('run3', 'o3', 'u1', 'w3', 'bulk-upload', 'processing', 'to-canonical', '${pipeline}', 10, 10);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      select 'big' || n, 'o3', 'u1', 'w3', 'run3', 'big' || n || '.docx', '${DOCX}', 'raw/b' || n, 'processing', 1 from generate_series(1, 10) n;
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count) values
      ('docx1', 'o1', 'u1', 'w1', 'run1', 'contract.docx', '${DOCX}', 'raw/c1', 'completed', 1),
      ('docx2', 'o2', 'u1', 'w2', 'run2', 'huge.docx', '${DOCX}', 'raw/c2', 'processing', 1);
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('run4', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'embed', '${withFeatures}', 2, 2);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source) values
      ('blank', 'o1', 'u1', 'w1', 'run4', 'blank.docx', '${DOCX}', 'raw/blank', 'completed', 1, 'assumed'),
      ('sheetless', 'o1', 'u1', 'w1', 'run4', 'notes.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'raw/sheetless', 'completed', 1, 'assumed');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  setSpendCheckConfig(null);
  await store?.close();
  await server?.stop();
  await db?.close();
});

/** A count the extractor's Markdown measured at `pages` by the text rule (lib/office-page-count.ts). */
const counted = (pages: number): PageCountResult => ({ pages, method: "text-rule" });

/** Pandoc-style Markdown of `pages` pages by the 3,500-character rule. */
const markdownOfPages = (pages: number) =>
  Array.from({ length: pages * 5 }, (_, index) => `Paragraph ${index}: ${"the supplier shall deliver the goods. ".repeat(18)}`.trim()).join("\n\n");

const sql = () => (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;

describe("a measured DOCX: page rows and billing", () => {
  it("keeps the page basis the text splits into and bills the measured 300 pages", async () => {
    const run = await store.loadRun("run1");
    const loaded = (await store.loadDocument("docx1"))!;
    const measured = await recordMeasuredPageCount({ run, store }, loaded, "office-word", { extractor: "pandoc", markdown: markdownOfPages(300) });
    expect(measured).toEqual({ pages: 300, method: "text-rule", intakePages: 1 });

    const document = (await store.loadDocument("docx1"))!;
    expect(document).toMatchObject({ pageCount: 1, billingPages: 300, billingPagesMethod: "text-rule" });

    // The extractor's text for a Word file has no form feeds: with the basis at 1 it splits into one page (page rows and
    // citations exist); a measured basis of 300 would drop every page.
    const text = Array.from({ length: 900 }, (_, line) => `Clause ${line}: the supplier shall deliver the goods.`).join("\n\n");
    const pages = splitTextIntoPagesStrict(text, document.pageCount);
    expect(pages).toHaveLength(1);
    expect(splitTextIntoPagesStrict(text, 300)).toBeNull();
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: document.id, text, pageCount: document.pageCount, extractor: "mammoth" });
    expect(canonical.blocks.length).toBeGreaterThan(0);
    expect(canonical.blocks.every((block) => block.pageNumber === 1)).toBe(true);

    // The completion fee bills the measured pages; features price on them too.
    const state = WorkflowState.create(await store.loadRun("run1"), [document]);
    expect(featurePages(state, document)).toBe(300);
    const charges = await recordPageBaseFee(sql(), state);
    expect(charges).toMatchObject({ fastPages: 300, richPages: 0 });
    const { rows } = await db.query<{ amount: string; cost_cents: string }>(
      `select amount::text, cost_cents::text from usage_events where run_id = 'run1' and metric = $1`, [BILLABLE_UNIT_METRICS.fastPage]);
    expect(Number(rows[0]!.amount)).toBe(300);
    expect(Number(rows[0]!.cost_cents)).toBeCloseTo(pageCredits("fast", 300));
  }, 60_000);

  it("pauses the run when a hostile DOCX measures far above intake's one page and the owed credits no longer fit", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const run = await store.loadRun("run2");
    const document = (await store.loadDocument("docx2"))!;
    // 20,000 blank pages: a few credits of base fee plus every enabled feature on them, against a 20-credit balance.
    const owed = extraCreditsForMeasuredPages(run.pipeline, 1, 20_000);
    expect(owed).toBeGreaterThan(20);
    // The count is recorded, the run is paused and the document is stopped (a run-policy stop), not carried on.
    await expect(recordMeasuredPageCount({ run, store }, document, "office-word", counted(20_000))).rejects.toMatchObject({ name: "RunPolicyError" });
    expect((await store.loadDocument("docx2"))!.billingPages).toBe(20_000);
    const { rows } = await db.query<{ control_state: string | null; pause_reason: string | null }>(`select control_state, pause_reason from workspace_runs where id = 'run2'`);
    expect(rows[0]).toEqual({ control_state: "paused", pause_reason: "credit_exhausted" });
    // A run already paused (or stopped) by something else: the check reports blocked without pausing, and still stops it.
    await expect(recordMeasuredPageCount({ run, store }, document, "office-word", counted(20_000))).rejects.toMatchObject({ name: "RunPolicyError" });
  }, 60_000);

  it("adds up the run's measured documents: ten large DOCX files that each fit a 10-credit balance cannot together overdraw it", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const run = await store.loadRun("run3");
    // 10 credits above the starter chat reserve (100). 400 pages each: about 2 Fast credits of extra pages per file, under the
    // balance alone, 20 credits for the ten.
    const each = extraCreditsForMeasuredPages(run.pipeline, 1, 400, "text-rule");
    expect(each).toBeLessThan(5);
    expect(each * 10).toBeGreaterThan(10);
    const state = async () => (await db.query<{ control_state: string | null }>(`select control_state from workspace_runs where id = 'run3'`)).rows[0]!.control_state;
    let pausedAt = 0;
    for (let n = 1; n <= 10 && !pausedAt; n += 1) {
      const stopped = await recordMeasuredPageCount({ run, store }, (await store.loadDocument(`big${n}`))!, "office-word", counted(400))
        .then(() => false, (error: Error) => error.name === "RunPolicyError");
      if (await state() === "paused") {
        expect(stopped).toBe(true);
        pausedAt = n;
      } else expect(stopped).toBe(false);
    }
    // Five files owe 9.98 credits and fit; the sixth takes the run to 11.97 and pauses it. Checked one file at a time, none ever would.
    expect(pausedAt).toBe(Math.floor(10 / each) + 1);
    expect(await store.measuredRunDocuments("run3")).toHaveLength(pausedAt);
    // Scoped to the run: another run's measured documents are not counted against this one.
    expect((await store.measuredRunDocuments("run2")).every((row) => row.billingPages === 20_000)).toBe(true);
  }, 60_000);

  it("does not pause when the measured count is the intake count or the balance holds", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    expect(extraCreditsForMeasuredPages(defaultPipelineFeatures, 1, 1)).toBe(0);
    expect(extraCreditsForMeasuredPages(defaultPipelineFeatures, 5, 3)).toBe(0);
    await db.exec(`update workspace_runs set control_state = null, pause_reason = null where id = 'run1'`);
    const run = await store.loadRun("run1");
    const document = (await store.loadDocument("docx1"))!;
    await recordMeasuredPageCount({ run, store }, document, "office-word", counted(40));
    const { rows } = await db.query<{ control_state: string | null }>(`select control_state from workspace_runs where id = 'run1'`);
    expect(rows[0]!.control_state).toBeNull();
  }, 60_000);

  it("fails closed when the measured-page spend check's database errors: retryable, never treated as funded", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await db.exec(`update workspace_runs set control_state = null, pause_reason = null where id = 'run1'`);
    const run = await store.loadRun("run1");
    const document = (await store.loadDocument("docx1"))!;
    await db.exec(`alter function org_spend_status(text, text, numeric) rename to org_spend_status_unavailable`);
    try {
      await expect(recordMeasuredPageCount({ run, store }, document, "office-word", counted(4_000)))
        .rejects.toMatchObject({ name: "SpendCheckUnavailableError" });
      // A retryable infrastructure error: the stage leaves the document unfinished rather than failing it.
      const { isDocumentLevelFailure } = await import("../lib/document-failure.js");
      const error = await recordMeasuredPageCount({ run, store }, document, "office-word", counted(4_000)).catch((caught: unknown) => caught);
      expect(isDocumentLevelFailure(error)).toBe(false);
    } finally {
      await db.exec(`alter function org_spend_status_unavailable(text, text, numeric) rename to org_spend_status`);
    }
  }, 60_000);
});

describe("an Office file always bills a measured outcome, never intake's assumed page", () => {
  it("nothing extracted: measured 0 pages; no page fee and no feature", async () => {
    const run = await store.loadRun("run4");
    const blank = (await store.loadDocument("blank"))!;
    expect(blank).toMatchObject({ pageCount: 1, pageCountSource: "assumed" });
    expect(await recordMeasuredPageCount({ run, store }, blank, "office-word", { extractor: "pandoc", markdown: "  \n\n " }))
      .toEqual({ pages: 0, method: "empty", intakePages: 1 });
    const stored = (await store.loadDocument("blank"))!;
    expect(stored).toMatchObject({ billingPages: 0, billingPagesMethod: "empty" });
    const state = WorkflowState.create(run, [stored]);
    expect(featurePages(state, stored)).toBe(0);
    expect(featurePages(state, stored, { textPages: 5 })).toBe(0);
  }, 60_000);

  it("text extracted but no sheet tables: counted by the text rule", async () => {
    const run = await store.loadRun("run4");
    const sheet = (await store.loadDocument("sheetless"))!;
    const measured = await recordMeasuredPageCount({ run, store }, sheet, "office-excel", { extractor: "xlsx", markdown: markdownOfPages(12) });
    expect(measured).toMatchObject({ method: "text-rule" });
    expect(measured.pages).toBeGreaterThanOrEqual(12);
    const stored = (await store.loadDocument("sheetless"))!;
    expect(stored.billingPages).toBe(measured.pages);
    expect(featurePages(WorkflowState.create(run, [stored]), stored)).toBe(measured.pages);
  }, 60_000);

  it("the page fee bills only the measured outcomes: 0 for the blank file, the text-rule count for the other", async () => {
    const run = await store.loadRun("run4");
    const docs = [(await store.loadDocument("blank"))!, (await store.loadDocument("sheetless"))!];
    const charges = await recordPageBaseFee(sql(), WorkflowState.create(run, docs));
    expect(charges.fastPages).toBe(docs[1]!.billingPages);
  }, 60_000);

  it("an assumed page count with no measurement prices no feature", () => {
    const state = WorkflowState.create({ id: "r", pipeline: {}, stats: {}, artifacts: {} } as never, []);
    expect(featurePages(state, { id: "d", pageCount: 1, pageCountSource: "assumed" })).toBe(0);
    expect(featurePages(state, { id: "d", pageCount: 7, pageCountSource: "counted" })).toBe(7);
    expect(featurePages(state, { id: "d", pageCount: 1, pageCountSource: "assumed", billingPages: 40, billingPagesMethod: "text-rule" })).toBe(40);
  });
});
