import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DENSE_PAGE_EQUIVALENTS, PAGE_AREA_EQUIVALENTS_CAP, defaultPipelineFeatures, imageAreaEquivalents, measuredTextPages, pageAreaEquivalentsPt,
  pageTextEquivalents, stripHtmlMarkup, textPageCount, billedPageEquivalents, billedPagePageEquivalents, DEFAULT_PAGE_EQUIVALENT_ALLOWANCE, DISTINCT_TEST_PRICING, installTestPricing,
} from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import type { Document } from "../models.js";
import { PdfRasterCache, PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { Store } from "../db/store.js";
import { recordPageEquivalents } from "../db/page-equivalents.js";
import { measureExtractedPages } from "../lib/office-page-count.js";
import { MAX_PAGE_EQUIVALENTS, recordExtractedPageEquivalents } from "../lib/page-equivalents.js";
import { recordMeasuredTextPageCount } from "../lib/text-page-count.js";
import { parsePageLayoutFacts } from "../lib/page-layout-facts.js";
import { processedPdfPages, splitProcessedPdfPages } from "../lib/pdf-page-count.js";
import { sanitizeExtractedMarkdown } from "../lib/extracted-markdown.js";
import { configurePageAreaSink, createPageAreaSink, recordRenderedPageAreas } from "../pipeline/page-area-sink.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Content stuffing: a page that carries many pages of text (tiny, invisible, off-page or overflowing text, a giant page)
 * bills the page equivalents it holds, measured from what was extracted or rendered. Every fixture is generated here.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
const pipeline = JSON.stringify({ ...defaultPipelineFeatures });
const pdfFacts = { declaredMimeType: "application/pdf", sniffedMimeType: "application/pdf", mimeType: "application/pdf", format: "pdf", container: null, encoding: null, mismatch: "none" };
const sql = () => (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000000), ('o3', 'Empty', 'empty', 'u1', 8, 0);
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w3', 'o3', 'u1', 'E');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}, 120_000);
afterEach(() => configurePageAreaSink(null));
afterAll(async () => { await store?.close(); await server?.stop(); await db?.close(); });

let seq = 0;
/** The bytes the raster harnesses stage; a parse decision binds parsers to what quarantine scanned (PR #339 R8-L1). */
const STAGED_SHA = createHash("sha256").update("pdf bytes").digest("hex");
/** A run with one counted document of `pages` pages; returns its state. */
async function documentRun(pages: number, mime = "application/pdf", facts: object = pdfFacts, org: { org: string; project: string } = { org: "o1", project: "w1" }) {
  seq += 1;
  const runId = `run-${seq}`, documentId = `doc-${seq}`;
  await db.exec(`
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('${runId}', '${org.org}', 'u1', '${org.project}', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 1, ${pages});
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts, parse_source_scan_version, parse_source_sha256)
      values ('${documentId}', '${org.org}', 'u1', '${org.project}', '${runId}', 'f', '${mime}', 'raw/${documentId}', 'processing', ${pages}, 'counted', '${JSON.stringify(facts)}', 1, '${STAGED_SHA}');`);
  const document = (await store.loadDocument(documentId))!;
  const state = WorkflowState.create(await store.loadRun(runId), [document]);
  state.store = store;
  return { state, document, runId, documentId };
}
async function billedFastPages(runId: string, documentId: string): Promise<number> {
  const state = WorkflowState.create(await store.loadRun(runId), [(await store.loadDocument(documentId))!]);
  return (await recordPageBaseFee(sql(), state)).fastPages;
}

/** A one-page PDF with `content` as its content stream. */
function pdfPage(content: string, media = "0 0 612 792", crop?: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${media}]${crop ? ` /CropBox [${crop}]` : ""} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango ";
/** `lines` unique lines of `chars` characters at `size` pt, `lead` apart, in text render `mode` (3 = invisible). */
function textBody(o: { size: number; lead: number; lines: number; chars: number; mode?: number; x?: number; y?: number }): string {
  const parts = [`BT /F1 ${o.size} Tf ${o.mode ?? 0} Tr ${o.x ?? 10} ${o.y ?? 785} Td ${o.lead} TL`];
  for (let line = 0; line < o.lines; line += 1) parts.push(`(line ${String(line).padStart(6, "0")} ${WORDS.repeat(Math.ceil(o.chars / WORDS.length)).slice(0, o.chars)}) '`);
  parts.push("ET");
  return parts.join("\n");
}

const pdftotext = spawnSync("pdftotext", ["-v"]).error ? null : "pdftotext";
/** Extract a PDF's pages as the extractors do (Poppler text, one form feed per page). */
async function extract(pdf: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "stuffed-"));
  const file = path.join(dir, "in.pdf");
  await writeFile(file, pdf);
  return spawnSync(pdftotext!, [file, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout;
}

describe("page equivalents: measurement", () => {
  it("counts a page's text by the text rule and its area against a Letter page, capped per page", () => {
    expect(pageTextEquivalents("")).toBe(1);
    expect(pageTextEquivalents("a short page")).toBe(1);
    expect(pageTextEquivalents("x".repeat(3_500 * 50))).toBe(50);
    expect(pageAreaEquivalentsPt(612, 792)).toBe(1);
    expect(pageAreaEquivalentsPt(1224, 1584)).toBe(4);
    expect(pageAreaEquivalentsPt(14_400, 14_400)).toBe(PAGE_AREA_EQUIVALENTS_CAP); // a 200-inch page
    expect(imageAreaEquivalents(2_550, 3_300)).toBe(1); // Letter scanned at 300 dpi
    expect(imageAreaEquivalents(1_700, 2_200)).toBe(1); // the blank upload the real-Modal run billed as 2
    expect(imageAreaEquivalents(4_032, 3_024, 2_000)).toBe(1); // a 12 MP phone photo, as the OCR reads it
    expect(imageAreaEquivalents(20_000, 20_000, 2_000)).toBe(1);
    expect(imageAreaEquivalents(20_000, 20_000, 4_000)).toBe(2); // only a raised read cap reads more than a page
    expect(imageAreaEquivalents(20_000, 20_000)).toBe(PAGE_AREA_EQUIVALENTS_CAP); // no read cap: the full pixels
  });
});

describe("stuffed PDFs bill the text extraction actually produced", () => {
  it.skipIf(!pdftotext)("a 1-page PDF of ~1 MB of 0.1 pt text: billed by what Poppler extracts (its tiny-glyph limit bounds the rest)", async () => {
    const pdf = pdfPage(textBody({ size: 0.1, lead: 0.5, lines: 1_100, chars: 1_000 }));
    expect(pdf.length).toBeGreaterThan(1_000_000);
    const text = await extract(pdf);
    // Poppler keeps at most 50,000 glyphs under 3 pt per page (TextOutputDev): the rest is neither extracted nor indexed.
    expect(text.length).toBeGreaterThan(45_000);
    expect(text.length).toBeLessThan(60_000);
    const { state, document, runId, documentId } = await documentRun(1);
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", text))!;
    expect(measured.equivalents).toBe(pageTextEquivalents(text));
    expect(measured.equivalents).toBe(15);
    expect(measured.densePages).toEqual([1]);
    // Far above the dense-page allowance: it bills every page it holds.
    expect(measured.billed).toBe(15);
    expect(await billedFastPages(runId, documentId)).toBe(15);
  });

  it.skipIf(!pdftotext)("invisible text (render mode 3) is extracted, indexed and billed by its volume", async () => {
    const text = await extract(pdfPage(textBody({ size: 10, lead: 12, lines: 300, chars: 1_000, mode: 3, y: 3_590 }), "0 0 6000 3600"));
    expect(text.length).toBeGreaterThan(250_000);
    const { state, document, runId, documentId } = await documentRun(1);
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", text))!;
    expect(measured.equivalents).toBeGreaterThan(70);
    expect(await billedFastPages(runId, documentId)).toBe(measured.equivalents);
  });

  it.skipIf(!pdftotext)("text outside the crop box (inside the media box) is extracted and billed; outside the media box Poppler drops it", async () => {
    const inside = await extract(pdfPage(textBody({ size: 10, lead: 12, lines: 200, chars: 1_000, x: 700, y: 3_590 }), "0 0 6000 3600", "0 0 612 792"));
    expect(inside.length).toBeGreaterThan(150_000);
    const { state, document, runId, documentId } = await documentRun(1);
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", inside))!;
    expect(measured.equivalents).toBeGreaterThan(40);
    expect(await billedFastPages(runId, documentId)).toBe(measured.equivalents);
    const outside = await extract(pdfPage(textBody({ size: 10, lead: 12, lines: 200, chars: 1_000, x: 9_000, y: 9_000 })));
    expect(outside.trim()).toBe(""); // not extracted, not indexed: nothing to bill beyond the page itself
  });

  it("a 200-inch page bills its rendered area, capped per page, through the raster cache's sink", async () => {
    const { runId, documentId } = await documentRun(2);
    configurePageAreaSink(createPageAreaSink(sql(), store));
    const document = (await store.loadDocument(documentId))!;
    await recordRenderedPageAreas(runId, document, [{ pageNumber: 1, area: pageAreaEquivalentsPt(14_400, 14_400) }, { pageNumber: 2, area: pageAreaEquivalentsPt(612, 792) }]);
    expect(document.billingPages).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
    // Page 1 counts as the cap, page 2 as one page.
    expect((await store.loadDocument(documentId))!.billingPages).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
    expect(await billedFastPages(runId, documentId)).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
    // A second render of the same page records nothing more.
    await recordRenderedPageAreas(runId, document, [{ pageNumber: 1, area: PAGE_AREA_EQUIVALENTS_CAP }]);
    expect((await store.loadDocument(documentId))!.billingPages).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
  });

  it("an uploaded image's frames count their area as the OCR reads them, and their text", async () => {
    const image = { declaredMimeType: "image/tiff", sniffedMimeType: "image/tiff", mimeType: "image/tiff", format: "image", container: null, encoding: null, mismatch: "none" };
    // At the default read cap (2,000 px long edge) any frame is one page of area: a 20,000 px frame and a blank 1700x2200 scan.
    const ordinary = await documentRun(2, "image/tiff", image);
    const measured = (await recordExtractedPageEquivalents(ordinary.state, ordinary.document, "image", "frame one\fframe two",
      [{ pageNumber: 1, sourceWidth: 20_000, sourceHeight: 20_000 }, { pageNumber: 2, sourceWidth: 1_700, sourceHeight: 2_200 }]))!;
    expect(measured.equivalents).toBe(2);
    // Nothing above one page per frame: billing_pages is not raised (the frames bill as their OCR reads, one Rich page each).
    expect((await store.loadDocument(ordinary.documentId))!.billingPages).toBeNull();
    // A raised read cap reads more pixels: the large frame counts 2 there.
    vi.stubEnv("DOCSLURP_OCR_MAX_LONG_EDGE", "4000");
    try {
      const raised = await documentRun(2, "image/tiff", image);
      const big = (await recordExtractedPageEquivalents(raised.state, raised.document, "image", "frame one\fframe two",
        [{ pageNumber: 1, sourceWidth: 20_000, sourceHeight: 20_000 }]))!;
      expect(big.equivalents).toBe(3);
      expect((await store.loadDocument(raised.documentId))!.billingPages).toBe(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a document over the page-equivalents limit is refused, never capped", async () => {
    const { state, document } = await documentRun(1);
    const huge = Array.from({ length: MAX_PAGE_EQUIVALENTS + 1 }, () => "x").join("\f");
    await expect(recordExtractedPageEquivalents(state, document, "pdf", huge)).rejects.toThrow(/exceeds/);
  });

  it("an ordinary document is unchanged: one page per page, no billing_pages written", async () => {
    const { state, document, documentId } = await documentRun(3);
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", "page one\fpage two\fpage three"))!;
    expect(measured).toMatchObject({ pages: 3, equivalents: 3, densePages: [], billingPages: null });
    expect((await store.loadDocument(documentId))!.billingPages).toBeNull();
  });
});

describe("stuffed Office, HTML and sheet files bill their extracted text", () => {
  const paragraph = "The supplier shall deliver the goods to the buyer at the agreed place and time, as set out in schedule one. ";

  it("a DOCX text box that overflows: its text is counted by the text rule", () => {
    // The extractor emits a text box's content as text (pandoc reads w:txbxContent); its volume is what is measured.
    const textBox = Array.from({ length: 2_000 }, () => paragraph).join("\n\n");
    const measured = measureExtractedPages("office-word", "pandoc", `# Cover\n\n${textBox}`)!;
    expect(measured.method).toBe("text-rule");
    expect(measured.pages).toBeGreaterThanOrEqual(Math.floor(textBox.length / 3_500));
  });

  it("HTML with an overflow:scroll div holding 1 MB: counted by its visible text, scroll and hidden boxes included", async () => {
    const hidden = Array.from({ length: 9_500 }, () => paragraph).join(" ");
    const html = `<html><body><p>Short page.</p><div style="overflow:scroll;height:10px">${hidden}</div><div style="display:none">${hidden.slice(0, 100_000)}</div></body></html>`;
    expect(html.length).toBeGreaterThan(1_000_000);
    // Intake's text rule over HTML (markup removed) counts every box: CSS does not hide text from the count.
    expect(measuredTextPages(html, { markup: true })).toBeGreaterThan(300);
    const { state, document, runId, documentId } = await documentRun(1, "text/html", { declaredMimeType: "text/html", sniffedMimeType: null, mimeType: "text/html", format: "html", container: null, encoding: "utf-8", mismatch: "none" });
    const measured = (await recordExtractedPageEquivalents(state, document, "html", stripHtmlMarkup(html)))!;
    expect(measured.equivalents).toBeGreaterThan(300);
    expect(await billedFastPages(runId, documentId)).toBe(measured.equivalents);
  });

  it("a single PPTX slide with huge text bills its text", () => {
    const measured = measureExtractedPages("office-pptx", "pptx", `## Slide 1\n${Array.from({ length: 3_000 }, () => paragraph).join("\n")}`)!;
    expect(measured.method).toBe("slides");
    expect(measured.pages).toBeGreaterThan(80);
  });

  it("an XLSX with one giant cell bills that cell's text", () => {
    const giant = paragraph.repeat(5_000);
    const measured = measureExtractedPages("office-excel", "xlsx", `## Sheet1\n\n| A |\n| --- |\n| ${giant} |\n`)!;
    expect(measured.method).toBe("sheet-rows");
    expect(measured.pages).toBeGreaterThanOrEqual(Math.floor(giant.length / 3_500));
  });

  it("dense pages are those holding more than DENSE_PAGE_EQUIVALENTS pages of text", () => {
    expect(DENSE_PAGE_EQUIVALENTS).toBe(3);
  });
});

describe("dense-page allowance (owner decision 2026-11-05): paged pages bill 1 up to 3 text equivalents, their full volume above", () => {
  /** A two-column Letter page: `perColumn` lines of `chars` characters in each column, 10 pt type. */
  const twoColumns = (perColumn: number, chars: number) => [
    textBody({ size: 7, lead: 9, lines: perColumn, chars, x: 36, y: 760 }),
    textBody({ size: 7, lead: 9, lines: perColumn, chars, x: 316, y: 760 }),
  ].join("\n");

  it("the rule: text at or under the allowance bills 1, above it its full volume (rounded up); area always in full", () => {
    expect(DEFAULT_PAGE_EQUIVALENT_ALLOWANCE).toBe(3);
    expect([1, 2, 3].map((text) => billedPageEquivalents(text))).toEqual([1, 1, 1]);
    expect(billedPageEquivalents(4)).toBe(4);
    expect(billedPageEquivalents(pageTextEquivalents("x".repeat(Math.round(3.5 * 3_500))))).toBe(4);
    expect(billedPageEquivalents(2, 1)).toBe(2); // a provider allowance of 1: full volume
    expect(billedPagePageEquivalents(3, 2)).toBe(2); // a large page still bills its area
    expect(billedPagePageEquivalents(5, 2)).toBe(5);
  });

  it.skipIf(!pdftotext)("a ~7,000-character two-column page (a dense paper) bills 1", async () => {
    const text = await extract(pdfPage(twoColumns(40, 82)));
    expect(text.length).toBeGreaterThan(6_500);
    expect(text.length).toBeLessThan(8_000);
    // What it holds by the text rule: more than a page (two columns of short lines), within the allowance.
    const holds = pageTextEquivalents(text);
    expect(holds).toBeGreaterThan(1);
    expect(holds).toBeLessThanOrEqual(DEFAULT_PAGE_EQUIVALENT_ALLOWANCE);
    const { state, document, runId, documentId } = await documentRun(1);
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", text))!;
    expect(measured).toMatchObject({ equivalents: holds, billed: 1, densePages: [] });
    expect(await billedFastPages(runId, documentId)).toBe(1);
  });

  it("a page at about 3.5 equivalents bills 4; a 3-equivalent page beside it bills 1", async () => {
    const { state, document, runId, documentId } = await documentRun(2);
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", `${"y".repeat(Math.round(3.5 * 3_500))}\f${"z".repeat(3 * 3_500)}`))!;
    expect(measured).toMatchObject({ equivalents: 7, billed: 5, densePages: [1] });
    expect((await store.loadDocument(documentId))!.billingPages).toBe(5);
    expect(await billedFastPages(runId, documentId)).toBe(5);
  });

  it("image frames get the same allowance; area still bills in full", async () => {
    vi.stubEnv("DOCSLURP_OCR_MAX_LONG_EDGE", "4000");
    try {
      const { state, document, documentId } = await documentRun(2, "image/tiff");
      const measured = (await recordExtractedPageEquivalents(state, document, "image", `${"w".repeat(2 * 3_500)}\fshort`, [
        { pageNumber: 2, sourceWidth: 8_000, sourceHeight: 8_000 }, // read at 4,000 px: 960 x 960 pt, 2 standard pages of area
      ]))!;
      expect(measured.billed).toBe(1 + 2);
      expect((await store.loadDocument(documentId))!.billingPages).toBe(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a twice-Letter page with little text bills 2: the allowance covers text, never area", async () => {
    expect(pageAreaEquivalentsPt(792, 1_224)).toBe(2);
    expect(billedPagePageEquivalents(1, 2)).toBe(2);
    expect(billedPagePageEquivalents(3, 2)).toBe(2); // text within the allowance, the area still counts
    const { state, document, runId, documentId } = await documentRun(1);
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", "A short caption on a tabloid page."))!;
    expect(measured).toMatchObject({ equivalents: 1, billed: 1 });
    // Its area arrives when the page is rendered (the raster cache's sink), under the same allowance.
    configurePageAreaSink(createPageAreaSink(sql(), store));
    await recordRenderedPageAreas(runId, document, [{ pageNumber: 1, area: pageAreaEquivalentsPt(792, 1_224) }]);
    expect((await store.loadDocument(documentId))!.billingPages).toBe(2);
    expect(await billedFastPages(runId, documentId)).toBe(2);
  });

  it("HTML and text keep the whole-document text rule: no allowance", async () => {
    const { state, document, documentId } = await documentRun(1, "text/html", { declaredMimeType: "text/html", sniffedMimeType: null, mimeType: "text/html", format: "html", container: null, encoding: "utf-8", mismatch: "none" });
    const measured = (await recordExtractedPageEquivalents(state, document, "html", "v".repeat(2 * 3_500)))!;
    expect(measured).toMatchObject({ equivalents: 2, billed: 2 });
    expect((await store.loadDocument(documentId))!.billingPages).toBe(2);
  });

  it("billing uses the installed pricing provider's allowance for paged formats, never for HTML", async () => {
    installTestPricing({ pageEquivalentAllowance: 1 });
    try {
      const paged = await documentRun(1);
      const pdf = (await recordExtractedPageEquivalents(paged.state, paged.document, "pdf", "u".repeat(2 * 3_500)))!;
      expect(pdf).toMatchObject({ equivalents: 2, billed: 2 });
      expect((await store.loadDocument(paged.documentId))!.billingPages).toBe(2);
    } finally {
      installTestPricing(DISTINCT_TEST_PRICING);
    }
    // The core default (3) again: the same page bills 1.
    const again = await documentRun(1);
    expect((await recordExtractedPageEquivalents(again.state, again.document, "pdf", "u".repeat(2 * 3_500)))!.billed).toBe(1);
  });
});

describe("whole-document text formats bill their true count from intake through completion (council F #1)", () => {
  const sentence = "The supplier shall deliver the goods to the buyer at the agreed place and time, as set out in schedule one. ";
  /** 35,000 characters of prose on one line: the text rule counts it as exactly 10 pages. */
  const text = sentence.repeat(Math.ceil(35_000 / sentence.length)).slice(0, 35_000);
  const textFacts = { declaredMimeType: "text/plain", sniffedMimeType: null, mimeType: "text/plain", format: "plain-text", container: null, encoding: "utf-8", mismatch: "none" };
  const htmlFacts = { declaredMimeType: "text/html", sniffedMimeType: null, mimeType: "text/html", format: "html", container: null, encoding: "utf-8", mismatch: "none" };

  it("a 35,000-character text file: intake counts 10, extraction measures 10, billing_pages is 10, never 19", async () => {
    // Intake (server source-metadata.ts nonPdfPageCount, under its sample size): the text rule over the decoded text, counted.
    const intake = textPageCount(text);
    expect(intake).toBe(10);
    const { state, document, runId, documentId } = await documentRun(intake, "text/plain", textFacts);
    const measured = (await recordExtractedPageEquivalents(state, document, "plain-text", text))!;
    expect(measured).toMatchObject({ pages: 1, equivalents: 10, billed: 10 });
    const stored = (await store.loadDocument(documentId))!;
    expect(stored.billingPages ?? stored.pageCount).toBe(10);
    expect(await billedFastPages(runId, documentId)).toBe(10);
    // A retry measures the same and changes nothing.
    await recordExtractedPageEquivalents(state, (await store.loadDocument(documentId))!, "plain-text", text);
    expect(await billedFastPages(runId, documentId)).toBe(10);
    // No per-page facts: a later rendered-area record cannot add the text a second time.
    expect((await db.query(`select count(*)::int as n from document_page_facts where document_id = '${documentId}' and text_equivalents is not null`)).rows).toEqual([{ n: 0 }]);
  });

  it("HTML: intake's markup-free count and the extracted text agree; billing_pages is the true count", async () => {
    const html = `<html><head><title>T</title></head><body>${Array.from({ length: 100 }, () => `<p>${sentence.repeat(3)}</p>`).join("")}</body></html>`;
    const intake = textPageCount(html, { markup: true });
    expect(intake).toBeGreaterThan(5);
    const { state, document, runId, documentId } = await documentRun(intake, "text/html", htmlFacts);
    const measured = (await recordExtractedPageEquivalents(state, document, "html", stripHtmlMarkup(html)))!;
    expect(measured.equivalents).toBe(intake);
    expect(await billedFastPages(runId, documentId)).toBe(intake);
  });

  it("a text file over intake's sample: format-detect counts it in full, extraction adds nothing on top", async () => {
    const { state, document, runId, documentId } = await documentRun(2, "text/plain", textFacts);
    // Quarantine scanned these bytes: the decision binds parsers to them (PR #339 R8-L1).
    const scanned = createHash("sha256").update(text).digest("hex");
    await db.exec(`update documents set page_count_source = 'assumed', parse_source_sha256 = '${scanned}' where id = '${documentId}'`);
    document.pageCountSource = "assumed";
    document.sourceSha256 = scanned;
    await recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: async () => new Uint8Array(Buffer.from(text)) });
    expect(document.pageCount).toBe(10);
    await recordExtractedPageEquivalents(state, document, "plain-text", text);
    expect(await billedFastPages(runId, documentId)).toBe(10);
  });

  it("extracted text that measures more than page_count bills the measured total, not page_count plus it", async () => {
    const { state, document, runId, documentId } = await documentRun(4, "text/plain", textFacts);
    const measured = (await recordExtractedPageEquivalents(state, document, "plain-text", text))!;
    expect(measured.billed).toBe(10);
    expect((await store.loadDocument(documentId))!.billingPages).toBe(10);
    expect(await billedFastPages(runId, documentId)).toBe(10);
  });

  it("form feeds in a text file are not pages: the text rule runs over the whole text", async () => {
    const { state, document, runId, documentId } = await documentRun(1, "text/plain", textFacts);
    await recordExtractedPageEquivalents(state, document, "plain-text", "a\fb\fc\fd");
    expect((await store.loadDocument(documentId))!.billingPages).toBeNull();
    expect(await billedFastPages(runId, documentId)).toBe(1);
  });
});

describe("rendered-area equivalents are authorized like every measured page (council F #2)", () => {
  afterEach(() => { setSpendCheckConfig(null); });

  /** A raster cache over a fake pdfinfo/pdftoppm: page 1 is 200 inches square, the rest Letter. Counts each command. */
  function rasterHarness() {
    const calls = { pdfinfo: 0, pdftoppm: 0 };
    const artifacts = new Map<string, Uint8Array>();
    const sources = new PdfSourceCache({
      async downloadToTempFile(_key: string, pattern: string) {
        const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "area-auth-"));
        const file = path.join(dir, pattern.replace("*", "src"));
        await writeFile(file, "pdf bytes");
        return file;
      },
    } as never);
    const runner = {
      async pdfPageSizes(_source: string, first: number, last: number) { return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
      async renderPdfPageRange(_source: string, prefix: string, first: number, last: number) { return { binary: "pdftoppm", args: [prefix, String(first), String(last)], available: true }; },
      async run(plan: { binary?: string; args: string[] }) {
        if (plan.binary === "pdfinfo") {
          calls.pdfinfo += 1;
          const [first, last] = plan.args.map(Number) as [number, number];
          const lines = [`Pages:           ${last}`];
          for (let page = first; page <= last; page += 1) lines.push(`Page ${String(page).padStart(4)} size: ${page === 1 ? "14400 x 14400" : "612 x 792"} pts`);
          return { stdout: lines.join("\n"), stderr: "" };
        }
        calls.pdftoppm += 1;
        const [prefix, first] = plan.args;
        await writeFile(`${prefix}-${first}.png`, "png");
        return { stdout: "", stderr: "" };
      },
    };
    const storage = {
      async objectSize(key: string) { return artifacts.get(key)?.byteLength ?? null; },
      async putBytes(key: string, bytes: Uint8Array) { artifacts.set(key, bytes); },
      uri(key: string) { return `s3://test/${key}`; },
    };
    return { calls, artifacts, cache: new PdfRasterCache(runner as never, storage as never, sources) };
  }
  const usageEvents = async (runId: string) => (await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = '${runId}'`)).rows[0]!.n;
  const runControl = async (runId: string) => (await db.query<{ control_state: string | null }>(`select control_state from project_runs where id = '${runId}'`)).rows[0]!.control_state;
  const balance = async (org: string) => Number((await db.query<{ c: string }>(`select credit_balance_cents::text as c from organizations where id = '${org}'`)).rows[0]!.c);

  it("an area-only increase on an unfunded run pauses it before anything renders, caches or charges", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    configurePageAreaSink(createPageAreaSink(sql(), store));
    const { document, runId, documentId } = await documentRun(2, "application/pdf", pdfFacts, { org: "o3", project: "w3" });
    const before = await balance("o3");
    const { calls, artifacts, cache } = rasterHarness();
    await expect(cache.renderSelectedPages({ document, runId, pageNumbers: [1, 2] })).rejects.toMatchObject({ name: "RunPolicyError" });
    expect(await runControl(runId)).toBe("paused");
    expect(calls.pdftoppm).toBe(0);
    expect(artifacts.size).toBe(0);
    expect(await usageEvents(runId)).toBe(0);
    expect(await balance("o3")).toBe(before);
    // The measurement is durable and the in-memory document carries it: page 1 at the cap plus page 2.
    expect(document.billingPages).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
    expect((await store.loadDocument(documentId))!.billingPages).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
  });

  it("a retry after a failed authorization authorizes again, though the count is already stored", async () => {
    const authorize = vi.fn();
    const real = createPageAreaSink(sql(), store);
    let failNext = true;
    configurePageAreaSink({
      record: real.record,
      authorize: async (runId: string, document: Document) => {
        authorize(document.billingPages);
        if (failNext) { failNext = false; throw new Error("spend check unavailable"); }
        await real.authorize(runId, document);
      },
    });
    const { runId, documentId } = await documentRun(2);
    const { calls, artifacts, cache } = rasterHarness();
    await expect(cache.renderSelectedPages({ document: (await store.loadDocument(documentId))!, runId, pageNumbers: [1, 2] })).rejects.toThrow("spend check unavailable");
    expect(artifacts.size).toBe(0);
    expect(calls.pdftoppm).toBe(0);
    // The retry loads the document with billing_pages already raised; it is authorized anyway, then renders.
    const retried = (await store.loadDocument(documentId))!;
    expect(retried.billingPages).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
    const pages = await cache.renderSelectedPages({ document: retried, runId, pageNumbers: [1, 2] });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(pages.map((page) => page.cacheHit)).toEqual([false, false]);
    expect(artifacts.size).toBe(2);
  });

  it("a cached render was authorized when it was cached: a hit measures and authorizes nothing again", async () => {
    const authorize = vi.fn();
    const real = createPageAreaSink(sql(), store);
    configurePageAreaSink({ record: real.record, authorize: async (runId: string, document: Document) => { authorize(); await real.authorize(runId, document); } });
    const { runId, documentId } = await documentRun(2);
    const { calls, cache } = rasterHarness();
    await cache.renderSelectedPages({ document: (await store.loadDocument(documentId))!, runId, pageNumbers: [1, 2] });
    expect(authorize).toHaveBeenCalledTimes(1);
    const again = await cache.renderSelectedPages({ document: (await store.loadDocument(documentId))!, runId, pageNumbers: [1, 2] });
    expect(again.every((page) => page.cacheHit)).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(calls).toEqual({ pdfinfo: 1, pdftoppm: 2 });
    expect(await billedFastPages(runId, documentId)).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
  });

  it("a page area that cannot be recorded leaves nothing cached, so the retry measures it", async () => {
    const real = createPageAreaSink(sql(), store);
    let failNext = true;
    configurePageAreaSink({
      record: async (args) => { if (failNext) { failNext = false; throw new Error("database unavailable"); } return await real.record(args); },
      authorize: real.authorize,
    });
    const { runId, documentId } = await documentRun(2);
    const { artifacts, cache } = rasterHarness();
    await expect(cache.renderSelectedPages({ document: (await store.loadDocument(documentId))!, runId, pageNumbers: [1, 2] })).rejects.toThrow("database unavailable");
    expect(artifacts.size).toBe(0);
    await cache.renderSelectedPages({ document: (await store.loadDocument(documentId))!, runId, pageNumbers: [1, 2] });
    expect((await store.loadDocument(documentId))!.billingPages).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
  });

  it("the native engine's renders are authorized the same way: an unfunded run caches nothing", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    configurePageAreaSink(createPageAreaSink(sql(), store));
    const { document, runId } = await documentRun(2, "application/pdf", pdfFacts, { org: "o3", project: "w3" });
    const png = (width: number, height: number) => {
      const buf = Buffer.alloc(33);
      buf.write("\x89PNG\r\n\x1a\n", 0, "latin1");
      buf.writeUInt32BE(width, 16);
      buf.writeUInt32BE(height, 20);
      return buf;
    };
    const engine = {
      id: "fake",
      version: () => ({ engine: "native-pdf", version: "0", gitSha: "x", features: [] }),
      async openPath() {
        return {
          pageCount: async () => 2,
          metadata: async () => ({ encrypted: false }),
          close: async () => undefined,
          page: (index: number) => ({
            size: async () => ({ widthPt: index === 0 ? 14_400 : 612, heightPt: index === 0 ? 14_400 : 792, rotation: 0 }),
            render: async () => (index === 0 ? png(6_000, 6_000) : png(1_275, 1_650)),
          }),
        };
      },
    };
    const artifacts = new Map<string, Uint8Array>();
    const sources = new PdfSourceCache({
      async downloadToTempFile(_key: string, pattern: string) {
        const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "area-native-"));
        const file = path.join(dir, pattern.replace("*", "src"));
        await writeFile(file, "pdf bytes");
        return file;
      },
    } as never);
    const cache = new PdfRasterCache({} as never, {
      async objectSize(key: string) { return artifacts.get(key)?.byteLength ?? null; },
      async putBytes(key: string, bytes: Uint8Array) { artifacts.set(key, bytes); },
      uri(key: string) { return `s3://test/${key}`; },
    } as never, sources, { engine: "native-pdf", loadEngine: async () => engine as never });
    await expect(cache.renderSelectedPages({ document, runId, dpi: 150, pageNumbers: [1, 2] })).rejects.toMatchObject({ name: "RunPolicyError" });
    expect(artifacts.size).toBe(0);
    expect(await runControl(runId)).toBe("paused");
    expect(document.billingPages).toBeGreaterThan(2);
  });

  it("the worker refuses to start with a database but no store to authorize rendered areas", async () => {
    const { createStages } = await import("../stages/index.js");
    expect(() => createStages({ runner: {} as never, storage: {} as never, config: {} as never, sql: sql() as never })).toThrow(/need a store/);
  });
});

describe("VM-extracted page areas bill from the layout facts' page boxes (real-Modal finding F4)", () => {
  afterEach(() => { setSpendCheckConfig(null); });
  const facts = (pages: Array<Record<string, unknown>>) => parsePageLayoutFacts({ version: "pdf-layout-facts@1", pages: pages.map((page) => ({ known: true, words: 3, ...page })) });

  it("a twice-Letter page with little text bills 2; Letter pages bill 1", async () => {
    const { state, document, runId, documentId } = await documentRun(2);
    const sizes = facts([{ pageNumber: 1, widthPt: 792, heightPt: 1224 }, { pageNumber: 2, widthPt: 612, heightPt: 792 }]);
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", "A short caption\fAnother short page", [], { pageSizesPt: sizes }))!;
    expect(measured).toMatchObject({ pages: 2, equivalents: 3, billed: 3 });
    expect((await store.loadDocument(documentId))!.billingPages).toBe(3);
    expect(await billedFastPages(runId, documentId)).toBe(3);
  });

  it("the area increase is authorized: an unfunded run pauses", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const { state, document, runId } = await documentRun(1, "application/pdf", pdfFacts, { org: "o3", project: "w3" });
    await expect(recordExtractedPageEquivalents(state, document, "pdf", "caption", [], { pageSizesPt: facts([{ pageNumber: 1, widthPt: 14_400, heightPt: 14_400 }]) }))
      .rejects.toMatchObject({ name: "RunPolicyError" });
    expect((await db.query<{ control_state: string }>(`select control_state from project_runs where id = '${runId}'`)).rows[0]!.control_state).toBe("paused");
  });

  it("a blank trailing page keeps its slot and bills its area: Doppler's \"caption\\f\" with a 4-Letter page 2 bills 5 (council H)", async () => {
    const { state, document, runId, documentId } = await documentRun(2);
    const sizes = facts([{ pageNumber: 1, widthPt: 612, heightPt: 792 }, { pageNumber: 2, widthPt: 1224, heightPt: 1584 }]);
    expect(processedPdfPages("caption\f", "vm-pdf")).toBe(2);
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", "caption\f", [], { extractor: "vm-pdf", pageSizesPt: sizes }))!;
    expect(measured).toMatchObject({ pages: 2, billed: 5 });
    expect((await store.loadDocument(documentId))!.billingPages).toBe(5);
    expect(await billedFastPages(runId, documentId)).toBe(5);
  });

  it("leading blank pages before a frontmatter-looking page keep their slots through the sanitizer: every page's area bills (council I #2)", async () => {
    const { state, document, documentId } = await documentRun(5);
    const raw = "\n\f\n\f\n---\ntitle: x\n---\nbody\fBIG\fBIG";
    const { markdown, strippedFrontmatterLines } = sanitizeExtractedMarkdown(raw);
    expect(strippedFrontmatterLines).toBe(0);
    expect(processedPdfPages(markdown, "vm-pdf")).toBe(5);
    const sizes = facts([4, 5].map((pageNumber) => ({ pageNumber, widthPt: 1224, heightPt: 1584 })));
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", markdown, [], { extractor: "vm-pdf", pageSizesPt: sizes }))!;
    expect(measured).toMatchObject({ pages: 5, billed: 1 + 1 + 1 + 4 + 4 });
    expect((await store.loadDocument(documentId))!.billingPages).toBe(11);
  });

  it("several trailing blank pages each keep their slot and area; the rows match the processed count", async () => {
    const { state, document, documentId } = await documentRun(4);
    const markdown = "caption\f\f\f";
    expect(splitProcessedPdfPages(markdown, "doppler-md")).toHaveLength(processedPdfPages(markdown, "doppler-md"));
    expect(processedPdfPages(markdown, "doppler-md")).toBe(4);
    const sizes = facts([3, 4].map((pageNumber) => ({ pageNumber, widthPt: 1224, heightPt: 792 })));
    const measured = (await recordExtractedPageEquivalents(state, document, "pdf", markdown, [], { extractor: "doppler-md", pageSizesPt: sizes }))!;
    expect(measured).toMatchObject({ pages: 4, billed: 1 + 1 + 2 + 2 });
    expect((await store.loadDocument(documentId))!.billingPages).toBe(6);
    // pdftotext terminates every page: the same text from poppler-text is 3 pages, the last blank.
    expect(splitProcessedPdfPages(markdown, "poppler-text")).toEqual(["caption", "", ""]);
  });

  it("a blank trailing page's area is authorized: an unfunded run pauses", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const { state, document, runId } = await documentRun(2, "application/pdf", pdfFacts, { org: "o3", project: "w3" });
    await expect(recordExtractedPageEquivalents(state, document, "pdf", "caption\f", [],
      { extractor: "vm-pdf", pageSizesPt: facts([{ pageNumber: 2, widthPt: 14_400, heightPt: 14_400 }]) })).rejects.toMatchObject({ name: "RunPolicyError" });
    expect((await db.query<{ control_state: string }>(`select control_state from project_runs where id = '${runId}'`)).rows[0]!.control_state).toBe("paused");
  });

  it("parses the walker's page box, bounded; an unknown or hostile size bills no area", () => {
    const parsed = facts([{ pageNumber: 1, widthPt: 792, heightPt: 1224 }, { pageNumber: 2, widthPt: 1e9, heightPt: 792 }, { pageNumber: 3, widthPt: -5, heightPt: 10 }, { pageNumber: 4 }]);
    expect(parsed.get(1)).toMatchObject({ widthPt: 792, heightPt: 1224 });
    for (const page of [2, 3, 4]) expect(parsed.get(page)?.widthPt).toBeUndefined();
  });
});

