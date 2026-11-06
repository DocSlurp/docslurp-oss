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
  | "structure-rejected" // the tree was walked, but Poppler (the extractor) refuses it and sees no pages: nothing to extract
  | "unavailable";      // the tool is missing, exit 99 (usage), or exit 0 without exactly one count

/** The page count could not be measured. Never read as a count. Refused outcomes fail the document; `unavailable` retries. */
export class PdfPageCountError extends Error {
  constructor(message: string, readonly outcome: PdfPageCountOutcome) {
    super(message);
    this.name = outcome === "unavailable" ? "PdfPageCountUnavailableError" : "PdfPageCountError";
  }
}

const PDF_PAGE_COUNT_OUTCOMES = new Set<PdfPageCountOutcome>(["open-failed", "encrypted", "limit", "malformed", "killed", "structure-rejected", "unavailable"]);

/** The fixed text a structure-rejected refusal carries; the ingest report classifies it as `pdf-structure-rejected`. */
export const PDF_STRUCTURE_REJECTED = "PDF structure rejected";

/**
 * After a successful walk, whether Poppler (the extractor) accepts the file: pdftotext on page 1 exiting 99 means it sees no
 * pages (its own sanity check refused the tree, for example a /Count beyond the file's objects), so nothing could be
 * extracted. That refuses the document (`structure-rejected`) before anything bills. Other exits are left to extraction,
 * which reports them itself; a missing tool is the platform's (unavailable).
 */
export async function assertPopplerAcceptsPdf(runner: Pick<CommandRunner, "pdfPopplerAcceptance" | "run">, source: string, signal?: AbortSignal): Promise<void> {
  const plan = await runner.pdfPopplerAcceptance(source);
  if (!plan.available) throw new PdfPageCountError("PDF page count unavailable: Doppler pdftotext is not installed", "unavailable");
  try {
    await runner.run(plan, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof CommandExitError && error.exitCode === 99) {
      throw new PdfPageCountError(`${PDF_STRUCTURE_REJECTED}: the page tree was walked but the PDF reader sees no pages`, "structure-rejected");
    }
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
  runner: Pick<CommandRunner, "pdfPageCount" | "pdfPopplerAcceptance" | "run">;
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
      // The VM's pdfpagecount outcome: the same refusal (or retry) as local mode.
      const outcome = (error as { pageCountOutcome?: unknown } | null)?.pageCountOutcome;
      if (typeof outcome === "string" && PDF_PAGE_COUNT_OUTCOMES.has(outcome as PdfPageCountOutcome)) {
        throw new PdfPageCountError(`PDF page count failed in the VM: ${outcome}`, outcome as PdfPageCountOutcome);
      }
      throw error;
    }
    if (counted.usage) state.usageLedger.enqueue(counted.usage);
    pages = Number.isSafeInteger(counted.pages) && counted.pages >= 1 && counted.pages <= MAX_MEASURED_PDF_PAGES ? counted.pages : null;
  } else {
    const source = await args.sourcePath();
    pages = await countPdfPages(args.runner, source, args.signal);
    await assertPopplerAcceptsPdf(args.runner, source, args.signal);
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

/** Run-ledger slot holding a PDF's walked page count when extraction processed fewer pages (so a retry still knows N of M). */
export const PDF_WALKED_PAGES_SLOT = "pdf-walked-pages";

/**
 * Cross-checks the structural count against the pages extraction actually processed, and bills what was done:
 * - processed above walked (the tree under-claimed): the page count is raised to what was processed, billed and authorized;
 * - processed below walked (the reader stopped short, e.g. a /Count that under-claims the kids): the page count is lowered to
 *   what was processed, so only extracted pages bill, and the file is flagged `pdf-partially-extracted` (N of M pages) in the
 *   ingest report (owner decision 2026-11-05).
 * The walked count is kept in the run ledger so a retried stage reports the same N of M.
 */
export async function reconcileProcessedPdfPages(
  state: WorkflowState,
  document: Document,
  processed: number,
): Promise<{ measured: number; processed: number; mismatch: "none" | "processed-above-measured" | "processed-below-measured" }> {
  const current = Math.max(1, Math.trunc(Number(document.pageCount)) || 1);
  const walked = Number(state.artifactLedger.readDocument(document.id, PDF_WALKED_PAGES_SLOT));
  const measured = Number.isSafeInteger(walked) && walked > current ? walked : current;
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
    // Bill what was extracted: lower the page count to the pages processed, and keep the walked count for the report.
    console.warn(`[pdf-pages] document=${document.id} extraction processed ${processed} of ${measured} walked pages: billing ${processed}`);
    state.artifactLedger.recordDocument(document.id, PDF_WALKED_PAGES_SLOT, String(measured));
    if (current > processed) {
      if (!state.store?.setDocumentPageCount) throw new Error("processed PDF pages are below the measured count but the store cannot persist it");
      await state.store.setDocumentPageCount(state.run.id, document.id, processed);
      state.run.pagesTotal = Math.max(0, (Number(state.run.pagesTotal) || 0) + processed - current);
      document.pageCount = processed;
      document.pageCountSource = "counted";
    }
    return { measured, processed, mismatch: "processed-below-measured" };
  }
  return { measured, processed, mismatch: "none" };
}
