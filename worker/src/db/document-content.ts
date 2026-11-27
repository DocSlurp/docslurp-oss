import type { PendingQuery, Row, Sql } from "postgres";

import type { EmbeddingReuseRef } from "../embeddings/embedding-reuse.js";
import type { PageFactUpsert } from "../pipeline/page-facts.js";
import type { DocumentRowScope } from "./document-records.js";
import { DocumentNotFoundError, DocumentOutOfScopeError } from "./missing-document.js";
import { batchedRows, jsonRowsText, wellFormed } from "./sql-helpers.js";
import { pipelineTransaction } from "./transaction-pipeline.js";

/** The document content port stages write through (pipeline CheckpointStore.content). */
export type DocumentContentWriter = Pick<PostgresDocumentContent, keyof PostgresDocumentContent>;

/** The run whose documents a page-facts write may touch. */
export type RunScope = { orgId: string | null; runId: string };

/**
 * Document content: the searchable rows a run derives from a document (pages, chunks and their page links, propositions,
 * summaries), its per-page ingest facts, and the org-scoped embedding reuse refs. Stages write through it (as the
 * DocumentContentWriter port); the run ledger's checkpoints commit the stage state around these writes.
 *
 * Every write names its tenant scope: the run's organization and the run the document belongs to. A write outside it
 * changes nothing: an insert throws (DocumentOutOfScopeError, or DocumentNotFoundError for a deleted document), a
 * delete, marker or link matches no row, and page facts skip the row.
 */
export class PostgresDocumentContent {
  constructor(private readonly sql: Sql<Record<string, unknown>>) {}

  async insertChunks(
    scope: DocumentRowScope,
    chunks: Array<{
      id: string;
      documentId: string;
      runId: string;
      userId: string;
      chunkIndex: number;
      text: string;
      headingPath: string[];
      pageNumber?: number;
      tokenEstimate: number;
      metadata: Record<string, unknown>;
      contentHash?: string;
      pipelineVersion?: string;
    }>,
  ): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    assertRowsInScope(scope, chunks);

    const rows = chunks.map((chunk) => ({
      id: chunk.id,
      document_id: chunk.documentId,
      run_id: chunk.runId,
      user_id: chunk.userId,
      chunk_index: chunk.chunkIndex,
      text: chunk.text,
      heading_path: chunk.headingPath,
      page_number: chunk.pageNumber ?? null,
      token_estimate: chunk.tokenEstimate,
      metadata: chunk.metadata,
      content_hash: chunk.contentHash ?? null,
      pipeline_version: chunk.pipelineVersion ?? null,
    }));

    for (const batch of batchedRows(rows)) {
      await this.scopedWrite(scope, (inScope) => this.sql`
        insert into document_chunks (
          id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata,
          content_hash, pipeline_version
        )
        select r.id, r.document_id, r.run_id, r.user_id, r.chunk_index, r.text, r.heading_path, r.page_number, r.token_estimate,
          coalesce(r.metadata, '{}'::jsonb), r.content_hash, r.pipeline_version
        from jsonb_to_recordset(${jsonRowsText(batch)}::text::jsonb) as r(
          id text, document_id text, run_id text, user_id text, chunk_index integer, text text, heading_path text[],
          page_number integer, token_estimate integer, metadata jsonb, content_hash text, pipeline_version text
        )
        where ${inScope}
        on conflict (id) do update
        set
          document_id = excluded.document_id,
          run_id = excluded.run_id,
          user_id = excluded.user_id,
          chunk_index = excluded.chunk_index,
          text = excluded.text,
          heading_path = excluded.heading_path,
          page_number = excluded.page_number,
          token_estimate = excluded.token_estimate,
          metadata = excluded.metadata,
          content_hash = excluded.content_hash,
          pipeline_version = excluded.pipeline_version
        -- An id collision with another document's row never overwrites it.
        where document_chunks.document_id = excluded.document_id
      `);
    }
  }

  /** Content-addressed embedding reuse (embeddings/embedding-reuse.ts); always org-scoped. */
  async findEmbeddingReuseRefs(orgId: string, keys: readonly string[]): Promise<EmbeddingReuseRef[]> {
    const refs: EmbeddingReuseRef[] = [];
    for (const batch of batchedRows([...new Set(keys)])) {
      const rows = await this.sql<{ embed_key: string; artifact_uri: string; chunk_index: number }[]>`
        select embed_key, artifact_uri, chunk_index
        from embedding_reuse_refs
        where org_id = ${orgId} and embed_key = any(${batch}::text[])
      `;
      refs.push(...rows.map((row) => ({ key: row.embed_key, artifactUri: row.artifact_uri, chunkIndex: row.chunk_index })));
    }
    return refs;
  }

  /** Points each key at its newest artifact, which outlives older purged versions. */
  async recordEmbeddingReuseRefs(orgId: string, refs: readonly EmbeddingReuseRef[]): Promise<void> {
    // One row per key (an upsert cannot touch a row twice), in key order so
    // concurrent writers lock rows in the same order.
    const unique = [...new Map(refs.map((ref) => [ref.key, ref])).values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const batch of batchedRows(unique)) {
      await this.sql`
        insert into embedding_reuse_refs (org_id, embed_key, artifact_uri, chunk_index)
        select ${orgId}, ref.embed_key, ref.artifact_uri, ref.chunk_index
        from unnest(${batch.map((ref) => ref.key)}::text[], ${batch.map((ref) => ref.artifactUri)}::text[], ${batch.map((ref) => ref.chunkIndex)}::int[])
          as ref(embed_key, artifact_uri, chunk_index)
        on conflict (org_id, embed_key) do update
        set artifact_uri = excluded.artifact_uri, chunk_index = excluded.chunk_index, updated_at = now()
        where embedding_reuse_refs.artifact_uri is distinct from excluded.artifact_uri
          or embedding_reuse_refs.chunk_index is distinct from excluded.chunk_index
      `;
    }
  }

  /** Drops refs whose artifact no longer holds the keyed vector (purged or rewritten). */
  async forgetEmbeddingReuseRefs(orgId: string, artifactUri: string, keys: readonly string[]): Promise<void> {
    for (const batch of batchedRows([...new Set(keys)])) {
      await this.sql`
        delete from embedding_reuse_refs
        where org_id = ${orgId} and artifact_uri = ${artifactUri} and embed_key = any(${batch}::text[])
      `;
    }
  }

  /**
   * Ingest report page facts. Source facts (text layer, images) and vision
   * outcomes come from different stages, so each write only touches its own
   * columns and never clears the other stage's values, except routing facts
   * (text_layer, scan_class, the encoding words): those belong to one run, so
   * any write that moves a row to another run clears them unless it sets them.
   */
  async upsertPageFacts(scope: RunScope, rows: readonly PageFactUpsert[]): Promise<void> {
    const own = rows.filter((row) => row.runId === scope.runId);
    if (own.length < rows.length) {
      console.warn(`[page-facts] dropped rows of another run run=${scope.runId} dropped=${rows.length - own.length}`);
    }
    rows = own;
    const source = rows.filter((row) => row.textBytes !== undefined || row.imageCount !== undefined);
    const vision = rows.filter((row) => row.visionStatus !== undefined);
    const routing = rows.filter((row) => row.textLayer != null || row.scanClass != null || row.mathBits != null);
    for (const batch of batchedRows(source)) {
      const payload = batch.map((row) => ({
        document_id: row.documentId, page_number: row.pageNumber, run_id: row.runId,
        text_bytes: row.textBytes ?? null, word_count: row.wordCount ?? null,
        image_count: row.imageCount ?? null, facts_source: row.factsSource ?? null,
      }));
      await this.sql`
        insert into document_page_facts (document_id, page_number, run_id, text_bytes, word_count, image_count, facts_source)
        select r.document_id, r.page_number, r.run_id, r.text_bytes, r.word_count, r.image_count, r.facts_source
        from jsonb_to_recordset(${jsonRowsText(payload)}::text::jsonb) as r(
          document_id text, page_number integer, run_id text, text_bytes integer, word_count integer,
          image_count integer, facts_source text
        )
        join documents d on d.id = r.document_id and d.org_id = ${scope.orgId} and d.run_id = ${scope.runId}
        on conflict (document_id, page_number) do update
        set run_id = excluded.run_id,
            -- Routing facts are a run's own: another run's write clears them (council #467).
            text_layer = case when document_page_facts.run_id = excluded.run_id then document_page_facts.text_layer end,
            scan_class = case when document_page_facts.run_id = excluded.run_id then document_page_facts.scan_class end,
            math_bits = case when document_page_facts.run_id = excluded.run_id then document_page_facts.math_bits end,
            table_bits = case when document_page_facts.run_id = excluded.run_id then document_page_facts.table_bits end,
            encoding_counts = case when document_page_facts.run_id = excluded.run_id then document_page_facts.encoding_counts end,
            text_bytes = excluded.text_bytes,
            word_count = excluded.word_count,
            image_count = excluded.image_count,
            facts_source = excluded.facts_source,
            updated_at = now()
      `;
    }
    for (const batch of batchedRows(vision)) {
      const payload = batch.map((row) => ({
        document_id: row.documentId, page_number: row.pageNumber, run_id: row.runId,
        vision_status: row.visionStatus ?? null, vision_text_bytes: row.visionTextBytes ?? null,
      }));
      await this.sql`
        insert into document_page_facts (document_id, page_number, run_id, vision_status, vision_text_bytes)
        select r.document_id, r.page_number, r.run_id, r.vision_status, r.vision_text_bytes
        from jsonb_to_recordset(${jsonRowsText(payload)}::text::jsonb) as r(
          document_id text, page_number integer, run_id text, vision_status text, vision_text_bytes integer
        )
        join documents d on d.id = r.document_id and d.org_id = ${scope.orgId} and d.run_id = ${scope.runId}
        on conflict (document_id, page_number) do update
        set run_id = excluded.run_id,
            -- Routing facts are a run's own: another run's write clears them (council #467).
            text_layer = case when document_page_facts.run_id = excluded.run_id then document_page_facts.text_layer end,
            scan_class = case when document_page_facts.run_id = excluded.run_id then document_page_facts.scan_class end,
            math_bits = case when document_page_facts.run_id = excluded.run_id then document_page_facts.math_bits end,
            table_bits = case when document_page_facts.run_id = excluded.run_id then document_page_facts.table_bits end,
            encoding_counts = case when document_page_facts.run_id = excluded.run_id then document_page_facts.encoding_counts end,
            vision_status = excluded.vision_status,
            vision_text_bytes = excluded.vision_text_bytes,
            updated_at = now()
      `;
    }
    // Routing facts (migration 0141): a value the write does not know keeps the stored one.
    for (const batch of batchedRows(routing)) {
      const payload = batch.map((row) => ({
        document_id: row.documentId, page_number: row.pageNumber, run_id: row.runId,
        text_layer: row.textLayer ?? null, scan_class: row.scanClass ?? null,
        // Doppler's encoding words (migration 0189): all three or none, so one write never mixes two runs' words.
        ...(row.mathBits != null && row.tableBits != null && row.encodingCounts != null
          ? { math_bits: row.mathBits, table_bits: row.tableBits, encoding_counts: row.encodingCounts }
          : { math_bits: null, table_bits: null, encoding_counts: null }),
      }));
      await this.sql`
        insert into document_page_facts (document_id, page_number, run_id, text_layer, scan_class, math_bits, table_bits, encoding_counts)
        select r.document_id, r.page_number, r.run_id, r.text_layer, r.scan_class, r.math_bits, r.table_bits, r.encoding_counts
        from jsonb_to_recordset(${jsonRowsText(payload)}::text::jsonb) as r(
          document_id text, page_number integer, run_id text, text_layer text, scan_class text, math_bits bigint, table_bits bigint,
          encoding_counts bigint
        )
        join documents d on d.id = r.document_id and d.org_id = ${scope.orgId} and d.run_id = ${scope.runId}
        on conflict (document_id, page_number) do update
        set run_id = excluded.run_id,
            -- A value the write does not know keeps the stored one only for the same run: another run's routing facts
            -- describe facts this run did not produce (a reprocess with page facts off, or an older provider), so they are
            -- cleared. The source and vision writes clear them the same way when they move the row to a new run.
            text_layer = coalesce(excluded.text_layer, case when document_page_facts.run_id = excluded.run_id then document_page_facts.text_layer end),
            scan_class = coalesce(excluded.scan_class, case when document_page_facts.run_id = excluded.run_id then document_page_facts.scan_class end),
            math_bits = case when excluded.encoding_counts is not null then excluded.math_bits
              when document_page_facts.run_id = excluded.run_id then document_page_facts.math_bits end,
            table_bits = case when excluded.encoding_counts is not null then excluded.table_bits
              when document_page_facts.run_id = excluded.run_id then document_page_facts.table_bits end,
            encoding_counts = case when excluded.encoding_counts is not null then excluded.encoding_counts
              when document_page_facts.run_id = excluded.run_id then document_page_facts.encoding_counts end,
            updated_at = now()
      `;
    }
  }

  async insertPages(
    scope: DocumentRowScope,
    pages: Array<{
      id: string;
      documentId: string;
      runId: string;
      userId: string;
      pageNumber: number;
      text: string;
      tokenEstimate: number;
    }>,
  ): Promise<void> {
    if (pages.length === 0) {
      return;
    }
    assertRowsInScope(scope, pages);

    const rows = pages.map((page) => ({
      id: page.id,
      document_id: page.documentId,
      run_id: page.runId,
      user_id: page.userId,
      page_number: page.pageNumber,
      text: page.text,
      token_estimate: page.tokenEstimate,
    }));

    for (const batch of batchedRows(rows)) {
      await this.scopedWrite(scope, (inScope) => this.sql`
        insert into document_pages (id, document_id, run_id, user_id, page_number, text, token_estimate)
        select r.id, r.document_id, r.run_id, r.user_id, r.page_number, r.text, r.token_estimate
        from jsonb_to_recordset(${jsonRowsText(batch)}::text::jsonb) as r(
          id text, document_id text, run_id text, user_id text, page_number integer, text text, token_estimate integer
        )
        where ${inScope}
        on conflict (id) do update
        set run_id = excluded.run_id,
            user_id = excluded.user_id,
            page_number = excluded.page_number,
            text = excluded.text,
            token_estimate = excluded.token_estimate
        -- An id collision with another document's row never overwrites it.
        where document_pages.document_id = excluded.document_id
      `);
    }
  }

  /**
   * The document's chunks are replaced by `keepChunkIds`; rows an earlier attempt
   * wrote beyond them are stale. Scoped to this document only.
   */
  async staleDocumentChunkIds(scope: DocumentRowScope, keepChunkIds: readonly string[]): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      select id from document_chunks
      where document_id = ${scope.documentId} and id <> all(${this.sql.array([...keepChunkIds])}::text[])
        and ${documentInScope(this.sql, scope)}
    `;
    return rows.map((row) => row.id);
  }

  async deleteStaleDocumentChunks(scope: DocumentRowScope, keepChunkIds: readonly string[]): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      delete from document_chunks
      where document_id = ${scope.documentId} and id <> all(${this.sql.array([...keepChunkIds])}::text[])
        and ${documentInScope(this.sql, scope)}
      returning id
    `;
    return rows.map((row) => row.id);
  }

  /**
   * deleteStaleDocumentChunks, then (when the replacement set is non-empty) markDocumentLexicalSearchable,
   * in one transaction and one round trip: the marker never precedes the tail drop.
   */
  async finalizeDocumentChunks(
    scope: DocumentRowScope,
    keepChunkIds: readonly string[],
    markSearchable: boolean,
    /** The chunks' LanceDB text rows are about to be rewritten: lift the key until that commits (needs lexical_index_key). */
    resetLexicalIndex = false,
  ): Promise<void> {
    await pipelineTransaction(this.sql, (client) => [
      client`
        delete from document_chunks
        where document_id = ${scope.documentId} and id <> all(${client.array([...keepChunkIds])}::text[])
          and ${documentInScope(client, scope)}
      `,
      ...(markSearchable ? [client`
        update documents
        set lexical_searchable_at = coalesce(lexical_searchable_at, now())
        where id = ${scope.documentId} and org_id = ${scope.orgId} and run_id = ${scope.runId}
      `] : []),
      ...(resetLexicalIndex ? [client`
        update documents set lexical_index_key = null
        where id = ${scope.documentId} and org_id = ${scope.orgId} and run_id = ${scope.runId} and lexical_index_key is not null
      `] : []),
    ]);
  }

  /**
   * The document's chunk rows of this run are committed to LanceDB without vectors: keyword search may read them
   * there (`key` is lexicalIndexKey of the run and embedding space). Only for the document's current run.
   */
  async markDocumentLexicalIndexed(scope: DocumentRowScope, key: string): Promise<void> {
    await this.sql`
      update documents set lexical_index_key = ${key}
      where id = ${scope.documentId} and org_id = ${scope.orgId} and run_id = ${scope.runId}
    `;
  }

  /**
   * Every chunk row of the document is written: keyword search may serve it
   * before the index stage completes (server/src/search/eligibility.ts).
   * Called after the last insertChunks batch, so a reader never sees a
   * half-materialized chunk set behind the marker.
   */
  async markDocumentLexicalSearchable(scope: DocumentRowScope): Promise<void> {
    await this.sql`
      update documents
      set lexical_searchable_at = coalesce(lexical_searchable_at, now())
      where id = ${scope.documentId} and org_id = ${scope.orgId} and run_id = ${scope.runId}
    `;
  }

  async linkChunksToPages(scope: DocumentRowScope): Promise<void> {
    const { documentId, runId } = scope;
    await this.sql`
      update document_chunks c
      set parent_page_id = p.id
      from document_pages p
      where c.document_id = ${documentId}
        and c.run_id = ${runId}
        and p.document_id = ${documentId}
        and p.run_id = ${runId}
        and c.page_number = p.page_number
        and c.parent_page_id is null
        and ${documentInScope(this.sql, scope, "c.document_id")}
    `;
  }

  async insertPropositions(
    scope: DocumentRowScope,
    propositions: Array<{
      id: string;
      documentId: string;
      runId: string;
      userId: string;
      chunkIndex: number;
      text: string;
      sourceParagraph: string;
      tokenEstimate: number;
    }>,
  ): Promise<void> {
    if (propositions.length === 0) {
      return;
    }
    assertRowsInScope(scope, propositions);

    const rows = propositions.map((prop) => ({
      id: prop.id,
      document_id: prop.documentId,
      run_id: prop.runId,
      user_id: prop.userId,
      chunk_index: prop.chunkIndex,
      text: prop.text,
      source_paragraph: prop.sourceParagraph,
      token_estimate: prop.tokenEstimate,
    }));

    for (const batch of batchedRows(rows)) {
      await this.scopedWrite(scope, (inScope) => this.sql`
        insert into document_propositions (id, document_id, run_id, user_id, chunk_index, text, source_paragraph, token_estimate)
        select r.id, r.document_id, r.run_id, r.user_id, r.chunk_index, r.text, r.source_paragraph, r.token_estimate
        from jsonb_to_recordset(${jsonRowsText(batch)}::text::jsonb) as r(
          id text, document_id text, run_id text, user_id text, chunk_index integer, text text, source_paragraph text,
          token_estimate integer
        )
        where ${inScope}
        on conflict (id) do nothing
      `);
    }
  }

  async insertSummary(scope: DocumentRowScope, summary: {
    id: string;
    documentId: string;
    runId: string;
    userId: string;
    summary: string;
  }): Promise<void> {
    assertRowsInScope(scope, [summary]);
    await this.scopedWrite(scope, (inScope) => this.sql`
      insert into document_summaries (
        id, document_id, run_id, user_id, summary
      )
      select
        ${summary.id},
        ${summary.documentId},
        ${summary.runId},
        ${summary.userId},
        ${wellFormed(summary.summary)}
      where ${inScope}
      on conflict (id) do nothing
    `);
  }

  /**
   * One insert, run only when the scope's document is the organization's and the run's (`inScope`, the statement's own
   * predicate), in the same statement that reports whether it was. Out of scope writes nothing and throws: a document of
   * another organization or run (DocumentOutOfScopeError), or one that is gone (DocumentNotFoundError).
   */
  private async scopedWrite(scope: DocumentRowScope, insert: (inScope: PendingQuery<Row[]>) => PendingQuery<Row[]>): Promise<void> {
    // A data-modifying CTE always runs; its rows exist only when the document is in scope.
    const [row] = await this.sql<{ in_scope: boolean }[]>`
      with in_scope as (
        select 1 from documents where id = ${scope.documentId} and org_id = ${scope.orgId} and run_id = ${scope.runId}
      ),
      written as (${insert(this.sql`exists (select 1 from in_scope)`)} returning 1)
      select exists (select 1 from in_scope) as in_scope
    `;
    if (row?.in_scope) return;
    // Which predicate failed, as two booleans: no column of another tenant's row leaves the database.
    const [found] = await this.sql<{ org_ok: boolean; run_ok: boolean }[]>`
      select coalesce(org_id = ${scope.orgId}, false) as org_ok, coalesce(run_id = ${scope.runId}, false) as run_ok
      from documents where id = ${scope.documentId} limit 1`;
    if (found) {
      const mismatch = !found.org_ok && !found.run_ok ? "org and run" as const : !found.org_ok ? "org" as const : "run" as const;
      console.error(`[document-content] write out of scope document=${scope.documentId} run=${scope.runId} mismatch=${mismatch}`);
      throw new DocumentOutOfScopeError(scope.documentId, mismatch);
    }
    throw new DocumentNotFoundError(scope.documentId);
  }



}

/** The document's rows, only while the document is the organization's and the run's: `<column> in (that document)`. */
function documentInScope(client: Sql<Record<string, unknown>>, scope: DocumentRowScope, column = "document_id") {
  return client`${client.unsafe(column)} in (
    select id from documents where id = ${scope.documentId} and org_id = ${scope.orgId} and run_id = ${scope.runId}
  )`;
}

/** Rows a caller writes under a scope must be that document's and that run's: anything else is a caller bug. */
function assertRowsInScope(scope: DocumentRowScope, rows: ReadonlyArray<{ documentId: string; runId: string }>): void {
  if (rows.some((row) => row.documentId !== scope.documentId || row.runId !== scope.runId)) {
    throw new Error(`content rows outside their write scope document=${scope.documentId} run=${scope.runId}`);
  }
}
