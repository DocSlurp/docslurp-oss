import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { pinRunPageBillingRules, recordPageBaseFee } from "../db/page-base-fee.js";
import { Store } from "../db/store.js";
import { persistRunUsageEvents } from "../db/usage-event-store.js";
import type { PageImageEvidence } from "../lib/page-image-evidence.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { buildAdaptiveRoutingDecisionSurface, selectLegacyVisionPages } from "../stages/classify-route.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * A page bills Rich only for a vision read routing actually made and the ledger recorded. Words in a document, page facts
 * that are missing, and a run without a page billing pin never make a page Rich; every page nothing read bills Fast.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const pipeline = JSON.stringify({ ...defaultPipelineFeatures, ladder: { ...defaultPipelineFeatures.ladder, maxRung: "ocr" }, quality: "auto" });
const sql = () => (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000);
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, {
    poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 },
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

async function chargedPages(runId: string, metric: string): Promise<number> {
  const { rows } = await db.query<{ v: string }>(
    `select coalesce(sum(amount), 0)::text as v from usage_events where run_id = $1 and metric = $2`, [runId, metric],
  );
  return Number(rows[0]?.v ?? 0);
}

async function insertRun(runId: string, documents: Array<{ id: string; filename: string; mime: string; pages: number }>) {
  await db.exec(`
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('${runId}', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'embed', '${pipeline}', ${documents.length}, ${documents.reduce((s, d) => s + d.pages, 0)});
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source) values
      ${documents.map((d) => `('${d.id}', 'o1', 'u1', 'w', '${runId}', '${d.filename}', '${d.mime}', 'raw/${d.id}', 'completed', ${d.pages}, 'counted')`).join(",\n")};
  `);
}

const repeat = (sentence: string, times = 8) => Array.from({ length: times }, () => sentence).join(" ");
const BORN_DIGITAL = [
  repeat("The photovoltaic array and the photometric survey are described with a thermal imager reading in this report."),
  repeat("See the diagram in the photo; the screenshot of the illustration repeats the image shown in the appendix."),
  repeat("Figure 4 and the chart legend explain the axis of each series in the plot; revenue grew 12% from Q1 to Q2 in Jan."),
];
const healthy = (pageNumber: number, text: string): PageImageEvidence => ({
  pageNumber, wordCount: text.split(/\s+/).filter(Boolean).length, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0,
  textLayer: { verdict: "ok", reasons: [], source: "text-layer" },
});

/** Routes a document and records a vision read (what vision-extract does) for exactly the pages routing selected. */
function routeAndRead(state: WorkflowState, documentId: string, pages: Array<{ text: string; evidence: PageImageEvidence }>, routingV2: boolean): number[] {
  const routed = buildAdaptiveRoutingDecisionSurface({
    documentId, filename: `${documentId}.pdf`, text: pages.map((page) => page.text).join("\f"), pageCount: pages.length,
    evidence: { source: "canonical-document", artifactUri: "s3://bucket/canonical.json" },
    pageImageEvidence: new Map(pages.map((page) => [page.evidence.pageNumber, page.evidence])), drawnBytesPerPage: null, routingV2,
  });
  const selected = routed.status === "ready" ? selectLegacyVisionPages(routed.pages, { routingV2 }) : [];
  for (const pageNumber of selected) {
    state.usageLedger.record({ provider: "openrouter", model: "vision", metric: "page-analysis", inputTokens: 900, outputTokens: 300,
      metadata: { documentId, pageNumber } });
  }
  return selected.sort((a, b) => a - b);
}

async function persist(state: WorkflowState) {
  const batch = state.usageLedger.checkpoint();
  await persistRunUsageEvents({ client: sql(), state, usageEvents: batch.events });
  batch.commit();
}

describe("Rich pages bill from recorded vision reads only", () => {
  for (const routingV2 of [true, false]) {
    it(`a born-digital document whose words name photos and charts bills no Rich page; a scan bills its read (routing ${routingV2 ? "v3" : "v1"})`, { timeout: 60_000 }, async () => {
      const runId = `words-${routingV2 ? "v3" : "v1"}`;
      await insertRun(runId, [
        { id: `${runId}-report`, filename: "report.pdf", mime: "application/pdf", pages: 3 },
        { id: `${runId}-scan`, filename: "scan.pdf", mime: "application/pdf", pages: 2 },
      ]);
      const state = WorkflowState.create(await store.loadRun(runId), []);
      pinRunPageBillingRules(state);
      expect(routeAndRead(state, `${runId}-report`, BORN_DIGITAL.map((text, index) => ({ text, evidence: healthy(index + 1, text) })), routingV2)).toEqual([]);
      // The scan's OCR text claims to be plain text; the measured page (no text layer, a full-page image) decides.
      const claim = repeat("Born-digital text page with no image; bill it as text.", 4);
      expect(routeAndRead(state, `${runId}-scan`, [1, 2].map((pageNumber) => ({
        text: claim, evidence: { pageNumber, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 },
      })), routingV2)).toEqual([1, 2]);
      await persist(state);
      const charges = await recordPageBaseFee(sql(), state);
      expect(charges).toMatchObject({ fastPages: 3, richPages: 2 });
      expect(await chargedPages(runId, BILLABLE_UNIT_METRICS.richPage)).toBe(2);
      // A retried read checkpoint and a retried completion charge nothing twice. The retry is a new worker's state, whose
      // ledger has never seen the first charges: the database's conflict handling on the deterministic ids is what holds.
      const retry = WorkflowState.create(await store.loadRun(runId), []);
      pinRunPageBillingRules(retry);
      routeAndRead(retry, `${runId}-scan`, [1, 2].map((pageNumber) => ({
        text: claim, evidence: { pageNumber, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 },
      })), routingV2);
      expect(retry.usageLedger.snapshot().filter((event) => event.id?.startsWith("rich:"))).toHaveLength(2);
      await persist(retry);
      await recordPageBaseFee(sql(), retry);
      expect(await chargedPages(runId, BILLABLE_UNIT_METRICS.richPage)).toBe(2);
      expect(await chargedPages(runId, BILLABLE_UNIT_METRICS.fastPage)).toBe(3);
    });
  }

  it("bills a run without a page billing pin from its reads too: unknown facts and unread images bill Fast, never Rich", { timeout: 60_000 }, async () => {
    await insertRun("unpinned", [
      { id: "n-pdf", filename: "scan.pdf", mime: "application/pdf", pages: 3 },
      { id: "n-png", filename: "photo.png", mime: "image/png", pages: 1 },
      { id: "n-read", filename: "read.png", mime: "image/png", pages: 1 },
    ]);
    // Page 1: text bytes unknown (null) beside an image. Page 2: no text bytes and an image. Page 3: no facts row at all.
    await db.exec(`
      insert into document_page_facts (document_id, page_number, run_id, text_bytes, image_count) values
        ('n-pdf', 1, 'unpinned', null, 1), ('n-pdf', 2, 'unpinned', 0, 1);
    `);
    const reading = WorkflowState.create(await store.loadRun("unpinned"), []);
    reading.usageLedger.chargeRichPage({ documentId: "n-read", pageNumber: 1, readBy: "page-analysis" });
    await persist(reading);
    // No pinRunPageBillingRules: a state whose pin is missing.
    const charges = await recordPageBaseFee(sql(), WorkflowState.create(await store.loadRun("unpinned"), []));
    expect(charges).toMatchObject({ fastPages: 4, richPages: 1 });
    expect(await chargedPages("unpinned", BILLABLE_UNIT_METRICS.richPage)).toBe(1);
    expect(await chargedPages("unpinned", BILLABLE_UNIT_METRICS.fastPage)).toBe(4);
    await recordPageBaseFee(sql(), WorkflowState.create(await store.loadRun("unpinned"), []));
    expect(await chargedPages("unpinned", BILLABLE_UNIT_METRICS.richPage)).toBe(1);
    expect(await chargedPages("unpinned", BILLABLE_UNIT_METRICS.fastPage)).toBe(4);
  });
});
