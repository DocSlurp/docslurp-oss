import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DENSE_PAGE_EQUIVALENTS, PAGE_AREA_EQUIVALENTS_CAP, defaultPipelineFeatures, imageAreaEquivalents, measuredTextPages, pageAreaEquivalentsPt,
  pageTextEquivalents, stripHtmlMarkup, billedPageEquivalents, billedPagePageEquivalents, DEFAULT_PAGE_EQUIVALENT_ALLOWANCE, DISTINCT_TEST_PRICING, installTestPricing,
} from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { Store } from "../db/store.js";
import { recordPageEquivalents } from "../db/page-equivalents.js";
import { measureExtractedPages } from "../lib/office-page-count.js";
import { MAX_PAGE_EQUIVALENTS, recordExtractedPageEquivalents } from "../lib/page-equivalents.js";
import { configurePageAreaSink, recordRenderedPageAreas } from "../pipeline/page-area-sink.js";
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
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000000);
    insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W');
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
/** A run with one counted document of `pages` pages; returns its state. */
async function documentRun(pages: number, mime = "application/pdf", facts: object = pdfFacts) {
  seq += 1;
  const runId = `run-${seq}`, documentId = `doc-${seq}`;
  await db.exec(`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('${runId}', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 1, ${pages});
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts)
      values ('${documentId}', 'o1', 'u1', 'w1', '${runId}', 'f', '${mime}', 'raw/${documentId}', 'processing', ${pages}, 'counted', '${JSON.stringify(facts)}');`);
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
    expect(imageAreaEquivalents(1275, 1650)).toBe(1); // Letter at 150 dpi
    expect(imageAreaEquivalents(20_000, 20_000)).toBe(PAGE_AREA_EQUIVALENTS_CAP);
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
    configurePageAreaSink((rows) => recordPageEquivalents(sql(), rows));
    await recordRenderedPageAreas(runId, documentId, [{ pageNumber: 1, area: pageAreaEquivalentsPt(14_400, 14_400) }, { pageNumber: 2, area: pageAreaEquivalentsPt(612, 792) }]);
    // Page 1 counts as the cap, page 2 as one page.
    expect((await store.loadDocument(documentId))!.billingPages).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
    expect(await billedFastPages(runId, documentId)).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
    // A second render of the same page records nothing more.
    await recordRenderedPageAreas(runId, documentId, [{ pageNumber: 1, area: PAGE_AREA_EQUIVALENTS_CAP }]);
    expect((await store.loadDocument(documentId))!.billingPages).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
  });

  it("an uploaded image's frames count their decoded area as well as their text", async () => {
    const image = { declaredMimeType: "image/tiff", sniffedMimeType: "image/tiff", mimeType: "image/tiff", format: "image", container: null, encoding: null, mismatch: "none" };
    const { state, document, runId, documentId } = await documentRun(2, "image/tiff", image);
    const measured = (await recordExtractedPageEquivalents(state, document, "image", "frame one\fframe two",
      [{ pageNumber: 1, sourceWidth: 20_000, sourceHeight: 20_000 }, { pageNumber: 2, sourceWidth: 1_000, sourceHeight: 1_000 }]))!;
    expect(measured.equivalents).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
    expect((await store.loadDocument(documentId))!.billingPages).toBe(PAGE_AREA_EQUIVALENTS_CAP + 1);
    expect(runId).toBeTruthy();
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
    const { state, document, documentId } = await documentRun(2, "image/tiff");
    const measured = (await recordExtractedPageEquivalents(state, document, "image", `${"w".repeat(2 * 3_500)}\fshort`, [
      { pageNumber: 2, sourceWidth: 2_550, sourceHeight: 3_300 }, // Letter at 300 dpi read at 150: 4 standard pages of area
    ]))!;
    expect(measured.billed).toBe(1 + 4);
    expect((await store.loadDocument(documentId))!.billingPages).toBe(5);
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
