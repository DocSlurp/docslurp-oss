/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Fuse multiple ranked result lists into a single ranking.
 * Standard RRF formula: score = sum(1 / (k + rank)) where k=60
 */

export function reciprocalRankFusion<T extends { id: string }>(
  lists: T[][],
  k = 60
): T[] {
  const scores = new Map<string, number>();
  const items = new Map<string, T>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const prev = scores.get(item.id) ?? 0;
      scores.set(item.id, prev + 1 / (k + rank + 1));
      if (!items.has(item.id)) {
        items.set(item.id, item);
      }
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => items.get(id)!);
}

/** Like `reciprocalRankFusion`, but returns each fused item with its RRF score. */
export function reciprocalRankFusionScored<T extends { id: string }>(
  lists: T[][],
  k = 60
): Array<{ item: T; score: number }> {
  const scores = new Map<string, number>();
  const items = new Map<string, T>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank]!;
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1));
      if (!items.has(item.id)) items.set(item.id, item);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ item: items.get(id)!, score }));
}
