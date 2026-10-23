/**
 * Ingest report (GET /v1/workspaces/:workspace/ingest-report): what DocSlurp
 * observed in a workspace's files, the settings behind it and rule-based
 * recommendations. Mirrors ingestReportSchema in the service.
 */
export type IngestReportHistogram = {
  unit: "bytes";
  /** Inclusive lower bound of each bin; the last bin is open-ended. */
  edges: number[];
  counts: number[];
  samples: number;
  p50: number | null;
  p95: number | null;
};
export type IngestReportPageReason =
  | "scanned-no-vision" | "no-text" | "vision-failed" | "vision-page-limit" | "vision-cost-cap"
  | "not-indexed" | "document-failed" | "processing";
export type IngestReportPage = {
  documentId: string; filename: string; pageNumber: number;
  searchable: boolean | null; reason: IngestReportPageReason | null;
  textBytes: number | null; imageCount: number | null; visionStatus: string | null; chunkCount: number;
};
export type IngestReportRecommendation = {
  id: string; severity: "high" | "medium" | "info"; title: string; reason: string; effect: string;
  affectedPages: number; affectedDocuments: number;
  cost: { centsPer100Pages: number | null; reprocessCents: number | null; basis: string };
  /** Pipeline change a workspace editor can apply from the dashboard. */
  patch: Record<string, unknown> | null;
  reprocessDocumentIds: string[];
};
export type IngestReportFileItem = {
  documentId: string; filename: string; mimeType: string; status: "queued" | "processing" | "completed" | "failed";
  pages: number | null; searchablePages: number | null; error: string | null;
};
export type IngestReport = {
  workspaceId: string; workspaceName: string; generatedAt: string;
  scope: { runId: string | null; documentIds: string[] | null; matchedDocuments: number; documents: number; pageDetailDocuments: number; truncated: boolean };
  files: { total: number; byType: Array<{ type: string; files: number; pages: number; bytes: number }>; byStatus: { completed: number; processing: number; queued: number; failed: number; other: number };
    /** Run-scoped reports only (at most 50, newest first). */
    items?: IngestReportFileItem[] };
  /** Run-scoped reports only. */
  run?: { id: string; status: string; durationMs: number | null } | null;
  pages: { total: number; avgPerFile: number | null };
  bytes: { total: number; avgPerFile: number | null; avgPerPage: number | null; unknownSizeFiles: number; perFile: IngestReportHistogram };
  text: { recordedPages: number; avgBytesPerPage: number | null; zeroTextPages: number; nearZeroTextPages: number; perPage: IngestReportHistogram; indexedAvgBytesPerPage: number | null; indexedPerPage: IngestReportHistogram };
  images: { recordedPages: number; avgPerPage: number | null; pagesWithImages: number; scannedLookingPages: number };
  extraction: { visionEnabled: boolean; visionPages: number; visionNotSelectedPages: number; visionOverCapPages: number; visionFailedPages: number; visionCostCapPages: number; nativeTextPages: number; visionCents: number | null };
  searchability: { searchablePages: number; unsearchablePages: number; pendingPages: number; unknownPages: number; byReason: Array<{ reason: IngestReportPageReason; pages: number }>; examples: IngestReportPage[] };
  focus: IngestReportPage[] | null;
  languages: Array<{ code: string; documents: number }>;
  stages: { failed: Array<{ stage: string; documents: number }>; skipped: Array<{ stage: string; reason: string; documents: number }> };
  media: { audioFiles: number; videoFiles: number; mediaSeconds: number | null; mediaFilesWithoutText: number };
  tables: { pages: number; documents: number };
  performance: { costCents: number | null; billedCostCents?: number | null; computeEstimated?: boolean; pagesPerMinute: number | null; minutesPer100Pages: number | null; pagesPerDollar: number | null; runs: number; basis: "run-wall-time-including-queue" };
  coverage: { factsSince: string; documentsWithFacts: number; documentsWithoutFacts: number; note: string | null };
  config: Array<{ key: string; label: string; value: string; note: string }>;
  recommendations: IngestReportRecommendation[];
  permissions: { canEdit: boolean };
};
