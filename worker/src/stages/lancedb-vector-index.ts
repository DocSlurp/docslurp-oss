import { Index } from "@lancedb/lancedb";

/** A bounded number of HNSW graphs avoids reading one monolithic graph on
 * the first query. Power-of-two buckets avoid rebuilding for every row added.
 * Set LANCEDB_VECTOR_PARTITION_ROWS=0 to retain the former million-row policy.
 */
export function vectorIndexPartitions(rows: number, env: Record<string, string | undefined> = process.env): number {
  if (!Number.isSafeInteger(rows) || rows < 1) throw new Error("Vector index rows must be a positive safe integer");
  const raw = env.LANCEDB_VECTOR_PARTITION_ROWS?.trim();
  const target = raw ? Number(raw) : 1_000;
  if (!Number.isSafeInteger(target) || target < 0) throw new Error("LANCEDB_VECTOR_PARTITION_ROWS must be a nonnegative integer");
  if (target === 0) return Math.max(1, Math.ceil(rows / 1_000_000));
  // IVF training needs enough vectors per centroid. Never grow past 4096 graphs.
  const wanted = 2 ** Math.ceil(Math.log2(Math.max(1, rows / target)));
  return Math.min(4096, wanted, Math.max(1, 2 ** Math.floor(Math.log2(Math.max(1, rows / 256)))));
}

export function vectorIndexConfig(rows: number): Index {
  // Keep L2 and scalar quantization unchanged; only the routing granularity changes.
  return Index.hnswSq({ distanceType: "l2", numPartitions: vectorIndexPartitions(rows) });
}
