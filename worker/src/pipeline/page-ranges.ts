import type { PageRangeSlice } from "../temporal/shared.js";

export type DocumentPageRanges = ReadonlyMap<string, ReadonlyArray<{ first: number; last: number }>>;

/**
 * Validates a page-range shard's ranges against the run's own documents.
 *
 * Fails closed: a range for a document outside this run, or with bounds that are not
 * integers within 1..pageCount, rejects the whole shard instead of being clamped or
 * guessed. Ranges of one document are merged and sorted.
 */
export function resolveShardPageRanges(
  ranges: readonly PageRangeSlice[],
  documents: ReadonlyArray<{ id: string; pageCount: number }>,
): DocumentPageRanges {
  if (ranges.length === 0) throw new Error("page-range shard has no ranges");
  const pageCounts = new Map(documents.map((document) => [document.id, Math.max(1, Math.floor(document.pageCount || 1))]));
  const byDocument = new Map<string, Array<{ first: number; last: number }>>();
  for (const range of ranges) {
    const pageCount = pageCounts.get(range.documentId);
    if (pageCount === undefined) throw new Error("page-range shard names a document outside this shard");
    if (!Number.isInteger(range.first) || !Number.isInteger(range.last) || range.first < 1 || range.last < range.first || range.last > pageCount) {
      throw new Error(`page-range shard has an invalid range ${range.first}-${range.last} for a ${pageCount}-page document`);
    }
    const list = byDocument.get(range.documentId) ?? [];
    list.push({ first: range.first, last: range.last });
    byDocument.set(range.documentId, list);
  }
  for (const [documentId, list] of byDocument) {
    list.sort((a, b) => a.first - b.first);
    const merged: Array<{ first: number; last: number }> = [];
    for (const range of list) {
      const previous = merged[merged.length - 1];
      if (previous && range.first <= previous.last + 1) previous.last = Math.max(previous.last, range.last);
      else merged.push({ ...range });
    }
    byDocument.set(documentId, merged);
  }
  return byDocument;
}

export function pageInRanges(pageNumber: number, ranges: ReadonlyArray<{ first: number; last: number }> | undefined): boolean {
  return ranges?.some((range) => pageNumber >= range.first && pageNumber <= range.last) ?? false;
}

export function pagesInRanges(ranges: ReadonlyArray<{ first: number; last: number }>): number {
  return ranges.reduce((sum, range) => sum + range.last - range.first + 1, 0);
}
