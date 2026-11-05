/**
 * Extractor fallbacks, for the ingest report: which extractors were tried for a document and did not serve it, and why, by
 * public reason code only (no error text). Recorded in the run's artifact ledger, so a failure in one stage attempt (the
 * attempt throws and the next one tries the next extractor) is still known when a later attempt succeeds.
 */
export const EXTRACTOR_FALLBACK_REASONS = ["unavailable", "failed", "timeout", "low-quality"] as const;
export type ExtractorFallbackReason = (typeof EXTRACTOR_FALLBACK_REASONS)[number];

export interface ExtractorFallback {
  /** The first extractor in order that was tried and did not serve the document. */
  wanted: string;
  /** The extractor whose output the document kept. */
  served: string;
  reasons: Array<{ extractor: string; reason: ExtractorFallbackReason }>;
}

interface Ledger {
  read(slot: string): string | undefined;
  record(slot: string, value: string | null | undefined): string | undefined;
}

const slot = (documentId: string) => `extractor-fallbacks:${documentId}`;
const EXTRACTOR_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function recorded(ledger: Ledger, documentId: string): ExtractorFallback["reasons"] {
  try {
    const parsed = JSON.parse(ledger.read(slot(documentId)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is ExtractorFallback["reasons"][number] =>
      typeof entry?.extractor === "string" && (EXTRACTOR_FALLBACK_REASONS as readonly string[]).includes(entry?.reason)) : [];
  } catch {
    return [];
  }
}

/** The public reason for an extractor's failure: a timeout or abort is `timeout`, anything else `failed`. */
export function extractorFailureReason(error: unknown): ExtractorFallbackReason {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /timed? ?out|timeout|AbortError|deadline exceeded/i.test(text) ? "timeout" : "failed";
}

/** Record that `extractor` was tried for the document and did not serve it. Ids outside the extractor id shape are dropped. */
export function recordExtractorFallback(ledger: Ledger, documentId: string, extractor: unknown, reason: ExtractorFallbackReason): void {
  if (typeof extractor !== "string" || !EXTRACTOR_ID.test(extractor)) return;
  const entries = recorded(ledger, documentId);
  if (entries.some((entry) => entry.extractor === extractor && entry.reason === reason)) return;
  ledger.record(slot(documentId), JSON.stringify([...entries, { extractor, reason }].slice(-16)));
}

/**
 * The fallback the served document took, or null: extractors tried before the one that served it (earlier in `order`, or
 * not in it) that failed, timed out or returned rejected output. A voting secondary that failed while the primary served
 * is not a fallback.
 */
export function extractorFallbackFor(ledger: Ledger, documentId: string, served: string, order: readonly string[]): ExtractorFallback | null {
  const servedAt = order.indexOf(served);
  const earlier = recorded(ledger, documentId).filter((entry) => {
    if (entry.extractor === served) return false;
    const at = order.indexOf(entry.extractor);
    return servedAt < 0 || at < 0 || at < servedAt;
  });
  return earlier.length ? { wanted: earlier[0]!.extractor, served, reasons: earlier } : null;
}
