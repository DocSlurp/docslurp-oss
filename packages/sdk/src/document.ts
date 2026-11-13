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
export type DocumentPiiWithheld = {
  scope: "none" | "pages" | "sections" | "document";
  withheldPages: number[];
  withheldPageCount: number;
  withheldSectionCount: number;
  /** "2 pages withheld for privacy (pages 3, 7)". */
  message: string | null;
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
  /**
   * What the project's PII policy withheld: `pages` (the rest of the document is served; these pages' text, images and
   * figures are not), `sections` (an unpaged document), `document` (all of it) or `none`. Page numbers and counts
   * only, never the withheld content. Absent from older servers.
   */
  piiWithheld?: DocumentPiiWithheld;
  run: { id: string; projectId: string; stage: string; status: ProjectRun["status"]; updatedAt: string } | null;
  usage: {
    document: { inputTokens: number; outputTokens: number; costCents: number; events: number };
    run: { inputTokens: number; outputTokens: number; costCents: number; computeEstimated: boolean; totalDocuments: number; events: number } | null;
    estimatedDocument: { inputTokens: number; outputTokens: number; costCents: number; basis: "document-events" | "run-average" | "none" };
  };
};
