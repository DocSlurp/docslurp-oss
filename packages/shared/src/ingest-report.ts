import { z } from "zod";

import { DOCUMENT_FAILURE_MARKERS, PUBLIC_ERROR_MESSAGES } from "./public-errors.js";

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
  /** Quality fast kept a page without a text layer as its page image (never read). */
  "kept-as-image",
  "no-text",
  "vision-failed",
  "vision-page-limit",
  "vision-cost-cap",
  /** The run's vision attempt guard (page bound, rejection breaker, org attempt limit) refused this page. */
  "vision-stopped",
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

/**
 * Why a file failed, classified from the worker's stored error. The raw error
 * text stays in the database and logs; the report carries only this reason,
 * reviewed copy and a short sanitized detail.
 */
export const ingestReportFailureReasonSchema = z.enum([
  "ocr_unavailable",
  "extractor_failed",
  "unsupported_format",
  "unreadable_file",
  "timeout",
  "provider_failed",
  "policy_blocked",
  "cancelled",
  "unknown",
]);
export type IngestReportFailureReason = z.infer<typeof ingestReportFailureReasonSchema>;

export const ingestReportFailureSchema = z.object({
  documentId: z.string(),
  filename: z.string(),
  /** The pipeline stage that failed, when a failed stage was recorded. */
  stage: z.string().nullable(),
  reason: ingestReportFailureReasonSchema,
  /** Reviewed, user-facing explanation of the reason. */
  message: z.string(),
  /** Short sanitized excerpt of the recorded error (no paths, URLs, secrets or stack frames); null when none was recorded. */
  detail: z.string().nullable(),
  /** False when running the same file again fails the same way until something else is fixed. */
  retryable: z.boolean(),
});
export type IngestReportFailure = z.infer<typeof ingestReportFailureSchema>;

export const ingestReportFailuresSchema = z.object({
  total: count,
  byReason: z.array(z.object({ reason: ingestReportFailureReasonSchema, documents: count })),
  /** Up to 20 failed files, newest first. */
  examples: z.array(ingestReportFailureSchema),
});
export type IngestReportFailures = z.infer<typeof ingestReportFailuresSchema>;

export const INGEST_REPORT_FAILURE_DETAIL_MAX = 160;

const FAILURE_COPY: Record<IngestReportFailureReason, { message: string; retryable: boolean }> = {
  ocr_unavailable: {
    message: "Text recognition (OCR) is not working on the processing server, so this file's text could not be read. Retrying fails the same way until an operator fixes the OCR setup.",
    retryable: false,
  },
  extractor_failed: { message: "None of the text extractors could read this file.", retryable: true },
  unsupported_format: { message: PUBLIC_ERROR_MESSAGES.unsupportedType, retryable: false },
  unreadable_file: { message: PUBLIC_ERROR_MESSAGES.unreadableSource, retryable: false },
  timeout: { message: "Processing timed out before this file finished.", retryable: true },
  provider_failed: { message: "An AI provider call failed or was rate-limited while processing this file.", retryable: true },
  policy_blocked: { message: "Workspace or server policy (privacy mode, spend cap or PII rules) stopped processing this file.", retryable: false },
  cancelled: { message: "Processing of this file was cancelled.", retryable: true },
  unknown: { message: "Processing failed and the cause was not recorded.", retryable: true },
};

/** Most specific, least recoverable causes first: an OCR crash arrives wrapped in "no extractor produced output". */
const FAILURE_PATTERNS: Array<[IngestReportFailureReason, RegExp]> = [
  ["ocr_unavailable", /tessdata|traineddata|tesseract|leptonica|\bocr\b.*(?:unavailable|not (?:installed|found|available)|failed to (?:init|load))/i],
  ["unsupported_format", /unsupported (?:file|format|media|mime|content)|(?:unknown|unrecognized|unrecognised) (?:file )?(?:format|type)|no (?:parser|handler) (?:for|available for)/i],
  ["unreadable_file", /password|encrypted|corrupt|truncated|malformed|damaged|invalid (?:pdf|zip|xref|header|image)|cross-reference|xref|not a valid|bad (?:zip|header)|unexpected end of file|premature end/i],
  ["timeout", /timed? ?out|timeout|deadline exceeded|ETIMEDOUT/i],
  ["policy_blocked", /privacy mode|local-only|strict-privacy|cost cap|spend cap|maxCostCents|budget|\bpii\b|policy/i],
  ["provider_failed", /rate.?limit|\b429\b|\bprovider\b|openrouter|upstream|overloaded|quota|\b50[0234]\b/i],
  ["extractor_failed", /no extractor produced output|extractor/i],
];

/** Maps a stored worker error (and the document status) to a reason and reviewed copy. Never echoes the raw text. */
export function classifyIngestFailure(error: string | null | undefined, documentStatus?: string): { reason: IngestReportFailureReason; message: string; retryable: boolean } {
  const text = error ?? "";
  const marker = Object.entries(DOCUMENT_FAILURE_MARKERS).find(([, value]) => text.includes(value));
  const reason: IngestReportFailureReason = documentStatus === "cancelled" ? "cancelled"
    : documentStatus === "pii_blocked" || marker ? "policy_blocked"
      : FAILURE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown";
  const copy = FAILURE_COPY[reason];
  // Conditions the uploader can act on keep their own reviewed copy (for example a silent video).
  return { reason, message: marker ? PUBLIC_ERROR_MESSAGES[marker[0] as keyof typeof DOCUMENT_FAILURE_MARKERS] : copy.message, retryable: copy.retryable };
}

/**
 * A short excerpt of a stored error that is safe to show: first line only, no
 * stack frames, filesystem paths, URLs (including connection strings), e-mail
 * addresses or credential-looking values. Null when nothing remains.
 */
export function sanitizeFailureDetail(error: string | null | undefined): string | null {
  if (!error) return null;
  const line = error.split(/\r?\n/).find((entry) => entry.trim() && !/^\s*at\s/.test(entry)) ?? "";
  const cleaned = line
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/(?<![\w.:/-])(?:[A-Za-z]:\\|~\/|\.{0,2}\/)[^\s'"`<>|,;)\]]*/g, "<path>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(?:authorization|api[_-]?key|token|secret|password|passwd|credential)s?\s*[=:]\s*(?!<)\S+(?:\s+<redacted>)?/gi, (match) => `${match.split(/[=:]/)[0]}=<redacted>`)
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]{8,}/g, "<redacted>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "<redacted>")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > INGEST_REPORT_FAILURE_DETAIL_MAX ? `${cleaned.slice(0, INGEST_REPORT_FAILURE_DETAIL_MAX - 1)}…` : cleaned;
}

export const ingestReportConfigItemSchema =z.object({
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

export const INGEST_REPORT_MAX_FILE_ITEMS = 50;

/** Per-file status row; present only on run-scoped reports (at most 50, newest first). Never carries storage keys or URLs. */
export const ingestReportFileItemSchema = z.object({
  documentId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  status: z.enum(["queued", "processing", "completed", "failed"]),
  /** Null until the page count is known. */
  pages: count.nullable(),
  /** Null until page-level facts are read for this file. */
  searchablePages: count.nullable(),
  /** Short, non-sensitive failure summary (names the failed stage); null unless failed. */
  error: z.string().nullable(),
});
export type IngestReportFileItem = z.infer<typeof ingestReportFileItemSchema>;

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
    /** Run-scoped reports only. */
    items: z.array(ingestReportFileItemSchema).max(INGEST_REPORT_MAX_FILE_ITEMS).optional(),
  }),
  /** Run-scoped reports only: the run the report is scoped to (null when it is not found). */
  run: z.object({
    id: z.string(),
    status: z.string(),
    durationMs: nullableCount,
  }).nullable().optional(),
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
    /** Pages with images and almost no text layer: scans or pictures of text. Pages of failed files are excluded (see `failures`). */
    scannedLookingPages: count,
  }),
  extraction: z.object({
    visionEnabled: z.boolean(),
    visionPages: count,
    visionNotSelectedPages: count,
    visionOverCapPages: count,
    visionFailedPages: count,
    visionCostCapPages: count,
    /** Vision output was rejected (degenerate, refusal, truncated); the page kept its native or OCR text. */
    visionRejectedPages: count.optional(),
    /** The run's vision attempt guard (page bound, rejection breaker, org attempt limit) refused these pages. */
    visionStoppedPages: count.optional(),
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
  /** Files that failed, why, and at which stage. Defaults to none for reports stored before this field existed. */
  failures: ingestReportFailuresSchema.default({ total: 0, byReason: [], examples: [] }),
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
export const reprocessIngestRecommendationSchema = applyIngestRecommendationSchema.extend({ speedBoost: z.boolean().optional() });

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
