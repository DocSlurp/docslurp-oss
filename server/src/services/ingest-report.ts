import {
  buildByteHistogram,
  classifyIngestFailure,
  sanitizeFailureDetail,
  INGEST_REPORT_FACTS_SINCE,
  INGEST_REPORT_FILE_BYTE_EDGES,
  INGEST_REPORT_MAX_DOCUMENTS,
  INGEST_REPORT_MAX_FILE_ITEMS,
  INGEST_REPORT_MAX_PAGES,
  INGEST_REPORT_NEAR_ZERO_TEXT_BYTES,
  INGEST_REPORT_TEXT_BYTE_EDGES,
  applyDefaultVisionOverride,
  mergePipelineFeatures,
  parserPlaybookCatalog,
  visionModelCatalogByUri,
  visionProfileCatalog,
  type IngestReport,
  type IngestReportFileItem,
  type IngestReportConfigItem,
  type IngestReportFailure,
  type IngestReportFailureReason,
  type IngestReportPage,
  type IngestReportPageReason,
  type IngestReportRecommendation,
  type PipelineFeatureOverrides,
  type PipelineFeatures,
  type WorkspaceRecord,
} from "@docslurp/shared";
import type { BulkReprocessResult } from "./documents.js";
import { sql, type SqlClient } from "../db.js";
import { workspaceRunsUsageCost } from "./usage-attribution.js";

/**
 * Ingest report: per-file and per-page observations for a workspace (or one
 * run / a set of documents), the pipeline settings that shaped them and
 * deterministic recommendations. No model call. Every query is scoped to the
 * caller-authorized workspace id; callers must check access first.
 */

/** Pages per file read page by page; longer files contribute their first pages. */
const MAX_PAGES_PER_DOCUMENT = 5_000;
/** Embedding planning constant, as in run-processing-preview.ts (local profiles are free). */
const EMBED_CENTS_PER_PAGE = 0.002;
const VISION_PAGE_CAP_MAX = 32;
const EXAMPLE_LIMIT = 20;

export interface IngestReportDocumentRow {
  id: string;
  filename: string;
  mimeType: string;
  status: string;
  pageCount: number;
  fileSize: number;
  runId: string | null;
  createdAt: string;
  chunkTotal: number;
  chunkUnattributed: number;
  language: string | null;
  /** A newer version replaced this document (only in run or document scopes); never reprocessed again. */
  superseded?: boolean;
}

export interface IngestReportPageRow {
  documentId: string;
  pageNumber: number;
  hasFacts: boolean;
  textBytes: number | null;
  imageCount: number | null;
  visionStatus: string | null;
  chunkCount: number;
  chunkBytes: number;
}

export interface IngestReportStageRow {
  documentId: string;
  stage: string;
  status: string;
  skipped: boolean;
  reason: string | null;
  selectedPages: number | null;
  pages: number | null;
  costCents: number | null;
  tablePages: number | null;
  durationSeconds: number | null;
  /** The worker's stored stage error (raw: never exposed, only classified and sanitized). Present on failed stages. */
  error?: string | null;
}

export interface IngestReportRunRow {
  id: string;
  status: string;
  pagesProcessed: number;
  durationMs: number;
}

export interface IngestReportInput {
  workspace: Pick<WorkspaceRecord, "id" | "name" | "pipeline">;
  scope: { runId: string | null; documentIds: string[] | null; matchedDocuments: number };
  documents: IngestReportDocumentRow[];
  /** Document ids whose pages were loaded (within the page cap). */
  pageDetailDocumentIds: string[];
  pages: IngestReportPageRow[];
  stages: IngestReportStageRow[];
  runs: IngestReportRunRow[];
  /** Run cost as the run records report it: billed spend plus the flagged compute estimate. */
  costCents: number | null;
  /** costCents without the compute estimate: what the run cost cap is enforced against. */
  billedCostCents?: number | null;
  computeEstimated?: boolean;
  canEdit: boolean;
  focusPages?: number[];
  now?: Date;
}

type FileKind = "pdf" | "image" | "audio" | "video" | "office" | "html" | "text" | "epub" | "other";

export function fileKind(mimeType: string, filename = ""): FileKind {
  const mime = mimeType.toLowerCase();
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/epub+zip" || ext === "epub") return "epub";
  if (mime.includes("html")) return "html";
  if (/officedocument|msword|ms-excel|ms-powerpoint|opendocument|rtf/.test(mime) || ["docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "rtf"].includes(ext)) return "office";
  if (mime.startsWith("text/") || mime === "application/json" || ["md", "txt", "csv", "json"].includes(ext)) return "text";
  return "other";
}

const QUEUED = new Set(["queued"]);
const FAILED = new Set(["failed", "pii_blocked", "cancelled"]);

function statusBucket(status: string): "completed" | "processing" | "queued" | "failed" {
  if (status === "completed") return "completed";
  if (QUEUED.has(status)) return "queued";
  if (FAILED.has(status)) return "failed";
  return "processing";
}

function buildFileItems(
  docs: IngestReportDocumentRow[],
  pageViews: Array<{ documentId: string; searchable: boolean | null }>,
  stagesByDoc: Map<string, IngestReportStageRow[]>,
  detailIds: Set<string>,
): IngestReportFileItem[] {
  const searchableByDoc = new Map<string, number>();
  for (const page of pageViews) if (page.searchable === true) searchableByDoc.set(page.documentId, (searchableByDoc.get(page.documentId) ?? 0) + 1);
  return docs.slice(0, INGEST_REPORT_MAX_FILE_ITEMS).map((doc) => {
    const status = statusBucket(doc.status);
    const failedStage = status === "failed" ? (stagesByDoc.get(doc.id) ?? []).find((stage) => stage.status === "failed") : undefined;
    return {
      documentId: doc.id,
      filename: doc.filename,
      mimeType: doc.mimeType,
      status,
      pages: doc.pageCount > 0 ? doc.pageCount : null,
      searchablePages: detailIds.has(doc.id) ? searchableByDoc.get(doc.id) ?? 0 : null,
      error: status === "failed" ? (failedStage ? `Failed during ${failedStage.stage}` : "Processing failed") : null,
    };
  });
}

function buildRunSummary(runId: string, runs: IngestReportRunRow[]): IngestReport["run"] {
  const run = runs.find((row) => row.id === runId);
  if (!run) return null;
  const terminal = run.status === "completed" || FAILED.has(run.status);
  return { id: run.id, status: run.status, durationMs: terminal && run.durationMs > 0 ? Math.round(run.durationMs) : null };
}

function avg(total: number, n: number): number | null {
  return n > 0 ? total / n : null;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function plural(n: number, word: string, many = `${word}s`) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? word : many}`;
}

/** Verb or pronoun that agrees with a count: agree(1, "has", "have"). */
function agree(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

function formatCents(cents: number): string {
  if (cents < 1) return `${cents.toFixed(2)}¢`;
  if (cents < 100) return `${cents.toFixed(1)}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

/** Model URI the workspace's vision stage calls (explicit, else the profile's). */
export function visionModelUri(pipeline: PipelineFeatures): string {
  // Includes the DOCSLURP_VISION_MODEL_URI override, matching the model the worker calls.
  return applyDefaultVisionOverride(pipeline).vision.modelUri ?? visionProfileCatalog[pipeline.vision.profile]?.config.modelUri ?? "";
}

/** Pages per file vision may read: forceAllPages uses vision.maxPagesPerDocument, otherwise the playbook's cap wins. */
export function effectiveVisionPageCap(pipeline: PipelineFeatures): number {
  if (pipeline.vision.forceAllPages) return pipeline.vision.maxPagesPerDocument;
  return parserPlaybookCatalog[pipeline.parserPlaybook]?.guidance?.visionMaxPagesPerDocument ?? pipeline.vision.maxPagesPerDocument;
}

interface PageView extends IngestReportPage {
  kind: FileKind;
  scannedLooking: boolean;
  docStatus: ReturnType<typeof statusBucket>;
}

function classifyPage(doc: IngestReportDocumentRow, row: IngestReportPageRow): PageView {
  const kind = fileKind(doc.mimeType, doc.filename);
  const docStatus = statusBucket(doc.status);
  const lowText = row.textBytes !== null && row.textBytes < INGEST_REPORT_NEAR_ZERO_TEXT_BYTES;
  const scannedLooking = lowText && ((row.imageCount ?? 0) > 0 || kind === "image");
  const pageAttributed = doc.chunkTotal > doc.chunkUnattributed;
  let searchable: boolean | null;
  let reason: IngestReportPageReason | null = null;
  if (docStatus === "failed") {
    searchable = false;
    reason = "document-failed";
  } else if (row.chunkCount > 0) {
    searchable = true;
  } else if (doc.chunkTotal > 0 && !pageAttributed) {
    // Chunks exist but carry no page numbers (e.g. non-paged formats): searchable as a whole.
    searchable = true;
  } else if (docStatus !== "completed") {
    searchable = null;
    reason = "processing";
  } else {
    searchable = false;
    if (row.visionStatus === "over-cap") reason = "vision-page-limit";
    else if (row.visionStatus === "cost-cap") reason = "vision-cost-cap";
    else if (row.visionStatus === "guarded") reason = "vision-stopped";
    else if (row.visionStatus === "failed") reason = "vision-failed";
    else if (scannedLooking) reason = "scanned-no-vision";
    else if (lowText) reason = "no-text";
    else if (row.textBytes !== null) reason = "not-indexed";
  }
  return {
    documentId: doc.id,
    filename: doc.filename,
    pageNumber: row.pageNumber,
    searchable,
    reason,
    textBytes: row.textBytes,
    imageCount: row.imageCount,
    visionStatus: row.visionStatus,
    chunkCount: row.chunkCount,
    kind,
    scannedLooking,
    docStatus,
  };
}

function publicPage(page: PageView): IngestReportPage {
  const { kind: _kind, scannedLooking: _scanned, docStatus: _status, ...rest } = page;
  return rest;
}

const KIND_ORDER: FileKind[] = ["pdf", "image", "office", "html", "text", "epub", "audio", "video", "other"];

export function buildIngestReport(input: IngestReportInput): IngestReport {
  const pipeline = input.workspace.pipeline;
  const docs = input.documents;
  const docById = new Map(docs.map((doc) => [doc.id, doc]));
  const pageViews = input.pages.flatMap((row) => {
    const doc = docById.get(row.documentId);
    return doc ? [classifyPage(doc, row)] : [];
  });
  const stagesByDoc = new Map<string, IngestReportStageRow[]>();
  for (const stage of input.stages) {
    stagesByDoc.set(stage.documentId, [...(stagesByDoc.get(stage.documentId) ?? []), stage]);
  }

  // Files and bytes
  const byType = new Map<FileKind, { files: number; pages: number; bytes: number }>();
  const byStatus = { completed: 0, processing: 0, queued: 0, failed: 0, other: 0 };
  let totalPages = 0;
  let totalBytes = 0;
  let sizedFiles = 0;
  let sizedPages = 0;
  const fileSizes: number[] = [];
  for (const doc of docs) {
    const kind = fileKind(doc.mimeType, doc.filename);
    const entry = byType.get(kind) ?? { files: 0, pages: 0, bytes: 0 };
    entry.files += 1;
    entry.pages += Math.max(0, doc.pageCount);
    entry.bytes += Math.max(0, doc.fileSize);
    byType.set(kind, entry);
    byStatus[statusBucket(doc.status)] += 1;
    totalPages += Math.max(0, doc.pageCount);
    if (doc.fileSize > 0) {
      totalBytes += doc.fileSize;
      sizedFiles += 1;
      sizedPages += Math.max(0, doc.pageCount);
      fileSizes.push(doc.fileSize);
    }
  }

  // Text layer and images (pages with facts)
  const textPages = pageViews.filter((page) => page.textBytes !== null);
  const imagePages = pageViews.filter((page) => page.imageCount !== null);
  const textValues = textPages.map((page) => page.textBytes!);
  const zeroTextPages = textPages.filter((page) => page.textBytes === 0).length;
  const nearZeroTextPages = textPages.filter((page) => page.textBytes! > 0 && page.textBytes! < INGEST_REPORT_NEAR_ZERO_TEXT_BYTES).length;
  const indexedValues = input.pages.filter((row) => {
    const doc = docById.get(row.documentId);
    return doc && statusBucket(doc.status) === "completed" && doc.chunkTotal > doc.chunkUnattributed;
  }).map((row) => row.chunkBytes);
  const imageTotal = imagePages.reduce((sum, page) => sum + (page.imageCount ?? 0), 0);
  // Pages of failed files are accounted for under `failures`; a crash during extraction says nothing about page triage.
  const scannedPages = pageViews.filter((page) => page.scannedLooking && page.docStatus !== "failed");

  // Vision outcome: page facts first, stage stats for files without them
  const visionCount = (status: string) => pageViews.filter((page) => page.visionStatus === status).length;
  const docsWithVisionFacts = new Set(pageViews.filter((page) => page.visionStatus !== null).map((page) => page.documentId));
  let visionPages = visionCount("extracted");
  let visionCents = 0;
  let visionCentsKnown = false;
  for (const doc of docs) {
    const stage = stagesByDoc.get(doc.id)?.find((entry) => entry.stage === "vision-extract");
    if (!stage) continue;
    if (stage.costCents !== null) {
      visionCents += stage.costCents;
      visionCentsKnown = true;
    }
    if (!docsWithVisionFacts.has(doc.id) && !stage.skipped && stage.pages !== null) visionPages += stage.pages;
  }
  const nativeTextPages = textPages.filter((page) => page.textBytes! >= INGEST_REPORT_NEAR_ZERO_TEXT_BYTES && page.visionStatus !== "extracted").length;

  // Searchability
  const evaluated = pageViews;
  const searchablePages = evaluated.filter((page) => page.searchable === true).length;
  const unsearchable = evaluated.filter((page) => page.searchable === false);
  const pendingPages = evaluated.filter((page) => page.searchable === null).length;
  const reasonCounts = new Map<IngestReportPageReason, number>();
  for (const page of unsearchable) if (page.reason) reasonCounts.set(page.reason, (reasonCounts.get(page.reason) ?? 0) + 1);
  const reasonOrder: IngestReportPageReason[] = ["scanned-no-vision", "vision-page-limit", "vision-cost-cap", "vision-stopped", "vision-failed", "not-indexed", "no-text", "document-failed", "processing"];
  const examples = [...unsearchable]
    .sort((a, b) => reasonOrder.indexOf(a.reason ?? "processing") - reasonOrder.indexOf(b.reason ?? "processing"))
    .slice(0, EXAMPLE_LIMIT)
    .map(publicPage);
  const focusSet = new Set(input.focusPages ?? []);
  const focus = focusSet.size
    ? pageViews.filter((page) => focusSet.has(page.pageNumber)).slice(0, EXAMPLE_LIMIT).map(publicPage)
    : null;

  // Languages, stages, media, tables
  const languageCounts = new Map<string, number>();
  for (const doc of docs) if (doc.language) languageCounts.set(doc.language, (languageCounts.get(doc.language) ?? 0) + 1);
  const failedStages = new Map<string, Set<string>>();
  const skippedStages = new Map<string, Set<string>>();
  let tablePages = 0;
  const tableDocs = new Set<string>();
  let mediaSeconds = 0;
  let mediaSecondsKnown = false;
  for (const stage of input.stages) {
    if (stage.status === "failed") {
      failedStages.set(stage.stage, (failedStages.get(stage.stage) ?? new Set()).add(stage.documentId));
    } else if (stage.skipped) {
      const key = `${stage.stage}\u0000${stage.reason ?? "skipped"}`;
      skippedStages.set(key, (skippedStages.get(key) ?? new Set()).add(stage.documentId));
    }
    if (stage.stage === "classify-route" && (stage.tablePages ?? 0) > 0) {
      tablePages += stage.tablePages!;
      tableDocs.add(stage.documentId);
    }
    if (stage.durationSeconds !== null && stage.durationSeconds > 0) {
      mediaSeconds += stage.durationSeconds;
      mediaSecondsKnown = true;
    }
  }
  const mediaDocs = docs.filter((doc) => ["audio", "video"].includes(fileKind(doc.mimeType, doc.filename)));
  const mediaWithoutText = mediaDocs.filter((doc) => statusBucket(doc.status) === "completed" && doc.chunkTotal === 0).length;

  // Performance and cost
  const completedRuns = input.runs.filter((run) => run.status === "completed" && run.durationMs > 0);
  const runPages = completedRuns.reduce((sum, run) => sum + run.pagesProcessed, 0);
  const runMs = completedRuns.reduce((sum, run) => sum + run.durationMs, 0);
  const pagesPerMinute = runMs > 0 && runPages > 0 ? (runPages * 60_000) / runMs : null;
  const allRunPages = input.runs.reduce((sum, run) => sum + run.pagesProcessed, 0);
  const pagesPerDollar = input.costCents && input.costCents > 0 && allRunPages > 0 ? allRunPages / (input.costCents / 100) : null;

  // Coverage of page facts
  const detailIds = new Set(input.pageDetailDocumentIds);
  const factsDocs = new Set(input.pages.filter((row) => row.hasFacts).map((row) => row.documentId));
  // Page facts are recorded for PDFs and image files only.
  const pagedDetailDocs = docs.filter((doc) => detailIds.has(doc.id) && doc.pageCount > 0 && ["pdf", "image"].includes(fileKind(doc.mimeType, doc.filename)));
  const withoutFacts = pagedDetailDocs.filter((doc) => !factsDocs.has(doc.id)).length;
  const coverageNote = withoutFacts > 0
    ? `Text-layer and image facts are not recorded for ${plural(withoutFacts, "file")} (processed before ${INGEST_REPORT_FACTS_SINCE}, a format other than PDF or image, or with page facts turned off); reprocessing PDFs and images fills them in.`
    : null;

  const failureList = listFailures(docs, stagesByDoc);
  const observed = {
    docs,
    failureList,
    pageViews,
    scannedPages,
    unsearchable,
    stagesByDoc,
    visionPages,
    visionCents: visionCentsKnown ? visionCents : null,
    tablePages,
    tableDocs,
    mediaDocs,
    mediaWithoutText,
    languageCounts,
    costCents: input.costCents,
    billedCostCents: input.billedCostCents ?? input.costCents,
    singleRun: input.scope.runId !== null || new Set(input.runs.map((run) => run.id)).size === 1,
    allRunPages,
    textPages: textPages.length,
  };

  return {
    workspaceId: input.workspace.id,
    workspaceName: input.workspace.name,
    generatedAt: (input.now ?? new Date()).toISOString(),
    scope: {
      runId: input.scope.runId,
      documentIds: input.scope.documentIds,
      matchedDocuments: input.scope.matchedDocuments,
      documents: docs.length,
      pageDetailDocuments: detailIds.size,
      truncated: input.scope.matchedDocuments > docs.length || detailIds.size < docs.length,
    },
    files: {
      total: docs.length,
      byType: KIND_ORDER.filter((kind) => byType.has(kind)).map((kind) => ({ type: kind, ...byType.get(kind)! })),
      byStatus,
      ...(input.scope.runId ? { items: buildFileItems(docs, pageViews, stagesByDoc, new Set(input.pageDetailDocumentIds)) } : {}),
    },
    ...(input.scope.runId ? { run: buildRunSummary(input.scope.runId, input.runs) } : {}),
    pages: { total: totalPages, avgPerFile: round(avg(totalPages, docs.length), 1) },
    bytes: {
      total: totalBytes,
      avgPerFile: round(avg(totalBytes, sizedFiles), 0),
      avgPerPage: round(avg(totalBytes, sizedPages), 0),
      unknownSizeFiles: docs.length - sizedFiles,
      perFile: buildByteHistogram(fileSizes, INGEST_REPORT_FILE_BYTE_EDGES),
    },
    text: {
      recordedPages: textPages.length,
      avgBytesPerPage: round(avg(textValues.reduce((sum, value) => sum + value, 0), textValues.length), 0),
      zeroTextPages,
      nearZeroTextPages,
      perPage: buildByteHistogram(textValues, INGEST_REPORT_TEXT_BYTE_EDGES),
      indexedAvgBytesPerPage: round(avg(indexedValues.reduce((sum, value) => sum + value, 0), indexedValues.length), 0),
      indexedPerPage: buildByteHistogram(indexedValues, INGEST_REPORT_TEXT_BYTE_EDGES),
    },
    images: {
      recordedPages: imagePages.length,
      avgPerPage: round(avg(imageTotal, imagePages.length), 2),
      pagesWithImages: imagePages.filter((page) => (page.imageCount ?? 0) > 0).length,
      scannedLookingPages: scannedPages.length,
    },
    extraction: {
      visionEnabled: pipeline.visionFallback,
      visionPages,
      visionNotSelectedPages: visionCount("not-selected"),
      visionOverCapPages: visionCount("over-cap"),
      visionFailedPages: visionCount("failed"),
      visionCostCapPages: visionCount("cost-cap"),
      visionRejectedPages: visionCount("rejected"),
      visionStoppedPages: visionCount("guarded"),
      nativeTextPages,
      visionCents: visionCentsKnown ? round(visionCents, 4) : null,
    },
    searchability: {
      searchablePages,
      unsearchablePages: unsearchable.length,
      pendingPages,
      unknownPages: unsearchable.filter((page) => page.reason === null).length,
      byReason: reasonOrder.filter((reason) => reasonCounts.has(reason)).map((reason) => ({ reason, pages: reasonCounts.get(reason)! })),
      examples,
    },
    failures: summarizeFailures(failureList),
    focus,
    languages: [...languageCounts].sort((a, b) => b[1] - a[1]).map(([code, documents]) => ({ code, documents })),
    stages: {
      failed: [...failedStages].map(([stage, ids]) => ({ stage, documents: ids.size })).sort((a, b) => b.documents - a.documents),
      skipped: [...skippedStages].map(([key, ids]) => {
        const [stage, reason] = key.split("\u0000");
        return { stage: stage!, reason: reason!, documents: ids.size };
      }).sort((a, b) => b.documents - a.documents),
    },
    media: {
      audioFiles: mediaDocs.filter((doc) => fileKind(doc.mimeType, doc.filename) === "audio").length,
      videoFiles: mediaDocs.filter((doc) => fileKind(doc.mimeType, doc.filename) === "video").length,
      mediaSeconds: mediaSecondsKnown ? round(mediaSeconds, 1) : null,
      mediaFilesWithoutText: mediaWithoutText,
    },
    tables: { pages: tablePages, documents: tableDocs.size },
    performance: {
      costCents: input.costCents === null ? null : round(input.costCents, 4),
      billedCostCents: input.billedCostCents == null ? input.costCents === null ? null : round(input.costCents, 4) : round(input.billedCostCents, 4),
      computeEstimated: input.computeEstimated ?? false,
      pagesPerMinute: round(pagesPerMinute, 1),
      minutesPer100Pages: pagesPerMinute ? round(100 / pagesPerMinute, 2) : null,
      pagesPerDollar: round(pagesPerDollar, 0),
      runs: input.runs.length,
      basis: "run-wall-time-including-queue",
    },
    coverage: {
      factsSince: INGEST_REPORT_FACTS_SINCE,
      documentsWithFacts: factsDocs.size,
      documentsWithoutFacts: withoutFacts,
      note: coverageNote,
    },
    config: buildConfigItems(pipeline, observed),
    recommendations: withoutSupersededReprocess(recommendIngestChanges(pipeline, observed), docs),
    permissions: { canEdit: input.canEdit },
  };
}

const FAILURE_EXAMPLE_LIMIT = 20;
const FAILURE_REASON_ORDER: IngestReportFailureReason[] = ["ocr_unavailable", "extractor_failed", "unreadable_file", "unsupported_format", "policy_blocked", "provider_failed", "timeout", "unknown", "cancelled"];

/** Failed files with the classified reason, failed stage and a sanitized excerpt of the stored error. */
function listFailures(docs: IngestReportDocumentRow[], stagesByDoc: Map<string, IngestReportStageRow[]>): IngestReportFailure[] {
  const failures: IngestReportFailure[] = [];
  for (const doc of docs) {
    if (statusBucket(doc.status) !== "failed") continue;
    const failedStage = stagesByDoc.get(doc.id)?.find((stage) => stage.status === "failed" && stage.error);
    const { reason, message, retryable } = classifyIngestFailure(failedStage?.error, doc.status);
    failures.push({
      documentId: doc.id, filename: doc.filename, stage: failedStage?.stage ?? null, reason, message,
      detail: sanitizeFailureDetail(failedStage?.error), retryable,
    });
  }
  return failures;
}

function summarizeFailures(failures: IngestReportFailure[]): IngestReport["failures"] {
  const counts = new Map<IngestReportFailureReason, number>();
  for (const failure of failures) counts.set(failure.reason, (counts.get(failure.reason) ?? 0) + 1);
  return {
    total: failures.length,
    byReason: FAILURE_REASON_ORDER.filter((reason) => counts.has(reason)).map((reason) => ({ reason, documents: counts.get(reason)! })),
    examples: failures.slice(0, FAILURE_EXAMPLE_LIMIT),
  };
}

function withoutSupersededReprocess(recs: IngestReportRecommendation[], docs: IngestReportDocumentRow[]): IngestReportRecommendation[] {
  const superseded = new Set(docs.filter((doc) => doc.superseded).map((doc) => doc.id));
  if (superseded.size === 0) return recs;
  return recs.map((rec) => ({ ...rec, reprocessDocumentIds: rec.reprocessDocumentIds.filter((id) => !superseded.has(id)) }));
}

type Observed = {
  docs: IngestReportDocumentRow[];
  /** Every failed file, with its classified reason. */
  failureList: IngestReportFailure[];
  pageViews: PageView[];
  scannedPages: PageView[];
  unsearchable: PageView[];
  stagesByDoc: Map<string, IngestReportStageRow[]>;
  visionPages: number;
  visionCents: number | null;
  tablePages: number;
  tableDocs: Set<string>;
  mediaDocs: IngestReportDocumentRow[];
  mediaWithoutText: number;
  languageCounts: Map<string, number>;
  costCents: number | null;
  /** Billed spend (the run cost cap's figure); null when cost is unknown. */
  billedCostCents: number | null;
  /** The report covers one run, so its spend is that run's. */
  singleRun: boolean;
  allRunPages: number;
  textPages: number;
};

function onOff(value: boolean | undefined) {
  return value ? "On" : "Off";
}

/** The settings that shaped what this report observed, with why each matters here. */
export function buildConfigItems(pipeline: PipelineFeatures, observed: Observed): IngestReportConfigItem[] {
  const items: IngestReportConfigItem[] = [];
  const kinds = new Set(observed.docs.map((doc) => fileKind(doc.mimeType, doc.filename)));
  const paged = kinds.has("pdf") || kinds.has("image");
  const cap = effectiveVisionPageCap(pipeline);
  const model = visionModelUri(pipeline);
  const perPage = visionModelCatalogByUri[model]?.estimatedCostPerPageCents;
  if (paged) {
    items.push({
      key: "visionFallback", label: "Vision for hard pages", value: onOff(pipeline.visionFallback),
      note: pipeline.visionFallback
        ? "Page triage picks pages with little or unusable text and reads them from the page image."
        : "Pages without a text layer (scans, photos of text) produce no text and cannot be found.",
    });
    items.push({
      key: "vision.forceAllPages", label: "Vision on every page", value: onOff(pipeline.vision.forceAllPages),
      note: pipeline.vision.forceAllPages
        ? `Every page up to the per-file limit is read with vision${perPage ? ` (about ${formatCents(perPage)} per page)` : ""}.`
        : "Only pages that page triage selects are read with vision.",
    });
    items.push({
      key: "vision.maxPagesPerDocument", label: "Vision pages per file", value: String(cap),
      note: pipeline.vision.forceAllPages
        ? "Vision stops after this many pages in each file."
        : `The "${pipeline.parserPlaybook}" playbook caps vision at ${cap} page${cap === 1 ? "" : "s"} per file; vision.maxPagesPerDocument applies only with vision on every page.`,
    });
    items.push({
      key: "vision.modelUri", label: "Vision model", value: model.replace(/^llm:\/\//, "") || "default",
      note: perPage !== undefined ? `Catalog estimate ${formatCents(perPage)} per page.` : "No catalog price for this model.",
    });
    items.push({
      key: "parserPlaybook", label: "Parser playbook", value: pipeline.parserPlaybook,
      note: parserPlaybookCatalog[pipeline.parserPlaybook]?.description ?? "",
    });
    if (pipeline.pageRouter?.mode && pipeline.pageRouter.mode !== "off") {
      items.push({ key: "pageRouter.mode", label: "Page router", value: pipeline.pageRouter.mode, note: "The decision-model router chooses an extractor per page; only active mode changes extraction." });
    }
    if (pipeline.documentExtraction.forceOcr || observed.scannedPages.length > 0) {
      items.push({
        key: "documentExtraction.ocr.language", label: "OCR language", value: pipeline.documentExtraction.ocr.language,
        note: `Local OCR reads text in this language${pipeline.documentExtraction.forceOcr ? "; OCR is forced on every page" : ""}.`,
      });
    }
  }
  if (observed.tablePages > 0 || !pipeline.preserveTables) {
    items.push({ key: "preserveTables", label: "Keep tables", value: onOff(pipeline.preserveTables), note: "Tables stay as Markdown tables in extracted text and chunks." });
  }
  items.push({
    key: "embed", label: "Embeddings", value: pipeline.embed && pipeline.indexVectors ? `On (${pipeline.embedding.profile})` : "Off",
    note: pipeline.embed && pipeline.indexVectors ? "Chunks are searchable by meaning as well as keywords." : "Only keyword search can find this workspace's text.",
  });
  items.push({
    key: "chunking", label: "Chunking", value: `${pipeline.chunkOverlap ? "Overlap on" : "No overlap"}, ${pipeline.contextualChunkPreambles ? "context preambles on" : "no preambles"}`,
    note: "Chunks of about 1,800 characters; a page without chunks cannot be found.",
  });
  if (kinds.has("video") || kinds.has("audio")) {
    items.push({
      key: "mediaVideo.enabled", label: "Video frames", value: onOff(pipeline.mediaVideo?.enabled !== false),
      note: "Workspace policy only, not evidence that frames were processed. Video also requires platform support, privacy permission and available budget/quota; audio transcription is a platform setting.",
    });
  }
  if (pipeline.outputSchema && Object.keys(pipeline.outputSchema).length > 0) {
    items.push({ key: "outputSchema", label: "Structured extraction", value: "On", note: "Fields are extracted against the workspace schema after text extraction." });
  }
  if (pipeline.maxCostCents !== null) {
    items.push({ key: "maxCostCents", label: "Cost cap per run", value: formatCents(pipeline.maxCostCents), note: "Vision stops for the rest of a run once its spend reaches the cap." });
  }
  if (pipeline.privacyMode !== "standard") {
    items.push({ key: "privacyMode", label: "Privacy mode", value: pipeline.privacyMode, note: "Hosted vision models are skipped unless a private route is configured." });
  }
  return items;
}

function visionCentsPerPage(pipeline: PipelineFeatures, observed: Observed): { cents: number; basis: string } {
  if (observed.visionCents !== null && observed.visionCents > 0 && observed.visionPages >= 3) {
    return { cents: observed.visionCents / observed.visionPages, basis: `observed vision spend in this workspace (${plural(observed.visionPages, "page")})` };
  }
  const model = visionModelUri(pipeline);
  const catalog = visionModelCatalogByUri[model]?.estimatedCostPerPageCents ?? 0.5;
  return { cents: catalog, basis: `catalog estimate for ${model.replace(/^llm:\/\//, "") || "the default vision model"}` };
}

/** Observed pipeline cost per page in scope excluding vision (priced separately), or null when unknown. */
function pipelineCentsPerPage(observed: Observed): number | null {
  if (observed.costCents === null || observed.allRunPages <= 0) return null;
  return Math.max(0, observed.costCents - (observed.visionCents ?? 0)) / observed.allRunPages;
}

function reprocessEstimate(observed: Observed, documentIds: string[], visionPagesPerDoc: (doc: IngestReportDocumentRow) => number, visionPerPage: number) {
  const docs = observed.docs.filter((doc) => documentIds.includes(doc.id));
  const pages = docs.reduce((sum, doc) => sum + Math.max(0, doc.pageCount), 0);
  const base = pipelineCentsPerPage(observed);
  const vision = docs.reduce((sum, doc) => sum + visionPagesPerDoc(doc), 0) * visionPerPage;
  return { pages, cents: (base ?? EMBED_CENTS_PER_PAGE) * pages + vision, baseKnown: base !== null };
}

/**
 * How each recommendation the report can emit reaches the user. Every id must be
 * listed (the compiler enforces it): "pipeline-patch" recommendations carry a
 * `patch` the chat assistant can prepare with `proposeWorkspaceSettings`
 * ({changes: {pipeline: patch}}); the rest are deliberately not proposable.
 */
export const INGEST_RECOMMENDATION_CATALOG = {
  "turn-on-vision": { proposal: "pipeline-patch", note: "visionFallback and vision page selection are proposable." },
  "vision-all-pages": { proposal: "pipeline-patch", note: "vision.forceAllPages and vision.maxPagesPerDocument are proposable." },
  "reprocess-with-vision": { proposal: "reprocess-only", note: "The setting is already in place; only reprocessing the affected files helps." },
  "retry-vision-failures": { proposal: "reprocess-only", note: "Nothing to change; reprocessing retries the failed pages." },
  "vision-cost-cap": { proposal: "outside-allowlist", note: "maxCostCents is a budget control the proposal tool never changes." },
  "vision-stopped": { proposal: "outside-allowlist", note: "The vision provider budget and rejection breaker are operator settings." },
  "vision-rejected-pages": { proposal: "informational", note: "Pages kept their own text; nothing to change." },
  "preserve-tables": { proposal: "pipeline-patch", note: "preserveTables is proposable." },
  "turn-on-embeddings": { proposal: "pipeline-patch", note: "embed and indexVectors are proposable." },
  "turn-on-video": { proposal: "pipeline-patch", note: "mediaVideo.enabled is proposable." },
  "media-without-transcript": { proposal: "outside-allowlist", note: "Transcription is a platform setting for operators." },
  "reindex-pages-with-text": { proposal: "reprocess-only", note: "Nothing to change; reprocessing re-chunks the files." },
  "retry-failed-files": { proposal: "reprocess-only", note: "Nothing to change; reprocessing runs the files again (see failures for causes that will not clear)." },
  "multilingual-embeddings": { proposal: "outside-allowlist", note: "Changing the embedding profile re-embeds everything; the proposal tool never changes it." },
  "scans-handled": { proposal: "informational", note: "No change needed." },
} as const satisfies Record<string, { proposal: "pipeline-patch" | "reprocess-only" | "outside-allowlist" | "informational"; note: string }>;
export type IngestRecommendationId = keyof typeof INGEST_RECOMMENDATION_CATALOG;

/**
 * Deterministic recommendations. Each names an existing pipeline option, the
 * evidence, the expected effect and an estimated cost; "patch" is merged onto
 * the stored pipeline when applied.
 */
export function recommendIngestChanges(pipeline: PipelineFeatures, observed: Observed): IngestReportRecommendation[] {
  const recs: Array<IngestReportRecommendation & { id: IngestRecommendationId }> = [];
  const vision = visionCentsPerPage(pipeline, observed);
  // Pages vision ran on (rejected) or the guard stopped are not missing a setting.
  const missedScans = observed.scannedPages.filter((page) =>
    page.visionStatus !== "extracted" && page.visionStatus !== "rejected" && page.visionStatus !== "guarded" && page.searchable !== true);
  const overCap = observed.pageViews.filter((page) => page.visionStatus === "over-cap" && page.searchable !== true);
  const affected = [...new Map([...missedScans, ...overCap].map((page) => [`${page.documentId}:${page.pageNumber}`, page])).values()];
  const affectedDocIds = [...new Set(affected.map((page) => page.documentId))];
  const totalScanned = observed.scannedPages.length;
  const recordedPages = observed.textPages;

  if (affected.length > 0) {
    const longest = Math.max(...observed.docs.filter((doc) => affectedDocIds.includes(doc.id)).map((doc) => doc.pageCount), 1);
    // Never lower an existing limit; raise it to the longest affected file, up to the schema maximum.
    const cap = Math.max(pipeline.vision.maxPagesPerDocument, Math.min(VISION_PAGE_CAP_MAX, longest));
    const patch = { visionFallback: true, vision: { forceAllPages: true, maxPagesPerDocument: cap } };
    // Already configured this way: the pages predate the setting (or exceed the 32-page maximum), so only reprocessing helps.
    const settingInPlace = patchHolds(pipeline, patch);
    const estimate = reprocessEstimate(observed, affectedDocIds, (doc) => Math.min(cap, Math.max(0, doc.pageCount)), vision.cents);
    const capNote = longest > VISION_PAGE_CAP_MAX ? ` Files longer than ${VISION_PAGE_CAP_MAX} pages get vision on their first ${VISION_PAGE_CAP_MAX} pages only.` : "";
    const evidence = missedScans.length > 0
      ? `${plural(missedScans.length, "page")}${recordedPages ? ` of ${recordedPages.toLocaleString("en-US")} measured` : ""} ${agree(missedScans.length, "has", "have")} images and almost no text layer (${agree(missedScans.length, "it looks", "they look")} scanned) and no searchable text`
      : `${plural(overCap.length, "page")} ${agree(overCap.length, "was", "were")} selected for vision but went past the per-file vision page limit`;
    const why = !pipeline.visionFallback
      ? "Vision is off, so nothing reads text from page images."
      : pipeline.vision.forceAllPages
        ? `Vision stops after ${pipeline.vision.maxPagesPerDocument} pages per file.`
        : `Page triage did not send them to vision, and the "${pipeline.parserPlaybook}" playbook reads at most ${effectiveVisionPageCap(pipeline)} vision pages per file.`;
    recs.push({
      id: settingInPlace ? "reprocess-with-vision" : pipeline.visionFallback ? "vision-all-pages" : "turn-on-vision",
      severity: "high",
      title: settingInPlace ? "Reprocess scanned pages with vision" : pipeline.visionFallback ? "Read every page with vision" : "Turn on vision for scanned pages",
      reason: settingInPlace
        ? `${evidence}. Vision already reads every page (up to ${cap} per file), so these files were processed before that setting${longest > VISION_PAGE_CAP_MAX ? " or are longer than the vision page maximum" : ""}.`
        : `${evidence}. ${why}`,
      effect: settingInPlace
        ? `Reprocess the ${plural(affectedDocIds.length, "affected file")} so ${agree(affectedDocIds.length, "its", "their")} scanned pages are read from the page images.${capNote}`
        : `Pages are read from their images, so scanned text becomes searchable and citable. Applies to new uploads; reprocess the ${plural(affectedDocIds.length, "affected file")} to fix existing pages.${capNote}`,
      affectedPages: affected.length,
      affectedDocuments: affectedDocIds.length,
      cost: {
        centsPer100Pages: round(vision.cents * 100, 2),
        reprocessCents: round(estimate.cents, 2),
        basis: `Vision about ${formatCents(vision.cents)} per page (${vision.basis}), charged on every page up to ${cap} per file. Reprocessing re-runs the ${plural(estimate.pages, "page")} of the affected files${estimate.baseKnown ? " at this workspace's observed cost per page" : ""} plus vision.`,
      },
      patch: settingInPlace ? null : patch,
      reprocessDocumentIds: affectedDocIds,
    });
  }

  const failedVision = observed.pageViews.filter((page) => page.visionStatus === "failed" && page.searchable !== true);
  if (failedVision.length > 0) {
    const ids = [...new Set(failedVision.map((page) => page.documentId))];
    const estimate = reprocessEstimate(observed, ids, (doc) => failedVision.filter((page) => page.documentId === doc.id).length, vision.cents);
    recs.push({
      id: "retry-vision-failures", severity: "medium",
      title: "Retry pages where vision failed",
      reason: `${plural(failedVision.length, "page")} in ${plural(ids.length, "file")} ${agree(failedVision.length, "was", "were")} sent to vision but returned no text (provider error or timeout).`,
      effect: "Reprocessing retries vision on these pages with the current settings.",
      affectedPages: failedVision.length, affectedDocuments: ids.length,
      cost: { centsPer100Pages: null, reprocessCents: round(estimate.cents, 2), basis: `Vision about ${formatCents(vision.cents)} per page (${vision.basis}).` },
      patch: null, reprocessDocumentIds: ids,
    });
  }

  const stopped = observed.pageViews.filter((page) => page.visionStatus === "guarded");
  if (stopped.length > 0) {
    const ids = [...new Set(stopped.map((page) => page.documentId))];
    recs.push({
      id: "vision-stopped", severity: "medium",
      title: "Vision stopped for the run",
      reason: `${plural(stopped.length, "page")} in ${plural(ids.length, "file")} skipped vision because the run reached its vision spend limit or too many pages returned unusable vision output.`,
      effect: "These pages keep only their own text. Reprocess the files once the cause is fixed; contact support if the limit is too low for your files.",
      affectedPages: stopped.length, affectedDocuments: ids.length,
      cost: { centsPer100Pages: null, reprocessCents: null, basis: `Vision about ${formatCents(vision.cents)} per page (${vision.basis}).` },
      patch: null, reprocessDocumentIds: [],
    });
  }

  const rejected = observed.pageViews.filter((page) => page.visionStatus === "rejected");
  if (rejected.length > 0) {
    const ids = [...new Set(rejected.map((page) => page.documentId))];
    recs.push({
      id: "vision-rejected-pages", severity: "info",
      title: "Vision output rejected on some pages",
      reason: `${plural(rejected.length, "page")} in ${plural(ids.length, "file")} returned unusable vision output (repeated, refused or cut off), so ${agree(rejected.length, "it keeps", "they keep")} ${agree(rejected.length, "its", "their")} own text layer or OCR text instead.`,
      effect: "Search and answers use the page's own text, which may miss layout, tables or formulas vision would have kept.",
      affectedPages: rejected.length, affectedDocuments: ids.length,
      cost: { centsPer100Pages: null, reprocessCents: null, basis: "No charge: rejected vision pages are not billed." },
      patch: null, reprocessDocumentIds: [],
    });
  }

  const costCapped = observed.pageViews.filter((page) => page.visionStatus === "cost-cap");
  if (costCapped.length > 0 && pipeline.maxCostCents !== null) {
    recs.push({
      id: "vision-cost-cap", severity: "medium",
      title: "The run cost cap stopped vision",
      reason: `${plural(costCapped.length, "page")} skipped vision because the run reached its ${formatCents(pipeline.maxCostCents)} cost cap${
        observed.singleRun && observed.billedCostCents !== null ? ` (${formatCents(observed.billedCostCents)} billed: AI calls, embeddings, page fees and billed compute; compute estimates do not count)` : ""
      }.`,
      effect: "Raise or remove maxCostCents in workspace settings, then reprocess, to read these pages.",
      affectedPages: costCapped.length, affectedDocuments: new Set(costCapped.map((page) => page.documentId)).size,
      cost: { centsPer100Pages: round(vision.cents * 100, 2), reprocessCents: null, basis: `Vision about ${formatCents(vision.cents)} per page (${vision.basis}).` },
      patch: null, reprocessDocumentIds: [],
    });
  }

  if (observed.tablePages > 0 && !pipeline.preserveTables) {
    recs.push({
      id: "preserve-tables", severity: "medium",
      title: "Keep tables as tables",
      reason: `${plural(observed.tablePages, "page")} in ${plural(observed.tableDocs.size, "file")} ${agree(observed.tablePages, "looks", "look")} table-heavy, but table preservation is off, so rows and columns are flattened into prose.`,
      effect: "Tables stay as Markdown tables, so cells keep their row and column context in answers. Applies to new uploads.",
      affectedPages: observed.tablePages, affectedDocuments: observed.tableDocs.size,
      cost: { centsPer100Pages: 0, reprocessCents: null, basis: "No model call; extraction keeps table structure." },
      patch: { preserveTables: true },
      reprocessDocumentIds: [...observed.tableDocs],
    });
  }

  const textual = observed.pageViews.filter((page) => (page.textBytes ?? 0) >= INGEST_REPORT_NEAR_ZERO_TEXT_BYTES).length;
  if ((!pipeline.embed || !pipeline.indexVectors) && (textual > 0 || observed.docs.length > 0)) {
    recs.push({
      id: "turn-on-embeddings", severity: "medium",
      title: "Turn on embeddings",
      reason: "Embeddings are off, so search only matches exact keywords and questions phrased differently from the text miss.",
      effect: "Chunks get vectors, so search and chat find passages by meaning. Applies to new uploads.",
      affectedPages: observed.pageViews.length, affectedDocuments: observed.docs.length,
      cost: { centsPer100Pages: pipeline.embedding.profile.endsWith("local") ? 0 : EMBED_CENTS_PER_PAGE * 100, reprocessCents: null, basis: pipeline.embedding.profile.endsWith("local") ? `Local ${pipeline.embedding.profile} profile: worker compute only.` : `Planning estimate ${EMBED_CENTS_PER_PAGE}¢ per page.` },
      patch: { embed: true, indexVectors: true },
      reprocessDocumentIds: [],
    });
  }

  const videos = observed.mediaDocs.filter((doc) => fileKind(doc.mimeType, doc.filename) === "video");
  if (videos.length > 0 && pipeline.mediaVideo?.enabled === false) {
    recs.push({
      id: "turn-on-video", severity: "medium",
      title: "Read video frames",
      reason: `${plural(videos.length, "video file")} ${agree(videos.length, "has", "have")} video frame reading disabled in this workspace; on-screen text and slides may not be indexed.`,
      effect: "Selected frames are read with a vision model alongside the transcript. Applies to new uploads and needs platform video support.",
      affectedPages: 0, affectedDocuments: videos.length,
      cost: { centsPer100Pages: null, reprocessCents: null, basis: "Depends on video length and frame selection; mediaVideo.maxCostCents bounds it per file." },
      patch: { mediaVideo: { enabled: true } },
      reprocessDocumentIds: videos.map((doc) => doc.id),
    });
  }

  if (observed.mediaWithoutText > 0) {
    recs.push({
      id: "media-without-transcript", severity: "info",
      title: "Some audio or video has no transcript",
      reason: `${plural(observed.mediaWithoutText, "media file")} finished without any searchable text.`,
      effect: "Transcription is a platform setting (remote media provider). Ask an operator to check it, then reprocess these files.",
      affectedPages: 0, affectedDocuments: observed.mediaWithoutText,
      cost: { centsPer100Pages: null, reprocessCents: null, basis: "Transcription is billed per audio minute." },
      patch: null,
      reprocessDocumentIds: observed.mediaDocs.filter((doc) => statusBucket(doc.status) === "completed" && doc.chunkTotal === 0).map((doc) => doc.id),
    });
  }

  const notIndexed = observed.unsearchable.filter((page) => page.reason === "not-indexed");
  if (notIndexed.length > 0) {
    const ids = [...new Set(notIndexed.map((page) => page.documentId))];
    const estimate = reprocessEstimate(observed, ids, () => 0, vision.cents);
    recs.push({
      id: "reindex-pages-with-text", severity: "medium",
      title: "Reprocess pages that have text but no chunks",
      reason: `${plural(notIndexed.length, "page")} in ${plural(ids.length, "file")} ${agree(notIndexed.length, "has", "have")} a text layer but no chunks, so search cannot return ${agree(notIndexed.length, "it", "them")}.`,
      effect: "Reprocessing re-extracts and re-chunks these files.",
      affectedPages: notIndexed.length, affectedDocuments: ids.length,
      cost: { centsPer100Pages: null, reprocessCents: round(estimate.cents, 2), basis: estimate.baseKnown ? "This workspace's observed cost per page." : `Planning estimate ${EMBED_CENTS_PER_PAGE}¢ per page.` },
      patch: null, reprocessDocumentIds: ids,
    });
  }

  const failedDocs = observed.docs.filter((doc) => doc.status === "failed");
  if (failedDocs.length > 0) {
    const ids = failedDocs.map((doc) => doc.id);
    const estimate = reprocessEstimate(observed, ids, () => 0, vision.cents);
    const causes = observed.failureList.filter((failure) => ids.includes(failure.documentId));
    const knownCauses = [...new Set(causes.filter((failure) => failure.reason !== "unknown").map((failure) => failure.message))].slice(0, 3);
    const retryable = causes.filter((failure) => failure.retryable).length;
    recs.push({
      id: "retry-failed-files", severity: "medium",
      title: "Retry failed files",
      reason: `${plural(failedDocs.length, "file")} failed during processing and ${agree(failedDocs.length, "is", "are")} not searchable.${knownCauses.length ? ` Cause: ${knownCauses.join(" ")}` : ""}`,
      effect: retryable === causes.length
        ? "Reprocessing runs them again with the current workspace settings."
        : retryable === 0
          ? `Reprocessing will fail the same way until the cause is fixed; changing workspace settings does not help. Check the failure details first.`
          : `Reprocessing runs the ${plural(retryable, "retryable file")} again with the current workspace settings; the others will fail the same way until their cause is fixed.`,
      affectedPages: failedDocs.reduce((sum, doc) => sum + Math.max(0, doc.pageCount), 0), affectedDocuments: failedDocs.length,
      cost: { centsPer100Pages: null, reprocessCents: round(estimate.cents, 2), basis: estimate.baseKnown ? "This workspace's observed cost per page." : `Planning estimate ${EMBED_CENTS_PER_PAGE}¢ per page.` },
      patch: null, reprocessDocumentIds: ids,
    });
  }

  const nonEnglish = [...observed.languageCounts].filter(([code]) => !/^en\b|^eng$/i.test(code));
  if (nonEnglish.length > 0 && !/multilingual/.test(pipeline.embedding.profile) && pipeline.embedding.profile !== "good-fast-local") {
    const files = nonEnglish.reduce((sum, [, n]) => sum + n, 0);
    recs.push({
      id: "multilingual-embeddings", severity: "info",
      title: "Use a multilingual embedding profile",
      reason: `${plural(files, "file")} ${agree(files, "is", "are")} in ${nonEnglish.map(([code]) => code).join(", ")}, and the ${pipeline.embedding.profile} profile is tuned for English.`,
      effect: "Switch the embedding profile to multilingual-local in workspace settings. Changing profiles re-embeds everything, so reprocess the whole workspace afterwards.",
      affectedPages: 0, affectedDocuments: files,
      cost: { centsPer100Pages: 0, reprocessCents: null, basis: "Local profile: worker compute only." },
      patch: null, reprocessDocumentIds: [],
    });
  }

  if (totalScanned > 0 && affected.length === 0 && observed.visionPages > 0) {
    // Nothing to fix: confirm the scans were handled so the report reads as a status check too.
    recs.push({
      id: "scans-handled", severity: "info",
      title: "Scanned pages were read with vision",
      reason: totalScanned === 1 ? "1 page looks scanned and it has searchable text." : `${plural(totalScanned, "page")} look scanned and all of them have searchable text.`,
      effect: "No change needed.",
      affectedPages: 0, affectedDocuments: 0,
      cost: { centsPer100Pages: null, reprocessCents: null, basis: vision.basis },
      patch: null, reprocessDocumentIds: [],
    });
  }

  const order = { high: 0, medium: 1, info: 2 } as const;
  return recs.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** User-controlled names go into Markdown as plain text: no links, images, HTML or emphasis. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|~]/g, (char) => `\\${char}`).replace(/\s+/g, " ").slice(0, 200);
}

/** Short Markdown for the chat transcript; the card carries the detail. */
export function summarizeIngestReport(report: IngestReport): string {
  const lines: string[] = [];
  const scope = report.scope.runId ? "this run" : report.scope.documentIds ? "the selected files" : escapeMarkdown(report.workspaceName);
  if (report.files.total === 0) {
    return `**Ingest report** for ${scope}: no files yet. Drop files here to start.`;
  }
  const pages = report.pages.total;
  const searchable = report.searchability.searchablePages;
  const evaluated = report.searchability.searchablePages + report.searchability.unsearchablePages;
  lines.push(`**Ingest report** for ${scope}: ${plural(report.files.total, "file")}, ${plural(pages, "page")}${evaluated ? `, ${searchable.toLocaleString("en-US")} of ${plural(evaluated, "checked page")} searchable` : ""}.`);
  if (report.failures.total > 0) lines.push(summarizeFailureLine(report.failures));
  if (report.images.scannedLookingPages > 0) {
    lines.push(`${plural(report.images.scannedLookingPages, "page")} ${agree(report.images.scannedLookingPages, "looks", "look")} scanned (images, almost no text layer); vision read ${plural(report.extraction.visionPages, "page")}.`);
  }
  if (report.focus?.length) {
    for (const page of report.focus.slice(0, 3)) {
      lines.push(`Page ${page.pageNumber} of ${escapeMarkdown(page.filename)}: ${page.searchable ? "searchable" : page.searchable === false ? `not searchable (${describeReason(page.reason)})` : "still processing"}.`);
    }
  }
  const top = report.recommendations.find((rec) => rec.severity !== "info");
  if (top) lines.push(`Suggested: ${top.title.toLowerCase()}. ${top.id === "retry-failed-files" ? top.effect : top.reason}`);
  else if (report.searchability.unsearchablePages === 0) lines.push("Nothing needs changing.");
  if (report.coverage.note) lines.push(report.coverage.note);
  return lines.join("\n\n");
}

/** Names the failed files, what stopped them and (sanitized) the recorded error, so chat never has to guess a cause. */
function summarizeFailureLine(failures: IngestReport["failures"]): string {
  const shown = failures.examples.slice(0, 3).map((failure) => {
    const where = failure.stage ? ` at ${escapeMarkdown(failure.stage)}` : "";
    const detail = failure.detail ? ` (recorded error: ${escapeMarkdown(failure.detail)})` : "";
    return `${escapeMarkdown(failure.filename)}${where}: ${failure.message}${detail}`;
  });
  const more = failures.total - shown.length;
  return `${plural(failures.total, "file")} failed. ${shown.join(" ")}${more > 0 ? ` And ${plural(more, "more file")}.` : ""}`;
}

export function describeReason(reason: IngestReportPageReason | null): string {
  switch (reason) {
    case "scanned-no-vision": return "looks scanned and was not read with vision";
    case "no-text": return "no text on the page";
    case "vision-failed": return "vision returned no text";
    case "vision-page-limit": return "past the vision page limit";
    case "vision-cost-cap": return "the run cost cap stopped vision";
    case "not-indexed": return "has text but no chunks";
    case "document-failed": return "the file failed";
    case "processing": return "still processing";
    default: return "reason not recorded";
  }
}

// ---- Loading -------------------------------------------------------------

type DocumentSqlRow = {
  id: string; filename: string; mime_type: string; status: string; page_count: number; file_size: string | number;
  run_id: string | null; created_at: Date | string; superseded: boolean;
};

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = num(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Loads and builds the report. `workspace` must already be authorized for the
 * caller; every query filters on its id, so a foreign runId or document id
 * simply matches nothing.
 */
export async function loadIngestReport(args: {
  workspace: Pick<WorkspaceRecord, "id" | "name" | "pipeline">;
  canEdit: boolean;
  runId?: string | null;
  documentIds?: string[] | null;
  focusPages?: number[];
}, client: SqlClient = sql): Promise<IngestReport> {
  const workspaceId = args.workspace.id;
  const runId = args.runId ?? null;
  const documentIds = args.documentIds?.length ? args.documentIds : null;
  const scoped = runId !== null || documentIds !== null;

  const [{ matched } = { matched: 0 }] = await client<{ matched: number }[]>`
    select count(*)::int as matched from documents d
    where d.workspace_id = ${workspaceId} and d.purged_at is null
      and (${scoped} or d.superseded_at is null)
      and (${runId}::text is null or d.run_id = ${runId})
      and (${documentIds === null} or d.id = any(${client.array(documentIds ?? [])}::text[]))
  `;
  const docRows = await client<DocumentSqlRow[]>`
    select d.id, d.filename, d.mime_type, d.status, d.page_count, d.file_size, d.run_id, d.created_at,
      (d.superseded_at is not null) as superseded
    from documents d
    where d.workspace_id = ${workspaceId} and d.purged_at is null
      and (${scoped} or d.superseded_at is null)
      and (${runId}::text is null or d.run_id = ${runId})
      and (${documentIds === null} or d.id = any(${client.array(documentIds ?? [])}::text[]))
    order by d.created_at desc, d.id
    limit ${INGEST_REPORT_MAX_DOCUMENTS}
  `;
  const ids = docRows.map((row) => row.id);
  if (ids.length === 0) {
    return buildIngestReport({
      workspace: args.workspace, scope: { runId, documentIds, matchedDocuments: matched },
      documents: [], pageDetailDocumentIds: [], pages: [], stages: [], runs: [], costCents: null,
      canEdit: args.canEdit, focusPages: args.focusPages,
    });
  }

  // Newest files first until the page budget is spent.
  const detailIds: string[] = [];
  let budget = INGEST_REPORT_MAX_PAGES;
  for (const row of docRows) {
    const pages = Math.min(MAX_PAGES_PER_DOCUMENT, Math.max(0, row.page_count));
    if (pages > budget) break;
    budget -= pages;
    detailIds.push(row.id);
  }

  const [chunkRows, pageRows, stageRows, languageRows] = await Promise.all([
    client<{ document_id: string; total: number; unattributed: number }[]>`
      select c.document_id, count(*)::int as total,
        count(*) filter (where c.page_number is null and jsonb_typeof(c.metadata -> 'pageNumbers') is distinct from 'array')::int as unattributed
      from document_chunks c
      join documents d on d.id = c.document_id and d.run_id = c.run_id
      where d.workspace_id = ${workspaceId} and d.id = any(${client.array(ids)}::text[])
      group by c.document_id
    `,
    detailIds.length === 0 ? Promise.resolve([]) : client<{
      document_id: string; page_number: number; has_facts: boolean; text_bytes: number | null; image_count: number | null;
      vision_status: string | null; chunks: number; chunk_bytes: string | number;
    }[]>`
      with d as (
        select id, run_id, least(greatest(page_count, 0), ${MAX_PAGES_PER_DOCUMENT}) as pages
        from documents
        where workspace_id = ${workspaceId} and id = any(${client.array(detailIds)}::text[])
      ),
      -- A chunk counts for its page, or for every page it spans (metadata.pageNumbers), its bytes split evenly.
      cp as (
        select c.document_id, octet_length(c.text) as bytes,
          case when c.page_number is not null then array[c.page_number]
            when jsonb_typeof(c.metadata -> 'pageNumbers') = 'array' then array(
              select x::int from jsonb_array_elements_text(c.metadata -> 'pageNumbers') as x where x ~ '^[0-9]{1,6}$')
          end as pages
        from document_chunks c
        join d on d.id = c.document_id and d.run_id = c.run_id
      ),
      ch as (
        select cp.document_id, pg as page_number, count(*)::int as chunks,
          coalesce(sum(cp.bytes::numeric / cardinality(cp.pages)), 0)::bigint as bytes
        from cp cross join lateral unnest(cp.pages) as pg
        where cardinality(cp.pages) > 0
        group by cp.document_id, pg
      )
      select d.id as document_id, gs.n as page_number, (f.text_bytes is not null or f.image_count is not null) as has_facts,
        f.text_bytes, f.image_count, f.vision_status, coalesce(ch.chunks, 0) as chunks, coalesce(ch.bytes, 0) as chunk_bytes
      from d
      cross join lateral generate_series(1, d.pages) as gs(n)
      left join document_page_facts f on f.document_id = d.id and f.page_number = gs.n
      left join ch on ch.document_id = d.id and ch.page_number = gs.n
      order by d.id, gs.n
    `,
    client<{
      document_id: string; stage_name: string; status: string; skipped: boolean; reason: string | null;
      selected_pages: number | null; pages: string | number | null; cost_cents: string | number | null;
      table_pages: string | number | null; duration_seconds: string | number | null; error: string | null;
    }[]>`
      select s.document_id, s.stage_name, s.status, left(s.error, 1000) as error,
        coalesce(s.stats -> 'skipped' = 'true'::jsonb, false) as skipped,
        left(s.stats ->> 'reason', 80) as reason,
        case when jsonb_typeof(s.stats -> 'selectedPages') = 'array' then jsonb_array_length(s.stats -> 'selectedPages') end as selected_pages,
        case when jsonb_typeof(s.stats -> 'pages') = 'number' then (s.stats ->> 'pages')::numeric end as pages,
        case when jsonb_typeof(s.stats -> 'costCents') = 'number' then (s.stats ->> 'costCents')::numeric end as cost_cents,
        case when jsonb_typeof(s.stats -> 'tablePages') = 'number' then (s.stats ->> 'tablePages')::numeric end as table_pages,
        case when jsonb_typeof(s.stats -> 'durationSeconds') = 'number' then (s.stats ->> 'durationSeconds')::numeric end as duration_seconds
      from document_run_stage_states s
      join documents d on d.id = s.document_id and d.run_id = s.run_id
      where d.workspace_id = ${workspaceId} and d.id = any(${client.array(ids)}::text[])
      order by s.started_at nulls last, s.updated_at
    `,
    client<{ document_id: string; language: string | null }[]>`
      select distinct on (p.document_id) p.document_id, left(p.metadata ->> 'detectedLanguage', 16) as language
      from performance_log p
      join documents d on d.id = p.document_id
      where d.workspace_id = ${workspaceId} and p.document_id = any(${client.array(ids)}::text[]) and p.metric = 'detected-language'
      order by p.document_id, p.created_at desc
    `,
  ]);

  const runIds = [...new Set(docRows.map((row) => row.run_id).filter((id): id is string => Boolean(id)))];
  const [runRows, cost] = await Promise.all([
    runIds.length === 0 ? Promise.resolve([]) : client<{ id: string; status: string; pages_processed: number; duration_ms: string | number }[]>`
      select r.id, r.status, greatest(r.pages_processed, 0) as pages_processed,
        greatest(extract(epoch from (r.updated_at - r.created_at)) * 1000, 0) as duration_ms
      from workspace_runs r
      where r.workspace_id = ${workspaceId} and r.id = any(${client.array(runIds)}::text[])
    `,
    workspaceRunsUsageCost(workspaceId, runIds, client).catch(() => null),
  ]);

  const chunksByDoc = new Map(chunkRows.map((row) => [row.document_id, row]));
  const languageByDoc = new Map(languageRows.map((row) => [row.document_id, row.language]));
  return buildIngestReport({
    workspace: args.workspace,
    scope: { runId, documentIds, matchedDocuments: matched },
    documents: docRows.map((row) => ({
      id: row.id, filename: row.filename, mimeType: row.mime_type, status: row.status,
      pageCount: num(row.page_count), fileSize: num(row.file_size), runId: row.run_id,
      createdAt: new Date(row.created_at).toISOString(),
      chunkTotal: chunksByDoc.get(row.id)?.total ?? 0,
      chunkUnattributed: chunksByDoc.get(row.id)?.unattributed ?? 0,
      language: languageByDoc.get(row.id) ?? null,
      superseded: row.superseded === true,
    })),
    pageDetailDocumentIds: detailIds,
    pages: pageRows.map((row) => ({
      documentId: row.document_id, pageNumber: num(row.page_number), hasFacts: row.has_facts,
      textBytes: numOrNull(row.text_bytes), imageCount: numOrNull(row.image_count), visionStatus: row.vision_status,
      chunkCount: num(row.chunks), chunkBytes: num(row.chunk_bytes),
    })),
    stages: stageRows.map((row) => ({
      documentId: row.document_id, stage: row.stage_name, status: row.status, skipped: row.skipped, reason: row.reason,
      selectedPages: numOrNull(row.selected_pages), pages: numOrNull(row.pages), costCents: numOrNull(row.cost_cents),
      tablePages: numOrNull(row.table_pages), durationSeconds: numOrNull(row.duration_seconds),
      error: row.status === "failed" ? row.error : null,
    })),
    runs: runRows.map((row) => ({ id: row.id, status: row.status, pagesProcessed: num(row.pages_processed), durationMs: num(row.duration_ms) })),
    costCents: cost?.costCents ?? null,
    billedCostCents: cost?.billedCostCents ?? null,
    computeEstimated: cost?.computeEstimated ?? false,
    canEdit: args.canEdit,
    focusPages: args.focusPages,
  });
}

/** The pipeline after applying a recommendation's patch onto the stored pipeline. */
export function applyRecommendationPatch(pipeline: PipelineFeatures, patch: Record<string, unknown>): PipelineFeatures {
  return mergePipelineFeatures(pipeline, patch as PipelineFeatureOverrides);
}

// ---- Acting on recommendations -------------------------------------------

export class IngestReportActionError extends Error {
  constructor(message: string, readonly status: 403 | 404 | 409) {
    super(message);
    this.name = "IngestReportActionError";
  }
}

/** True when every leaf of `patch` holds in `pipeline` (template locks can override a change). */
export function patchHolds(pipeline: unknown, patch: unknown): boolean {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return JSON.stringify(pipeline) === JSON.stringify(patch);
  if (pipeline === null || typeof pipeline !== "object") return false;
  return Object.entries(patch as Record<string, unknown>).every(([key, value]) => patchHolds((pipeline as Record<string, unknown>)[key], value));
}

type RecommendationAction = {
  workspace: WorkspaceRecord; userId: string; recommendationId: string;
  /** The scope of the report the action came from; the server recomputes that same report. */
  runId?: string | null; documentIds?: string[] | null;
};

async function editableRecommendation(args: RecommendationAction): Promise<IngestReportRecommendation> {
  const { getWorkspaceAccess, canEditWorkspace } = await import("./organizations.js");
  const access = await getWorkspaceAccess(args.workspace.id, args.userId);
  if (!access) throw new IngestReportActionError("Workspace not found", 404);
  if (!canEditWorkspace(access, args.userId)) {
    throw new IngestReportActionError("Only workspace editors can change ingest settings or reprocess files.", 403);
  }
  // Recompute: the change comes from the server's own rules, never from the client.
  const report = await loadIngestReport({
    workspace: args.workspace, canEdit: true, runId: args.runId ?? null, documentIds: args.documentIds ?? null,
  });
  const recommendation = report.recommendations.find((rec) => rec.id === args.recommendationId);
  if (!recommendation) throw new IngestReportActionError("This recommendation no longer applies; refresh the report.", 409);
  return recommendation;
}

/** Applies a recommendation's pipeline change through the regular workspace update path. */
export async function applyIngestRecommendation(args: RecommendationAction): Promise<{ workspace: WorkspaceRecord; recommendation: IngestReportRecommendation; pipeline: PipelineFeatures }> {
  const recommendation = await editableRecommendation(args);
  if (!recommendation.patch) throw new IngestReportActionError("This recommendation has no setting to turn on.", 409);
  const { getWorkspace, updateWorkspace } = await import("./workspaces.js");
  // Merge onto the pipeline as stored now, so a settings edit made meanwhile is kept.
  const current = await getWorkspace(args.workspace.id, args.userId);
  if (!current) throw new IngestReportActionError("Workspace not found", 404);
  const next = applyRecommendationPatch(current.pipeline, recommendation.patch);
  const updated = await updateWorkspace(args.workspace.id, args.userId, { pipeline: next });
  if (!updated) throw new IngestReportActionError("Only workspace editors can change ingest settings.", 403);
  if (!patchHolds(updated.pipeline, recommendation.patch)) {
    throw new IngestReportActionError("The workspace template locks this setting, so it was not changed.", 409);
  }
  return { workspace: updated, recommendation, pipeline: updated.pipeline };
}

export const INGEST_REPORT_REPROCESS_LIMIT = 100;

/** Reprocesses a recommendation's affected files (at most 100) with the workspace's current settings. */
export async function reprocessIngestRecommendation(args: RecommendationAction): Promise<{ runs: Array<{ id: string }>; documentIds: string[]; skippedDocuments: number; estimatedCents: number | null; failed: BulkReprocessResult["failed"]; warnings: string[] }> {
  const recommendation = await editableRecommendation(args);
  const ids = recommendation.reprocessDocumentIds.slice(0, INGEST_REPORT_REPROCESS_LIMIT);
  if (ids.length === 0) throw new IngestReportActionError("No files to reprocess for this recommendation.", 409);
  const { bulkReprocessDocuments } = await import("./documents.js");
  const { runs, failed, warnings } = await bulkReprocessDocuments(ids, args.userId, { useWorkspacePipeline: true });
  return {
    runs: runs.map((run) => ({ id: run.id })),
    documentIds: ids,
    skippedDocuments: recommendation.reprocessDocumentIds.length - ids.length,
    estimatedCents: recommendation.cost.reprocessCents,
    failed,
    warnings,
  };
}
