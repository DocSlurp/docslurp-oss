/**
 * Groups one run's first-pass documents into sandboxed PDF batches.
 *
 * Workflow-safe: pure and deterministic, no I/O and no imports (it runs inside the Temporal workflow sandbox).
 *
 * First-fit decreasing by pages: the largest document is placed first, into the first batch with room for its pages, bytes
 * and file slot. A document larger than a batch limit on its own gets a batch of its own (the provider bounds a single file
 * separately). Batches come back in creation order, which puts the largest documents first; never an empty batch.
 *
 * Pages here are intake's estimates: they size batches only. Billing uses the structural count the VM measures.
 */

export interface FirstPassCandidate {
  documentId: string;
  /** Intake's page estimate (0 or less, or not finite: counted as 1). */
  pages: number;
  bytes: number;
}

export interface FirstPassBatchLimits {
  maxFiles: number;
  maxBatchBytes: number;
  maxBatchPages: number;
}

export function planFirstPassBatches(candidates: readonly FirstPassCandidate[], limits: FirstPassBatchLimits): string[][] {
  const maxFiles = Math.max(1, Math.floor(limits.maxFiles));
  const maxBytes = Math.max(1, limits.maxBatchBytes);
  const maxPages = Math.max(1, limits.maxBatchPages);
  const pagesOf = (c: FirstPassCandidate) => (Number.isFinite(c.pages) && c.pages > 0 ? Math.ceil(c.pages) : 1);
  const bytesOf = (c: FirstPassCandidate) => (Number.isFinite(c.bytes) && c.bytes > 0 ? c.bytes : 0);
  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.documentId) ? false : (seen.add(c.documentId), true)));
  const order = unique
    .map((candidate, position) => ({ candidate, position }))
    .sort((a, b) => pagesOf(b.candidate) - pagesOf(a.candidate) || bytesOf(b.candidate) - bytesOf(a.candidate) || a.position - b.position);
  const batches: Array<{ ids: string[]; pages: number; bytes: number }> = [];
  for (const { candidate } of order) {
    const pages = pagesOf(candidate);
    const bytes = bytesOf(candidate);
    const oversize = pages > maxPages || bytes > maxBytes;
    const target = oversize
      ? undefined
      : batches.find((batch) => batch.ids.length < maxFiles && batch.pages + pages <= maxPages && batch.bytes + bytes <= maxBytes);
    if (target) {
      target.ids.push(candidate.documentId);
      target.pages += pages;
      target.bytes += bytes;
    } else {
      // An oversize document runs alone: mark its batch full so nothing joins it.
      batches.push({ ids: [candidate.documentId], pages: oversize ? Number.POSITIVE_INFINITY : pages, bytes });
    }
  }
  return batches.map((batch) => batch.ids);
}
