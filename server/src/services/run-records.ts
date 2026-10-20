import {
  PUBLIC_ERROR_MESSAGES,
  publicDocumentError,
  parseStoredPipelineFeatures,
  defaultPipelineFeatures,
  documentSchema,
  publicDiagnostics,
  workspaceRunSchema,
  type DocumentRecord,
  type PipelineFeatures,
  type WorkspaceRun,
} from "@docslurp/shared";

import type { RunUsageCostSummary } from "./usage-attribution.js";

// Row shapes and mappers for workspace_runs and documents. A leaf module: it
// imports neither runs.ts nor run-creation.ts, which both depend on it.

export type WorkspaceRunRow = {
  id: string;
  org_id: string;
  user_id: string;
  workspace_id: string;
  workspace_name: string | null;
  kind: string;
  status: string;
  priority: number;
  control_state: string | null;
  pause_reason?: string | null;
  control_requested_at: string | Date | null;
  last_heartbeat_at?: string | Date | null;
  lease_expires_at?: string | Date | null;
  failure_count?: number | null;
  dead_lettered_at?: string | Date | null;
  dead_letter_reason?: string | null;
  stage: string;
  total_documents: number;
  processed_documents: number;
  pages_total: number;
  pages_processed: number;
  pipeline: PipelineFeatures;
  stats: Record<string, unknown> | null;
  artifacts: Record<string, string> | null;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type DocumentRow = {
  tags?: string[];
  id: string;
  org_id: string;
  user_id: string;
  workspace_id: string;
  run_id: string | null;
  filename: string;
  mime_type: string;
  source_key: string;
  status: string;
  extraction_mode: string;
  page_count: number;
  source_sha256?: string | null;
  deduped_from_document_id?: string | null;
  dedup_scope?: "workspace" | "org" | null;
  version_number: number;
  previous_version_id: string | null;
  canonical_id?: string | null;
  superseded_at?: string | Date | null;
  superseded_by_document_id?: string | null;
  indexing_mode?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export function serializeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function serializeOptionalTimestamp(
  value: string | Date | null,
): string | null {
  if (value === null) {
    return null;
  }
  return serializeTimestamp(value);
}

/** Older rows stored some JSON columns as JSON text; read either form, else empty. */
export function jsonRecord<T extends Record<string, unknown>>(value: unknown): T {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as T;
}

/**
 * `cost` comes from the usage ledger (usage_attribution). billedCostCents is
 * the figure the worker enforces the run cost cap against (it equals
 * workspace_runs.spent_cents); costCents adds the unbilled compute estimate.
 * Runs mapped without it (just created) have spent nothing; listed runs go
 * through withRunCosts.
 */
function failedDocumentsOf(stats: Record<string, unknown>): number {
  const value = stats.failedDocuments;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function mapWorkspaceRun(row: WorkspaceRunRow, cost?: Pick<RunUsageCostSummary, "costCents" | "computeEstimated" | "billedCostCents">): WorkspaceRun {
  return workspaceRunSchema.parse({
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    kind: row.kind,
    status: row.status,
    priority: row.priority ?? 0,
    controlState: row.control_state ?? null,
    pauseReason: row.pause_reason ? PUBLIC_ERROR_MESSAGES.paused : null,
    controlRequestedAt: serializeOptionalTimestamp(row.control_requested_at),
    stage: row.stage,
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    pagesTotal: row.pages_total,
    pagesProcessed: row.pages_processed,
    failedDocuments: failedDocumentsOf(jsonRecord(row.stats)),
    costCents: cost?.costCents ?? 0,
    computeEstimated: cost?.computeEstimated ?? false,
    billedCostCents: cost?.billedCostCents ?? 0,
    // Historical snapshots may predate the schema; never fail a run list on one row.
    pipeline: parseStoredPipelineFeatures(typeof row.pipeline === "string" ? jsonRecord(row.pipeline) : row.pipeline ?? defaultPipelineFeatures),
    stats: publicDiagnostics(jsonRecord(row.stats)),
    artifacts: jsonRecord(row.artifacts),
    error: publicDocumentError(row.error),
    createdAt: serializeTimestamp(row.created_at),
    updatedAt: serializeTimestamp(row.updated_at),
  });
}

export function mapDocument(row: DocumentRow): DocumentRecord {
  return documentSchema.parse({
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sourceKey: row.source_key,
    status: row.status,
    extractionMode: row.extraction_mode,
    pageCount: row.page_count,
    sourceSha256: row.source_sha256 ?? null,
    dedupedFromDocumentId: row.deduped_from_document_id ?? null,
    dedupScope: row.dedup_scope ?? null,
    versionNumber: row.version_number ?? 1,
    previousVersionId: row.previous_version_id ?? null,
    canonicalId: row.canonical_id ?? null,
    tags: row.tags ?? [],
    supersededAt: row.superseded_at ? serializeTimestamp(row.superseded_at) : null,
    supersededByDocumentId: row.superseded_by_document_id ?? null,
    createdAt: serializeTimestamp(row.created_at),
    updatedAt: serializeTimestamp(row.updated_at),
  });
}

