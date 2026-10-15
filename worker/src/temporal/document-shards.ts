/**
 * Splits a run's documents into shards for one stage.
 *
 * Workflow-safe: pure and deterministic, no I/O and no Temporal imports.
 *
 * Shards are balanced by page count (longest-processing-time first: the
 * largest document goes to the lightest shard), so one long PDF does not
 * leave the other machines idle while its shard finishes. Shards come back
 * heaviest first, which is the order to dispatch them in.
 */

export interface DocumentShardPlanOptions {
  /** Fewest documents worth a shard of their own. */
  minDocsPerShard: number;
  /** Most shards; bounds workflow history and fleet demand. */
  maxShards: number;
  /** Fewest pages worth a shard (amortizes each shard's fixed overhead). */
  minPagesPerShard?: number;
}

/** Returns no shards when the run is too small to split (fewer than two shards). */
export function planDocumentShards(
  documentIds: readonly string[],
  documentPages: readonly number[] | undefined,
  options: DocumentShardPlanOptions,
): string[][] {
  const weight = (index: number) => {
    const pages = documentPages?.[index];
    return typeof pages === "number" && Number.isFinite(pages) && pages > 0 ? pages : 1;
  };
  const minDocs = Math.max(1, Math.floor(options.minDocsPerShard));
  const totalPages = documentIds.reduce((sum, _, index) => sum + weight(index), 0);
  const byPages = options.minPagesPerShard && options.minPagesPerShard > 0
    ? Math.floor(totalPages / options.minPagesPerShard)
    : Number.POSITIVE_INFINITY;
  const count = Math.min(Math.max(0, Math.floor(options.maxShards)), Math.floor(documentIds.length / minDocs), byPages);
  if (count < 2) return [];

  const order = documentIds.map((_, index) => index).sort((a, b) => weight(b) - weight(a) || a - b);
  const shards = Array.from({ length: count }, () => ({ ids: [] as string[], pages: 0 }));
  for (const index of order) {
    let target = shards[0]!;
    for (const shard of shards) {
      if (shard.pages < target.pages || (shard.pages === target.pages && shard.ids.length < target.ids.length)) target = shard;
    }
    target.ids.push(documentIds[index]!);
    target.pages += weight(index);
  }
  return shards
    .filter((shard) => shard.ids.length > 0)
    .sort((a, b) => b.pages - a.pages)
    .map((shard) => shard.ids);
}
