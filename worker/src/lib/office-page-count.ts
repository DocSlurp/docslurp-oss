import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  DOCUMENT_FEATURES,
  estimateProfileFor,
  featureCredits,
  listZipEntryNames,
  pageCredits,
  pagesFromSize,
  speedBoostMultiplier,
  textPageCount,
  workerCountedFormat,
  type PipelineFeatures,
  type WorkerCountedFormat,
} from "@docslurp/shared";

import type { Document } from "../models.js";
import type { CommandRunner } from "../tools/runner.js";

/**
 * Real page counts for formats whose page count the server cannot know at intake (it counts Office, EPUB and spreadsheet files
 * as one page). The worker measures them after converting, so billing and progress read the count of what is actually read:
 *
 *  - Word, OpenDocument, RTF and legacy Office files: pages of the file converted to PDF (LibreOffice, in the sandbox);
 *  - PowerPoint: slides;
 *  - spreadsheets: the pages of each sheet's non-empty CSV rows under the text rule (60 lines or 3,500 characters), summed;
 *  - EPUB: the text rule over the chapters' text.
 *
 * When LibreOffice is not on the worker (the lean production image has none) a Word, RTF or legacy .doc file is counted by the
 * same text rule over its extracted text (`text-rule`); a file no text tool reads falls back to its size at the format's typical
 * bytes per page (`size-estimate`). A long document is never left at the intake count of one page.
 */
export type PageCountMethod = "pdf-conversion" | "slides" | "sheet-rows" | "text-pages" | "text-rule" | "size-estimate";
export interface PageCountResult { pages: number; method: PageCountMethod }

/** Hard ceiling for a measured count: more than this is a parser fault, not a document. */
export const MAX_COUNTED_PAGES = 100_000;
const CONVERT_TIMEOUT_MS = 180_000;
/** Extracted text is read from a sandboxed tool's stdout; counting stops reading past this many characters (a page is 3,500). */
const MAX_COUNTED_TEXT_CHARS = MAX_COUNTED_PAGES * 3_500;

export interface PageCountDeps {
  runner: Pick<CommandRunner, "run" | "officeToPdf" | "pdfInfo" | "pptxExtract" | "xlsxExtractPy" | "epubExtract" | "mammothMarkdown" | "docToText" | "rtfToHtml">;
  /** Downloads the document's source to a local temp file and returns its path (callers delete it). */
  downloadSource: (document: Document) => Promise<string>;
  signal?: AbortSignal;
}

/** Bounds a sandboxed command; the caller's abort signal still applies. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function parsePdfInfoPages(stdout: string): number | null {
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  const pages = match ? Number.parseInt(match[1]!, 10) : NaN;
  return Number.isSafeInteger(pages) && pages > 0 ? pages : null;
}

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

async function pdfPagesOfConversion(deps: PageCountDeps, sourcePath: string): Promise<number | null> {
  const outdir = await mkdtemp(path.join(path.dirname(sourcePath), "pages-"));
  try {
    const signal = withTimeout(deps.signal, CONVERT_TIMEOUT_MS);
    const convert = await deps.runner.officeToPdf(sourcePath, outdir);
    if (!convert.available) return null;
    await deps.runner.run(convert, signal);
    const pdf = path.join(outdir, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
    if (!(await stat(pdf).then((entry) => entry.isFile(), () => false))) return null;
    const info = await deps.runner.pdfInfo(pdf);
    if (!info.available) return null;
    return parsePdfInfoPages((await deps.runner.run(info, signal)).stdout);
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
}

async function sidecarJson(deps: PageCountDeps, sourcePath: string, suffix: string, plan: (output: string) => ReturnType<PageCountDeps["runner"]["pptxExtract"]>): Promise<unknown | null> {
  const output = `${sourcePath}.${suffix}.json`;
  try {
    const command = await plan(output);
    if (!command.available) return null;
    await deps.runner.run(command, withTimeout(deps.signal, 120_000));
    return JSON.parse(await readFile(output, "utf8"));
  } finally {
    await rm(output, { force: true });
  }
}

/** The text of a Word, RTF or legacy .doc file from the sandboxed text tools the lean worker image has, or null. */
async function extractedTextForCounting(deps: PageCountDeps, document: Document, sourcePath: string, format: string): Promise<{ text: string; markup: boolean } | null> {
  const extension = path.extname(document.filename).toLowerCase();
  const attempt = async <T>(read: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      console.warn(`[page-count] text extraction unavailable document=${document.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  if (format === "office-word" && extension !== ".doc") {
    const payload = await attempt(() => sidecarJson(deps, sourcePath, "mammoth", (output) => deps.runner.mammothMarkdown(sourcePath, output))) as { text?: unknown } | null;
    if (typeof payload?.text === "string") return { text: payload.text.slice(0, MAX_COUNTED_TEXT_CHARS), markup: false };
  }
  if (extension === ".rtf") {
    const html = await attempt(async () => {
      const plan = await deps.runner.rtfToHtml(sourcePath);
      return plan.available ? (await deps.runner.run(plan, withTimeout(deps.signal, 120_000))).stdout : null;
    });
    if (html !== null) return { text: html.slice(0, MAX_COUNTED_TEXT_CHARS), markup: true };
  }
  if (extension === ".doc") {
    const text = await attempt(async () => {
      const plan = await deps.runner.docToText(sourcePath);
      return plan.available ? (await deps.runner.run(plan, withTimeout(deps.signal, 120_000))).stdout : null;
    });
    if (text !== null) return { text: text.slice(0, MAX_COUNTED_TEXT_CHARS), markup: false };
  }
  return null;
}

/** The measured page count of a converted document, or null when it could not be measured at all. */
export async function measureDocumentPages(deps: PageCountDeps, document: Document, format: string): Promise<PageCountResult | null> {
  if (!formatNeedsMeasuredPages(format)) return null;
  const sourcePath = await deps.downloadSource(document);
  try {
    if (format === "office-pptx" && !/\.ppt$/i.test(document.filename)) {
      // Slides: the container's own slide parts, read from the ZIP directory without inflating anything.
      const bytes = await readFile(sourcePath);
      const slides = listZipEntryNames(bytes)?.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length ?? 0;
      const pages = bounded(slides);
      if (pages) return { pages, method: "slides" };
      const payload = await sidecarJson(deps, sourcePath, "pptx", (output) => deps.runner.pptxExtract(sourcePath, output)) as { slideCount?: number; slides?: unknown[] } | null;
      const counted = bounded(Number(payload?.slideCount) || payload?.slides?.length || 0);
      return counted ? { pages: counted, method: "slides" } : null;
    }
    if (format === "office-excel" && !/\.xls$/i.test(document.filename)) {
      const payload = await sidecarJson(deps, sourcePath, "xlsx", (output) => deps.runner.xlsxExtractPy(sourcePath, output)) as { sheets?: Array<{ csv?: unknown }> } | null;
      if (!payload || !Array.isArray(payload.sheets)) return null;
      // Sheets bill by the text their cells hold, never by the characters of the CSV that carries them.
      const pages = bounded(textBodyPages(payload.sheets.map((sheet) => (typeof sheet.csv === "string" ? csvCellText(sheet.csv) : ""))));
      return pages ? { pages, method: "sheet-rows" } : null;
    }
    if (format === "epub") {
      const payload = await sidecarJson(deps, sourcePath, "epub", (output) => deps.runner.epubExtract(sourcePath, output)) as { chapters?: Array<{ text?: unknown }> } | null;
      if (!payload || !Array.isArray(payload.chapters)) return null;
      const pages = bounded(textBodyPages(payload.chapters.map((chapter) => (typeof chapter.text === "string" ? chapter.text : ""))));
      return pages ? { pages, method: "text-pages" } : null;
    }
    // Word, OpenDocument, RTF, legacy .doc/.ppt/.xls: the layout engine decides the pages.
    let converted: number | null = null;
    try {
      converted = await pdfPagesOfConversion(deps, sourcePath);
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      console.warn(`[page-count] conversion unavailable document=${document.id} format=${format}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pages = bounded(converted ?? 0);
    if (pages) return { pages, method: "pdf-conversion" };
    // No layout engine (the lean worker image has no LibreOffice) or it failed: count the text the file holds, by the text rule.
    const extracted = await extractedTextForCounting(deps, document, sourcePath, format);
    if (extracted) {
      const content = contentLines(extracted.text);
      const textPages = bounded(content.trim() ? textPageCount(content, { markup: extracted.markup }) : 1);
      if (textPages) return { pages: textPages, method: "text-rule" };
    }
    // No text tool read it either: its size at the format's typical bytes per page, never the one page intake assumed.
    const size = await stat(sourcePath).then((entry) => entry.size, () => 0);
    const counted = workerCountedFormat({ name: document.filename, type: document.mimeType }) ?? (format as WorkerCountedFormat);
    const estimated = size > 0 ? bounded(pagesFromSize(counted, size)) : null;
    return estimated ? { pages: estimated, method: "size-estimate" } : null;
  } finally {
    await rm(sourcePath, { force: true });
    await rm(path.dirname(sourcePath), { recursive: true, force: true }).catch(() => undefined);
  }
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
  options: { features?: boolean } = {},
): number {
  const before = Math.max(1, intakePages);
  if (!(measuredPages > before)) return 0;
  const features = estimateProfileFor(pipeline, { env: {} }).documentFeatures;
  let credits = pageCredits("fast", measuredPages - before);
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
 * Measures the document's pages and records them as `documents.billing_pages` (and on the in-memory document) before billing reads
 * them. The page basis (`page_count`, what the text splits into) is left alone: these formats' text has no page breaks, so
 * replacing it would make the page index drop every page. Best effort: when the count cannot be measured at all the document bills
 * its intake count and the stage reports why.
 */
export async function recordMeasuredPageCount(
  state: {
    run: { id: string; orgId?: string | null; userId?: string; workspaceId?: string; pipeline?: PipelineFeatures };
    store?: {
      setDocumentBillingPages?(runId: string, documentId: string, billingPages: number, method: string): Promise<boolean>;
      enforceSpendForCharge?(run: { id: string; orgId: string | null; workspaceId?: string | null; userId: string }, credits: number): Promise<{ paused: boolean }>;
      measuredRunDocuments?(runId: string): Promise<MeasuredRunDocument[]>;
    } | null;
  },
  deps: PageCountDeps,
  document: Document,
  format: string,
): Promise<{ pages: number | null; method: PageCountMethod | null; intakePages: number }> {
  const intakePages = document.pageCount;
  if (!formatNeedsMeasuredPages(format)) return { pages: null, method: null, intakePages };
  let measured: PageCountResult | null = null;
  try {
    measured = await measureDocumentPages(deps, document, format);
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    console.warn(`[page-count] unavailable document=${document.id} format=${format}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!measured) return { pages: null, method: null, intakePages };
  if (measured.method !== "pdf-conversion" && measured.method !== "slides") {
    console.warn(`[page-count] document=${document.id} format=${format} counted by ${measured.method}: ${measured.pages} pages (intake ${intakePages})`);
  }
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
      const outcome = await state.store.enforceSpendForCharge({ id: state.run.id, orgId: state.run.orgId ?? null, workspaceId: state.run.workspaceId, userId: state.run.userId }, extra);
      if (outcome.paused) console.warn(`[page-count] run=${state.run.id} document=${document.id} paused: measured ${measured.pages} pages (intake ${intakePages}) owes ${extra.toFixed(2)} more credits than the balance holds`);
    }
  }
  return { pages: measured.pages, method: measured.method, intakePages };
}
