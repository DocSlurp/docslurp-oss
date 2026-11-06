import { resolvePdfMode } from "@docslurp/shared";

import { sandboxedPdfProvider } from "../extractors/plugins.js";
import type { Document } from "../models.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { CommandExitError, type CommandRunner } from "../tools/runner.js";
import { authorizeMeasuredPages } from "./measured-page-authorization.js";
import { sniffedPdf } from "./sniffed-pdf.js";

/** More pages than this is a parser fault, not a document. */
export const MAX_MEASURED_PDF_PAGES = 100_000;

/** One page probe's answer: the page exists, or the tool reported the document's last page (`lastPage` < the probed page). */
export type PageProbe = { exists: true } | { exists: false; lastPage: number };

/** The page count could not be measured (a probe failed some other way, or the answers disagree). Never read as a count. */
export class PdfPageCountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfPageCountError";
  }
}

/**
 * The PDF's page count as its page tree is walked, never parsed out of text the author controls: the largest page `probe` reports
 * as existing, found by binary search over 1..limit (about 17 probes). Every "past the end" answer carries Poppler's own count of
 * the last page; they must all agree with the result, or the count is refused, so a damaged or hostile file that fails a page some
 * other way cannot shorten the count. Null when page 1 does not exist; throws past `limit`.
 */
export async function pdfPageTreeCount(probe: (page: number) => Promise<PageProbe>, limit = MAX_MEASURED_PDF_PAGES): Promise<number | null> {
  const reported = new Set<number>();
  const exists = async (page: number) => {
    const answer = await probe(page);
    if (!answer.exists) reported.add(answer.lastPage);
    return answer.exists;
  };
  if (!(await exists(1))) return null;
  if (await exists(limit + 1)) throw new Error(`PDF has more than ${limit} pages`);
  let low = 1;
  let high = limit + 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (await exists(middle)) low = middle;
    else high = middle;
  }
  if (reported.size !== 1 || !reported.has(low)) {
    throw new PdfPageCountError(`PDF page tree is inconsistent: probes found ${low} pages, Poppler reported ${[...reported].join(", ")}`);
  }
  return low;
}

/**
 * Poppler's own message for a page past the end (utils/pdftotext.cc, errCommandLine): its format string holds only the two page
 * numbers, so no document text can appear in it. Matched as a whole line, for the page this probe asked for.
 */
export function pastLastPage(stderr: string, page: number): number | null {
  for (const line of stderr.split("\n")) {
    const match = /^(?:\S+ \(99\): )?Command Line Error: Wrong page range given: the first page \((\d{1,7})\) can not be after the last page \((\d{1,7})\)\.\r?$/.exec(line);
    if (match && Number(match[1]) === page && Number(match[2]) < page) return Number(match[2]);
  }
  return null;
}

/**
 * A page probe in the parser sandbox (runner.pdfPageProbe): exit 0 is an existing page; exit 99 with Poppler's wrong-page-range
 * line for this page is past the end; anything else (another 99, a crash, an unreadable file) fails closed with
 * PdfPageCountError, never a shorter count.
 */
export function sandboxedPageProbe(runner: Pick<CommandRunner, "pdfPageProbe" | "run">, source: string, signal?: AbortSignal): (page: number) => Promise<PageProbe> {
  return async (page) => {
    const plan = await runner.pdfPageProbe(source, page);
    if (!plan.available) throw new Error("PDF page count unavailable: pdftotext is not installed (DOCSLURP_PDF_MODE=local)");
    try {
      await runner.run(plan, signal);
      return { exists: true };
    } catch (error) {
      const lastPage = error instanceof CommandExitError && error.exitCode === 99 ? pastLastPage(error.message, page) : null;
      if (lastPage !== null) return { exists: false, lastPage };
      throw new PdfPageCountError(`PDF page ${page} could not be probed (exit ${error instanceof CommandExitError ? error.exitCode : "unknown"})`);
    }
  };
}

/**
 * The API never parses customer PDF bytes, so a PDF arrives with a page count intake estimated from its size (`assumed`).
 * Measure it in the PDF mode's boundary before any stage uses it or anything bills, and record it as `counted`:
 *  - `vm`: the sandboxed PDF provider counts it in a fresh VM; a provider that cannot is a refusal, never host parsing;
 *  - `local` (customer-owned): the page tree walked under the parser sandbox on this host (pdfPageTreeCount, exit codes only);
 *  - `off`: nothing (PDF extraction refuses the document anyway).
 * Measuring only: the pages above the estimate are authorized separately, on every attempt (authorizeMeasuredPages). Billing
 * reads only this measured count: a PDF still `assumed` never bills (db/page-base-fee.ts).
 */
export async function recordMeasuredPdfPageCount(args: {
  state: WorkflowState;
  document: Document;
  runner: Pick<CommandRunner, "pdfPageProbe" | "run">;
  sourcePath: () => Promise<string>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<{ pages: number; method: "vm" | "local"; estimate: number } | null> {
  const { state, document } = args;
  if (!sniffedPdf(document) || document.pageCountSource !== "assumed") return null;
  const mode = resolvePdfMode(args.env ?? process.env);
  if (mode === "off") return null;
  const estimate = Math.max(1, Math.trunc(document.pageCount) || 1);
  let pages: number | null;
  if (mode === "vm") {
    const provider = sandboxedPdfProvider();
    if (!provider?.pageCount) {
      console.error(`[pdf-pages] refused document=${document.id}: the VM PDF provider cannot count pages; refusing to bill an estimate or parse on the host`);
      throw new Error("PDF page count unavailable: the VM PDF provider does not count pages (guest protocol 8 or newer is required)");
    }
    let counted: Awaited<ReturnType<NonNullable<typeof provider.pageCount>>>;
    try {
      counted = await provider.pageCount({ input: await args.sourcePath() }, args.signal);
    } catch (error) {
      // A VM that ran and failed still cost the provider: record its usage (0 credits) before the refusal propagates.
      const usage = (error as { usage?: unknown } | null)?.usage;
      if (usage && typeof usage === "object") state.usageLedger.enqueue(usage as Parameters<typeof state.usageLedger.enqueue>[0]);
      throw error;
    }
    if (counted.usage) state.usageLedger.enqueue(counted.usage);
    pages = Number.isSafeInteger(counted.pages) && counted.pages >= 1 && counted.pages <= MAX_MEASURED_PDF_PAGES ? counted.pages : null;
  } else {
    pages = await pdfPageTreeCount(sandboxedPageProbe(args.runner, await args.sourcePath(), args.signal));
  }
  if (pages === null) throw new Error("unreadable PDF: no valid page count");
  if (!state.store?.setDocumentPageCount) throw new Error("PDF page count measured but the store cannot persist it");
  await state.store.setDocumentPageCount(state.run.id, document.id, pages);
  document.pageCount = pages;
  document.pageCountSource = "counted";
  state.run.pagesTotal = Math.max(0, (Number(state.run.pagesTotal) || 0) + pages - estimate);
  console.log(`[pdf-pages] document=${document.id} measured=${pages} estimate=${estimate} mode=${mode}`);
  // Authorizing the pages above the estimate is separate (lib/measured-page-authorization.ts) and runs on every attempt.
  return { pages, method: mode, estimate };
}

/** Pages a PDF extractor's output holds: every PDF extractor writes one form-feed-separated page per page it processed. */
export function processedPdfPages(markdown: string): number {
  return markdown.replace(/\f\s*$/, "").split("\f").length;
}

/**
 * Cross-checks the structural count against the pages extraction actually processed, and bills and authorizes the larger: when
 * the extractor processed more pages than the page tree reported, the page count is raised to that (recorded `counted`) and the
 * extra pages are authorized (authorizeMeasuredPages). A large disagreement either way is flagged in the stage stats and logs.
 */
export async function reconcileProcessedPdfPages(
  state: WorkflowState,
  document: Document,
  processed: number,
): Promise<{ measured: number; processed: number; mismatch: "none" | "processed-above-measured" | "processed-below-measured" }> {
  const measured = Math.max(1, Math.trunc(Number(document.pageCount)) || 1);
  if (!Number.isSafeInteger(processed) || processed < 1) return { measured, processed, mismatch: "none" };
  if (processed > measured) {
    console.warn(`[pdf-pages] document=${document.id} extraction processed ${processed} pages, the page tree reported ${measured}: billing and authorizing ${processed}`);
    if (!state.store?.setDocumentPageCount) throw new Error("processed PDF pages exceed the measured count but the store cannot persist it");
    await state.store.setDocumentPageCount(state.run.id, document.id, processed);
    state.run.pagesTotal = Math.max(0, (Number(state.run.pagesTotal) || 0) + processed - measured);
    document.pageCount = processed;
    document.pageCountSource = "counted";
    await authorizeMeasuredPages(state, document);
    return { measured, processed, mismatch: "processed-above-measured" };
  }
  if (processed * 2 < measured && measured - processed > 2) {
    console.warn(`[pdf-pages] document=${document.id} extraction processed ${processed} of ${measured} measured pages`);
    return { measured, processed, mismatch: "processed-below-measured" };
  }
  return { measured, processed, mismatch: "none" };
}
