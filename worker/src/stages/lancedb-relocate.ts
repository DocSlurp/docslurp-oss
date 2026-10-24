/**
 * One-off move of an org's vectors from the org-level LanceDB layouts
 * (lancedb-legacy-layout.ts) into per-workspace databases, without
 * re-embedding (CLI: lancedb-relocate-cli.ts):
 *
 *   1. route every row of the org's legacy tables by its documentId to the
 *      workspace(s) that read it: the document's own workspace, the workspace
 *      of each same-workspace dedup copy (copies read their source's rows),
 *      and, rebound to the copy's own chunk ids by chunk index, each copy in
 *      another workspace (those now own their rows);
 *   2. upsert the rows into `<root>/<org>/<workspace>/vectors-<model>-<dims>`
 *      (idempotent: keyed by chunk id, so a rerun converges);
 *   3. run maintenance on every written table (vector index, FTS, optimize);
 *   4. with `dropLegacy`, drop the legacy tables once every row was routed
 *      and written without an error.
 *
 * Rows whose document no longer exists (deleted or purged) are not moved; the
 * legacy drop removes them. Read-only on Postgres. Safe beside ingest: new
 * writes already go to workspace databases, and upserts commit like any
 * other writer (retrying conflicts).
 */
import { performance } from "node:perf_hooks";

import { resolveLanceDbConfig, type VectorLocation } from "@docslurp/shared";
import { decodeLanceChunkHydration, encodeLanceChunkHydration } from "@docslurp/shared/lancedb-hydration";
import type postgres from "postgres";

import { dropLanceDbTable } from "../db/superseded-purge.js";
import type { VectorBackendRecord } from "./embedding-runtime.js";
import { connectLanceDb } from "./lancedb-connection.js";
import { legacyEmbeddingLocations, legacyOrgTable } from "./lancedb-legacy-layout.js";
import { workspaceVectorLocation } from "./lancedb-location.js";
import { lanceDbMaintenanceSettings, runLanceDbMaintenance } from "./lancedb-maintenance.js";
import { writeLanceDbRecords } from "./lancedb-writer.js";

export interface LanceRelocateOptions {
  sql: postgres.Sql;
  orgId: string;
  dryRun?: boolean;
  /** Drop the legacy tables after a clean relocation. */
  dropLegacy?: boolean;
  /** Rows per read page and per write batch (default 2,000). */
  batchRows?: number;
  skipMaintenance?: boolean;
  log?: (line: string) => void;
  /** Test seams. */
  write?: (location: VectorLocation, records: VectorBackendRecord[]) => Promise<void>;
  drop?: (location: VectorLocation) => Promise<void>;
}

export interface LanceRelocateResult {
  orgId: string;
  /** Legacy tables that existed and were read. */
  sources: Array<VectorLocation & { rows: number }>;
  /** Rows written per workspace database. */
  written: Array<VectorLocation & { workspaceId: string; rows: number }>;
  /** Rows of documents that no longer exist (left for the legacy drop). */
  orphanRows: number;
  /** Rows of a cross-workspace copy's source without a matching chunk on the copy. */
  unmatchedCopyRows: number;
  droppedLegacy: VectorLocation[];
  errors: string[];
}

type IndexedDocument = {
  id: string;
  workspace_id: string;
  run_id: string;
  deduped_from_document_id: string | null;
  owner_workspace_id: string | null;
  embedding_model: string;
  dimension: number;
};

/** Where one source document's rows go: as-is into workspaces, rebound into copies. */
type Route = { workspaces: Set<string>; copies: Array<{ id: string; workspaceId: string; runId: string }> };

type LegacyRow = Record<string, unknown> & { id: string; documentId: string; vector: unknown };

const plain = (value: unknown): unknown =>
  value && typeof (value as { toJSON?: unknown }).toJSON === "function" ? (value as { toJSON: () => unknown }).toJSON() : value;

export async function relocateOrgVectors(options: LanceRelocateOptions): Promise<LanceRelocateResult> {
  const { sql, orgId, dryRun = false } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const batchRows = Math.max(1, Math.trunc(options.batchRows ?? 2_000));
  const write = options.write ?? ((location, records) => writeLanceDbRecords(location.uri, location.table, records));
  const drop = options.drop ?? dropLanceDbTable;
  const { root } = resolveLanceDbConfig();
  const result: LanceRelocateResult = { orgId, sources: [], written: [], orphanRows: 0, unmatchedCopyRows: 0, droppedLegacy: [], errors: [] };

  const documents = await sql<IndexedDocument[]>`
    select distinct d.id, d.workspace_id, d.run_id, d.deduped_from_document_id, owner.workspace_id as owner_workspace_id,
      v.embedding_model, v.dimension
    from documents d
    join vector_indexes v on v.document_id = d.id and v.backend = 'lancedb'
    left join documents owner on owner.id = d.deduped_from_document_id
    where d.org_id = ${orgId}
  `;
  const spaces = new Map<string, { model: string; dimensions: number; routes: Map<string, Route> }>();
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
      route(source).copies.push({ id: document.id, workspaceId: document.workspace_id, runId: document.run_id });
    }
  }

  const chunkIdCache = new Map<string, Map<number, string>>();
  const chunkIds = async (documentId: string) => {
    let ids = chunkIdCache.get(documentId);
    if (!ids) {
      const rows = await sql<{ chunk_index: number; id: string }[]>`select chunk_index, id from document_chunks where document_id = ${documentId}`;
      chunkIdCache.set(documentId, ids = new Map(rows.map((row) => [row.chunk_index, row.id])));
    }
    return ids;
  };

  const writtenRows = new Map<string, VectorLocation & { workspaceId: string; rows: number }>();
  const pending = new Map<string, { location: VectorLocation; workspaceId: string; records: VectorBackendRecord[] }>();
  const flush = async (key: string) => {
    const batch = pending.get(key);
    if (!batch || batch.records.length === 0) return;
    pending.delete(key);
    if (!dryRun) await write(batch.location, batch.records);
    const entry = writtenRows.get(key) ?? { ...batch.location, workspaceId: batch.workspaceId, rows: 0 };
    entry.rows += batch.records.length;
    writtenRows.set(key, entry);
  };
  const enqueue = async (workspaceId: string, space: { model: string; dimensions: number }, record: VectorBackendRecord) => {
    const location = workspaceVectorLocation({ orgId, workspaceId }, space, root);
    const key = `${location.uri}\u0000${location.table}`;
    let batch = pending.get(key);
    if (!batch) pending.set(key, batch = { location, workspaceId, records: [] });
    batch.records.push(record);
    if (batch.records.length >= batchRows) await flush(key);
  };

  const legacyRecord = (row: LegacyRow): VectorBackendRecord => {
    const metadata = (plain(row.metadata) ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      documentId: row.documentId,
      chunkIndex: typeof row.chunkIndex === "number" ? row.chunkIndex : (null as unknown as number),
      text: typeof row.text === "string" ? row.text : "",
      vector: Array.from(plain(row.vector) as ArrayLike<number>),
      metadata: { documentId: row.documentId, sourceKey: metadata.sourceKey, filename: metadata.filename },
      ...(typeof row.hydration === "string" ? {
        runId: (row.runId as string | null) ?? null,
        pageNumber: (row.pageNumber as number | null) ?? null,
        hydration: row.hydration,
      } : {}),
    } as VectorBackendRecord;
  };

  const rebind = (record: VectorBackendRecord, copy: { id: string; runId: string }, id: string): VectorBackendRecord => {
    const hydration = decodeLanceChunkHydration((record as { hydration?: unknown }).hydration);
    return {
      ...record,
      id,
      documentId: copy.id,
      metadata: { ...record.metadata, documentId: copy.id },
      ...(hydration ? {
        runId: copy.runId,
        hydration: encodeLanceChunkHydration({ ...hydration, runId: copy.runId, metadata: hydration.metadata ? { ...hydration.metadata, documentId: copy.id } : hydration.metadata }),
      } : {}),
    } as VectorBackendRecord;
  };

  const readSource = async (source: VectorLocation, accept: (row: LegacyRow) => boolean, routeRow: (row: LegacyRow) => Promise<void>) => {
    const db = await connectLanceDb(source.uri);
    try {
      if (!(await db.tableNames()).includes(source.table)) return;
      const table = await db.openTable(source.table);
      try {
        const total = await table.countRows();
        log(`[relocate] org=${orgId} source=${source.uri}#${source.table} rows=${total}`);
        let read = 0;
        const started = performance.now();
        for (let offset = 0; offset < total; offset += batchRows) {
          const rows = await table.query().limit(batchRows).offset(offset).toArray() as LegacyRow[];
          for (const row of rows) if (accept(row)) await routeRow(row);
          read += rows.length;
          if (rows.length < batchRows) break;
        }
        result.sources.push({ ...source, rows: read });
        log(`[relocate] org=${orgId} source=${source.uri}#${source.table} read=${read} elapsed_s=${Math.round((performance.now() - started) / 1000)}`);
      } finally {
        table.close();
      }
    } finally {
      db.close();
    }
  };

  const routeInto = (space: { model: string; dimensions: number; routes: Map<string, Route> }) => async (row: LegacyRow) => {
    const route = space.routes.get(row.documentId);
    if (!route) {
      result.orphanRows += 1;
      return;
    }
    const record = legacyRecord(row);
    for (const workspaceId of route.workspaces) await enqueue(workspaceId, space, record);
    for (const copy of route.copies) {
      const id = record.chunkIndex === null ? undefined : (await chunkIds(copy.id)).get(record.chunkIndex);
      if (!id) {
        result.unmatchedCopyRows += 1;
        continue;
      }
      await enqueue(copy.workspaceId, space, rebind(record, copy, id));
    }
  };

  try {
    for (const space of spaces.values()) {
      for (const source of legacyEmbeddingLocations(root, orgId, space.model, space.dimensions)) {
        await readSource(source, () => true, routeInto(space));
      }
    }
    // The org-wide table predates embedding spaces: route each row by its document's space and dimensions.
    const orgTable = legacyOrgTable(root, orgId);
    const byDimension = [...spaces.values()];
    await readSource(orgTable, () => true, async (row) => {
      const length = (plain(row.vector) as ArrayLike<number>).length;
      const space = byDimension.find((candidate) => candidate.dimensions === length && candidate.routes.has(row.documentId));
      if (!space) {
        result.orphanRows += 1;
        return;
      }
      await routeInto(space)(row);
    });
    for (const key of [...pending.keys()]) await flush(key);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  result.written = [...writtenRows.values()];

  if (!dryRun && !options.skipMaintenance && result.errors.length === 0) {
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
  log(`[relocate] org=${orgId} sources=${result.sources.length} written=${result.written.reduce((sum, entry) => sum + entry.rows, 0)}`
    + ` workspaces=${new Set(result.written.map((entry) => entry.workspaceId)).size} orphan_rows=${result.orphanRows}`
    + ` unmatched_copy_rows=${result.unmatchedCopyRows} dropped=${result.droppedLegacy.length} errors=${result.errors.length}${dryRun ? " (dry run)" : ""}`);
  return result;
}

/** Every org with LanceDB-indexed documents, one at a time. */
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
