import type { JSONValue, Sql } from "postgres";

import type { EmbeddingReuseRef } from "../embeddings/embedding-reuse.js";
import type { PageFactUpsert } from "../pipeline/page-facts.js";
import { batchedRows, sqlJson } from "./sql-helpers.js";
import { pipelineTransaction } from "./transaction-pipeline.js";

/** The document content port stages write through (pipeline CheckpointStore.content). */
export type DocumentContentWriter = Pick<PostgresDocumentContent, keyof PostgresDocumentContent>;

/**
 * Document content: the searchable rows a run derives from a document (pages, chunks and their page links, propositions,
 * summaries), its per-page ingest facts, and the org-scoped embedding reuse refs. Stages write through it (as the
 * DocumentContentWriter port); the run ledger's checkpoints commit the stage state around these writes.
 */
export class PostgresDocumentContent {
  constructor(private readonly sql: Sql<Record<string, unknown>>) {}

  async insertChunks(
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
      metadata: this.toJson(chunk.metadata),
      content_hash: chunk.contentHash ?? null,
      pipeline_version: chunk.pipelineVersion ?? null,
    }));

    for (const batch of batchedRows(rows)) {
      await this.sql`
        insert into document_chunks ${this.sql(
          batch,
          "id",
          "document_id",
          "run_id",
          "user_id",
          "chunk_index",
          "text",
          "heading_path",
          "page_number",
          "token_estimate",
          "metadata",
          "content_hash",
          "pipeline_version",
        )}
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
      `;
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
   * columns and never clears the other stage's values.
   */
  async upsertPageFacts(rows: readonly PageFactUpsert[]): Promise<void> {
    const source = rows.filter((row) => row.textBytes !== undefined || row.imageCount !== undefined);
    const vision = rows.filter((row) => row.visionStatus !== undefined);
    const routing = rows.filter((row) => row.textLayer != null || row.scanClass != null);
    for (const batch of batchedRows(source)) {
      const payload = batch.map((row) => ({
        document_id: row.documentId, page_number: row.pageNumber, run_id: row.runId,
        text_bytes: row.textBytes ?? null, word_count: row.wordCount ?? null,
        image_count: row.imageCount ?? null, facts_source: row.factsSource ?? null,
      }));
      await this.sql`
        insert into document_page_facts (document_id, page_number, run_id, text_bytes, word_count, image_count, facts_source)
        select r.document_id, r.page_number, r.run_id, r.text_bytes, r.word_count, r.image_count, r.facts_source
        from jsonb_to_recordset(${this.sql.json(payload as unknown as JSONValue)}::jsonb) as r(
          document_id text, page_number integer, run_id text, text_bytes integer, word_count integer,
          image_count integer, facts_source text
        )
        join documents d on d.id = r.document_id
        on conflict (document_id, page_number) do update
        set run_id = excluded.run_id,
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
        from jsonb_to_recordset(${this.sql.json(payload as unknown as JSONValue)}::jsonb) as r(
          document_id text, page_number integer, run_id text, vision_status text, vision_text_bytes integer
        )
        join documents d on d.id = r.document_id
        on conflict (document_id, page_number) do update
        set run_id = excluded.run_id,
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
      }));
      await this.sql`
        insert into document_page_facts (document_id, page_number, run_id, text_layer, scan_class)
        select r.document_id, r.page_number, r.run_id, r.text_layer, r.scan_class
        from jsonb_to_recordset(${this.sql.json(payload as unknown as JSONValue)}::jsonb) as r(
          document_id text, page_number integer, run_id text, text_layer text, scan_class text
        )
        join documents d on d.id = r.document_id
        on conflict (document_id, page_number) do update
        set run_id = excluded.run_id,
            text_layer = coalesce(excluded.text_layer, document_page_facts.text_layer),
            scan_class = coalesce(excluded.scan_class, document_page_facts.scan_class),
            updated_at = now()
      `;
    }
  }

  async insertPages(
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
      await this.sql`
        insert into document_pages ${this.sql(
          batch,
          "id",
          "document_id",
          "run_id",
          "user_id",
          "page_number",
          "text",
          "token_estimate",
        )}
        on conflict (id) do update
        set run_id = excluded.run_id,
            user_id = excluded.user_id,
            page_number = excluded.page_number,
            text = excluded.text,
            token_estimate = excluded.token_estimate
      `;
    }
  }

  /**
   * The document's chunks are replaced by `keepChunkIds`; rows an earlier attempt
   * wrote beyond them are stale. Scoped to this document only.
   */
  async staleDocumentChunkIds(documentId: string, keepChunkIds: readonly string[]): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      select id from document_chunks
      where document_id = ${documentId} and id <> all(${this.sql.array([...keepChunkIds])}::text[])
    `;
    return rows.map((row) => row.id);
  }

  async deleteStaleDocumentChunks(documentId: string, keepChunkIds: readonly string[]): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      delete from document_chunks
      where document_id = ${documentId} and id <> all(${this.sql.array([...keepChunkIds])}::text[])
      returning id
    `;
    return rows.map((row) => row.id);
  }

  /**
   * deleteStaleDocumentChunks, then (when the replacement set is non-empty) markDocumentLexicalSearchable,
   * in one transaction and one round trip: the marker never precedes the tail drop.
   */
  async finalizeDocumentChunks(documentId: string, keepChunkIds: readonly string[], markSearchable: boolean): Promise<void> {
    await pipelineTransaction(this.sql, (client) => [
      client`
        delete from document_chunks
        where document_id = ${documentId} and id <> all(${client.array([...keepChunkIds])}::text[])
      `,
      ...(markSearchable ? [client`
        update documents
        set lexical_searchable_at = coalesce(lexical_searchable_at, now())
        where id = ${documentId}
      `] : []),
    ]);
  }

  /**
   * Every chunk row of the document is written: keyword search may serve it
   * before the index stage completes (server/src/search/eligibility.ts).
   * Called after the last insertChunks batch, so a reader never sees a
   * half-materialized chunk set behind the marker.
   */
  async markDocumentLexicalSearchable(documentId: string): Promise<void> {
    await this.sql`
      update documents
      set lexical_searchable_at = coalesce(lexical_searchable_at, now())
      where id = ${documentId}
    `;
  }

  async linkChunksToPages(documentId: string, runId: string): Promise<void> {
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
    `;
  }

  async insertPropositions(
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
      await this.sql`
        insert into document_propositions ${this.sql(
          batch,
          "id",
          "document_id",
          "run_id",
          "user_id",
          "chunk_index",
          "text",
          "source_paragraph",
          "token_estimate",
        )}
        on conflict (id) do nothing
      `;
    }
  }

  async insertSummary(summary: {
    id: string;
    documentId: string;
    runId: string;
    userId: string;
    summary: string;
  }): Promise<void> {
    await this.sql`
      insert into document_summaries (
        id, document_id, run_id, user_id, summary
      )
      values (
        ${summary.id},
        ${summary.documentId},
        ${summary.runId},
        ${summary.userId},
        ${summary.summary}
      )
      on conflict (id) do nothing
    `;
  }

  private toJson(value: unknown) {
    return sqlJson(this.sql, value);
  }
}
