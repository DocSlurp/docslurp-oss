import {
  publicDocumentError,
  parseStoredPipelineFeatures,
  defaultPipelineFeatures,
  documentSchema,
  publicDiagnostics,
  projectRunSchema,
  type DocumentRecord,
  type PipelineFeatures,
  type ProjectRun,
} from "@docslurp/shared";

import type { RunUsageCostSummary } from "./usage-attribution.js";
import { toPublicRunRowStage } from "../lib/public-run-stage.js";

// Row shapes and mappers for project_runs and documents. A leaf module: it
// imports neither runs.ts nor run-creation.ts, which both depend on it.

export type ProjectRunRow = {
  job_id?: string | null;
  id: string;
  org_id: string;
  user_id: string;
  project_id: string;
  project_name: string | null;
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
  project_id: string;
  run_id: string | null;
  filename: string;
  mime_type: string;
  source_key: string;
  status: string;
  extraction_mode: string;
  page_count: number;
  /** The worker's measured page count of an Office, slide, sheet or EPUB file (migration 0126); null until measured. */
  billing_pages?: number | null;
  /** How billing_pages was found (pdf-conversion, slides, sheet-rows, text-pages, text-rule, size-estimate). */
  billing_pages_method?: string | null;
  /** `counted` (from the bytes or the worker's measurement) or `assumed` (an estimate the worker replaces); see PageCountSource. */
  page_count_source?: string | null;
  source_sha256?: string | null;
  deduped_from_document_id?: string | null;
  dedup_scope?: "project" | "org" | null;
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
 * project_runs.spent_cents); costCents adds the unbilled compute estimate.
 * Runs mapped without it (just created) have spent nothing; listed runs go
 * through withRunCosts.
 */
function failedDocumentsOf(stats: Record<string, unknown>): number {
  const value = stats.failedDocuments;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function mapProjectRun(row: ProjectRunRow, cost?: Pick<RunUsageCostSummary, "costCents" | "computeEstimated" | "billedCostCents">): ProjectRun {
  return projectRunSchema.parse({
    id: row.id,
    jobId: row.job_id ?? row.id,
    userId: row.user_id,
    orgId: row.org_id,
    projectId: row.project_id,
    projectName: row.project_name,
    kind: row.kind,
    status: row.status,
    priority: row.priority ?? 0,
    controlState: row.control_state ?? null,
    pauseReason: ["credit_exhausted", "project_budget_paused", "org_budget_paused", "plan_not_entitled"].includes(row.pause_reason ?? "") ? row.pause_reason : null,
    controlRequestedAt: serializeOptionalTimestamp(row.control_requested_at),
    stage: toPublicRunRowStage(row.stage, row.status, row.id),
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    pagesTotal: row.pages_total,
    pagesProcessed: row.pages_processed,
    failedDocuments: failedDocumentsOf(jsonRecord(row.stats)),
    costCents: cost?.costCents ?? 0,
    computeEstimated: cost?.computeEstimated ?? false,
    billedCostCents: cost?.billedCostCents ?? 0,
    // Historical snapshots may predate the schema; never fail a run list on one row.
    pipeline: parseStoredPipelineFeatures(typeof row.pipeline === "string" ? jsonRecord(row.pipeline) : row.pipeline ?? defaultPipelineFeatures, `run ${row.id}`),
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
    projectId: row.project_id,
    runId: row.run_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sourceKey: row.source_key,
    status: row.status,
    extractionMode: row.extraction_mode,
    pageCount: row.page_count,
    // Describes pageCount: measured only when it was counted from the bytes or by the worker; any other source is an estimate.
    pageCountSource: row.page_count_source === "counted" ? "measured" : "estimated",
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

