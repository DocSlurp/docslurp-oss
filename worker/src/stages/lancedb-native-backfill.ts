/**
 * Prepare a workspace's existing LanceDB tables for SEARCH_LANCEDB_NATIVE search, without
 * re-embedding (CLI: worker/scripts/lancedb-native-backfill.ts):
 *
 *   1. add the nullable hydration columns (runId, pageNumber, hydration) when missing
 *      (metadata only: no data files are rewritten);
 *   2. fill them for every chunk row from Postgres document_chunks, by partial merge-insert
 *      (only those three columns change; vectors and text keep their values; ids that are
 *      not in the table are skipped);
 *   3. build the chunk-text FTS (BM25) index when it is missing;
 *   4. optimize the table: a merge-insert moves every updated row out of the vector (and FTS)
 *      index until the next optimize, so without it the org's searches, flag on or off, would
 *      flat-scan the backfilled rows until some later ingest triggers maintenance.
 *
 * Safe to rerun: rows already carrying hydration are rewritten with the same values, an
 * existing FTS index is kept. Each batch is one Lance commit that can conflict with a
 * concurrent writer; both sides retry, so running during ingest is safe but slower. The
 * workspace's org table is shared by the org's other workspaces; only this workspace's rows
 * are filled, but the FTS index and the optimize cover the whole table. Read-only on Postgres.
 */
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { resolveLanceDbConfig, VectorNamespaceManager } from "@docslurp/shared";
import { encodeLanceChunkHydration, lancePageNumberValue } from "@docslurp/shared/lancedb-hydration";
import type postgres from "postgres";

import { connectLanceDb } from "./lancedb-connection.js";
import { chunkTextFtsIndex, hasChunkTextFtsIndex } from "./lancedb-maintenance.js";
import { ensureLanceHydrationColumns, isRetryableLanceCommitError } from "./lancedb-writer.js";

export interface LanceNativeBackfillOptions {
  sql: postgres.Sql;
  workspaceId: string;
  /** Documents per Postgres read and Lance commit (default 50). */
  batchDocs?: number;
  dryRun?: boolean;
  skipFts?: boolean;
  skipOptimize?: boolean;
  log?: (line: string) => void;
}

export interface LanceNativeBackfillTableResult {
  uri: string;
  table: string;
  skipped?: "missing";
  chunkRows: number;
  ftsBuilt: boolean;
  optimized: boolean;
  /** Rows of the table still without hydration (other workspaces, legacy rows); null on a dry run. */
  rowsWithoutHydration: number | null;
}

async function withRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= 8 || !isRetryableLanceCommitError(error)) throw error;
      await delay(Math.min(15_000, 250 * 2 ** attempt));
    }
  }
}

export async function backfillWorkspaceLanceHydration(options: LanceNativeBackfillOptions): Promise<LanceNativeBackfillTableResult[]> {
  const { sql, workspaceId, dryRun = false, skipFts = false, skipOptimize = false } = options;
  const batchDocs = Math.max(1, Math.trunc(options.batchDocs ?? 50));
  const log = options.log ?? ((line: string) => console.log(line));
  const [workspace] = await sql<{ org_id: string }[]>`select org_id from workspaces where id = ${workspaceId}`;
  if (!workspace) throw new Error(`workspace ${workspaceId} not found`);
  const spaces = await sql<{ embedding_model: string; dimension: number; documents: number }[]>`
    select v.embedding_model, v.dimension, count(distinct v.document_id)::int as documents
    from vector_indexes v join documents d on d.id = v.document_id
    where d.workspace_id = ${workspaceId} and v.backend = 'lancedb'
    group by 1, 2 order by 3 desc
  `;
  const { root } = resolveLanceDbConfig();
  const results: LanceNativeBackfillTableResult[] = [];
  for (const space of spaces) {
    const location = VectorNamespaceManager.getEmbeddingLocation(root, workspace.org_id, space.embedding_model, space.dimension);
    const result: LanceNativeBackfillTableResult = { uri: location.uri, table: location.table, chunkRows: 0, ftsBuilt: false, optimized: false, rowsWithoutHydration: null };
    results.push(result);
    log(`[backfill] table=${location.uri}/${location.table} model=${space.embedding_model} d=${space.dimension} documents=${space.documents}`);
    const db = await connectLanceDb(location.uri);
    try {
      if (!(await db.tableNames()).includes(location.table)) {
        result.skipped = "missing";
        log("[backfill] table missing; skipped");
        continue;
      }
      const table = await db.openTable(location.table);
      try {
        if (!dryRun) log(`[backfill] hydration columns added=${await withRetry(() => ensureLanceHydrationColumns(table))}`);
        const documents = await sql<{ document_id: string }[]>`
          select distinct v.document_id from vector_indexes v join documents d on d.id = v.document_id
          where d.workspace_id = ${workspaceId} and v.backend = 'lancedb'
            and v.embedding_model = ${space.embedding_model} and v.dimension = ${space.dimension}
          order by 1
        `;
        const started = performance.now();
        for (let offset = 0; offset < documents.length; offset += batchDocs) {
          const ids = documents.slice(offset, offset + batchDocs).map((row) => row.document_id);
          const chunks = await sql<{ id: string; run_id: string; heading_path: string[] | null; page_number: number | null; token_estimate: number; metadata: Record<string, unknown> | null }[]>`
            select id, run_id, heading_path, page_number, token_estimate, metadata
            from document_chunks where document_id = any(${sql.array(ids)})
          `;
          const updates = chunks.map((chunk) => ({
            id: chunk.id,
            runId: chunk.run_id,
            pageNumber: lancePageNumberValue(chunk.page_number),
            hydration: encodeLanceChunkHydration({
              runId: chunk.run_id, headingPath: chunk.heading_path, pageNumber: chunk.page_number,
              tokenEstimate: chunk.token_estimate, metadata: chunk.metadata,
            }),
          }));
          if (!dryRun && updates.length > 0) {
            // Partial-schema merge: matched rows get the three columns, unmatched ids are ignored.
            await withRetry(() => table.mergeInsert("id").whenMatchedUpdateAll().execute(updates));
          }
          result.chunkRows += updates.length;
          log(`[backfill] documents=${Math.min(offset + batchDocs, documents.length)}/${documents.length} chunk_rows=${result.chunkRows} elapsed_s=${Math.round((performance.now() - started) / 1000)}`);
        }
        const indices = await table.listIndices();
        if (!skipFts && !dryRun && !hasChunkTextFtsIndex(indices)) {
          const ftsStarted = performance.now();
          try {
            await withRetry(() => table.createIndex("text", { config: chunkTextFtsIndex(), replace: false }));
            result.ftsBuilt = true;
            log(`[backfill] fts index built in ${Math.round(performance.now() - ftsStarted)} ms`);
          } catch (error) {
            // Worker maintenance (LANCEDB_FTS_INDEX=1) built it concurrently.
            if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
            log("[backfill] fts index built concurrently by another writer");
          }
        } else {
          log(`[backfill] fts index ${hasChunkTextFtsIndex(indices) ? "present" : "skipped"}`);
        }
        if (!dryRun && !skipOptimize && result.chunkRows > 0) {
          // Folds the rewritten rows back into the vector and FTS indices (and compacts).
          const optimizeStarted = performance.now();
          await withRetry(() => table.optimize());
          result.optimized = true;
          log(`[backfill] optimized in ${Math.round(performance.now() - optimizeStarted)} ms`);
        } else if (!dryRun && result.chunkRows > 0) {
          log("[backfill] skip-optimize: backfilled rows stay outside the vector index until the next maintenance optimize");
        }
        if (!dryRun) {
          result.rowsWithoutHydration = await table.countRows("hydration IS NULL OR hydration = ''");
          log(`[backfill] rows still without hydration (other workspaces, legacy rows): ${result.rowsWithoutHydration}`);
        }
      } finally {
        table.close();
      }
    } finally {
      db.close();
    }
  }
  return results;
}
