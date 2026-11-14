import {
  LANCEDB_SUMMARIES_TABLE,
  resolveLanceDbConfig,
  summaryRowIdSchema,
  summaryRowSchema,
  VectorNamespaceManager,
  type SummaryRow,
  type VectorLocation,
} from "@docslurp/shared";
import type { Sql } from "postgres";

import { deleteLanceDbDocumentRows, type DeleteVectorRows } from "../db/superseded-purge.js";
import type { VectorBackendRecord } from "./embedding-runtime.js";
import { connectLanceDb } from "./lancedb-connection.js";
import type { VectorScope } from "./lancedb-location.js";
import { lanceDbMaintenanceSettings, requireLanceDbMaintenance, scheduleLanceDbMaintenance } from "./lancedb-maintenance.js";
import { deleteLanceDbRecords, ensureLanceScalarIndex, writeLanceDbRecords, type LanceWriteRetryOptions } from "./lancedb-writer.js";

/**
 * Write and delete primitives for the summary tree's LanceDB table (`summaries`, @docslurp/shared summary-tree.ts).
 *
 * The table lives beside `chunks` in the project's own database, so it shares the project's tenant boundary, and
 * every path that removes a document's chunk rows also removes its summary rows (worker/src/db/superseded-purge.ts).
 * Deletes here are strict: the table is compacted and its older versions pruned in the same call, and a failure
 * rejects, because a plain Lance delete only hides rows whose text then stays in older versions.
 *
 * Nothing in this module builds a summary or calls a model.
 */

/**
 * The summaries table of one project and embedding space. Fails closed: without both ids there is no tenant boundary
 * to write inside.
 */
export function projectSummariesLocation(
  scope: VectorScope,
  space: { model: string; dimensions: number },
  root: string = resolveLanceDbConfig().root,
): VectorLocation {
  if (!scope.orgId?.trim() || !scope.projectId?.trim()) {
    throw new Error("Summary tree storage requires the document's orgId and projectId for tenant isolation");
  }
  return VectorNamespaceManager.getEmbeddingLocation(root, scope.orgId, scope.projectId, space.model, space.dimensions, LANCEDB_SUMMARIES_TABLE);
}

export class SummaryRowsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryRowsRefused";
  }
}

export type WriteSummaryRowsArgs = {
  sql: Sql<Record<string, unknown>>;
  scope: { orgId: string; projectId: string };
  space: { model: string; dimensions: number };
  /** Every row must belong to this document and run. */
  documentId: string;
  runId: string;
  rows: SummaryRow[];
  root?: string;
  signal?: AbortSignal;
  retry?: LanceWriteRetryOptions;
};

/**
 * Upserts one document's summary rows (keyed by row id; safe to replay).
 *
 * Refuses, before anything is written, unless:
 * - every row parses, belongs to `documentId` and `runId`, and its vector has the space's dimensions;
 * - the document is a live document of exactly this org and project (not purged, not superseded, not archived);
 * - the document is indexed in this embedding space (a `vector_indexes` row), which is where the purge paths look for
 *   its summary rows;
 * - the document has a tree state row naming this embedding space (`document_summary_trees`), which gates serving and
 *   is deleted with the document.
 *
 * So a summary row can only exist where a delete path will find it.
 */
export async function writeSummaryRows(args: WriteSummaryRowsArgs): Promise<VectorLocation> {
  const location = projectSummariesLocation(args.scope, args.space, args.root);
  args.signal?.throwIfAborted();
  const rows = args.rows.map((row) => summaryRowSchema.parse(row));
  for (const row of rows) {
    if (row.documentId !== args.documentId) throw new SummaryRowsRefused("A summary row names another document");
    if (row.runId !== args.runId) throw new SummaryRowsRefused("A summary row names another run");
    if (row.vector.length !== args.space.dimensions) throw new SummaryRowsRefused("A summary vector does not match the embedding space");
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new SummaryRowsRefused("Summary row ids must be unique");
  const [owner] = await args.sql<{ indexed: boolean; tracked: boolean }[]>`
    select
      exists (
        select 1 from vector_indexes vi
        where vi.document_id = d.id and vi.backend = 'lancedb'
          and vi.embedding_model = ${args.space.model} and vi.dimension = ${args.space.dimensions}
      ) as indexed,
      exists (
        select 1 from document_summary_trees t
        where t.document_id = d.id and t.org_id = d.org_id and t.project_id = d.project_id
          and t.embedding_model = ${args.space.model} and t.dimension = ${args.space.dimensions}
      ) as tracked
    from documents d
    where d.id = ${args.documentId} and d.org_id = ${args.scope.orgId} and d.project_id = ${args.scope.projectId}
      and d.purged_at is null and d.superseded_at is null and d.archived_at is null
  `;
  if (!owner) throw new SummaryRowsRefused("The document is not a live document of this project");
  if (!owner.indexed) throw new SummaryRowsRefused("The document is not indexed in this embedding space");
  if (!owner.tracked) throw new SummaryRowsRefused("The document has no summary tree state for this embedding space");
  if (rows.length === 0) return location;
  // The writer is typed for chunk records; it upserts any rows keyed by "id" into the named table.
  await writeLanceDbRecords(location.uri, location.table, rows as unknown as VectorBackendRecord[], args.signal, args.retry);
  await ensureSummariesDocumentIndex(location, args.retry);
  return location;
}

/** Tables this process has already seen with their `documentId` index: asked once per table, not once per write. */
const indexedSummariesTables = new Set<string>();

/**
 * The summaries table is only ever read and purged by `documentId` (`documentId IN (...)` is the tenant prefilter of
 * every search, summary-tree.ts in the server), so it carries a BTREE scalar index on that column from its first
 * write: created with the table, and added to a table an earlier release created without it the first time this
 * process writes to it. Maintenance ensures the same index (lancedb-maintenance.ts), which covers a table that is
 * never written again. The index is an optimization: a failure to build it is logged and retried on the next write,
 * and never fails the write that committed the rows.
 */
export async function ensureSummariesDocumentIndex(location: Pick<VectorLocation, "uri" | "table">, retry?: LanceWriteRetryOptions): Promise<boolean> {
  const key = `${location.uri}\u0000${location.table}`;
  if (indexedSummariesTables.has(key)) return false;
  try {
    const created = await ensureLanceScalarIndex(location.uri, location.table, "documentId", retry);
    indexedSummariesTables.add(key);
    return created;
  } catch (error) {
    console.warn(`[summary-tree] documentId index not built table=${location.table} error=${error instanceof Error ? error.name : "error"}`);
    return false;
  }
}

export function resetSummariesIndexMemoForTests(): void {
  indexedSummariesTables.clear();
}

/**
 * Deletes every summary row of the given documents from one project's summaries table, then compacts the table and
 * prunes its history; rejects unless both succeeded. Resolves "missing" when the project has no summaries table.
 */
export async function deleteDocumentSummaryRows(args: {
  scope: { orgId: string; projectId: string };
  space: { model: string; dimensions: number };
  documentIds: string[];
  root?: string;
  deleteVectorRows?: DeleteVectorRows;
}): Promise<void | "missing"> {
  const location = projectSummariesLocation(args.scope, args.space, args.root);
  return await (args.deleteVectorRows ?? deleteLanceDbDocumentRows)({
    uri: location.uri, table: location.table, documentIds: args.documentIds, purgeHistory: true,
  });
}

/**
 * Deletes summary rows by id (nodes replaced by a rebuild), then compacts the table and prunes its history; rejects
 * unless both succeeded. A missing table is nothing to delete.
 */
export async function deleteSummaryRowsById(args: {
  scope: { orgId: string; projectId: string };
  space: { model: string; dimensions: number };
  ids: string[];
  root?: string;
  retry?: LanceWriteRetryOptions;
}): Promise<void> {
  const location = projectSummariesLocation(args.scope, args.space, args.root);
  if (args.ids.length === 0) return;
  for (const id of args.ids) {
    if (!summaryRowIdSchema.safeParse(id).success) throw new SummaryRowsRefused("Unsafe summary row id");
  }
  const db = await connectLanceDb(location.uri);
  try {
    if (!(await db.tableNames()).includes(location.table)) return;
  } finally {
    db.close();
  }
  await deleteLanceDbRecords(location.uri, location.table, args.ids, args.retry);
  await requireLanceDbMaintenance(location.uri, location.table, {
    ...lanceDbMaintenanceSettings(resolveLanceDbConfig().params),
    versionRetentionMs: 0,
  });
}

/**
 * Hands one project's summaries table to the background maintenance pool (compaction of the small fragments a
 * tree build commits window by window, index refresh) without waiting. Never part of an erasure: deletes use the
 * strict calls above. Returns false when maintenance is disabled or the pool is closing.
 */
export function scheduleSummariesMaintenance(args: { scope: { orgId: string; projectId: string }; space: { model: string; dimensions: number }; root?: string }): boolean {
  const settings = lanceDbMaintenanceSettings(resolveLanceDbConfig().params);
  if (!settings.enabled) return false;
  const location = projectSummariesLocation(args.scope, args.space, args.root);
  return scheduleLanceDbMaintenance(location.uri, location.table, settings);
}
