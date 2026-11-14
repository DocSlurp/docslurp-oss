import { resolveSummaryTreeLimits, SummaryTreeInputError, type SummaryTreeLimits } from "./limits.js";

/**
 * The fields of one chunk the summary tree reads. `index` is the chunk's position in the document's chunk
 * stream (the `chunk_index` the embed stage stores), `rawText` the chunk text without its contextual preamble.
 */
export interface SummaryTreeChunk {
  index: number;
  rawText: string;
  headingPath?: readonly string[] | null;
  pageNumber?: number | null;
  pageNumbers?: readonly number[] | null;
  overlapIndex?: number | null;
  tableGranularity?: string | null;
  evidenceType?: string | null;
}

export interface SummaryTreeLeaf {
  chunkIndex: number;
  rawText: string;
  headingPath: readonly string[];
  pageStart: number | null;
  pageEnd: number | null;
}

export type SummaryTreeLeafExclusion = "overlap-chunk" | "table-detail-chunk" | "table-chunk";

export type SummaryTreeDocumentSkipReason =
  | "spreadsheet-format"
  | "structured-data-format"
  | "audio-video"
  | "no-leaves"
  | "table-heavy"
  | "below-long-document-floor";

export interface SummaryTreeLeafSelection {
  /** Prose leaves in document order. Empty when the document is skipped. */
  leaves: SummaryTreeLeaf[];
  /** Why the whole document is skipped, or null when it gets a tree. */
  skipReason: SummaryTreeDocumentSkipReason | null;
  /** Counts for stage stats. `table-chunk` counts table leaves left out of a prose document. */
  excluded: Record<SummaryTreeLeafExclusion, number>;
  stats: { chunks: number; candidateLeaves: number; proseLeaves: number; tableLeaves: number; tableLeafShare: number };
}

/** Why a chunk is not a leaf at all: it repeats text another chunk already carries. */
export function chunkDuplicateReason(chunk: SummaryTreeChunk): "overlap-chunk" | "table-detail-chunk" | null {
  if ((chunk.overlapIndex ?? 0) !== 0) return "overlap-chunk";
  if (chunk.tableGranularity === "row" || chunk.tableGranularity === "cell") return "table-detail-chunk";
  return null;
}

export function isTableLeaf(chunk: SummaryTreeChunk): boolean {
  return (chunk.tableGranularity ?? null) !== null || chunk.evidenceType === "table";
}

const SKIPPED_FORMATS: Record<string, SummaryTreeDocumentSkipReason> = {
  "office-excel": "spreadsheet-format",
  "structured-csv": "structured-data-format",
  "structured-json": "structured-data-format",
  audio: "audio-video",
  video: "audio-video",
};

/** The skip decided by the file alone, before any chunk is read. */
export function summaryTreeFormatSkipReason(document: { normalizedFormat?: string | null; mimeType?: string | null }): SummaryTreeDocumentSkipReason | null {
  const byFormat = SKIPPED_FORMATS[document.normalizedFormat ?? ""];
  if (byFormat) return byFormat;
  const mimeType = (document.mimeType ?? "").toLowerCase();
  return mimeType.startsWith("audio/") || mimeType.startsWith("video/") ? "audio-video" : null;
}

function pageRange(chunk: SummaryTreeChunk): { pageStart: number | null; pageEnd: number | null } {
  let pageStart: number | null = null;
  let pageEnd: number | null = null;
  const visit = (page: number | null | undefined) => {
    if (typeof page !== "number" || !Number.isFinite(page)) return;
    pageStart = pageStart === null ? page : Math.min(pageStart, page);
    pageEnd = pageEnd === null ? page : Math.max(pageEnd, page);
  };
  for (const page of chunk.pageNumbers ?? []) visit(page);
  if (pageStart === null) visit(chunk.pageNumber);
  return { pageStart, pageEnd };
}

export type SummaryTreeChunkVerdict =
  /** A prose leaf; `pageStart`/`pageEnd` are its page range. */
  | { kind: "leaf"; pageStart: number | null; pageEnd: number | null }
  | { kind: "excluded"; reason: SummaryTreeLeafExclusion };

export interface SummaryTreeLeafCounts {
  /** Why the whole document is skipped, or null when it gets a tree. */
  skipReason: SummaryTreeDocumentSkipReason | null;
  /** Counts for stage stats. `table-chunk` counts table leaves left out of a prose document. */
  excluded: Record<SummaryTreeLeafExclusion, number>;
  stats: { chunks: number; candidateLeaves: number; proseLeaves: number; tableLeaves: number; tableLeafShare: number };
}

/**
 * Leaf selection one chunk at a time, for a caller that streams a document's chunks and must not hold them.
 * `add` says whether the chunk is a leaf; `finish` says whether the document gets a tree. Chunks must arrive in
 * increasing index order.
 *
 * A leaf is a chunk with `overlapIndex === 0` and no row or cell table granularity: overlap chunks and
 * per-row / per-cell chunks repeat text the base chunks already hold. Whole-table chunks count toward the
 * table share and are then left out, so a prose document is summarized from its prose.
 */
export function createSummaryTreeLeafSelector(
  document: { normalizedFormat?: string | null; mimeType?: string | null },
  limitOverrides?: Partial<SummaryTreeLimits>,
): { add(chunk: SummaryTreeChunk): SummaryTreeChunkVerdict; finish(): SummaryTreeLeafCounts } {
  const limits = resolveSummaryTreeLimits(limitOverrides);
  const excluded: Record<SummaryTreeLeafExclusion, number> = { "overlap-chunk": 0, "table-detail-chunk": 0, "table-chunk": 0 };
  let chunkCount = 0;
  let proseLeaves = 0;
  let previousIndex = -1;
  return {
    add(chunk) {
      chunkCount++;
      if (!Number.isInteger(chunk.index) || chunk.index <= previousIndex) {
        throw new SummaryTreeInputError(`summary tree chunks must arrive in increasing index order (got ${chunk.index} after ${previousIndex})`);
      }
      previousIndex = chunk.index;
      const duplicate = chunkDuplicateReason(chunk);
      if (duplicate) {
        excluded[duplicate]++;
        return { kind: "excluded", reason: duplicate };
      }
      if (isTableLeaf(chunk)) {
        excluded["table-chunk"]++;
        return { kind: "excluded", reason: "table-chunk" };
      }
      if (typeof chunk.rawText !== "string") {
        throw new SummaryTreeInputError(`summary tree chunk ${chunk.index} has no raw text`);
      }
      proseLeaves++;
      return { kind: "leaf", ...pageRange(chunk) };
    },
    finish() {
      const tableLeaves = excluded["table-chunk"];
      const candidateLeaves = proseLeaves + tableLeaves;
      const tableLeafShare = candidateLeaves === 0 ? 0 : tableLeaves / candidateLeaves;
      const skipReason: SummaryTreeDocumentSkipReason | null =
        summaryTreeFormatSkipReason(document)
        ?? (candidateLeaves === 0 ? "no-leaves" : null)
        ?? (tableLeafShare > limits.maxTableLeafShare ? "table-heavy" : null)
        ?? (proseLeaves < limits.minDocumentLeaves ? "below-long-document-floor" : null);
      return { skipReason, excluded, stats: { chunks: chunkCount, candidateLeaves, proseLeaves, tableLeaves, tableLeafShare } };
    },
  };
}

/** Leaves of one document and whether the document gets a tree at all (see `createSummaryTreeLeafSelector`). */
export function selectSummaryTreeLeaves(
  document: { normalizedFormat?: string | null; mimeType?: string | null },
  chunks: Iterable<SummaryTreeChunk>,
  limitOverrides?: Partial<SummaryTreeLimits>,
): SummaryTreeLeafSelection {
  const selector = createSummaryTreeLeafSelector(document, limitOverrides);
  const leaves: SummaryTreeLeaf[] = [];
  for (const chunk of chunks) {
    const verdict = selector.add(chunk);
    if (verdict.kind === "leaf") {
      leaves.push({ chunkIndex: chunk.index, rawText: chunk.rawText, headingPath: chunk.headingPath ?? [], pageStart: verdict.pageStart, pageEnd: verdict.pageEnd });
    }
  }
  const counts = selector.finish();
  return { ...counts, leaves: counts.skipReason ? [] : leaves };
}

/** One chunk as the embed stage stores it in its artifact: raw text lives in `metadata.rawText`. */
export interface EmbeddingChunkLike {
  index: number;
  headingPath?: readonly string[] | null;
  pageNumber?: number | null;
  pageNumbers?: readonly number[] | null;
  tableGranularity?: string | null;
  evidenceType?: string | null;
  metadata?: Record<string, unknown>;
}

export function summaryTreeChunkFromEmbeddingChunk(chunk: EmbeddingChunkLike): SummaryTreeChunk {
  const rawText = chunk.metadata?.rawText;
  // `text` carries the contextual preamble, which changes on any edit: it is never a stand-in for raw text.
  if (typeof rawText !== "string") throw new SummaryTreeInputError(`embedding chunk ${chunk.index} has no metadata.rawText`);
  const overlapIndex = chunk.metadata?.overlapIndex;
  return {
    index: chunk.index,
    rawText,
    headingPath: chunk.headingPath ?? [],
    pageNumber: chunk.pageNumber ?? null,
    pageNumbers: chunk.pageNumbers ?? [],
    overlapIndex: typeof overlapIndex === "number" ? overlapIndex : 0,
    tableGranularity: chunk.tableGranularity ?? null,
    evidenceType: chunk.evidenceType ?? null,
  };
}

/** Chunks as the embed stage stores them in its artifact: raw text lives in `metadata.rawText`. */
export function summaryTreeChunksFromEmbeddingChunks(chunks: ReadonlyArray<EmbeddingChunkLike>): SummaryTreeChunk[] {
  return chunks.map(summaryTreeChunkFromEmbeddingChunk);
}
