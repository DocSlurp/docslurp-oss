/**
 * Maximum Marginal Relevance (MMR)
 *
 * Select diverse results that are relevant to the query
 * but not redundant with each other.
 *
 * Carbonell & Goldstein (1998) define MMR over any passage similarity. Embedding
 * cosine is used when every candidate carries a vector; otherwise passages are
 * compared as term-frequency vectors (the paper's own measure), which needs no
 * extra storage read and works for keyword-only hits.
 */

export interface VectorizedChunk {
  id: string;
  text: string;
  score: number;
  vector?: number[];
}

export type MmrSimilarity = "embedding" | "lexical";

export interface MmrSelection {
  selected: VectorizedChunk[];
  similarity: MmrSimilarity;
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

function termVector(text: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const term of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    terms.set(term, (terms.get(term) ?? 0) + 1);
  }
  return terms;
}

function termCosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, count] of small) dot += count * (large.get(term) ?? 0);
  if (dot === 0) return 0;
  let normA = 0;
  let normB = 0;
  for (const count of a.values()) normA += count * count;
  for (const count of b.values()) normB += count * count;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Rescale relevance to 0..1 so it is comparable with similarity. Fused and
 * rank-derived scores sit in a narrow band (RRF tops out near 0.03), and
 * subtracting a 0..1 similarity from them would let redundancy swamp relevance.
 */
function normalizedRelevance(candidates: VectorizedChunk[]): number[] {
  const scores = candidates.map((c) => c.score);
  const min = Math.min(...scores);
  const span = Math.max(...scores) - min;
  return scores.map((score) => (span > 0 ? (score - min) / span : 1));
}

/**
 * MMR selection: pick top-K results balancing relevance and diversity.
 *
 * @param candidates - Candidate chunks with scores and optional vectors
 * @param topK - Number of results to return
 * @param lambda - 0=max diversity, 1=max relevance, default 0.5
 */
export function mmrSelectWithDiagnostics(
  candidates: VectorizedChunk[],
  topK: number,
  lambda = 0.5
): MmrSelection {
  const hasVectors = candidates.length > 0 && candidates.every((c) => c.vector && c.vector.length > 0);
  const similarity: MmrSimilarity = hasVectors ? "embedding" : "lexical";
  if (candidates.length === 0) return { selected: [], similarity };
  if (topK >= candidates.length) return { selected: [...candidates], similarity };

  const relevance = normalizedRelevance(candidates);
  const terms = hasVectors ? [] : candidates.map((c) => termVector(c.text));
  const similar = (i: number, j: number) =>
    hasVectors ? cosineSimilarity(candidates[i].vector!, candidates[j].vector!) : termCosine(terms[i]!, terms[j]!);

  const selected: number[] = [];
  const remaining = new Set(candidates.map((_, i) => i));
  // Highest similarity of each remaining candidate to anything selected so far.
  const maxSim = candidates.map(() => Number.NEGATIVE_INFINITY);

  // Start with the highest-relevance candidate
  let bestIdx = 0;
  for (const i of remaining) if (relevance[i]! > relevance[bestIdx]!) bestIdx = i;
  selected.push(bestIdx);
  remaining.delete(bestIdx);

  // Iteratively pick the next candidate that maximizes MMR
  while (selected.length < topK && remaining.size > 0) {
    const last = selected[selected.length - 1]!;
    let nextIdx = -1;
    let nextMmr = Number.NEGATIVE_INFINITY;

    for (const i of remaining) {
      maxSim[i] = Math.max(maxSim[i]!, similar(i, last));
      const mmr = lambda * relevance[i]! - (1 - lambda) * maxSim[i]!;
      // Ties keep the more relevant passage.
      if (mmr > nextMmr || (mmr === nextMmr && relevance[i]! > relevance[nextIdx]!)) {
        nextMmr = mmr;
        nextIdx = i;
      }
    }

    if (nextIdx === -1) break;
    selected.push(nextIdx);
    remaining.delete(nextIdx);
  }

  return { selected: selected.map((i) => candidates[i]!), similarity };
}

export function mmrSelect(
  candidates: VectorizedChunk[],
  topK: number,
  lambda = 0.5
): VectorizedChunk[] {
  return mmrSelectWithDiagnostics(candidates, topK, lambda).selected;
}
