import { CURRENT_INGEST_CAPABILITIES, CURRENT_INGEST_VERSION, PARSE_SOURCE_SCAN_VERSION } from "@docslurp/shared";
import type { Sql } from "postgres";

/**
 * Ingest version stamping (packages/shared/src/ingest-version.ts). Capabilities are measured from what is stored, never
 * assumed: a parse decision from the current scan, page facts, and a figure ledger written by this run. Only the run's
 * own, unsuperseded documents that finished (completed or PII-blocked) are stamped, so a failed or cancelled document
 * keeps the version that last produced it. The stamps ride on statements the run already makes (no extra round trips;
 * db-statement-budget.test.ts).
 */

/** The `set` assignments that stamp a `documents` row referenced as `d`. */
function documentStampAssignments(client: Sql<Record<string, unknown>>, runId: string) {
  return client`
    ingest_version = ${CURRENT_INGEST_VERSION},
    ingest_capabilities = array_remove(array[
      case when d.parse_source_scan_version = ${PARSE_SOURCE_SCAN_VERSION} and d.parse_source_sha256 is not null
        then 'parseSourceDecision' end,
      case when exists (select 1 from document_page_facts f where f.document_id = d.id and f.run_id = ${runId}) then 'pageFacts' end,
      case when exists (select 1 from document_extraction_levels l where l.document_id = d.id and l.org_id = d.org_id
        and l.run_id = ${runId}) then 'figureLedger' end
    ]::text[], null)`;
}

/**
 * Extra `set` assignments for a statement that completes one `documents` row aliased `d`: stamp it when it belongs to
 * this run and is not superseded, else keep its version.
 */
export function completingDocumentStamp(client: Sql<Record<string, unknown>>, runId: string) {
  const owned = client`d.run_id = ${runId} and d.superseded_at is null`;
  return client`,
    ingest_version = case when ${owned} then ${CURRENT_INGEST_VERSION} else d.ingest_version end,
    ingest_capabilities = case when ${owned} then array_remove(array[
      case when d.parse_source_scan_version = ${PARSE_SOURCE_SCAN_VERSION} and d.parse_source_sha256 is not null
        then 'parseSourceDecision' end,
      case when exists (select 1 from document_page_facts f where f.document_id = d.id and f.run_id = ${runId}) then 'pageFacts' end,
      case when exists (select 1 from document_extraction_levels l where l.document_id = d.id and l.org_id = d.org_id
        and l.run_id = ${runId}) then 'figureLedger' end
    ]::text[], null) else d.ingest_capabilities end`;
}

/** Stamp the run's finished documents (all of them, or only `documentIds`). */
export function stampDocumentIngestVersion(client: Sql<Record<string, unknown>>, runId: string, documentIds?: readonly string[]) {
  const only = documentIds ? client`and d.id = any(${client.array([...documentIds])}::text[])` : client``;
  return client`
    update documents d
    set ${documentStampAssignments(client, runId)}
    where d.run_id = ${runId}
      ${only}
      and d.superseded_at is null
      and d.status in ('completed', 'pii_blocked')`;
}

/** Stamp the run with the build's version and supported capabilities, and its finished documents, in one statement. */
export function stampRunIngestVersion(client: Sql<Record<string, unknown>>, runId: string) {
  return client`
    with stamped as (${stampDocumentIngestVersion(client, runId)} returning 1)
    update project_runs
    set ingest_version = ${CURRENT_INGEST_VERSION}, ingest_capabilities = ${client.array([...CURRENT_INGEST_CAPABILITIES])}::text[]
    where id = ${runId}`;
}

/** Deferred page materialization fills pages of an existing document; it does not reproduce the document. */
export function runStampsIngestVersion(kind: string | null | undefined): boolean {
  return kind !== "materialize";
}
