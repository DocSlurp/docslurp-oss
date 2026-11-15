/** Search effort for partitioned HNSW-SQ. Explicit refinement remains configurable. */
export function lanceDbQueryTuning(limit: number, documentCount: number, rawRefineFactor?: string, filtered = documentCount > 0): {
  ef: number;
  refineFactor: number;
  nprobes: number;
} {
  const raw = rawRefineFactor?.trim();
  const refineFactor = raw ? Number(raw) : 2;
  if (!Number.isSafeInteger(refineFactor) || refineFactor < 1 || refineFactor > 16) {
    throw new Error("LANCEDB_REFINE_FACTOR must be an integer between 1 and 16");
  }
  const scopedEf = documentCount > 0
    ? Math.ceil(Math.min(Math.max(limit * 10, documentCount * limit), 1_000) * 1.5)
    : Math.max(100, Math.ceil(limit * 1.5));
  // Narrow prefilters can hide their nearest rows outside the globally closest
  // partitions. Probe every partition for any document/page filter; leave the
  // scope predicate applied before candidate selection. Our build policy caps at 4096.
  return { ef: Math.max(scopedEf, limit * refineFactor), refineFactor, nprobes: filtered ? 4096 : 32 };
}
