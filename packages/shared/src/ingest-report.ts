import { z } from "zod";

/**
 * Ingest report: what DocSlurp observed about a workspace's files (pages,
 * bytes, text layer, images, vision, searchability, cost) plus the pipeline
 * settings that shaped it and rule-based recommendations. Built without any
 * model call (server/src/services/ingest-report.ts).
 */

const count = z.number().nonnegative().finite();
const nullableCount = count.nullable();

export const INGEST_REPORT_MAX_DOCUMENTS = 500;
export const INGEST_REPORT_MAX_PAGES = 20_000;
export const INGEST_REPORT_MAX_DOCUMENT_IDS = 100;
/** Per-page facts exist for files processed from this date (migration 0054). */
export const INGEST_REPORT_FACTS_SINCE = "2026-10-14";
/** A page with fewer plain-text bytes than this has effectively no text layer. */
export const INGEST_REPORT_NEAR_ZERO_TEXT_BYTES = 64;

export const ingestReportQuerySchema = z.object({
  runId: z.string().trim().min(1).max(128).optional(),
  /** Comma-separated document IDs (at most 100). */
  documentIds: z.string().trim().max(100 * 80).optional()
    .transform((value) => value ? [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))] : undefined)
    .refine((ids) => !ids || ids.length <= INGEST_REPORT_MAX_DOCUMENT_IDS, { message: `At most ${INGEST_REPORT_MAX_DOCUMENT_IDS} document IDs` }),
});
export type IngestReportQuery = z.infer<typeof ingestReportQuerySchema>;

export const ingestReportHistogramSchema = z.object({
  unit: z.literal("bytes"),
  /** Inclusive lower bound of each bin; the last bin is open-ended. */
  edges: z.array(count),
  counts: z.array(count),
  samples: count,
  p50: nullableCount,
  p95: nullableCount,
});
export type IngestReportHistogram = z.infer<typeof ingestReportHistogramSchema>;

export const ingestReportPageReasonSchema = z.enum([
  "scanned-no-vision",
  "no-text",
  "vision-failed",
  "vision-page-limit",
  "vision-cost-cap",
  "not-indexed",
  "document-failed",
  "processing",
]);
export type IngestReportPageReason = z.infer<typeof ingestReportPageReasonSchema>;

export const ingestReportPageSchema = z.object({
  documentId: z.string(),
  filename: z.string(),
  pageNumber: z.number().int().positive(),
  searchable: z.boolean().nullable(),
  reason: ingestReportPageReasonSchema.nullable(),
  textBytes: nullableCount,
  imageCount: nullableCount,
  visionStatus: z.string().nullable(),
  chunkCount: count,
});
export type IngestReportPage = z.infer<typeof ingestReportPageSchema>;

export const ingestReportConfigItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  /** Why this setting matters for what was observed. */
  note: z.string(),
});
export type IngestReportConfigItem = z.infer<typeof ingestReportConfigItemSchema>;

export const ingestReportRecommendationSchema = z.object({
  id: z.string(),
  severity: z.enum(["high", "medium", "info"]),
  title: z.string(),
  reason: z.string(),
  effect: z.string(),
  affectedPages: count,
  affectedDocuments: count,
  cost: z.object({
    /** Estimated added spend per 100 future pages; null when not estimable. */
    centsPer100Pages: nullableCount,
    /** Estimated spend to reprocess the affected files with the change. */
    reprocessCents: nullableCount,
    basis: z.string(),
  }),
  /** The pipeline change "Turn on" applies (merged onto the current pipeline server-side). */
  patch: z.record(z.string(), z.unknown()).nullable(),
  /** Files a reprocess would re-run with the workspace's current settings. */
  reprocessDocumentIds: z.array(z.string()),
});
export type IngestReportRecommendation = z.infer<typeof ingestReportRecommendationSchema>;

export const ingestReportSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  generatedAt: z.string(),
  scope: z.object({
    runId: z.string().nullable(),
    documentIds: z.array(z.string()).nullable(),
    /** Files matching the scope. */
    matchedDocuments: count,
    /** Files the report read (newest first, capped). */
    documents: count,
    /** Files whose pages were read page by page (page cap). */
    pageDetailDocuments: count,
    truncated: z.boolean(),
  }),
  files: z.object({
    total: count,
    byType: z.array(z.object({ type: z.string(), files: count, pages: count, bytes: count })),
    byStatus: z.object({ completed: count, processing: count, queued: count, failed: count, other: count }),
  }),
  pages: z.object({ total: count, avgPerFile: nullableCount }),
  bytes: z.object({
    total: count,
    avgPerFile: nullableCount,
    avgPerPage: nullableCount,
    unknownSizeFiles: count,
    perFile: ingestReportHistogramSchema,
  }),
  text: z.object({
    /** Pages with a recorded text-layer measurement. */
    recordedPages: count,
    avgBytesPerPage: nullableCount,
    zeroTextPages: count,
    nearZeroTextPages: count,
    perPage: ingestReportHistogramSchema,
    /** Bytes of indexed chunk text per page (after vision and chunking). */
    indexedAvgBytesPerPage: nullableCount,
    indexedPerPage: ingestReportHistogramSchema,
  }),
  images: z.object({
    recordedPages: count,
    avgPerPage: nullableCount,
    pagesWithImages: count,
    /** Pages with images and almost no text layer: scans or pictures of text. */
    scannedLookingPages: count,
  }),
  extraction: z.object({
    visionEnabled: z.boolean(),
    visionPages: count,
    visionNotSelectedPages: count,
    visionOverCapPages: count,
    visionFailedPages: count,
    visionCostCapPages: count,
    nativeTextPages: count,
    visionCents: nullableCount,
  }),
  searchability: z.object({
    searchablePages: count,
    unsearchablePages: count,
    pendingPages: count,
    unknownPages: count,
    byReason: z.array(z.object({ reason: ingestReportPageReasonSchema, pages: count })),
    /** Up to 20 unsearchable pages with their reason. */
    examples: z.array(ingestReportPageSchema),
  }),
  focus: ingestReportPageSchema.array().nullable(),
  languages: z.array(z.object({ code: z.string(), documents: count })),
  stages: z.object({
    failed: z.array(z.object({ stage: z.string(), documents: count })),
    skipped: z.array(z.object({ stage: z.string(), reason: z.string(), documents: count })),
  }),
  media: z.object({ audioFiles: count, videoFiles: count, mediaSeconds: nullableCount, mediaFilesWithoutText: count }),
  tables: z.object({ pages: count, documents: count }),
  performance: z.object({
    /** Run cost as run records report it: billed spend plus the flagged unbilled compute estimate. */
    costCents: nullableCount,
    /** Billed spend only: what the run cost cap (`maxCostCents`) is enforced against. */
    billedCostCents: nullableCount.optional(),
    /** True when costCents includes a worker-compute estimate. */
    computeEstimated: z.boolean().optional(),
    pagesPerMinute: nullableCount,
    minutesPer100Pages: nullableCount,
    pagesPerDollar: nullableCount,
    runs: count,
    basis: z.literal("run-wall-time-including-queue"),
  }),
  coverage: z.object({
    factsSince: z.string(),
    documentsWithFacts: count,
    documentsWithoutFacts: count,
    note: z.string().nullable(),
  }),
  config: z.array(ingestReportConfigItemSchema),
  recommendations: z.array(ingestReportRecommendationSchema),
  permissions: z.object({ canEdit: z.boolean() }),
});
export type IngestReport = z.infer<typeof ingestReportSchema>;

export const applyIngestRecommendationSchema = z.object({
  recommendationId: z.string().trim().min(1).max(64),
  /** The scope of the report the action was taken from, so the server recomputes the same report. */
  runId: z.string().trim().min(1).max(128).optional(),
  documentIds: z.array(z.string().trim().min(1).max(128)).min(1).max(INGEST_REPORT_MAX_DOCUMENT_IDS).optional(),
}).strict();
export const reprocessIngestRecommendationSchema = applyIngestRecommendationSchema;

/** Doubling byte bins, 0 then 1 B, 64 B, 256 B ... 4 MB+. */
export const INGEST_REPORT_TEXT_BYTE_EDGES = [0, 1, 64, 256, 1024, 4096, 16_384, 65_536];
export const INGEST_REPORT_FILE_BYTE_EDGES = [0, 10_240, 51_200, 204_800, 1_048_576, 5_242_880, 26_214_400, 104_857_600];

export function buildByteHistogram(values: readonly number[], edges: readonly number[]): IngestReportHistogram {
  const counts = edges.map(() => 0);
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  for (const value of sorted) {
    let index = 0;
    while (index < edges.length - 1 && value >= edges[index + 1]!) index += 1;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const quantile = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]! : null;
  return { unit: "bytes", edges: [...edges], counts, samples: sorted.length, p50: quantile(0.5), p95: quantile(0.95) };
}

const SLASH_COMMAND = /^\s*\/(?:status|report|ingest(?:-report)?)\b/i;
const NATURAL_INTENTS = [
  /\bingest(?:ion)?\s+(?:report|status|stats|summary)\b/i,
  /^\s*(?:show\s+(?:me\s+)?)?(?:the\s+)?(?:processing|indexing)\s+(?:report|status)\s*[?.!]?\s*$/i,
  /\b(?:processing|indexing)\s+(?:report|status)\s+(?:of|for)\s+(?:my|our|these|the\s+uploaded)\s+(?:files?|documents?|docs|uploads?|pdfs?|workspace)\b/i,
  /\bhow\s+(?:did|were|have|has)\s+(?:my|our|these|those|all\s+my|the\s+uploaded|my\s+uploaded)\s+(?:\w+\s+)?(?:files?|documents?|docs|uploads?|pdfs?|scans?)\s+(?:\w+\s+){0,3}?(?:process(?:ed|ing)?|ingest(?:ed)?|index(?:ed)?|go|went|do|done)\b/i,
  /\bwhy\s+(?:can'?t|cannot|couldn'?t|doesn'?t|didn'?t|won'?t|isn'?t|does\s?n'?t)\s+(?:it|you|search|docslurp|chat|the\s+search)\s+(?:\w+\s+){0,2}?(?:find|see|search|show|return|cite|answer\s+from)\b/i,
  /^\s*(?:why\s+(?:is|isn'?t)\s+)?(?:my\s+|this\s+|the\s+)?(?:page|file|document|pdf)\s*\S*\s+(?:is\s+)?(?:not|n'?t)\s+(?:searchable|indexed|showing\s+up|found)\b/i,
];

/**
 * True when a chat message asks how files were processed or why content is
 * missing, so chat answers with the ingest report instead of a model call.
 * `natural: false` accepts only the slash commands.
 */
export function requestsIngestReport(query: string, options: { natural?: boolean } = {}): boolean {
  const text = query.trim();
  if (!text || text.length > 600) return false;
  if (SLASH_COMMAND.test(text)) return true;
  return options.natural !== false && NATURAL_INTENTS.some((pattern) => pattern.test(text));
}

/** "page 4", "p. 12" and "pages 3" in a chat message (at most 5). */
export function ingestReportFocusPages(query: string): number[] {
  const pages = new Set<number>();
  for (const match of query.matchAll(/\b(?:pages?|p\.)\s*(\d{1,5})\b/gi)) {
    const page = Number(match[1]);
    if (page >= 1) pages.add(page);
    if (pages.size >= 5) break;
  }
  return [...pages];
}
