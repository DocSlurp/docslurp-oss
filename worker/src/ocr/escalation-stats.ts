/*
 * Per-document record of the OCR escalation reads (escalation.ts) in the run's artifact ledger: the pages a hosted second
 * read replaced or returned, and the pages that wanted one but kept their first OCR read, by reason:
 * - `capped`: the per-document second-read cap was spent: the page budget (DOCSLURP_OCR_ESCALATION_MAX_PAGES) or the
 *   attempt budget, retries included (DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS); both are reported as the same cap;
 * - `skipped.unfunded`: the organization's balance did not cover the read;
 * - `skipped.cost-cap`: the run cost cap was reached;
 * - `skipped.price-check`: the second-read model's current price was not accepted for an automatic call.
 * Kept as page sets, so a retried stage or a second call for the same page never counts a page twice; a page later
 * escalated is no longer counted as skipped. Document stages copy it into their stats (`ocrEscalation`), where the ingest
 * report reads it (`ocr-escalation-cap`, `ocr-escalation-skipped`).
 */

/** Artifact ledger key (per document) of the escalation record. */
export const OCR_ESCALATION_STATS_KEY = "ocr-escalation";
/** Stage stats key the record is copied under. */
export const OCR_ESCALATION_STAGE_STAT = "ocrEscalation";
/** Reasons, besides the cap, a wanted second read did not happen. */
export const OCR_ESCALATION_SKIP_REASONS = ["unfunded", "cost-cap", "price-check"] as const;
export type OcrEscalationSkipReason = (typeof OCR_ESCALATION_SKIP_REASONS)[number];
/** Most capped page numbers a stage's stats list (the counts are always whole). */
const MAX_LISTED_PAGES = 50;

type DocumentLedger = {
  readDocument(documentId: string, key: string): string | null | undefined;
  recordDocument(documentId: string, key: string, value: string): void;
};

type Pages = { escalated: Set<number>; capped: Set<number>; skipped: Record<OcrEscalationSkipReason, Set<number>> };

function pageList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((page): page is number => Number.isSafeInteger(page) && page > 0) : [];
}

function emptySkipped(): Record<OcrEscalationSkipReason, Set<number>> {
  return { unfunded: new Set(), "cost-cap": new Set(), "price-check": new Set() };
}

function read(ledger: Pick<DocumentLedger, "readDocument">, documentId: string): Pages {
  try {
    const raw = JSON.parse(ledger.readDocument(documentId, OCR_ESCALATION_STATS_KEY) ?? "{}") as { escalated?: unknown; capped?: unknown; skipped?: unknown };
    const skipped = emptySkipped();
    const rawSkipped = raw.skipped && typeof raw.skipped === "object" ? raw.skipped as Record<string, unknown> : {};
    for (const reason of OCR_ESCALATION_SKIP_REASONS) for (const page of pageList(rawSkipped[reason])) skipped[reason].add(page);
    return { escalated: new Set(pageList(raw.escalated)), capped: new Set(pageList(raw.capped)), skipped };
  } catch {
    return { escalated: new Set(), capped: new Set(), skipped: emptySkipped() };
  }
}

/** Add escalated, capped and skipped pages to the document's record. A page that was escalated is never counted as not escalated. */
export function recordOcrEscalationPages(
  ledger: DocumentLedger,
  documentId: string,
  pages: { escalated?: readonly number[]; capped?: readonly number[]; skipped?: Partial<Record<OcrEscalationSkipReason, readonly number[]>> },
): void {
  const anySkipped = OCR_ESCALATION_SKIP_REASONS.some((reason) => pages.skipped?.[reason]?.length);
  if (!pages.escalated?.length && !pages.capped?.length && !anySkipped) return;
  const known = read(ledger, documentId);
  for (const page of pageList(pages.escalated)) known.escalated.add(page);
  for (const page of pageList(pages.capped)) known.capped.add(page);
  for (const reason of OCR_ESCALATION_SKIP_REASONS) for (const page of pageList(pages.skipped?.[reason])) known.skipped[reason].add(page);
  for (const page of known.escalated) {
    known.capped.delete(page);
    for (const reason of OCR_ESCALATION_SKIP_REASONS) known.skipped[reason].delete(page);
  }
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  ledger.recordDocument(documentId, OCR_ESCALATION_STATS_KEY, JSON.stringify({
    escalated: sorted(known.escalated),
    capped: sorted(known.capped),
    skipped: Object.fromEntries(OCR_ESCALATION_SKIP_REASONS.map((reason) => [reason, sorted(known.skipped[reason])])),
  }));
}

/**
 * What a document stage reports: counts, the first capped page numbers and the pages skipped per reason. Null when nothing
 * was escalated, capped or skipped.
 */
export type OcrEscalationStageStats = {
  escalatedPages: number;
  cappedPages: number;
  capped: number[];
  skippedPages: Record<OcrEscalationSkipReason, number>;
};

export function ocrEscalationStageStats(ledger: Pick<DocumentLedger, "readDocument"> | null | undefined, documentId: string): OcrEscalationStageStats | null {
  if (typeof ledger?.readDocument !== "function") return null;
  const known = read(ledger, documentId);
  const skippedTotal = OCR_ESCALATION_SKIP_REASONS.reduce((sum, reason) => sum + known.skipped[reason].size, 0);
  if (known.escalated.size === 0 && known.capped.size === 0 && skippedTotal === 0) return null;
  return {
    escalatedPages: known.escalated.size,
    cappedPages: known.capped.size,
    capped: [...known.capped].sort((a, b) => a - b).slice(0, MAX_LISTED_PAGES),
    skippedPages: Object.fromEntries(OCR_ESCALATION_SKIP_REASONS.map((reason) => [reason, known.skipped[reason].size])) as Record<OcrEscalationSkipReason, number>,
  };
}
