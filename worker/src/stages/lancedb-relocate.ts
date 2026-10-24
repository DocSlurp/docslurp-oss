/**
 * One-off move of an org's vectors from the org-level LanceDB layouts
 * (lancedb-legacy-layout.ts) into per-workspace databases, without
 * re-embedding (CLI: lancedb-relocate-cli.ts):
 *
 *   1. stream every legacy table of the org, newest layout first, and route
 *      each row by its documentId to the workspace(s) that read it: the
 *      document's own workspace, the workspace of each same-workspace dedup
 *      copy (copies read their source's rows), and, rebound to the copy's own
 *      chunk ids by chunk index, each copy in another workspace (those now own
 *      their rows);
 *   2. keep only rows whose chunk still exists in `document_chunks` (a stale
 *      row from before a reprocess or correction would otherwise come back as
 *      a ghost citation), with the chunk index taken from Postgres;
 *   3. append them to `<root>/<org>/<workspace>/vectors-<model>-<dims>`, never
 *      replacing a row already there: the first copy of an id wins, whether
 *      the worker wrote it since the upgrade or a newer legacy layout held it.
 *      Reruns therefore converge and never clobber newer vectors;
 *   4. before each append, drop rows of documents deleted meanwhile;
 *   5. run maintenance on every written table (vector index, FTS, optimize);
 *   6. with `dropLegacy`, drop the legacy tables once every row of every
 *      source was read (count verified) and the run had no error.
 *
 * Rows of documents that no longer exist are not moved; the legacy drop
 * removes them. Read-only on Postgres. Run it with ingest stopped or drained
 * (see the operations guide): a worker writing the same chunk id between the
 * existing-id read and the append would leave a duplicate row.
 */
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { resolveLanceDbConfig, type VectorLocation } from "@docslurp/shared";
import { decodeLanceChunkHydration, encodeLanceChunkHydration } from "@docslurp/shared/lancedb-hydration";
import type postgres from "postgres";

import { dropLanceDbTable } from "../db/superseded-purge.js";
import type { VectorBackendRecord } from "./embedding-runtime.js";
import { connectLanceDb } from "./lancedb-connection.js";
import { legacyEmbeddingLocations, legacyOrgTable } from "./lancedb-legacy-layout.js";
import { workspaceVectorLocation } from "./lancedb-location.js";
import { lanceDbMaintenanceSettings, runLanceDbMaintenance } from "./lancedb-maintenance.js";
import { isRetryableLanceCommitError, withUniformHydrationColumns } from "./lancedb-writer.js";

export interface LanceRelocateOptions {
  sql: postgres.Sql;
  orgId: string;
  dryRun?: boolean;
  /** Drop the legacy tables after a clean relocation. */
  dropLegacy?: boolean;
  /** Rows per append (default 2,000). */
  batchRows?: number;
  /** Rows buffered across all destinations before the largest buffer is flushed (default 20,000). */
  maxPendingRows?: number;
  skipMaintenance?: boolean;
  log?: (line: string) => void;
  /** Test seams. */
  existingIds?: (location: VectorLocation) => Promise<Set<string>>;
  append?: (location: VectorLocation, records: VectorBackendRecord[]) => Promise<void>;
  drop?: (location: VectorLocation) => Promise<void>;
}

export interface LanceRelocateResult {
  orgId: string;
  /** Legacy tables that existed, with the rows counted and read. */
  sources: Array<VectorLocation & { rows: number; read: number }>;
  /** Rows appended per workspace database. */
  written: Array<VectorLocation & { workspaceId: string; rows: number }>;
  /** Rows already present in the destination (written since the upgrade, a newer layout, or a rerun). */
  skippedExisting: number;
  /** Rows of documents that no longer exist (left for the legacy drop). */
  orphanRows: number;
  /** Rows whose chunk no longer exists (replaced by a reprocess or correction). */
  staleRows: number;
  /** Rows of a cross-workspace copy's source without a matching chunk on the copy. */
  unmatchedCopyRows: number;
  droppedLegacy: VectorLocation[];
  errors: string[];
}

type IndexedDocument = {
  id: string;
  workspace_id: string;
  run_id: string;
  source_key: string | null;
  filename: string | null;
  deduped_from_document_id: string | null;
  owner_workspace_id: string | null;
  embedding_model: string;
  dimension: number;
};

type Copy = { id: string; workspaceId: string; runId: string; sourceKey: string | null; filename: string | null };

/** Where one source document's rows go: as-is into workspaces, rebound into copies elsewhere. */
type Route = { workspaces: Set<string>; copies: Copy[] };

type Space = { model: string; dimensions: number; routes: Map<string, Route> };

type LegacyRow = Record<string, unknown> & { id: string; documentId: string; vector: unknown };

/** A document's chunks: id -> index, and index -> id. */
type Chunks = { byId: Map<string, number>; byIndex: Map<number, string> };

const plain = (value: unknown): unknown =>
  value && typeof (value as { toJSON?: unknown }).toJSON === "function" ? (value as { toJSON: () => unknown }).toJSON() : value;

async function readExistingIds(location: VectorLocation): Promise<Set<string>> {
  const db = await connectLanceDb(location.uri);
  try {
    if (!(await db.tableNames()).includes(location.table)) return new Set();
    const table = await db.openTable(location.table);
    try {
      const ids = new Set<string>();
      for await (const batch of table.query().select(["id"])) {
        for (const row of batch.toArray() as unknown as Array<{ id: string }>) ids.add(row.id);
      }
      return ids;
    } finally {
      table.close();
    }
  } finally {
    db.close();
  }
}

/** Appends rows (never replaces): the caller has removed ids the table already holds. */
async function appendRows(location: VectorLocation, records: VectorBackendRecord[]): Promise<void> {
  const rows = withUniformHydrationColumns(records) as unknown as Array<Record<string, unknown>>;
  const db = await connectLanceDb(location.uri);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (!(await db.tableNames()).includes(location.table)) {
          (await db.createTable(location.table, rows)).close();
          return;
        }
        const table = await db.openTable(location.table);
        try {
          await table.add(rows);
        } finally {
          table.close();
        }
        return;
      } catch (error) {
        const creationRace = /already exists|was not found/i.test(error instanceof Error ? error.message : String(error));
        if (attempt >= 8 || (!creationRace && !isRetryableLanceCommitError(error))) throw error;
        await delay(Math.min(15_000, 200 * 2 ** attempt));
      }
    }
  } finally {
    db.close();
  }
}

export async function relocateOrgVectors(options: LanceRelocateOptions): Promise<LanceRelocateResult> {
  const { sql, orgId, dryRun = false } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const batchRows = Math.max(1, Math.trunc(options.batchRows ?? 2_000));
  const maxPendingRows = Math.max(batchRows, Math.trunc(options.maxPendingRows ?? 20_000));
  const existingIds = options.existingIds ?? readExistingIds;
  const append = options.append ?? appendRows;
  const drop = options.drop ?? dropLanceDbTable;
  const { root } = resolveLanceDbConfig();
  const result: LanceRelocateResult = {
    orgId, sources: [], written: [], skippedExisting: 0, orphanRows: 0, staleRows: 0, unmatchedCopyRows: 0, droppedLegacy: [], errors: [],
  };

  try {
    const documents = await sql<IndexedDocument[]>`
      select distinct d.id, d.workspace_id, d.run_id, d.source_key, d.filename, d.deduped_from_document_id,
        owner.workspace_id as owner_workspace_id, v.embedding_model, v.dimension
      from documents d
      join vector_indexes v on v.document_id = d.id and v.backend = 'lancedb'
      left join documents owner on owner.id = d.deduped_from_document_id
      where d.org_id = ${orgId}
    `;
    const spaces = new Map<string, Space>();
    for (const document of documents) {
      const key = `${document.embedding_model}\u0000${document.dimension}`;
      let space = spaces.get(key);
      if (!space) spaces.set(key, space = { model: document.embedding_model, dimensions: document.dimension, routes: new Map() });
      const route = (id: string) => {
        let entry = space!.routes.get(id);
        if (!entry) space!.routes.set(id, entry = { workspaces: new Set(), copies: [] });
        return entry;
      };
      // The document's own rows, and a same-workspace copy's view of its source's rows.
      route(document.id).workspaces.add(document.workspace_id);
      const source = document.deduped_from_document_id;
      if (source && (document.owner_workspace_id ?? document.workspace_id) === document.workspace_id) {
        route(source).workspaces.add(document.workspace_id);
      } else if (source) {
        route(source).copies.push({
          id: document.id, workspaceId: document.workspace_id, runId: document.run_id,
          sourceKey: document.source_key, filename: document.filename,
        });
      }
    }

    // Current chunks per document, loaded once (a row whose chunk is gone is stale).
    const chunkCache = new Map<string, Chunks>();
    const chunks = async (documentId: string): Promise<Chunks> => {
      let entry = chunkCache.get(documentId);
      if (!entry) {
        const rows = await sql<{ chunk_index: number; id: string }[]>`select chunk_index, id from document_chunks where document_id = ${documentId}`;
        chunkCache.set(documentId, entry = { byId: new Map(rows.map((row) => [row.id, row.chunk_index])), byIndex: new Map(rows.map((row) => [row.chunk_index, row.id])) });
      }
      return entry;
    };

    type Destination = { location: VectorLocation; workspaceId: string; seen: Set<string>; pending: VectorBackendRecord[]; rows: number };
    const destinations = new Map<string, Destination>();
    let pendingRows = 0;
    const destination = async (workspaceId: string, space: Space): Promise<Destination> => {
      const location = workspaceVectorLocation({ orgId, workspaceId }, { model: space.model, dimensions: space.dimensions }, root);
      const key = `${location.uri}\u0000${location.table}`;
      let entry = destinations.get(key);
      if (!entry) destinations.set(key, entry = { location, workspaceId, seen: await existingIds(location), pending: [], rows: 0 });
      return entry;
    };
    const flush = async (entry: Destination) => {
      if (entry.pending.length === 0) return;
      const records = entry.pending;
      entry.pending = [];
      pendingRows -= records.length;
      // Documents deleted while the run was going must not come back.
      const live = new Set((await sql<{ id: string }[]>`
        select id from documents where id = any(${sql.array([...new Set(records.map((record) => record.documentId))])})
      `).map((row) => row.id));
      const kept = records.filter((record) => live.has(record.documentId));
      result.orphanRows += records.length - kept.length;
      for (let index = 0; index < kept.length; index += batchRows) {
        const batch = kept.slice(index, index + batchRows);
        if (!dryRun) await append(entry.location, batch);
        entry.rows += batch.length;
      }
    };
    const enqueue = async (entry: Destination, record: VectorBackendRecord) => {
      if (entry.seen.has(record.id)) {
        result.skippedExisting += 1;
        return;
      }
      entry.seen.add(record.id);
      entry.pending.push(record);
      pendingRows += 1;
      if (entry.pending.length >= batchRows) await flush(entry);
      if (pendingRows >= maxPendingRows) {
        const largest = [...destinations.values()].reduce((a, b) => (b.pending.length > a.pending.length ? b : a));
        await flush(largest);
      }
    };

    const record = (row: LegacyRow, documentId: string, id: string, chunkIndex: number, copy?: Copy): VectorBackendRecord => {
      const metadata = (plain(row.metadata) ?? {}) as Record<string, unknown>;
      const hydration = decodeLanceChunkHydration(row.hydration);
      const runId = copy?.runId ?? hydration?.runId ?? null;
      return {
        id,
        documentId,
        chunkIndex,
        text: typeof row.text === "string" ? row.text : "",
        vector: Array.from(plain(row.vector) as ArrayLike<number>),
        metadata: copy
          ? { documentId, sourceKey: copy.sourceKey, filename: copy.filename }
          : { documentId, sourceKey: metadata.sourceKey, filename: metadata.filename },
        ...(hydration && runId ? {
          runId,
          pageNumber: (row.pageNumber as number | null | undefined) ?? hydration.pageNumber ?? null,
          hydration: encodeLanceChunkHydration({
            ...hydration,
            runId,
            metadata: copy && hydration.metadata ? { ...hydration.metadata, documentId } : hydration.metadata,
          }),
        } : {}),
      } as VectorBackendRecord;
    };

    const routeRow = async (space: Space, row: LegacyRow) => {
      const route = space.routes.get(row.documentId);
      if (!route) {
        result.orphanRows += 1;
        return;
      }
      const owner = await chunks(row.documentId);
      const chunkIndex = owner.byId.get(row.id);
      if (chunkIndex === undefined) {
        result.staleRows += 1;
        return;
      }
      for (const workspaceId of route.workspaces) {
        await enqueue(await destination(workspaceId, space), record(row, row.documentId, row.id, chunkIndex));
      }
      for (const copy of route.copies) {
        const id = (await chunks(copy.id)).byIndex.get(chunkIndex);
        if (!id) {
          result.unmatchedCopyRows += 1;
          continue;
        }
        await enqueue(await destination(copy.workspaceId, space), record(row, copy.id, id, chunkIndex, copy));
      }
    };

    const readSource = async (source: VectorLocation, routeTo: (row: LegacyRow) => Promise<void>) => {
      const db = await connectLanceDb(source.uri);
      try {
        if (!(await db.tableNames()).includes(source.table)) return;
        const table = await db.openTable(source.table);
        try {
          const total = await table.countRows();
          const entry = { ...source, rows: total, read: 0 };
          result.sources.push(entry);
          log(`[relocate] org=${orgId} source=${source.uri}#${source.table} rows=${total}`);
          const started = performance.now();
          for await (const batch of table.query()) {
            for (const row of batch.toArray() as unknown as LegacyRow[]) {
              entry.read += 1;
              await routeTo(row);
            }
          }
          if (entry.read !== total) throw new Error(`read ${entry.read} of ${total} rows from ${source.uri}#${source.table}`);
          log(`[relocate] org=${orgId} source=${source.uri}#${source.table} read=${entry.read} elapsed_s=${Math.round((performance.now() - started) / 1000)}`);
        } finally {
          table.close();
        }
      } finally {
        db.close();
      }
    };

    // Newest layout first: a row's first copy wins in the destination.
    for (const space of spaces.values()) {
      for (const source of legacyEmbeddingLocations(root, orgId, space.model, space.dimensions)) {
        await readSource(source, (row) => routeRow(space, row));
      }
    }
    // The org-wide table predates embedding spaces: route each row by its document and dimensions.
    const bySpace = [...spaces.values()];
    await readSource(legacyOrgTable(root, orgId), async (row) => {
      const length = (plain(row.vector) as ArrayLike<number>).length;
      const space = bySpace.find((candidate) => candidate.dimensions === length && candidate.routes.has(row.documentId));
      if (!space) {
        result.orphanRows += 1;
        return;
      }
      await routeRow(space, row);
    });
    for (const entry of destinations.values()) await flush(entry);
    result.written = [...destinations.values()].filter((entry) => entry.rows > 0)
      .map((entry) => ({ ...entry.location, workspaceId: entry.workspaceId, rows: entry.rows }));

    if (!dryRun && !options.skipMaintenance) {
      const maintenance = lanceDbMaintenanceSettings(resolveLanceDbConfig().params);
      for (const target of result.written) {
        const outcome = await runLanceDbMaintenance(target.uri, target.table, maintenance);
        if (!outcome.ok) result.errors.push(`maintenance ${target.uri}: ${outcome.error ?? "failed"}`);
      }
    }

    if (options.dropLegacy && !dryRun && result.errors.length === 0) {
      for (const source of result.sources) {
        await drop(source);
        result.droppedLegacy.push({ uri: source.uri, table: source.table });
      }
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  log(`[relocate] org=${orgId} sources=${result.sources.length} written=${result.written.reduce((sum, entry) => sum + entry.rows, 0)}`
    + ` workspaces=${new Set(result.written.map((entry) => entry.workspaceId)).size} skipped_existing=${result.skippedExisting}`
    + ` orphan_rows=${result.orphanRows} stale_rows=${result.staleRows} unmatched_copy_rows=${result.unmatchedCopyRows}`
    + ` dropped=${result.droppedLegacy.length} errors=${result.errors.length}${dryRun ? " (dry run)" : ""}`);
  return result;
}

/** Every org with LanceDB-indexed documents, one at a time; one org's failure does not stop the rest. */
export async function relocateAllOrgVectors(options: Omit<LanceRelocateOptions, "orgId">): Promise<LanceRelocateResult[]> {
  const orgs = await options.sql<{ org_id: string }[]>`
    select distinct d.org_id from documents d
    join vector_indexes v on v.document_id = d.id and v.backend = 'lancedb'
    where d.org_id is not null order by 1
  `;
  const results: LanceRelocateResult[] = [];
  for (const org of orgs) results.push(await relocateOrgVectors({ ...options, orgId: org.org_id }));
  return results;
}
