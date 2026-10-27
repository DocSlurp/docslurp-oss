/**
 * Prepare a workspace's existing LanceDB tables for SEARCH_LANCEDB_NATIVE search, without
 * re-embedding (CLI: lancedb-native-backfill-cli.ts, `node worker/dist/stages/lancedb-native-backfill-cli.js` in the image):
 *
 *   1. add the nullable hydration columns (runId, pageNumber, hydration) when missing
 *      (metadata only: no data files are rewritten);
 *   2. fill them for every chunk row from Postgres document_chunks, by partial merge-insert
 *      (only those three columns change; vectors and text keep their values; ids that are
 *      not in the table are skipped);
 *   3. build the chunk-text FTS (BM25) index when it is missing;
 *   4. optimize the table: a merge-insert moves every updated row out of the vector (and FTS)
 *      index until the next optimize, so without it the workspace's searches, flag on or off,
 *      would flat-scan the backfilled rows until some later ingest triggers maintenance.
 *
 * Every workspace has its own LanceDB database per embedding space (see searchTarget in
 * server/src/search/lancedb.ts); each one its documents were indexed into is covered. A
 * table without an FTS index sends that workspace's keyword search to Postgres FTS.
 *
 * Scope: one workspace, every workspace of an org, or every org.
 *
 * Safe to rerun: rows already carrying hydration are rewritten with the same values, an
 * existing FTS index is kept. Each batch is one Lance commit that can conflict with a
 * concurrent writer; both sides retry, so running during ingest is safe but slower.
 * Read-only on Postgres.
 */
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { resolveLanceDbConfig, VectorNamespaceManager } from "@docslurp/shared";
import { encodeLanceChunkHydration, lancePageNumberValue } from "@docslurp/shared/lancedb-hydration";
import type postgres from "postgres";

import { connectLanceDb } from "./lancedb-connection.js";
import { chunkTextFtsIndex, hasChunkTextFtsIndex } from "./lancedb-maintenance.js";
import { ensureLanceHydrationColumns, isRetryableLanceCommitError } from "./lancedb-writer.js";

export interface LanceNativeBackfillScope {
  sql: postgres.Sql;
  /** Documents per Postgres read and Lance commit (default 50). */
  batchDocs?: number;
  dryRun?: boolean;
  skipFts?: boolean;
  skipOptimize?: boolean;
  log?: (line: string) => void;
}

export interface LanceNativeBackfillOptions extends LanceNativeBackfillScope {
  workspaceId: string;
}

export interface LanceNativeBackfillTableResult {
  orgId: string;
  workspaceId: string;
  uri: string;
  table: string;
  skipped?: "missing";
  /** The table failed (logged); the run went on with the next table. */
  error?: string;
  chunkRows: number;
  ftsBuilt: boolean;
  /** The table has a chunk-text FTS index after the run (built now or before). */
  ftsPresent: boolean;
  optimized: boolean;
  /** Rows of the table still without hydration (orphaned rows); null on a dry run. */
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

/** One workspace's LanceDB databases. */
export async function backfillWorkspaceLanceHydration(options: LanceNativeBackfillOptions): Promise<LanceNativeBackfillTableResult[]> {
  const [workspace] = await options.sql<{ org_id: string }[]>`select org_id from workspaces where id = ${options.workspaceId}`;
  if (!workspace) throw new Error(`workspace ${options.workspaceId} not found`);
  return await backfillOrgLanceHydration({ ...options, orgId: workspace.org_id, workspaceIds: [options.workspaceId] });
}

/** Every org with LanceDB-indexed documents, one org at a time. */
export async function backfillAllLanceHydration(options: LanceNativeBackfillScope): Promise<LanceNativeBackfillTableResult[]> {
  const log = options.log ?? ((line: string) => console.log(line));
  const orgs = await options.sql<{ org_id: string; workspaces: number; documents: number }[]>`
    select d.org_id, count(distinct d.workspace_id)::int as workspaces, count(distinct d.id)::int as documents
    from documents d join vector_indexes v on v.document_id = d.id and v.backend = 'lancedb'
    where d.org_id is not null
    group by 1 order by 3 desc
  `;
  log(`[backfill] orgs=${orgs.length} workspaces=${orgs.reduce((sum, org) => sum + org.workspaces, 0)} documents=${orgs.reduce((sum, org) => sum + org.documents, 0)}`);
  const results: LanceNativeBackfillTableResult[] = [];
  for (const [index, org] of orgs.entries()) {
    log(`[backfill] org ${index + 1}/${orgs.length} id=${org.org_id} workspaces=${org.workspaces} documents=${org.documents}`);
    results.push(...await backfillOrgLanceHydration({ ...options, orgId: org.org_id }));
  }
  return results;
}

/**
 * Every LanceDB database of `workspaceIds` (default: all of the org's
 * workspaces), one per workspace and embedding space, each filled from
 * Postgres, indexed and optimized once.
 */
export async function backfillOrgLanceHydration(options: LanceNativeBackfillScope & { orgId: string; workspaceIds?: string[] }): Promise<LanceNativeBackfillTableResult[]> {
  const { sql, orgId, dryRun = false, skipFts = false, skipOptimize = false } = options;
  const batchDocs = Math.max(1, Math.trunc(options.batchDocs ?? 50));
  const log = options.log ?? ((line: string) => console.log(line));
  const workspaceIds = options.workspaceIds ?? (await sql<{ id: string }[]>`select id from workspaces where org_id = ${orgId} order by id`).map((row) => row.id);
  if (workspaceIds.length === 0) return [];
  const indexed = await sql<{ document_id: string; workspace_id: string; embedding_model: string; dimension: number }[]>`
    select distinct v.document_id, d.workspace_id, v.embedding_model, v.dimension
    from vector_indexes v join documents d on d.id = v.document_id
    where d.workspace_id = any(${sql.array(workspaceIds)}) and v.backend = 'lancedb'
    order by 1
  `;
  const { root } = resolveLanceDbConfig();
  // Each workspace database with the documents whose rows it may hold.
  const targets = new Map<string, { workspaceId: string; uri: string; table: string; documentIds: Set<string> }>();
  for (const row of indexed) {
    const location = VectorNamespaceManager.getEmbeddingLocation(root, orgId, row.workspace_id, row.embedding_model, row.dimension);
    const key = `${location.uri}\u0000${location.table}`;
    let entry = targets.get(key);
    if (!entry) targets.set(key, entry = { workspaceId: row.workspace_id, uri: location.uri, table: location.table, documentIds: new Set() });
    entry.documentIds.add(row.document_id);
  }
  const results: LanceNativeBackfillTableResult[] = [];
  for (const entry of targets.values()) {
    try {
      results.push(await backfillTable({ ...entry, orgId, documentIds: [...entry.documentIds].sort(), sql, batchDocs, dryRun, skipFts, skipOptimize, log }));
    } catch (error) {
      // One bad table (an old schema, a storage error) must not stop an org-wide or --all run.
      const message = error instanceof Error ? error.message : String(error);
      log(`[backfill] table=${entry.uri}/${entry.table} FAILED: ${message}`);
      results.push({ orgId, workspaceId: entry.workspaceId, uri: entry.uri, table: entry.table, error: message,
        chunkRows: 0, ftsBuilt: false, ftsPresent: false, optimized: false, rowsWithoutHydration: null });
    }
  }
  const withoutFts = results.filter((result) => !result.skipped && !result.ftsPresent);
  log(`[backfill] org=${orgId} tables=${results.filter((result) => !result.skipped).length} missing=${results.filter((result) => result.skipped).length}`
    + ` failed=${results.filter((result) => result.error).length}`
    + ` without_fts=${withoutFts.length}${withoutFts.length ? " (keyword search stays on Postgres FTS for those workspaces)" : ""}`);
  return results;
}

async function backfillTable(args: {
  sql: postgres.Sql; orgId: string; workspaceId: string; uri: string; table: string; documentIds: string[];
  batchDocs: number; dryRun: boolean; skipFts: boolean; skipOptimize: boolean; log: (line: string) => void;
}): Promise<LanceNativeBackfillTableResult> {
  const { sql, documentIds, batchDocs, dryRun, skipFts, skipOptimize, log } = args;
  const result: LanceNativeBackfillTableResult = {
    orgId: args.orgId, workspaceId: args.workspaceId, uri: args.uri, table: args.table,
    chunkRows: 0, ftsBuilt: false, ftsPresent: false, optimized: false, rowsWithoutHydration: null,
  };
  const db = await connectLanceDb(args.uri);
  try {
    if (!(await db.tableNames()).includes(args.table)) {
      result.skipped = "missing";
      log(`[backfill] table=${args.uri}/${args.table} missing; skipped`);
      return result;
    }
    log(`[backfill] table=${args.uri}/${args.table} documents=${documentIds.length}`);
    const table = await db.openTable(args.table);
    try {
      if (!dryRun) log(`[backfill] hydration columns added=${await withRetry(() => ensureLanceHydrationColumns(table))}`);
      const started = performance.now();
      for (let offset = 0; offset < documentIds.length; offset += batchDocs) {
        const ids = documentIds.slice(offset, offset + batchDocs);
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
        log(`[backfill] documents=${Math.min(offset + batchDocs, documentIds.length)}/${documentIds.length} chunk_rows=${result.chunkRows} elapsed_s=${Math.round((performance.now() - started) / 1000)}`);
      }
      const indices = await table.listIndices();
      result.ftsPresent = hasChunkTextFtsIndex(indices);
      if (!skipFts && !dryRun && !result.ftsPresent) {
        const ftsStarted = performance.now();
        try {
          await withRetry(() => table.createIndex("text", { config: chunkTextFtsIndex(), replace: false }));
          result.ftsBuilt = true;
          log(`[backfill] fts index built in ${Math.round(performance.now() - ftsStarted)} ms`);
        } catch (error) {
          // Worker maintenance (LANCEDB_FTS_INDEX) built it concurrently.
          if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
          log("[backfill] fts index built concurrently by another writer");
        }
        result.ftsPresent = true;
      } else {
        log(`[backfill] fts index ${result.ftsPresent ? "present" : "skipped"}`);
      }
      if (!dryRun && !skipOptimize && (result.chunkRows > 0 || result.ftsBuilt)) {
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
        log(`[backfill] rows still without hydration (orphaned rows): ${result.rowsWithoutHydration}`);
      }
    } finally {
      table.close();
    }
  } finally {
    db.close();
  }
  return result;
}
