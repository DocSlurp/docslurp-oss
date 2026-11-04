import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { listZipEntryNames, textPageCount } from "@docslurp/shared";

import type { Document } from "../models.js";
import type { CommandRunner } from "../tools/runner.js";

/**
 * Real page counts for formats whose page count the server cannot know at intake (it counts Office, EPUB and spreadsheet files
 * as one page). The worker measures them after converting, so billing and progress read the count of what is actually read:
 *
 *  - Word, OpenDocument, RTF and legacy Office files: pages of the file converted to PDF (LibreOffice, in the sandbox);
 *  - PowerPoint: slides;
 *  - spreadsheets: the pages of each sheet's CSV under the text rule (60 lines or 3,500 characters), summed;
 *  - EPUB: the text rule over the chapters' text.
 */
export type PageCountMethod = "pdf-conversion" | "slides" | "sheet-rows" | "text-pages";
export interface PageCountResult { pages: number; method: PageCountMethod }

/** Hard ceiling for a measured count: more than this is a parser fault, not a document. */
export const MAX_COUNTED_PAGES = 100_000;
const CONVERT_TIMEOUT_MS = 180_000;

export interface PageCountDeps {
  runner: Pick<CommandRunner, "run" | "officeToPdf" | "pdfInfo" | "pptxExtract" | "xlsxExtractPy" | "epubExtract">;
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

/** Pages of one text split into chunks that each already fit the text rule, summed as one body of text. */
export function textBodyPages(bodies: readonly string[]): number {
  return Math.max(1, bodies.reduce((total, body) => total + (body.trim() ? textPageCount(body) : 0), 0));
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

/** The measured page count of a converted document, or null when it could not be measured (the caller keeps the intake count). */
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
      const pages = bounded(textBodyPages(payload.sheets.map((sheet) => (typeof sheet.csv === "string" ? sheet.csv : ""))));
      return pages ? { pages, method: "sheet-rows" } : null;
    }
    if (format === "epub") {
      const payload = await sidecarJson(deps, sourcePath, "epub", (output) => deps.runner.epubExtract(sourcePath, output)) as { chapters?: Array<{ text?: unknown }> } | null;
      if (!payload || !Array.isArray(payload.chapters)) return null;
      const pages = bounded(textBodyPages(payload.chapters.map((chapter) => (typeof chapter.text === "string" ? chapter.text : ""))));
      return pages ? { pages, method: "text-pages" } : null;
    }
    // Word, OpenDocument, RTF, legacy .doc/.ppt/.xls: the layout engine decides the pages.
    const pages = bounded(await pdfPagesOfConversion(deps, sourcePath) ?? 0);
    return pages ? { pages, method: "pdf-conversion" } : null;
  } finally {
    await rm(sourcePath, { force: true });
    await rm(path.dirname(sourcePath), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Measures the document's pages and writes them to `documents.page_count` (and the in-memory document) before billing reads it.
 * Best effort: when the count cannot be measured the intake count stands and the stage reports why.
 */
export async function recordMeasuredPageCount(
  state: { run: { id: string }; store?: { setDocumentPageCount?(runId: string, documentId: string, pageCount: number): Promise<boolean> } | null },
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
  if (!state.store?.setDocumentPageCount) throw new Error("page count measured but the store cannot persist it");
  await state.store.setDocumentPageCount(state.run.id, document.id, measured.pages);
  document.pageCount = measured.pages;
  return { pages: measured.pages, method: measured.method, intakePages };
}
