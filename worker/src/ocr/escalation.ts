/*
 * Escalation: a hosted second read (hosted-reader.ts) of the pages the recogniser read poorly, after a VM (or self-hosted)
 * read. It is an additional read with its own budget and ledger entry, never a substitute for OCR that could not run: a
 * page reaches here only with the boundary's own read and PNG. A skipped or failed escalation keeps the recogniser's text.
 */
import { recordPageEscalation } from "../pipeline/run-milestones.js";
import type { OcrReadOutcome } from "./engine.js";
import { SpendCheckUnavailableError } from "../db/spend-check.js";
import type { OcrEscalationSkipReason } from "./escalation-stats.js";
import { HostedOcrSkipped, type HostedOcrReader } from "./hosted-reader.js";

/** The skip reasons the escalation record keeps (escalation-stats.ts), by the reader's reason. */
const SKIP_REASON: Partial<Record<HostedOcrSkipped["reason"], OcrEscalationSkipReason>> = {
  unfunded: "unfunded",
  "cost-cap": "cost-cap",
  margin: "price-check",
  "unknown-billed": "unknown-billed",
};

export interface EscalationSummary {
  attempted: number;
  replaced: number;
  skipped: Record<string, number>;
  failed: number;
  /**
   * Candidate pages that kept their first OCR read because the per-document second-read cap was spent: the page that hit
   * the cap and every candidate after it (the loop stops there).
   */
  capped: number;
}

/**
 * Escalate every candidate page in order; pages are replaced in `outcome.pages` when the hosted read has text. The pages read
 * and the pages the per-document cap left on their first read are recorded on the reader (`recordEscalation`) for the
 * ingest report.
 */
export async function escalateOcrPages(
  outcome: OcrReadOutcome,
  reader: HostedOcrReader,
  documentId: string,
  signal?: AbortSignal,
): Promise<EscalationSummary> {
  const summary: EscalationSummary = { attempted: 0, replaced: 0, skipped: {}, failed: 0, capped: 0 };
  const escalated: number[] = [];
  const capped: number[] = [];
  const skipped: Partial<Record<OcrEscalationSkipReason, number[]>> = {};
  const candidates = outcome.pages.filter((page) => page.escalation);
  for (const [index, page] of candidates.entries()) {
    if (signal?.aborted) break;
    summary.attempted += 1;
    try {
      const read = await reader.read({ documentId, pageNumber: page.pageNumber, imagePath: page.escalation!.imagePath, mimeType: "image/png" }, "ocr-escalation", signal);
      escalated.push(page.pageNumber);
      const text = read.text.trim();
      if (text) {
        page.text = text;
        page.recogniser = `escalated:${read.model}`;
        summary.replaced += 1;
      }
    } catch (error) {
      if (error instanceof HostedOcrSkipped) {
        summary.skipped[error.reason] = (summary.skipped[error.reason] ?? 0) + 1;
        // The per-document cap: this page and every later candidate keep their first OCR read. `budget` covers both
        // per-document bounds: the page budget (DOCSLURP_OCR_ESCALATION_MAX_PAGES) and the attempt budget
        // (DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS, retries included); either one spent leaves the rest on their first read.
        const rest = candidates.slice(index).map((candidate) => candidate.pageNumber);
        if (error.reason === "budget") capped.push(...rest);
        // An unfunded balance, the run cost cap and a refused price stop the rest of this document the same way; a timed-out
        // read (unknown-billed) is this page's alone.
        const reason = SKIP_REASON[error.reason];
        if (reason) (skipped[reason] ??= []).push(...(error.reason === "unknown-billed" ? [page.pageNumber] : rest));
        // Page extract records tag the pages that kept their first read (pipeline/page-extracts.ts).
        const held = error.reason === "budget" ? "capped" as const : error.reason === "unfunded" ? "unfunded" as const : null;
        if (held) for (const candidate of candidates.slice(index)) candidate.escalationHeld ??= held;
        // Once disabled, refused, capped or out of budget, later pages of this document would be skipped the same way.
        // A timed-out read (unknown-billed) is this page's alone: later pages are still read.
        if (error.reason !== "guard" && error.reason !== "unknown-billed") break;
        continue;
      }
      if (signal?.aborted) throw error;
      // A balance check that could not decide is retried with the activity (retryable), never read as a failed escalation.
      if (error instanceof SpendCheckUnavailableError) throw error;
      summary.failed += 1;
      console.warn(`[ocr] escalation failed document=${documentId} page=${page.pageNumber}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    }
  }
  summary.capped = capped.length;
  if (escalated.length || capped.length || Object.keys(skipped).length) reader.recordEscalation?.(documentId, { escalated, capped, skipped });
  if (summary.attempted) {
    recordPageEscalation("ocr-hosted", "replaced", summary.replaced);
    recordPageEscalation("ocr-hosted", "failed", summary.failed);
    for (const [reason, count] of Object.entries(summary.skipped)) recordPageEscalation("ocr-hosted", `skipped-${reason}`, count);
    console.log(`[ocr] escalation document=${documentId} attempted=${summary.attempted} replaced=${summary.replaced} failed=${summary.failed} capped=${summary.capped} skipped=${JSON.stringify(summary.skipped)}`);
  }
  return summary;
}
