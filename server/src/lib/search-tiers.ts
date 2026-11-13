import { SEARCH_MODES, type SearchMode } from "@docslurp/shared";

/** The API key scope for each search mode. Modes nest: a `search:deep` key may also run hybrid and keyword searches. */
export const SEARCH_SCOPE_BY_MODE = {
  keyword: "search:keyword",
  hybrid: "search:hybrid",
  deep: "search:deep",
} as const satisfies Record<SearchMode, string>;

/** Every search scope: any of them may call the search endpoints; the search service holds each to its mode. */
export const SEARCH_SCOPES = [SEARCH_SCOPE_BY_MODE.keyword, SEARCH_SCOPE_BY_MODE.hybrid, SEARCH_SCOPE_BY_MODE.deep] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export function isSearchScope(scope: string): scope is SearchScope {
  return (SEARCH_SCOPES as readonly string[]).includes(scope);
}

/**
 * The most a key with these scopes may search, or null without a search scope. Saving a key refuses more than one
 * search scope; a row that has several anyway gets the narrowest (fail closed).
 */
export function searchModeOfScopes(scopes: readonly string[]): SearchMode | null {
  return SEARCH_MODES.find((mode) => scopes.includes(SEARCH_SCOPE_BY_MODE[mode])) ?? null;
}

/** The narrower of two modes. */
export function narrowerSearchMode(a: SearchMode, b: SearchMode): SearchMode {
  return SEARCH_MODES.indexOf(a) <= SEARCH_MODES.indexOf(b) ? a : b;
}
