import type { DocumentRecord, JsonObject, ProjectRun } from "./index.js";

export type ViewerDocumentRecord = DocumentRecord & {
  userId: string;
  orgId: string;
  projectId: string;
  runId: string | null;
  mimeType: string;
  sourceKey: string;
  extractionMode: string;
  pageCount: number;
  sourceSha256?: string | null;
  dedupedFromDocumentId?: string | null;
  dedupScope?: "project" | "org" | null;
  tags: string[];
  versionNumber?: number;
  previousVersionId?: string | null;
  createdAt: string;
  updatedAt: string;
};
/** One version of a document, newest first. Purged versions are tombstones: listed, not openable. */
export type DocumentVersionEntry = {
  documentId: string; versionNumber: number; createdAt: string; status: string;
  isCurrent: boolean; archived: boolean; purged: boolean;
  pageCount: number; sourcePath: string; filename: string; sizeBytes: number;
};
export type DocumentArtifactEntry = { slot: string; uri: string; url: string };
export type DocumentSourceEntry = {
  key: string; url: string; filename: string; mimeType: string;
  category: "image" | "audio" | "video" | "other"; previewable: boolean;
};
export type DocumentVersionChangelogEntry = {
  id: string; kind: "addition" | "deletion" | "rewrite" | "contradiction";
  title: string; score: number; reasons: string[];
  currentExcerpt: string | null; previousExcerpt: string | null;
};
export type DocumentVersionChangelog = {
  available: boolean; generatedAt: string;
  baselineDocument: { id: string; filename: string; versionNumber: number; updatedAt: string } | null;
  currentSource: "markdown" | "page-text" | "missing";
  baselineSource: "markdown" | "page-text" | "missing";
  summary: string[];
  stats: { currentBlocks: number; baselineBlocks: number; matchedBlocks: number; additions: number; deletions: number; rewrites: number; contradictions: number; changedRatio: number; truncated?: boolean };
  additions: DocumentVersionChangelogEntry[]; deletions: DocumentVersionChangelogEntry[];
  rewrites: DocumentVersionChangelogEntry[]; contradictions: DocumentVersionChangelogEntry[];
};
/** Stage diagnostics retain the API's database column names. */
export type DocumentViewerStage = {
  stage_name: string; status: string; attempts: number;
  artifact_uri: string | null; stats: JsonObject | null; error: string | null; updated_at: string;
};
export type DocumentViewerPayload = {
  document: ViewerDocumentRecord;
  tags: string[];
  versions: DocumentVersionEntry[];
  changelog: DocumentVersionChangelog;
  stages: DocumentViewerStage[];
  artifacts: DocumentArtifactEntry[];
  source: DocumentSourceEntry;
  pageStats: { pageCount: number; chunkCount: number; pageTextCount: number };
  /** The ingest version that produced the document against the workspace's current one. */
  ingest?: IngestStatus;
  run: { id: string; projectId: string; stage: string; status: ProjectRun["status"]; updatedAt: string } | null;
  usage: {
    document: { inputTokens: number; outputTokens: number; costCents: number; events: number };
    run: { inputTokens: number; outputTokens: number; costCents: number; computeEstimated: boolean; totalDocuments: number; events: number } | null;
    estimatedDocument: { inputTokens: number; outputTokens: number; costCents: number; basis: "document-events" | "run-average" | "none" };
  };
};

/** A document's ingest version against the workspace's current one (GET /v1/documents/:id `ingest`). */
export type IngestStatus = {
  version: number; capabilities: string[]; currentVersion: number;
  /** The version is below the workspace's (informational). */
  updateAvailable: boolean;
  /** Capabilities a serving path needs and this document lacks, measured from its row (e.g. `parseSourceDecision`). */
  missingCapabilities: string[];
  /** `missingCapabilities` is non-empty: the case to badge "Update available". */
  updateRecommended: boolean;
  /** True only when an update is available or recommended and this caller may start the reprocess. */
  canReprocess?: boolean;
};
/** GET /v1/ingest-version. */
export type WorkspaceIngestVersion = { ingestVersion: number; capabilities: string[] };
/** Why the API cannot show data the caller may see. A closed vocabulary; never error text. */
export type DataUnavailableReason = "needs-reprocess" | "withheld" | "not-extracted" | "processing" | "not-supported" | "disabled" | "temporarily-unavailable";
/**
 * The typed state the API answers (HTTP 200) for a page image, figure or structured result that exists for the caller but
 * cannot be shown. `canReprocess` is true only when a reprocess fixes it and the caller may start one.
 */
export type DataUnavailable = {
  status: "unavailable";
  reason: DataUnavailableReason;
  message: string;
  canReprocess: boolean;
  ingestVersion: number | null;
  currentIngestVersion: number;
};
