/**
 * Maximum Marginal Relevance (MMR)
 *
 * Select diverse results that are relevant to the query
 * but not redundant with each other.
 */

export interface VectorizedChunk {
  id: string;
  text: string;
  score: number;
  vector?: number[];
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * MMR selection: pick top-K results balancing relevance and diversity.
 *
 * @param candidates - Candidate chunks with scores and optional vectors
 * @param topK - Number of results to return
 * @param lambda - 0=max diversity, 1=max relevance, default 0.5
 */
export function mmrSelect(
  candidates: VectorizedChunk[],
  topK: number,
  lambda = 0.5
): VectorizedChunk[] {
  if (candidates.length === 0) return [];
  if (topK >= candidates.length) return [...candidates];

  const hasVectors = candidates.every((c) => c.vector && c.vector.length > 0);

  if (!hasVectors) {
    // Without similarity evidence, preserve relevance. Rank parity is not
    // diversity and can discard the second-best supporting passage.
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    return sorted.slice(0, topK);
  }

  const selected: VectorizedChunk[] = [];
  const remaining = new Set(candidates.map((_, i) => i));

  // Start with the highest-relevance candidate
  let bestIdx = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const i of remaining) {
    if (candidates[i].score > bestScore) {
      bestScore = candidates[i].score;
      bestIdx = i;
    }
  }
  selected.push(candidates[bestIdx]);
  remaining.delete(bestIdx);

  // Iteratively pick the next candidate that maximizes MMR
  while (selected.length < topK && remaining.size > 0) {
    let nextIdx = -1;
    let nextMmr = Number.NEGATIVE_INFINITY;

    for (const i of remaining) {
      const relevance = candidates[i].score;

      // Max similarity to any already-selected item
      let maxSim = Number.NEGATIVE_INFINITY;
      for (const sel of selected) {
        const sim = cosineSimilarity(candidates[i].vector!, sel.vector!);
        if (sim > maxSim) maxSim = sim;
      }

      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > nextMmr) {
        nextMmr = mmr;
        nextIdx = i;
      }
    }

    if (nextIdx === -1) break;
    selected.push(candidates[nextIdx]);
    remaining.delete(nextIdx);
  }

  return selected;
}
