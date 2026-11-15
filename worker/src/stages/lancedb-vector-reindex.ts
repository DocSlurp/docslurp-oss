import { VectorNamespaceManager } from "@docslurp/shared";
import type { Table } from "@lancedb/lancedb";
import { availableMemoryBytes } from "@docslurp/shared/lancedb-session";
import { vectorIndexConfig, vectorIndexPartitions } from "./lancedb-vector-index.js";

/** Explicit operator maintenance, never part of the upload/search request path.
 * replace=true commits a new index atomically; no table drop, optimize/prune,
 * extraction, re-embedding or row rewrite is performed here.
 */
export async function rebuildVectorIndex(table: Table, options: { apply: boolean; maxRows: number; memoryBytes?: number; dimensions?: number }) {
  if (!Number.isSafeInteger(options.maxRows) || options.maxRows < 1) throw new Error("maxRows must be a positive safe integer");
  const stats = await table.stats();
  const rows = await table.countRows();
  const field = (await table.schema()).fields.find((f) => f.name === "vector");
  const dimensions = (field?.type as { listSize?: number } | undefined)?.listSize;
  if (!dimensions || !Number.isSafeInteger(dimensions)) throw new Error("A fixed-size vector column is required");
  if (options.dimensions !== undefined && dimensions !== options.dimensions) throw new Error("Requested dimension does not match this index\'s vectors");
  if (rows < 1 || rows + (stats.numDeletedRows ?? 0) > options.maxRows) throw new Error("Vector reindex exceeds the explicit row budget");
  // Build buffers, centroid training and HNSW graph coexist. Conservative
  // envelope rather than the compressed index size; leave half RAM for the host.
  const estimatedBytes = Math.max(stats.totalBytes * 2, (rows + (stats.numDeletedRows ?? 0)) * dimensions * 4 * 6);
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > (options.memoryBytes ?? availableMemoryBytes()) / 2) throw new Error("Vector reindex exceeds the machine memory budget");
  const beforeVersion = await table.version();
  const plan = { rows, dimensions, partitions: vectorIndexPartitions(rows), estimatedBytes, beforeVersion };
  if (!options.apply) return { ...plan, applied: false };
  await table.createIndex("vector", { config: vectorIndexConfig(rows), replace: true });
  return { ...plan, applied: true, afterVersion: await table.version() };
}


export function vectorReindexLocation(root: string, input: { org: string; project: string; model: string; dimensions: number; uri?: string }) {
  const location = VectorNamespaceManager.getEmbeddingLocation(root, input.org, input.project, input.model, input.dimensions);
  const projectRoot = VectorNamespaceManager.getProjectRoot(root, input.org, input.project);
  if (input.uri && (!input.uri.startsWith(`${projectRoot}/`) || /[?#]/.test(input.uri) || decodeURIComponent(input.uri).split("/").some((p) => [".", ".."].includes(p)))) throw new Error("Reindex URI must stay in the explicit organization's project root");
  return { ...location, uri: input.uri ?? location.uri };
}
