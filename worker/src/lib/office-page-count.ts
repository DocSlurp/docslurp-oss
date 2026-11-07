import {
  DOCUMENT_FEATURES,
  estimateProfileFor,
  featureCredits,
  pageCredits,
  speedBoostMultiplier,
  textPageCount,
  type PipelineFeatures,
} from "@docslurp/shared";

import type { Document } from "../models.js";
import { RunPolicyError } from "./document-failure.js";

/**
 * Real page counts for formats whose page count the server cannot know at intake (it counts Office, EPUB and spreadsheet files
 * as one page). The worker counts them from the Markdown the document's extractor already produced, in the parser sandbox, for
 * extract-markdown; counting runs no parser of its own and never reads the source file on the host:
 *
 *  - PowerPoint: slides, the form-feed-separated pages of the python-pptx extractor's output (`slides`);
 *  - spreadsheets: each sheet's table cells under the text rule (60 lines or 3,500 characters), summed (`sheet-rows`);
 *  - Word, OpenDocument, RTF, EPUB (and any other extractor's output): the text rule over the Markdown (`text-rule`).
 *
 * A long document is never left at the intake count of one page. Earlier counts (`pdf-conversion`, `text-pages`,
 * `size-estimate`) can still be on stored documents; features and billing read them as before.
 */
/**
 * `empty`: the extractor read no text at all, so the file measured 0 pages; it bills no page fee and no feature, never intake's
 * assumed page.
 */
export type PageCountMethod = "slides" | "sheet-rows" | "text-rule" | "empty";
export interface PageCountResult { pages: number; method: PageCountMethod }

/** Hard ceiling for a measured count: more than this is a parser fault, not a document. */
export const MAX_COUNTED_PAGES = 100_000;
/** Counting reads at most this many characters of the extractor's Markdown (a page is 3,500). */
const MAX_COUNTED_TEXT_CHARS = MAX_COUNTED_PAGES * 3_500;

function bounded(pages: number): number | null {
  return Number.isFinite(pages) && pages >= 1 ? Math.min(MAX_COUNTED_PAGES, Math.floor(pages)) : null;
}

/** Whether `format` is one whose page count the worker measures (everything the server counted as one page). */
export function formatNeedsMeasuredPages(format: string | undefined): boolean {
  return format === "office-word" || format === "office-other" || format === "office-pptx" || format === "office-excel" || format === "epub";
}

/**
 * The lines of `text` that hold something: a blank line, or a line of only separators (the commas of a spreadsheet row with no
 * cells, a lone quote), is not read. Empty spreadsheet rows, in particular, must not bill as pages of text.
 */
export function contentLines(text: string): string {
  return text.split(/\r?\n/).filter((line) => /[^\s,"';\t|]/.test(line)).join("\n");
}

/**
 * The text a sheet's CSV holds: each record's non-empty cells, one record a line, cells joined by a space. Separators and empty
 * cells are not read, so a row padded out to a far column (openpyxl pads every row to the sheet's widest one; one stray cell at XFD1
 * makes 16,383 commas a row) counts what its cells hold, not the width of the sheet. Quoted cells may hold commas and newlines.
 */
export function csvCellText(csv: string): string {
  const lines: string[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  const endCell = () => {
    const value = cell.trim();
    if (value) cells.push(value);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    if (cells.length) lines.push(cells.join(" "));
    cells = [];
  };
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (csv[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = false;
    } else if (char === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (char === ",") endCell();
    else if (char === "\n") endRecord();
    else if (char !== "\r") cell += char;
  }
  endRecord();
  return lines.join("\n");
}

/** Pages of one text split into chunks that each already fit the text rule, summed as one body of text. */
export function textBodyPages(bodies: readonly string[]): number {
  return Math.max(1, bodies.reduce((total, body) => {
    const content = contentLines(body);
    return total + (content.trim() ? textPageCount(content) : 0);
  }, 0));
}

/**
 * Where the spreadsheet extractor's appendix (office_markdown.py: formula source, then source context) starts. Each opens with a
 * heading followed by a prose line; a sheet section is only its `## name` heading and table rows (`| ...`), so no sheet name or
 * cell can produce these markers and move the cut.
 */
const SHEET_APPENDIX_MARKERS = [
  "\n## Spreadsheet formula source\n\nFormulas are source expressions.",
  "\n## Office source context\n\nSource-authored metadata",
];

/** The cells of one GFM table row (`| a | b\\|c |`), unescaped; null when the line is not a table row. */
function gfmRowCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (char === "\\" && index + 1 < trimmed.length) { cell += trimmed[index + 1]; index += 1; }
    else if (char === "|") { cells.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}

/**
 * The text each sheet's table holds, one entry a sheet, from the spreadsheet extractor's Markdown: each row's non-empty cells joined
 * by a space (a cell's line breaks, written `<br>`, stay line breaks), the header separator row and the appendix not read. The same
 * text the CSV rule read (csvCellText), so a sheet bills by what its cells hold.
 */
export function sheetCellTexts(markdown: string): string[] {
  const cut = Math.min(...SHEET_APPENDIX_MARKERS.map((marker) => {
    const at = markdown.indexOf(marker);
    return at < 0 ? markdown.length : at;
  }));
  const sheets: string[][] = [];
  for (const line of markdown.slice(0, cut).split(/\r?\n/)) {
    if (line.startsWith("## ") || sheets.length === 0) sheets.push([]);
    const cells = gfmRowCells(line);
    if (!cells || cells.every((cell) => /^:?-{3,}:?$/.test(cell) || cell === "")) continue;
    const text = cells.filter(Boolean).join(" ").replace(/<br>/g, "\n");
    if (text) sheets[sheets.length - 1]!.push(text);
  }
  return sheets.map((rows) => rows.join("\n")).filter((text) => text.trim() !== "");
}

/**
 * The measured page count of a document from its extractor's Markdown; null only for a format not measured this way. There is
 * always a measurement: text is counted (slides, sheet rows, else the text rule), and no text at all is 0 pages (`empty`). An
 * Office, slide, sheet or EPUB file therefore never bills on intake's assumed page. `extractor` is the winning extractor's id: only
 * python-pptx's output marks slides, and only the spreadsheet extractor's output is sheet tables.
 */
export function measureExtractedPages(format: string, extractor: string, markdown: string): PageCountResult | null {
  if (!formatNeedsMeasuredPages(format)) return null;
  const text = markdown.length > MAX_COUNTED_TEXT_CHARS ? markdown.slice(0, MAX_COUNTED_TEXT_CHARS) : markdown;
  if (!text.trim()) return { pages: 0, method: "empty" };
  if (format === "office-pptx" && extractor === "pptx") {
    // Each slide is at least one page, and as many as its text fills by the text rule: a single slide holding a book's worth
    // of text bills that text, not one page.
    const slides = text.replace(/\f\s*$/, "").split("\f");
    const pages = bounded(slides.reduce((total, slide) => {
      const content = contentLines(slide);
      return total + Math.max(1, content.trim() ? textPageCount(content, { markup: true }) : 0);
    }, 0));
    return pages ? { pages, method: "slides" } : null;
  }
  if (format === "office-excel" && extractor === "xlsx") {
    const sheets = sheetCellTexts(text);
    const pages = sheets.length ? bounded(textBodyPages(sheets)) : null;
    // A spreadsheet extractor that wrote text but no sheet tables is counted by the text rule below.
    if (pages) return { pages, method: "sheet-rows" };
  }
  const content = contentLines(text);
  const pages = content.trim() ? bounded(textPageCount(content, { markup: true })) : null;
  return pages ? { pages, method: "text-rule" } : { pages: 0, method: "empty" };
}

/**
 * Credits a run newly owes once a document measures at `measuredPages` where admission priced `intakePages`: the Fast page fee on the
 * extra pages, and each enabled per-page feature on them, times the speed boost. Zero when the count did not grow. Page reads by a model
 * are not included (they bill as they happen). A count guessed from the file's size prices no feature (feature-charges.ts featurePages).
 */
export function extraCreditsForMeasuredPages(
  pipeline: PipelineFeatures,
  intakePages: number,
  measuredPages: number,
  method?: string | null,
  options: { features?: boolean; mode?: "fast" | "rich" } = {},
): number {
  const before = Math.max(1, intakePages);
  if (!(measuredPages > before)) return 0;
  const features = estimateProfileFor(pipeline, { env: {} }).documentFeatures;
  // Office pages bill Fast; a multi-frame image's frames are each read by OCR and bill Rich.
  let credits = pageCredits(options.mode ?? "fast", measuredPages - before);
  if (options.features !== false && method !== "size-estimate") {
    for (const feature of DOCUMENT_FEATURES) {
      if (features[feature]) credits += featureCredits(feature, measuredPages) - featureCredits(feature, before);
    }
  }
  return credits * speedBoostMultiplier(pipeline.speedBoost === true);
}

/** A document of the run the worker measured: intake's count, the measured one and how it was found. */
export interface MeasuredRunDocument { pageCount: number; billingPages: number; method: string | null }

/**
 * Measures the document's pages from its extractor's Markdown (measureExtractedPages) and records them as `documents.billing_pages`
 * (and on the in-memory document) before billing reads them. The page basis (`page_count`, what the text splits into) is left
 * alone: these formats' text has no page breaks, so replacing it would make the page index drop every page. When there is nothing
 * to count the document bills its intake count.
 */
export async function recordMeasuredPageCount(
  state: {
    run: { id: string; orgId?: string | null; userId?: string; projectId?: string; pipeline?: PipelineFeatures };
    store?: {
      setDocumentBillingPages?(runId: string, documentId: string, billingPages: number, method: string): Promise<boolean>;
      enforceSpendForCharge?(run: { id: string; orgId: string | null; projectId?: string | null; userId: string }, credits: number): Promise<{ paused: boolean; blocked?: boolean }>;
      measuredRunDocuments?(runId: string): Promise<MeasuredRunDocument[]>;
    } | null;
  },
  document: Document,
  format: string,
  extracted: { extractor: string; markdown: string } | PageCountResult | null,
): Promise<{ pages: number | null; method: PageCountMethod | null; intakePages: number }> {
  const intakePages = document.pageCount;
  if (!formatNeedsMeasuredPages(format)) return { pages: null, method: null, intakePages };
  // A measured count is passed straight through (a deduplicated copy reuses its original's count).
  const counted = extracted === null ? null : "pages" in extracted ? extracted : measureExtractedPages(format, extracted.extractor, extracted.markdown);
  if (!counted) return { pages: null, method: null, intakePages };
  // Never bill below the page basis: an extractor that reads less than intake counted does not lower the bill.
  // Never bill below a page basis intake counted from the bytes; an assumed intake (these formats' one page) is no floor, so an
  // empty file measures 0 pages.
  const floor = document.pageCountSource === "counted" ? Math.max(1, Math.floor(intakePages) || 1) : 0;
  const measured: PageCountResult = { pages: Math.max(counted.pages, floor), method: counted.method };
  console.log(`[page-count] document=${document.id} format=${format} counted by ${measured.method}: ${measured.pages} pages (intake ${intakePages})`);
  if (!state.store?.setDocumentBillingPages) throw new Error("page count measured but the store cannot persist it");
  await state.store.setDocumentBillingPages(state.run.id, document.id, measured.pages, measured.method);
  document.billingPages = measured.pages;
  document.billingPagesMethod = measured.method;
  // Admission priced the intake count (one page for these formats). When the measured count is far above it, the credits the run
  // now owes may not fit the balance: check again here and pause the run instead of finding out when the completion fee is charged.
  // The Fast fee on those pages is charged only when the run completes, so the balance shows no measured document's extra pages
  // yet: the check adds the Fast extra of every document of the run measured so far, not just this one, or ten large files that each
  // fit the balance would together overdraw it. Features are charged as their stages run (and checked at those checkpoints), so
  // only this document's feature extra is added.
  if (state.store.enforceSpendForCharge && state.run.pipeline && state.run.userId) {
    const pipeline = state.run.pipeline;
    const own = extraCreditsForMeasuredPages(pipeline, intakePages, measured.pages, measured.method);
    if (own > 0) {
      const ownFast = extraCreditsForMeasuredPages(pipeline, intakePages, measured.pages, measured.method, { features: false });
      const measuredDocuments = state.store.measuredRunDocuments ? await state.store.measuredRunDocuments(state.run.id) : [];
      const runFast = measuredDocuments.reduce((sum, row) => sum + extraCreditsForMeasuredPages(pipeline, row.pageCount, row.billingPages, row.method, { features: false }), 0);
      // The run's rows include this document once it is recorded; never count less than this document alone.
      const extra = own - ownFast + Math.max(ownFast, runFast);
      const outcome = await state.store.enforceSpendForCharge({ id: state.run.id, orgId: state.run.orgId ?? null, projectId: state.run.projectId, userId: state.run.userId }, extra);
      if (outcome.paused || outcome.blocked) {
        console.warn(`[page-count] run=${state.run.id} document=${document.id} stopped (paused=${outcome.paused}): measured ${measured.pages} pages (intake ${intakePages}) owes ${extra.toFixed(2)} more credits than the balance holds`);
        throw new RunPolicyError(`Credits do not cover the measured pages of document ${document.id}; run ${outcome.paused ? "paused" : "stopped"}`);
      }
    }
  }
  return { pages: measured.pages, method: measured.method, intakePages };
}
