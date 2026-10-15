/**
 * Lost-in-the-middle mitigation.
 *
 * Reorder chunks so highest-scoring appear first and last (not in the middle).
 * Classic position for 5 items: [rank1, rank3, rank5, rank4, rank2]
 */
export function lostInTheMiddleReorder<T extends { score: number }>(
  chunks: T[]
): T[] {
  if (chunks.length <= 2) return [...chunks];

  const sorted = [...chunks].sort((a, b) => b.score - a.score);
  const result: T[] = new Array(sorted.length);

  // Place odd-indexed items (0, 2, 4, ...) at the front
  // Place even-indexed items (1, 3, 5, ...) at the back in reverse
  let left = 0;
  let right = sorted.length - 1;

  for (let i = 0; i < sorted.length; i++) {
    if (i % 2 === 0) {
      result[left++] = sorted[i];
    } else {
      result[right--] = sorted[i];
    }
  }

  return result;
}
