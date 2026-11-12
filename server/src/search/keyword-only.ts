import { currentChatTurn } from "../lib/chat-turn-context.js";
import { currentRequestKeywordOnly } from "../lib/request-context.js";
import type { SearchOptions } from "../services/search.js";

/**
 * Is this search keyword-only? Either the caller asked for it, or the request's
 * API key holds `search:keyword` without `search`. The request flag applies to
 * every route that reaches the search service (REST, compat clients, MCP), so a
 * route that forgets to pass the option still cannot widen the key. Searches a
 * chat turn runs belong to the chat answer, which the separate `chat` scope governs.
 */
export function searchIsKeywordOnly(options: Pick<SearchOptions, "keywordOnly">): boolean {
  return options.keywordOnly === true || (currentRequestKeywordOnly() && !currentChatTurn());
}

/**
 * Keyword-only retrieval: no query embedding, vector or graph legs, hosted
 * reranker or LLM query strategy. Applied after project defaults resolve, so a
 * project setting cannot turn any of them back on. The free BM25 rerank stays.
 */
export function clampKeywordOnly<T extends SearchOptions>(options: T): T {
  return {
    ...options,
    keywordOnly: true,
    queryVector: undefined,
    useHyDE: false,
    queryRewrite: false,
    queryDecompose: false,
    stepback: false,
    selfQuery: false,
    useContextualCompression: false,
    adaptiveRetrieval: false,
    iterativeMultiHop: false,
    summarySeed: false,
    enableGraphExpansion: false,
    enableCommunityExpansion: false,
    enableWebFallback: false,
    // An unset provider means BM25 (search/session.ts); only the hosted reranker is removed.
    useRerank: options.useRerank === true && (options.rerankProvider ?? "bm25") === "bm25",
    rerankProvider: "bm25",
    rerankModel: undefined,
  };
}
