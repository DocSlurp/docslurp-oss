/*
 * Per-document record of the OCR escalation reads (escalation.ts) in the run's artifact ledger: the pages a hosted second read
 * replaced or returned, and the pages that wanted one but kept their first OCR read because the per-document second-read cap
 * was spent: the page budget (DOCSLURP_OCR_ESCALATION_MAX_PAGES) or the attempt budget, retries included
 * (DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS); both are reported as the same per-document cap. Kept as page sets, so a retried stage or a second
 * call for the same page never counts a page twice. Document stages copy it into their stats (`ocrEscalation`), where the
 * ingest report reads it (`ocr-escalation-cap`).
 */

/** Artifact ledger key (per document) of the escalation record. */
export const OCR_ESCALATION_STATS_KEY = "ocr-escalation";
/** Stage stats key the record is copied under. */
export const OCR_ESCALATION_STAGE_STAT = "ocrEscalation";
/** Most capped page numbers a stage's stats list (the counts are always whole). */
const MAX_LISTED_PAGES = 50;

type DocumentLedger = {
  readDocument(documentId: string, key: string): string | null | undefined;
  recordDocument(documentId: string, key: string, value: string): void;
};

type Pages = { escalated: Set<number>; capped: Set<number> };

function pageList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((page): page is number => Number.isSafeInteger(page) && page > 0) : [];
}

function read(ledger: Pick<DocumentLedger, "readDocument">, documentId: string): Pages {
  try {
    const raw = JSON.parse(ledger.readDocument(documentId, OCR_ESCALATION_STATS_KEY) ?? "{}") as { escalated?: unknown; capped?: unknown };
    return { escalated: new Set(pageList(raw.escalated)), capped: new Set(pageList(raw.capped)) };
  } catch {
    return { escalated: new Set(), capped: new Set() };
  }
}

/** Add escalated and capped pages to the document's record. A page that was escalated is never counted as capped. */
export function recordOcrEscalationPages(
  ledger: DocumentLedger,
  documentId: string,
  pages: { escalated?: readonly number[]; capped?: readonly number[] },
): void {
  if (!pages.escalated?.length && !pages.capped?.length) return;
  const known = read(ledger, documentId);
  for (const page of pageList(pages.escalated)) known.escalated.add(page);
  for (const page of pageList(pages.capped)) known.capped.add(page);
  for (const page of known.escalated) known.capped.delete(page);
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  ledger.recordDocument(documentId, OCR_ESCALATION_STATS_KEY, JSON.stringify({ escalated: sorted(known.escalated), capped: sorted(known.capped) }));
}

/** What a document stage reports: counts, and the first capped page numbers. Null when nothing was escalated or capped. */
export type OcrEscalationStageStats = { escalatedPages: number; cappedPages: number; capped: number[] };

export function ocrEscalationStageStats(ledger: Pick<DocumentLedger, "readDocument"> | null | undefined, documentId: string): OcrEscalationStageStats | null {
  if (typeof ledger?.readDocument !== "function") return null;
  const known = read(ledger, documentId);
  if (known.escalated.size === 0 && known.capped.size === 0) return null;
  return {
    escalatedPages: known.escalated.size,
    cappedPages: known.capped.size,
    capped: [...known.capped].sort((a, b) => a - b).slice(0, MAX_LISTED_PAGES),
  };
}
