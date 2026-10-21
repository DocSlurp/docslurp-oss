/**
 * Prepare existing LanceDB tables for SEARCH_LANCEDB_NATIVE search, without re-embedding:
 *
 *   1. add the nullable hydration columns (runId, pageNumber, hydration) when missing;
 *   2. fill them for every chunk row from Postgres document_chunks, by partial merge-insert
 *      (only those three columns are rewritten; vectors and text are untouched; ids that are
 *      not in the table are skipped);
 *   3. build the chunk-text FTS (BM25) index when it is missing.
 *
 *   DATABASE_URL=… LANCEDB_URI=… pnpm --filter @docslurp/worker exec tsx scripts/lancedb-native-backfill.ts \
 *     --workspace <workspace id> [--batch-docs 50] [--skip-fts] [--dry-run]
 *
 * Safe to rerun: rows already carrying hydration are rewritten with the same values, an
 * existing FTS index is kept. Run while ingest is quiet: each batch is one Lance commit that
 * can conflict with a concurrent writer (the writer retries; this script retries too). The
 * workspace's org table is shared by the org's other workspaces; only this workspace's rows
 * are filled, but the FTS index covers the whole table. Read-only on Postgres.
 */
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { resolveLanceDbConfig, VectorNamespaceManager } from "@docslurp/shared";
import { encodeLanceChunkHydration, lancePageNumberValue } from "@docslurp/shared/lancedb-hydration";
import postgres from "postgres";

import { connectLanceDb } from "../src/stages/lancedb-connection.js";
import { chunkTextFtsIndex, hasChunkTextFtsIndex } from "../src/stages/lancedb-maintenance.js";
import { ensureLanceHydrationColumns, isRetryableLanceCommitError } from "../src/stages/lancedb-writer.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workspaceId = arg("workspace");
const batchDocs = Math.max(1, Number(arg("batch-docs") ?? 50));
const dryRun = process.argv.includes("--dry-run");
const skipFts = process.argv.includes("--skip-fts");
if (!workspaceId) throw new Error("--workspace <id> is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });

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

try {
  const [workspace] = await sql<{ org_id: string }[]>`select org_id from workspaces where id = ${workspaceId}`;
  if (!workspace) throw new Error(`workspace ${workspaceId} not found`);
  const spaces = await sql<{ embedding_model: string; dimension: number; documents: number }[]>`
    select v.embedding_model, v.dimension, count(distinct v.document_id)::int as documents
    from vector_indexes v join documents d on d.id = v.document_id
    where d.workspace_id = ${workspaceId} and v.backend = 'lancedb'
    group by 1, 2 order by 3 desc
  `;
  const { root } = resolveLanceDbConfig();
  for (const space of spaces) {
    const location = VectorNamespaceManager.getEmbeddingLocation(root, workspace.org_id, space.embedding_model, space.dimension);
    console.log(`[backfill] table=${location.uri}/${location.table} model=${space.embedding_model} d=${space.dimension} documents=${space.documents}`);
    const db = await connectLanceDb(location.uri);
    try {
      if (!(await db.tableNames()).includes(location.table)) {
        console.log("[backfill] table missing; skipped");
        continue;
      }
      const table = await db.openTable(location.table);
      try {
        if (!dryRun) console.log(`[backfill] hydration columns added=${await withRetry(() => ensureLanceHydrationColumns(table))}`);
        const documents = await sql<{ document_id: string }[]>`
          select distinct v.document_id from vector_indexes v join documents d on d.id = v.document_id
          where d.workspace_id = ${workspaceId} and v.backend = 'lancedb'
            and v.embedding_model = ${space.embedding_model} and v.dimension = ${space.dimension}
          order by 1
        `;
        let rows = 0;
        const started = performance.now();
        for (let offset = 0; offset < documents.length; offset += batchDocs) {
          const ids = documents.slice(offset, offset + batchDocs).map((row) => row.document_id);
          const chunks = await sql<{ id: string; run_id: string; heading_path: string[] | null; page_number: number | null; token_estimate: number; metadata: Record<string, unknown> | null }[]>`
            select id, run_id, heading_path, page_number, token_estimate, metadata
            from document_chunks where document_id = any(${ids})
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
          rows += updates.length;
          console.log(`[backfill] documents=${Math.min(offset + batchDocs, documents.length)}/${documents.length} chunk_rows=${rows} elapsed_s=${Math.round((performance.now() - started) / 1000)}`);
        }
        const indices = await table.listIndices();
        if (!skipFts && !dryRun && !hasChunkTextFtsIndex(indices)) {
          const ftsStarted = performance.now();
          await withRetry(() => table.createIndex("text", { config: chunkTextFtsIndex(), replace: false }));
          console.log(`[backfill] fts index built in ${Math.round(performance.now() - ftsStarted)} ms`);
        } else {
          console.log(`[backfill] fts index ${hasChunkTextFtsIndex(indices) ? "present" : "skipped"}`);
        }
        if (!dryRun) {
          const missing = await table.countRows("hydration IS NULL OR hydration = ''");
          console.log(`[backfill] rows still without hydration (other workspaces, legacy rows): ${missing}`);
        }
      } finally {
        table.close();
      }
    } finally {
      db.close();
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
