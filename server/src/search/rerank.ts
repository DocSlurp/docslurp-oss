/**
 * Local BM25 reranking with candidate-corpus inverse document frequency.
 */

export interface RankedChunk {
  id: string;
  text: string;
  score: number;
  crossScore?: number;
}

/**
 * Tokenize text into lowercase terms.
 */
export const stopWords = new Set("a an and are as at be by for from has have how i in is it of on or that the their this to was were what which with you your".split(" "));
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term && !stopWords.has(term));
}

/**
 * Compute BM25 score for a single document against a query.
 * k1=1.5, b=0.75
 */
function bm25Score(
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
export function rerankBM25(query: string, chunks: RankedChunk[]): RankedChunk[] {
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
      crossScore: bm25Score(queryTerms, docTokens[i], avgDl || 1, idf) +
        queryTokens.slice(1).reduce((bonus, term, index) => {
          const previous = queryTokens[index];
          const adjacent = docTokens[i].some((token, offset) => token === previous && docTokens[i][offset + 1] === term);
          return bonus + (adjacent ? (idf.get(previous) ?? 0) + (idf.get(term) ?? 0) : 0);
        }, 0),
    }))
    .sort((a, b) => (b.crossScore ?? 0) - (a.crossScore ?? 0));
}

/**
 * Remote re-ranking stub. If apiKey provided, would call a reranker endpoint.
 * Currently falls back to BM25 re-ranking.
 */
export async function rerankRemote(
  query: string,
  chunks: RankedChunk[],
  _apiKey: string
): Promise<RankedChunk[]> {
  // Stub: just return BM25 reranked results
  return rerankBM25(query, chunks);
}
