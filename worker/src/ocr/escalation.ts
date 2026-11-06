/*
 * Escalation: a hosted second read (hosted-reader.ts) of the pages the recogniser read poorly, after a VM (or self-hosted)
 * read. It is an additional read with its own budget and ledger entry, never a substitute for OCR that could not run: a
 * page reaches here only with the boundary's own read and PNG. A skipped or failed escalation keeps the recogniser's text.
 */
import type { OcrReadOutcome } from "./engine.js";
import { HostedOcrSkipped, type HostedOcrReader } from "./hosted-reader.js";

export interface EscalationSummary {
  attempted: number;
  replaced: number;
  skipped: Record<string, number>;
  failed: number;
}

/** Escalate every candidate page in order; pages are replaced in `outcome.pages` when the hosted read has text. */
export async function escalateOcrPages(
  outcome: OcrReadOutcome,
  reader: HostedOcrReader,
  documentId: string,
  signal?: AbortSignal,
): Promise<EscalationSummary> {
  const summary: EscalationSummary = { attempted: 0, replaced: 0, skipped: {}, failed: 0 };
  for (const page of outcome.pages) {
    if (!page.escalation) continue;
    if (signal?.aborted) break;
    summary.attempted += 1;
    try {
      const read = await reader.read({ documentId, pageNumber: page.pageNumber, imagePath: page.escalation.imagePath, mimeType: "image/png" }, "ocr-escalation", signal);
      const text = read.text.trim();
      if (text) {
        page.text = text;
        page.recogniser = `escalated:${read.model}`;
        summary.replaced += 1;
      }
    } catch (error) {
      if (error instanceof HostedOcrSkipped) {
        summary.skipped[error.reason] = (summary.skipped[error.reason] ?? 0) + 1;
        // Once disabled, refused, capped or out of budget, later pages of this document would be skipped the same way.
        if (error.reason !== "guard") break;
        continue;
      }
      if (signal?.aborted) throw error;
      summary.failed += 1;
      console.warn(`[ocr] escalation failed document=${documentId} page=${page.pageNumber}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    }
  }
  if (summary.attempted) {
    console.log(`[ocr] escalation document=${documentId} attempted=${summary.attempted} replaced=${summary.replaced} failed=${summary.failed} skipped=${JSON.stringify(summary.skipped)}`);
  }
  return summary;
}
