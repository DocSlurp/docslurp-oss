import { piiWithholding, type DerivedDocumentTitle, type FileFacts, type PiiWithholding } from "@docslurp/shared";
import type { Sql } from "postgres";

import { assertParseSourceRecord, PARSE_SOURCE_SCAN_VERSION, resolveDocumentSource, type ParseSourceDecisionRecord, type ResolvedDocumentSource } from "../lib/parse-source.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { beginGeoAttempt } from "./geo-final-source.js";

/**
 * One document of a run, as its tenant scope: every document-row read or write names the run's organization and the run the
 * document belongs to, so a wrong (or null) organization or run matches no row.
 */
export type DocumentRowScope = { orgId: string | null; runId: string; documentId: string };

/** The document records port stages write through (pipeline CheckpointStore.records). */
export type DocumentRecords = Pick<PostgresDocumentRecords, keyof PostgresDocumentRecords>;

/**
 * Document records: the facts a run's stages settle on its own document rows, each write scoped to that document (and to
 * the run where the stage owns the row): the worker's file facts and parse source decision, the derived title, the PII
 * withheld list, the structured-output revision a geo attempt starts, and the organization and run each document
 * belongs to.
 */
export class PostgresDocumentRecords {
  constructor(private readonly sql: Sql<Record<string, unknown>>) {}

  async beginGeoAttempt(state: WorkflowState, documentId: string, schema: Record<string, unknown>) {
    if (!state.run.projectId || !state.run.orgId) throw new Error("Geo extraction requires tenant scope");
    return beginGeoAttempt(this.sql, {documentId, projectId:state.run.projectId, orgId:state.run.orgId, runId:state.run.id}, schema);
  }

  /**
   * Whether the document's PII outcome withholds artifacts (`documents.metadata.pii`: it redacted or blocked, so it keeps
   * a withheld list). A missing document, or one outside the scope, withholds (fail closed).
   */
  async documentPiiWithholds(scope: DocumentRowScope): Promise<boolean> {
    const { documentId } = scope;
    const [row] = await this.sql<{ withholds: boolean }[]>`
      select coalesce((metadata->'pii'->>'blocked')::boolean, false)
        or coalesce((metadata->'pii'->>'redacted')::boolean, false)
        or coalesce(jsonb_array_length(case when jsonb_typeof(metadata->'pii'->'withheldArtifactUris') = 'array'
          then metadata->'pii'->'withheldArtifactUris' else '[]'::jsonb end), 0) > 0 as withholds
      from documents where id = ${documentId} and run_id = ${scope.runId} and org_id = ${scope.orgId}`;
    return row?.withholds ?? true;
  }

  /**
   * The document's recorded PII withholding (packages/shared/src/pii-withholding.ts), so a step that runs after the PII
   * stage keeps clean pages servable. A missing document, or one outside the scope, withholds everything (fail closed).
   */
  async documentPiiWithholding(scope: DocumentRowScope): Promise<PiiWithholding> {
    const [row] = await this.sql<{ status: string | null; metadata: unknown; indexing_mode: string | null }[]>`
      select status, indexing_mode, metadata #- '{pii,withheldArtifactUris}' as metadata from documents
      where id = ${scope.documentId} and run_id = ${scope.runId} and org_id = ${scope.orgId}`;
    return row ? piiWithholding({ status: row.status, metadata: row.metadata, indexingMode: row.indexing_mode }) : { scope: "document", reason: "missing-document" };
  }

  /**
   * Add URIs to the document's PII withheld list (`documents.metadata.pii.withheldArtifactUris`), for artifacts written
   * after its PII stage. Throws when the document has no PII outcome to add to, so a caller never records the artifacts
   * as servable on a write that did not land.
   */
  async appendWithheldArtifactUris(scope: DocumentRowScope, uris: readonly string[]): Promise<void> {
    const { documentId } = scope;
    if (uris.length === 0) return;
    const updated = await this.sql`
      update documents d
      set metadata = jsonb_set(d.metadata, '{pii,withheldArtifactUris}', (
            select coalesce(jsonb_agg(u order by u), '[]'::jsonb) from (
              select jsonb_array_elements_text(case when jsonb_typeof(d.metadata->'pii'->'withheldArtifactUris') = 'array'
                then d.metadata->'pii'->'withheldArtifactUris' else '[]'::jsonb end) as u
              union
              select unnest(${this.sql.array([...uris])}::text[])
            ) withheld), true),
          updated_at = now()
      where d.id = ${documentId} and d.run_id = ${scope.runId} and d.org_id = ${scope.orgId}
        and jsonb_typeof(d.metadata->'pii') = 'object'
      returning 1`;
    if (updated.length !== 1) throw new Error("PII withheld list not updated: the document has no PII outcome");
  }

  /**
   * The organization and run each document belongs to, read from the database (never from a request or a provider): what a
   * sandboxed PDF batch is checked against before any VM work (assertSingleScopeBatch).
   */
  async documentScopes(documentIds: readonly string[]): Promise<Map<string, { orgId: string | null; runId: string; bytes: number }>> {
    if (documentIds.length === 0) return new Map();
    const rows = await this.sql<{ id: string; org_id: string | null; run_id: string; file_size: string | number }[]>`
      select id, org_id, run_id, file_size from documents where id = any(${this.sql.array([...documentIds])}::text[])
    `;
    return new Map(rows.map((row) => [row.id, { orgId: row.org_id, runId: row.run_id, bytes: Number(row.file_size) || 0 }]));
  }

  async setDocumentFileFacts(runId: string, documentId: string, facts: FileFacts): Promise<boolean> {
    const rows = await this.sql`
      update documents set file_facts = ${this.sql.json(JSON.parse(JSON.stringify(facts)))}, mime_type = ${facts.mimeType}, updated_at = now()
      where id = ${documentId} and run_id = ${runId}
      returning id
    `;
    return rows.length > 0;
  }

  /**
   * Record quarantine's parse decision for this run's own document (lib/parse-source.ts, migrations 0134-0135): `{ copy }`
   * parses the scanned copy (an encrypted PDF's), `{ copy: null }` the upload it scanned, and null clears the decision
   * (refused: nothing may parse it). Either decision stores the sha256 of the bytes parsers read: the copy's, or the
   * upload's as the scan read it (`scannedSha256`, council R8-L1), so a later swap of the object is refused whether or not
   * the row has a server hash. Stamped with this build's scan version; false when no row matched.
   */
  async setDocumentParseSource(runId: string, documentId: string, decision: ParseSourceDecisionRecord | null): Promise<boolean> {
    const copy = decision?.copy ?? null;
    const sha = decision ? assertParseSourceRecord(decision) : null;
    const rows = await this.sql`
      update documents set parse_source_key = ${copy?.key ?? null}, parse_source_sha256 = ${sha},
        parse_source_scan_version = ${decision ? PARSE_SOURCE_SCAN_VERSION : null}, updated_at = now()
      where id = ${documentId} and run_id = ${runId}
      returning id
    `;
    return rows.length > 0;
  }

  async setDocumentTitleIfAbsent(scope: DocumentRowScope, title: DerivedDocumentTitle): Promise<boolean> {
    const { documentId } = scope;
    const rows = await this.sql`
      update documents
      set metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object('title', ${title.title}::text, 'titleSource', ${title.source}::text)
      where id = ${documentId} and run_id = ${scope.runId} and org_id = ${scope.orgId}
        and nullif(btrim(metadata ->> 'title'), '') is null
      returning id
    `;
    return rows.length > 0;
  }
}

/**
 * The parse source of one document for a reader outside the stage pipeline (the figure resume runner): the loader's own
 * resolution (lib/parse-source.ts resolveDocumentSource), so it is quarantine's decision and never the upload's key unless
 * the scan read the upload itself. Org-scoped; null when the document is not the organization's. Only this module reads
 * the upload's key (quarantine-council-r6 tripwire). Read for the claimed run only, and only while the document is completed
 * (a reprocess or a failure since the claim reads nothing).
 */
export async function documentParseSource(
  sql: Sql<Record<string, unknown>>, scope: { orgId: string; documentId: string; runId: string }, env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedDocumentSource | null> {
  const [row] = await sql<Array<{ id: string; source_key: string; source_sha256: string | null; parse_source_key: string | null; parse_source_sha256: string | null; parse_source_scan_version: number | null }>>`
    select id, source_key, source_sha256, parse_source_key, parse_source_sha256, parse_source_scan_version
    from documents where id = ${scope.documentId} and org_id = ${scope.orgId} and run_id = ${scope.runId} and status = 'completed'`;
  return row ? resolveDocumentSource(row, env) : null;
}
