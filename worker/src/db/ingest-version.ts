import { compilePipelinePlan, CURRENT_INGEST_CAPABILITIES, CURRENT_INGEST_VERSION, PARSE_SOURCE_SCAN_VERSION, type PipelineFeatures } from "@docslurp/shared";
import type { Sql } from "postgres";

/**
 * Ingest version stamping (packages/shared/src/ingest-version.ts). The stamps ride on statements the run already makes
 * (no extra round trips; db-statement-budget.test.ts). Only the run's own, unsuperseded documents that finished
 * (completed or PII-blocked) are stamped, so a failed or cancelled document keeps the version that last produced it.
 *
 * Two kinds of stamp:
 * - **extracted**: the run ran extraction for the document. It gets CURRENT_INGEST_VERSION and capabilities measured
 *   from what this run stored: a parse decision from the current scan, page facts and a figure ledger written by this run.
 * - **inherited**: the run reused extraction (a partial reprocess or reindex: `reusedStages` reach back into intake, prep
 *   or extraction), or the document is a deduplicated copy. Its content is the source document's, so it keeps the source's
 *   version and capabilities (reused_from_document_id, else deduped_from_document_id; 0 when there is no source). The one
 *   addition is `parseSourceDecision` when measured on the row itself: every partial run re-runs quarantine
 *   (stageDataFlow.quarantine.alwaysRerun), and that decision belongs to this row, not the source.
 */

export type IngestStampMode = "extracted" | "inherited";

/** Whether the run's plan reuses extraction output instead of producing it. Quarantine always re-runs and does not count. */
export function runReusesExtraction(pipeline: PipelineFeatures | null | undefined): boolean {
  if (!pipeline) return false;
  const plan = compilePipelinePlan(pipeline);
  return plan.reusedStages.some((stage) => stage !== "quarantine" && plan.stagesByName[stage]?.phase !== "index");
}

/** Deferred page materialization fills pages of an existing document; it does not reproduce the document. */
export function runStampsIngestVersion(kind: string | null | undefined): boolean {
  return kind !== "materialize";
}

function measuredParseDecision(client: Sql<Record<string, unknown>>) {
  return client`case when d.parse_source_scan_version = ${PARSE_SOURCE_SCAN_VERSION} and d.parse_source_sha256 is not null
    then 'parseSourceDecision' end`;
}

/** Capabilities measured from what `runId` stored for the row `d`. */
function measuredCapabilities(client: Sql<Record<string, unknown>>, runId: string) {
  return client`array_remove(array[
      ${measuredParseDecision(client)},
      case when exists (select 1 from document_page_facts f where f.document_id = d.id and f.run_id = ${runId}) then 'pageFacts' end,
      case when exists (select 1 from document_extraction_levels l where l.document_id = d.id and l.org_id = d.org_id
        and l.run_id = ${runId}) then 'figureLedger' end
    ]::text[], null)`;
}

/** The source row whose content `d` carries: the version it reused, else the document it deduplicates. Same org only. */
function sourceOf(client: Sql<Record<string, unknown>>) {
  return client`(select s from documents s where s.id = coalesce(d.reused_from_document_id, d.deduped_from_document_id) and s.org_id = d.org_id)`;
}

function inheritedVersion(client: Sql<Record<string, unknown>>) {
  return client`coalesce((${sourceOf(client)}).ingest_version, 0)`;
}

function inheritedCapabilities(client: Sql<Record<string, unknown>>) {
  return client`(select coalesce(array_agg(distinct capability order by capability), '{}'::text[]) from unnest(
      coalesce((${sourceOf(client)}).ingest_capabilities, '{}'::text[]) || array_remove(array[${measuredParseDecision(client)}]::text[], null)
    ) as capability)`;
}

/**
 * The version and capabilities for row `d`. A deduplicated copy inherits even in a run that extracted, since nothing was
 * extracted for it.
 */
function stampValues(client: Sql<Record<string, unknown>>, runId: string, mode: IngestStampMode) {
  if (mode === "inherited") return { version: inheritedVersion(client), capabilities: inheritedCapabilities(client) };
  return {
    version: client`case when d.deduped_from_document_id is not null then ${inheritedVersion(client)} else ${CURRENT_INGEST_VERSION} end`,
    capabilities: client`case when d.deduped_from_document_id is not null then ${inheritedCapabilities(client)}
      else ${measuredCapabilities(client, runId)} end`,
  };
}

/**
 * Extra `set` assignments for a statement that completes one `documents` row aliased `d`: stamp it when it belongs to
 * this run and is not superseded, else keep its version.
 */
export function completingDocumentStamp(client: Sql<Record<string, unknown>>, runId: string, mode: IngestStampMode) {
  const owned = client`d.run_id = ${runId} and d.superseded_at is null`;
  const values = stampValues(client, runId, mode);
  return client`,
    ingest_version = case when ${owned} then ${values.version} else d.ingest_version end,
    ingest_capabilities = case when ${owned} then ${values.capabilities} else d.ingest_capabilities end`;
}

/** Stamp the run's finished documents (all of them, or only `documentIds`). */
export function stampDocumentIngestVersion(client: Sql<Record<string, unknown>>, runId: string, mode: IngestStampMode, documentIds?: readonly string[]) {
  const only = documentIds ? client`and d.id = any(${client.array([...documentIds])}::text[])` : client``;
  const values = stampValues(client, runId, mode);
  return client`
    update documents d
    set ingest_version = ${values.version}, ingest_capabilities = ${values.capabilities}
    where d.run_id = ${runId}
      ${only}
      and d.superseded_at is null
      and d.status in ('completed', 'pii_blocked')`;
}

/**
 * The run row's assignments: the build's version and capabilities when it extracted. A run that reused extraction is
 * left at 0: its documents carry their sources' versions, and the run did not produce current output.
 */
export function runStamp(client: Sql<Record<string, unknown>>, mode: IngestStampMode) {
  return mode === "extracted"
    ? client`, ingest_version = ${CURRENT_INGEST_VERSION}, ingest_capabilities = ${client.array([...CURRENT_INGEST_CAPABILITIES])}::text[]`
    : client``;
}

/** Stamp the run and its finished documents in one statement (tests and tools; completeRun folds the same SQL in). */
export function stampRunIngestVersion(client: Sql<Record<string, unknown>>, runId: string, mode: IngestStampMode = "extracted") {
  return client`
    with stamped as (${stampDocumentIngestVersion(client, runId, mode)} returning 1)
    update project_runs set updated_at = updated_at ${runStamp(client, mode)}
    where id = ${runId}`;
}
