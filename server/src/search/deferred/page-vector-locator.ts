import { hammingTopK, int8Rescore, packSignBits } from "@docslurp/shared";

import { sql } from "../../db.js";

/**
 * Visual Pages locator: first-stage Hamming top-200 over packed sign bits,
 * then int8 cosine rescore. A workspace+model matrix is loaded once and kept
 * in an in-process LRU bounded by bytes; it is revalidated against
 * `max(created_at)`/`count(*)` at most once per TTL (and dropped explicitly
 * when materialization lands new pages), so a warm query runs no SQL.
 */

export const HAMMING_CANDIDATES = 200;

interface Matrix {
  stamp: string;
  checkedAt: number;
  dims: number;
  bytesPerVector: number;
  bits: Uint8Array;
  int8: Int8Array;
  scales: Float32Array;
  docIds: string[];
  /** Per-row document index and page number. */
  rowDoc: Uint32Array;
  rowPage: Int32Array;
  /** Row range [start, end) per document id (rows are ordered by document). */
  ranges: Map<string, [number, number]>;
  bytes: number;
}

const cache = new Map<string, Matrix>();
let cachedBytes = 0;

function maxCacheBytes(): number {
  const mb = Number.parseInt(process.env.DOCSLURP_PAGE_VECTOR_CACHE_MB ?? "", 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : 256) * 1024 * 1024;
}

function ttlMs(): number {
  const value = Number.parseInt(process.env.DOCSLURP_PAGE_VECTOR_CACHE_TTL_MS ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : 5000;
}

export function clearPageVectorCache(workspaceId?: string): void {
  for (const [key, matrix] of [...cache]) {
    if (workspaceId === undefined || key.startsWith(`${workspaceId}\u0000`)) {
      cachedBytes -= matrix.bytes;
      cache.delete(key);
    }
  }
}

function remember(key: string, matrix: Matrix): void {
  const previous = cache.get(key);
  if (previous) cachedBytes -= previous.bytes;
  cache.delete(key);
  cache.set(key, matrix);
  cachedBytes += matrix.bytes;
  const limit = maxCacheBytes();
  for (const [oldKey, old] of cache) {
    if (cachedBytes <= limit || oldKey === key) break;
    cachedBytes -= old.bytes;
    cache.delete(oldKey);
  }
}

type VectorRow = { document_id: string; page_number: number; dims: number; bits: Uint8Array; int8: Uint8Array; scale: number };

async function loadMatrix(workspaceId: string, model: string, stamp: string): Promise<Matrix | null> {
  const rows = await sql<VectorRow[]>`
    select document_id, page_number, dims, bits, int8, scale
    from document_page_vectors
    where workspace_id = ${workspaceId} and model = ${model}
    order by document_id, page_number
  `;
  const dims = rows[0]?.dims;
  if (!dims) return null;
  const usable = rows.filter((row) => row.dims === dims);
  const bytesPerVector = Math.ceil(dims / 8);
  const bits = new Uint8Array(usable.length * bytesPerVector);
  const int8 = new Int8Array(usable.length * dims);
  const scales = new Float32Array(usable.length);
  const rowDoc = new Uint32Array(usable.length);
  const rowPage = new Int32Array(usable.length);
  const docIds: string[] = [];
  const ranges = new Map<string, [number, number]>();
  usable.forEach((row, index) => {
    bits.set(row.bits.subarray(0, bytesPerVector), index * bytesPerVector);
    int8.set(new Int8Array(row.int8.buffer, row.int8.byteOffset, Math.min(row.int8.byteLength, dims)), index * dims);
    scales[index] = row.scale;
    rowPage[index] = row.page_number;
    let range = ranges.get(row.document_id);
    if (!range) {
      range = [index, index];
      ranges.set(row.document_id, range);
      docIds.push(row.document_id);
    }
    range[1] = index + 1;
    rowDoc[index] = docIds.length - 1;
  });
  return {
    stamp, checkedAt: Date.now(), dims, bytesPerVector, bits, int8, scales, docIds, rowDoc, rowPage, ranges,
    bytes: bits.byteLength + int8.byteLength + scales.byteLength + rowDoc.byteLength + rowPage.byteLength,
  };
}

const inflight = new Map<string, Promise<Matrix | null>>();

async function matrixFor(workspaceId: string, model: string): Promise<Matrix | null> {
  const key = `${workspaceId}\u0000${model}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.checkedAt < ttlMs()) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const [stampRow] = await sql<{ stamp: string | null }[]>`
    select (max(created_at)::text || ':' || count(*)::text) as stamp
    from document_page_vectors
    where workspace_id = ${workspaceId} and model = ${model}
  `;
  const stamp = stampRow?.stamp ?? "";
  if (!stamp) {
    clearPageVectorCache(workspaceId);
    return null;
  }
  if (hit && hit.stamp === stamp) {
    hit.checkedAt = Date.now();
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  // Concurrent queries share one load instead of each reading the table.
  const flightKey = `${key}\u0000${stamp}`;
  let flight = inflight.get(flightKey);
  if (!flight) {
    flight = loadMatrix(workspaceId, model, stamp)
      .then((matrix) => {
        // A matrix bigger than the whole budget would evict everything: serve it uncached.
        if (matrix && matrix.bytes <= maxCacheBytes()) remember(key, matrix);
        return matrix;
      })
      .finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, flight);
  }
  return flight;
}

/** Models that have stored page vectors in the workspace, most pages first. */
export async function listPageVectorModels(workspaceId: string, documentIds?: string[]): Promise<string[]> {
  const rows = documentIds && documentIds.length > 0
    ? await sql<{ model: string }[]>`
        select model from document_page_vectors
        where workspace_id = ${workspaceId} and document_id = any(${sql.array(documentIds, 25)})
        group by model order by count(*) desc`
    : await sql<{ model: string }[]>`
        select model from document_page_vectors where workspace_id = ${workspaceId}
        group by model order by count(*) desc`;
  return rows.map((row) => row.model);
}

export async function locatePageImageCandidates(args: {
  workspaceId: string;
  documentIds: string[];
  model: string;
  queryVector: Float32Array;
  k: number;
}): Promise<Array<{ documentId: string; page: number; score: number }>> {
  const matrix = await matrixFor(args.workspaceId, args.model);
  if (!matrix || args.queryVector.length !== matrix.dims || args.k <= 0) return [];
  const query = packSignBits(args.queryVector);

  const scoped = args.documentIds.length > 0 ? args.documentIds.filter((id) => matrix.ranges.has(id)) : [];
  const useWhole = args.documentIds.length === 0 || scoped.length === matrix.ranges.size;
  let candidates: Array<{ index: number; distance: number }>;
  if (useWhole) {
    candidates = hammingTopK(query, matrix.bits, matrix.bytesPerVector, HAMMING_CANDIDATES);
  } else {
    candidates = [];
    for (const id of scoped) {
      const [start, end] = matrix.ranges.get(id)!;
      const slice = matrix.bits.subarray(start * matrix.bytesPerVector, end * matrix.bytesPerVector);
      for (const hit of hammingTopK(query, slice, matrix.bytesPerVector, HAMMING_CANDIDATES)) {
        candidates.push({ index: hit.index + start, distance: hit.distance });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
    candidates = candidates.slice(0, HAMMING_CANDIDATES);
  }
  return int8Rescore(args.queryVector, candidates, matrix.int8, matrix.scales, matrix.dims)
    .slice(0, args.k)
    .map(({ index, score }) => ({
      documentId: matrix.docIds[matrix.rowDoc[index]!]!,
      page: matrix.rowPage[index]!,
      score,
    }));
}
