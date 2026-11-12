import { type SearchMode } from "@docslurp/shared";

import { currentChatTurn } from "../lib/chat-turn-context.js";
import { currentRequestSearchCeiling } from "../lib/request-context.js";
import { narrowerSearchMode } from "../lib/search-tiers.js";
import type { SearchOptions } from "../services/search.js";

/**
 * The mode this search runs in: what the caller asked for (default `deep`, the project's own settings), never more
 * than the request's API key allows. The ceiling comes from the request context, which `setRequestActor` fills from the
 * key's `search:<mode>` scope, so every route that reaches the search service (REST, compat clients, MCP) is held to it
 * even if the route passed no mode. Searches a chat turn runs belong to the answer, which the `chat` scope governs.
 */
export function effectiveSearchMode(options: Pick<SearchOptions, "searchMode">): SearchMode {
  const requested = options.searchMode ?? "deep";
  const ceiling = currentChatTurn() ? null : currentRequestSearchCeiling();
  return ceiling ? narrowerSearchMode(requested, ceiling) : requested;
}

/**
 * Turns off what a mode may not run. Applied after project defaults resolve, so no project setting re-enables it.
 * - keyword: no query embedding or vector leg, nothing below.
 * - hybrid: no graph or community expansion, hosted reranker, web fallback or LLM query strategy (HyDE, rewrite,
 *   decomposition, stepback, self-query, compression, multi-hop).
 * - deep: unchanged.
 * The free BM25 rerank (the default provider) stays in every mode.
 */
export function clampToSearchMode<T extends SearchOptions>(options: T, mode: SearchMode): T {
  if (mode === "deep") return { ...options, searchMode: mode };
  const hybrid: T = {
    ...options,
    searchMode: mode,
    useHyDE: false,
    queryRewrite: false,
    queryDecompose: false,
    stepback: false,
    selfQuery: false,
    useContextualCompression: false,
    adaptiveRetrieval: false,
    iterativeMultiHop: false,
    enableGraphExpansion: false,
    enableCommunityExpansion: false,
    enableWebFallback: false,
    // An unset provider means BM25 (search/session.ts); only the hosted reranker is removed.
    useRerank: options.useRerank === true && (options.rerankProvider ?? "bm25") === "bm25",
    rerankProvider: "bm25",
    rerankModel: undefined,
  };
  return mode === "hybrid" ? hybrid : { ...hybrid, queryVector: undefined, summarySeed: false };
}
