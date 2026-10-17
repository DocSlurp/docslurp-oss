// Offline comparison only: do not treat fusion of retained outputs as a live run.
export function fuseEqualRankLists(lists, k = 60) {
  if (!Number.isFinite(k) || k < 0) throw new Error("Invalid RRF constant");
  const scores = new Map();
  const items = new Map();
  for (const list of lists) {
    const seen = new Set();
    list.forEach((result, rank) => {
      const citation = result.citation;
      if (!citation?.documentId || !Number.isInteger(citation.chunkIndex)) throw new Error("Missing chunk identity");
      const key = `${citation.documentId}:${citation.chunkIndex}`;
      if (seen.has(key)) throw new Error("Duplicate chunk within a ranked list");
      seen.add(key);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
      if (!items.has(key)) items.set(key, result);
    });
  }
  return [...scores].sort((a, b) => b[1] - a[1]).map(([key]) => items.get(key));
}
