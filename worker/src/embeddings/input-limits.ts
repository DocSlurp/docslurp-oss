import { embeddingModelBaseUri } from "@docslurp/shared";

/**
 * Maximum input tokens of an embedding model. Text past this is truncated by
 * the model without any error, so chunks and their context preamble are sized
 * to fit it. Matched on the model name; an unknown model gets the smallest
 * limit common to the models we host, never an optimistic one.
 */
const KNOWN_LIMITS: Array<[pattern: RegExp, tokens: number]> = [
  [/paraphrase-multilingual-minilm/i, 128],
  [/all-minilm/i, 256],
  [/gte-small|bge-small|bge-base|e5-(small|base|large)/i, 512],
  [/bge-m3/i, 8192],
  [/jina-embeddings-v[23]/i, 8192],
  [/nomic-embed/i, 8192],
  [/pplx-embed/i, 32768],
  [/text-embedding-(3-|ada)/i, 8191],
];

export const DEFAULT_EMBEDDING_INPUT_TOKENS = 512;

export function embeddingInputTokenLimit(modelUri: string): number {
  const name = embeddingModelBaseUri(modelUri);
  for (const [pattern, tokens] of KNOWN_LIMITS) if (pattern.test(name)) return tokens;
  return DEFAULT_EMBEDDING_INPUT_TOKENS;
}

/** Tokens kept free in every embedding input for the `Document / Context / Section / Pages` preamble. */
export function preambleReserveTokens(inputLimit: number): number {
  return Math.min(Math.ceil(inputLimit / 3), 100);
}

/** Token budget of one chunk's own text for a model: what is left after the preamble reserve. */
export function chunkTokenBudget(modelUri: string): number {
  const limit = embeddingInputTokenLimit(modelUri);
  return Math.max(16, limit - preambleReserveTokens(limit));
}
