import { describe, expect, it } from "vitest";

import { rerankBM25, tokenize, type RankedChunk } from "../search/rerank.js";

// Reference: the previous per-step implementation, kept to prove the optimized rerank is bit-identical.
function bm25ScoreRef(
  queryTerms: string[],
  docTerms: string[],
  avgDl: number,
  idf: Map<string, number>,
): number {
  const k1 = 1.5;
  const b = 0.75;
  const dl = docTerms.length;

  // Build term frequency map for the document
  const tf = new Map<string, number>();
  for (const term of docTerms) {
    tf.set(term, (tf.get(term) ?? 0) + 1);
  }

  let score = 0;
  for (const qt of queryTerms) {
    const freq = tf.get(qt) ?? 0;
    if (freq === 0) continue;
    const numerator = freq * (k1 + 1);
    const denominator = freq + k1 * (1 - b + b * (dl / avgDl));
    score += (idf.get(qt) ?? 0) * numerator / denominator;
  }

  return score;
}

/**
 * Re-rank chunks using BM25-style term overlap scoring.
 * Returns chunks sorted by crossScore descending.
 */
function rerankBM25Ref(query: string, chunks: RankedChunk[]): RankedChunk[] {
  if (chunks.length === 0) return [];

  const queryTokens = tokenize(query);
  const queryTerms = [...new Set(queryTokens)];
  const docTokens = chunks.map((c) => tokenize(c.text));
  const avgDl =
    docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / chunks.length;

  const idf = new Map(queryTerms.map(term => {
    const frequency = docTokens.filter(tokens => tokens.includes(term)).length;
    return [term, Math.log(1 + (chunks.length - frequency + 0.5) / (frequency + 0.5))];
  }));
  return chunks
    .map((chunk, i) => ({
      ...chunk,
      crossScore: bm25ScoreRef(queryTerms, docTokens[i], avgDl || 1, idf) +
        queryTokens.slice(1).reduce((bonus, term, index) => {
          const previous = queryTokens[index];
          const adjacent = docTokens[i].some((token, offset) => token === previous && docTokens[i][offset + 1] === term);
          return bonus + (adjacent ? (idf.get(previous) ?? 0) + (idf.get(term) ?? 0) : 0);
        }, 0),
    }))
    .sort((a, b) => (b.crossScore ?? 0) - (a.crossScore ?? 0));
}


let seed = 99;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const VOCAB = "pump valve seal torque bearing gasket filter impeller coupling flange rotor shaft the of and install guide manual error code retry timeout the a".split(" ");
const words = (n: number) => Array.from({ length: n }, () => VOCAB[Math.floor(rand() * VOCAB.length)]).join(" ");

describe("rerankBM25", () => {
  it("matches the reference implementation exactly on random pools", () => {
    for (let round = 0; round < 200; round++) {
      const chunks: RankedChunk[] = Array.from({ length: 1 + Math.floor(rand() * 60) }, (_, i) => ({ id: `c${i}`, text: words(Math.floor(rand() * 120)), score: rand() }));
      const query = words(1 + Math.floor(rand() * 8));
      expect(rerankBM25(query, chunks)).toEqual(rerankBM25Ref(query, chunks));
    }
    expect(rerankBM25("", [])).toEqual([]);
    expect(tokenize("The Pump, valve!")).toEqual(["pump", "valve"]);
  });
});
