/*
 * Billing and usage for OCR reads. Every page the engine read with words in it is one Rich page read (`page-ocr`; the
 * ledger keys the charge by run, document and page, so a retried checkpoint or a second reader never charges it twice).
 * One compute event per job carries the boundary's measured CPU, peak RSS and wall time; the VM provider's own cost
 * arrives separately through the runner (settleRemote), at provider cost.
 */
import type { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import type { OcrReadOutcome } from "./engine.js";

const HAS_WORDS = /[\p{L}\p{N}]/u;

type OcrLedger = Pick<PipelineUsageEventLedger, "chargeRichPage" | "enqueue">;

/** Charge each page with words as a Rich read and record the job's measured compute. Returns the pages charged. */
export function recordOcrReads(ledger: OcrLedger, documentId: string, outcome: OcrReadOutcome, context: { stage: string }): number[] {
  const charged: number[] = [];
  for (const page of outcome.pages) {
    if (!HAS_WORDS.test(page.text)) continue;
    ledger.chargeRichPage({ documentId, pageNumber: page.pageNumber, readBy: "page-ocr", model: `ppocr:${page.recogniser}` });
    charged.push(page.pageNumber);
  }
  ledger.enqueue({
    provider: outcome.mode === "vm" ? `ocr-vm:${outcome.engine}` : "ocr-local-sandbox",
    model: "ppocr-v6-small",
    metric: "ocr-compute",
    amount: outcome.pages.length,
    unit: "page",
    costCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    metadata: {
      documentId,
      stage: context.stage,
      mode: outcome.mode,
      engine: outcome.engine,
      language: outcome.language.setting,
      pages: outcome.pages.map((page) => page.pageNumber),
      chargedPages: charged,
      recognisers: [...new Set(outcome.pages.map((page) => page.recogniser))],
      wallMs: outcome.wallMs,
      cpuMs: outcome.cpuMs,
      peakRssKb: outcome.peakRssKb,
      truncatedFrames: outcome.truncatedFrames,
      escalationCandidates: outcome.pages.filter((page) => page.escalation).map((page) => ({ page: page.pageNumber, reason: page.escalation!.reason })),
    },
  });
  return charged;
}
