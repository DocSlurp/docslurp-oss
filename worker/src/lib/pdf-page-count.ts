import { resolvePdfMode } from "@docslurp/shared";

import { sandboxedPdfProvider } from "../extractors/plugins.js";
import type { Document } from "../models.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { HungWorkError } from "./hung-work.js";
import { CommandExitError, type CommandRunner, type PdfPageCountLimits } from "../tools/runner.js";
import { authorizeMeasuredPages } from "./measured-page-authorization.js";
import { sniffedPdf } from "./sniffed-pdf.js";

/** More pages than this is a parser fault, not a document. */
export const MAX_MEASURED_PDF_PAGES = 100_000;

/** Budgets for one structural count (`pdfpagecount`): explicit to the tool, plus an external hard limit and timeout around it. */
export const PDF_PAGE_COUNT_LIMITS: PdfPageCountLimits = {
  maxPages: MAX_MEASURED_PDF_PAGES,
  // Real page trees are a few levels deep; Poppler's own default is 256.
  maxDepth: 64,
  toolMemoryMiB: 512,
  addressSpaceMiB: 768,
  cpuSeconds: 30,
  wallMs: 60_000,
};

/**
 * Why a structural count produced no number. Refused outcomes are verdicts on the document (it fails with the reason, no retry
 * reads it differently); `unavailable` is the platform's (missing tool, a usage error, output that breaks the tool's contract).
 */
export type PdfPageCountOutcome =
  | "open-failed"       // exit 1: not a readable PDF, or the output could not be written
  | "encrypted"         // exit 2: needs a password, or an unknown security handler
  | "limit"             // exit 3: pages, depth, work or memory over budget
  | "malformed"         // exit 4: no pages, a cycle, a broken page tree
  | "killed"            // killed by the external limit, the wall clock, or a crash (an abort, a signal, any other exit code)
  | "unavailable";      // the tool is missing, exit 99 (usage), or exit 0 without exactly one count

/** The page count could not be measured. Never read as a count. Refused outcomes fail the document; `unavailable` retries. */
export class PdfPageCountError extends Error {
  constructor(message: string, readonly outcome: PdfPageCountOutcome) {
    super(message);
    this.name = outcome === "unavailable" ? "PdfPageCountUnavailableError" : "PdfPageCountError";
  }
}

const EXIT_OUTCOMES: Record<number, PdfPageCountOutcome> = { 1: "open-failed", 2: "encrypted", 3: "limit", 4: "malformed", 99: "unavailable" };

/** Exactly one decimal integer, at least 1, and a newline: anything else is not a count. */
export function parsePdfPageCount(stdout: string, maxPages = MAX_MEASURED_PDF_PAGES): number | null {
  const match = /^([1-9][0-9]{0,9})\n$/.exec(stdout);
  const pages = match ? Number(match[1]) : null;
  return pages !== null && Number.isSafeInteger(pages) && pages <= maxPages ? pages : null;
}

/**
 * The PDF's page count from its page tree, in the parser sandbox: one `pdfpagecount` run (runner.pdfPageCount), which walks the
 * tree the way Poppler builds its page list and never reads `/Count`, Info, XMP or page content. Its stderr is fixed text and is
 * never parsed. Every exit code maps to a distinct outcome; anything unexpected fails closed.
 */
export async function countPdfPages(
  runner: Pick<CommandRunner, "pdfPageCount" | "run">,
  source: string,
  signal?: AbortSignal,
  limits: PdfPageCountLimits = PDF_PAGE_COUNT_LIMITS,
): Promise<number> {
  const plan = await runner.pdfPageCount(source, limits);
  if (!plan.available) throw new PdfPageCountError("PDF page count unavailable: Doppler pdfpagecount or prlimit is not installed", "unavailable");
  let stdout: string;
  try {
    stdout = (await runner.run(plan, signal)).stdout;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof CommandExitError) {
      const outcome = error.exitCode === null ? "killed" : EXIT_OUTCOMES[error.exitCode] ?? "killed";
      throw new PdfPageCountError(`PDF page count failed: ${outcome} (exit ${error.exitCode ?? "signal"})`, outcome);
    }
    if (error instanceof HungWorkError) throw new PdfPageCountError("PDF page count failed: killed (wall-clock limit)", "killed");
    throw error;
  }
  const pages = parsePdfPageCount(stdout, limits.maxPages);
  if (pages === null) throw new PdfPageCountError("PDF page count failed: the tool exited 0 without exactly one page count", "unavailable");
  return pages;
}

/**
 * The API never parses customer PDF bytes, so a PDF arrives with a page count intake estimated from its size (`assumed`).
 * Measure it in the PDF mode's boundary before any stage uses it or anything bills, and record it as `counted`:
 *  - `vm`: the sandboxed PDF provider counts it in a fresh VM; a provider that cannot is a refusal, never host parsing;
 *  - `local` (customer-owned): the page tree walked under the parser sandbox on this host (countPdfPages: Doppler pdfpagecount);
 *  - `off`: nothing (PDF extraction refuses the document anyway).
 * Measuring only: the pages above the estimate are authorized separately, on every attempt (authorizeMeasuredPages). Billing
 * reads only this measured count: a PDF still `assumed` never bills (db/page-base-fee.ts).
 */
export async function recordMeasuredPdfPageCount(args: {
  state: WorkflowState;
  document: Document;
  runner: Pick<CommandRunner, "pdfPageCount" | "run">;
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
    pages = await countPdfPages(args.runner, await args.sourcePath(), args.signal);
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
 * extra pages are authorized (authorizeMeasuredPages). Any disagreement either way is flagged in the stage stats and logs.
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
  if (processed < measured) {
    // Billing stays on the walked count (the larger); the disagreement is flagged, never silently absorbed.
    console.warn(`[pdf-pages] document=${document.id} extraction processed ${processed} of ${measured} measured pages`);
    return { measured, processed, mismatch: "processed-below-measured" };
  }
  return { measured, processed, mismatch: "none" };
}
