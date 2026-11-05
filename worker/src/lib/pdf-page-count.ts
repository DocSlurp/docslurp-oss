import { pageCredits, resolvePdfMode, speedBoostMultiplier } from "@docslurp/shared";

import { sandboxedPdfProvider } from "../extractors/plugins.js";
import type { Document } from "../models.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import { RunPolicyError } from "./document-failure.js";
import { sniffedPdf } from "./sniffed-pdf.js";

/** More pages than this is a parser fault, not a document. */
export const MAX_MEASURED_PDF_PAGES = 100_000;

export function parsePdfInfoPages(stdout: string): number | null {
  const match = stdout.match(/^Pages:\s+(\d+)\s*$/m);
  const pages = match ? Number.parseInt(match[1]!, 10) : NaN;
  return Number.isSafeInteger(pages) && pages >= 1 && pages <= MAX_MEASURED_PDF_PAGES ? pages : null;
}

/**
 * The API never parses customer PDF bytes, so a PDF arrives with a page count intake estimated from its size (`assumed`).
 * Measure it in the PDF mode's boundary before any stage uses it or anything bills, and record it as `counted`:
 *  - `vm`: the sandboxed PDF provider counts it in a fresh VM; a provider that cannot is a refusal, never host parsing;
 *  - `local` (customer-owned): pdfinfo under the parser sandbox on this host;
 *  - `off`: nothing (PDF extraction refuses the document anyway).
 * Pages above the estimate are re-checked against the balance (Fast base fee) and pause an unfunded run. Billing reads only
 * this measured count: a PDF still `assumed` never bills (db/page-base-fee.ts).
 */
export async function recordMeasuredPdfPageCount(args: {
  state: WorkflowState;
  document: Document;
  runner: Pick<CommandRunner, "pdfInfo" | "run">;
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
    const counted = await provider.pageCount({ input: await args.sourcePath() }, args.signal);
    if (counted.usage) state.usageLedger.enqueue(counted.usage);
    pages = Number.isSafeInteger(counted.pages) && counted.pages >= 1 && counted.pages <= MAX_MEASURED_PDF_PAGES ? counted.pages : null;
  } else {
    const plan = await args.runner.pdfInfo(await args.sourcePath());
    if (!plan.available) throw new Error("PDF page count unavailable: pdfinfo is not installed (DOCSLURP_PDF_MODE=local)");
    pages = parsePdfInfoPages((await args.runner.run(plan, args.signal)).stdout);
  }
  if (pages === null) throw new Error("unreadable PDF: no valid page count");
  if (!state.store?.setDocumentPageCount) throw new Error("PDF page count measured but the store cannot persist it");
  await state.store.setDocumentPageCount(state.run.id, document.id, pages);
  document.pageCount = pages;
  document.pageCountSource = "counted";
  state.run.pagesTotal = Math.max(0, (Number(state.run.pagesTotal) || 0) + pages - estimate);
  console.log(`[pdf-pages] document=${document.id} measured=${pages} estimate=${estimate} mode=${mode}`);
  // Admission priced the estimate: pages above it owe a Fast base fee admission never saw.
  if (pages > estimate && state.store.enforceSpendForCharge && state.run.userId) {
    const credits = pageCredits("fast", pages - estimate) * speedBoostMultiplier(state.run.pipeline.speedBoost === true);
    const outcome = await state.store.enforceSpendForCharge({ id: state.run.id, orgId: state.run.orgId ?? null, workspaceId: state.run.workspaceId, userId: state.run.userId }, credits);
    if (outcome.paused || outcome.blocked) {
      console.warn(`[pdf-pages] run=${state.run.id} document=${document.id} paused: ${pages} measured pages (estimate ${estimate}) owe ${credits.toFixed(2)} credits more than the balance holds`);
      throw new RunPolicyError(`Credits do not cover the measured pages of PDF ${document.id}; run paused`);
    }
  }
  return { pages, method: mode, estimate };
}
