import type { SearchInput, SearchResponse, SearchResult } from "./index.js";
import { assertBrowserSafeApiKey } from "./keys.js";

export type SearchProvider = "meilisearch" | "typesense" | "pagefind";
export type AdapterSearch = (input: SearchInput) => Promise<SearchResponse>;
export type SearchAdapterOptions = {
  apiUrl: string;
  /** Browser integrations must use a domain-restricted, search-only client key (dslp_pub_…); server keys (dslp_priv_…) throw in browsers. */
  clientKey: string;
  fetch?: typeof fetch;
  workspaceId?: string;
  /** Map a cited document to a public site URL, especially for Pagefind migrations. */
  resolveUrl?: (result: SearchResult) => string;
};
export class SearchCompatibilityError extends Error {
  readonly name = "SearchCompatibilityError";
  readonly code = "UNSUPPORTED_SEARCH_OPTION";
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SearchCompatibilityError("Search parameters must be an object.");
  return value as Record<string, unknown>;
}
function integer(value: unknown, fallback: number, min: number) {
  const n = value === undefined ? fallback : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > 100) throw new SearchCompatibilityError("Pagination values must be integers within the 100-passage retrieval window.");
  return n;
}
function workspace(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new SearchCompatibilityError("A workspace ID is required.");
}
export function adapterQuery(provider: SearchProvider, workspaceId: string, input: unknown) {
  const params = record(input);
  const supported = provider === "meilisearch" ? ["q", "offset", "limit", "page", "hitsPerPage"] : provider === "typesense" ? ["q", "query_by", "page", "per_page"] : ["term", "limit", "filters", "sort"];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && !supported.includes(key)) throw new SearchCompatibilityError(`${provider}: ${key} is not supported. Use the native search API for retrieval controls.`);
  }
  if (provider === "pagefind" && ((params.filters && Object.keys(record(params.filters)).length) || params.sort)) throw new SearchCompatibilityError("Pagefind filters and sorting require native retrieval controls.");
  if (provider === "typesense" && params.query_by !== undefined && params.query_by !== "text") throw new SearchCompatibilityError("Typesense query_by must be text; arbitrary indexed attributes are not available.");
  if ((provider === "typesense" && params.q === undefined) || (provider === "pagefind" && params.term === undefined)) throw new SearchCompatibilityError(`${provider}: a query string is required (an empty string is allowed).`);
  const q = params[provider === "pagefind" ? "term" : "q"] ?? "";
  if (typeof q !== "string" || q.length > 16000) throw new SearchCompatibilityError("The query must be a string of at most 16,000 characters.");
  workspace(workspaceId);
  if (q.trim() === "*") throw new SearchCompatibilityError("Wildcard browsing is not supported. Send a nonempty search query, or use the document-list API.");
  const paged = provider === "typesense" || (provider === "meilisearch" && (params.page !== undefined || params.hitsPerPage !== undefined));
  const size = integer(provider === "typesense" ? params.per_page : paged ? params.hitsPerPage : params.limit, provider === "pagefind" ? 100 : 20, 1);
  const page = integer(params.page, 1, 1);
  const offset = paged ? (page - 1) * size : integer(params.offset, 0, 0);
  if (offset + size > 100) throw new SearchCompatibilityError("Only the first 100 ranked passages are available. Narrow the query instead of paging beyond this window.");
  return { q: q.trim(), workspaceId, offset, size, page, paged };
}
export function escapeSearchHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
function sourceUrl(hit: SearchResult) {
  const candidate = hit.url ?? (hit.citation as unknown as Record<string, unknown>).canonicalDocumentUri;
  return typeof candidate === "string" && (/^https?:\/\//.test(candidate) || /^\/(?!\/)/.test(candidate)) ? candidate : "";
}
function document(hit: SearchResult, resolveUrl?: SearchAdapterOptions["resolveUrl"]) {
  const url = resolveUrl?.(hit) ?? sourceUrl(hit);
  if (resolveUrl && (typeof url !== "string" || !(/^https?:\/\//.test(url) || /^\/(?!\/)/.test(url)))) throw new SearchCompatibilityError("resolveUrl must return an HTTP(S) or site-relative public source URL for every hit.");
  return { id: `${hit.citation.documentId}:${hit.citation.chunkIndex}`, text: hit.text, title: hit.citation.filename, filename: hit.citation.filename, url, score: hit.score, citation: hit.citation };
}
export async function runSearchAdapter(provider: SearchProvider, workspaceId: string, params: unknown, search: AdapterSearch, resolveUrl?: SearchAdapterOptions["resolveUrl"]) {
  const query = adapterQuery(provider, workspaceId, params);
  const started = performance.now();
  const response = query.q ? await search({ q: query.q, workspaceId, limit: 100 }) : null;
  const all = response?.results ?? [];
  const hits = all.slice(query.offset, query.offset + query.size).map(hit => document(hit, resolveUrl));
  // Counts describe a bounded ranked window, never the whole indexed corpus.
  const docslurp = { bounded: true, windowLimit: 100, countIsExact: false, sessionId: response?.sessionId ?? null, availability: response?.availability ?? null, usage: response?.usage ?? null };
  const elapsed = Math.round(performance.now() - started);
  if (provider === "meilisearch") return { hits, query: query.q, processingTimeMs: elapsed, ...(query.paged ? { page: query.page, hitsPerPage: query.size, totalHits: all.length, totalPages: Math.ceil(all.length / query.size) } : { offset: query.offset, limit: query.size, estimatedTotalHits: all.length }), docslurp };
  if (provider === "typesense") return { found: all.length, page: query.page, search_time_ms: elapsed, hits: hits.map(document => ({ document })), facet_counts: [], request_params: { q: query.q, query_by: "text", per_page: query.size, collection_name: workspaceId }, docslurp };
  return { results: hits.map(hit => ({ id: hit.id, score: hit.score, data: { url: hit.url, excerpt: escapeSearchHtml(hit.text), plain_excerpt: hit.text, raw_content: hit.text, content: hit.text, word_count: hit.text.split(/\s+/).length, meta: { title: hit.title }, filters: {}, anchors: [], weighted_locations: [], locations: [], sub_results: [], citation: hit.citation } })), unfilteredResultCount: all.length, filters: {}, totalFilters: {}, docslurp };
}
function transport(options: SearchAdapterOptions) {
  if (!options.apiUrl || !options.clientKey) throw new Error("apiUrl and clientKey are required.");
  assertBrowserSafeApiKey(options.clientKey);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetchImpl(`${options.apiUrl.replace(/\/$/, "")}${path}`, { method: "POST", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${options.clientKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`DocSlurp search failed (${response.status}): ${await response.text()}`);
    return response.json() as Promise<T>;
  };
}
export type AdapterResponse = Awaited<ReturnType<typeof runSearchAdapter>>;
export type MeilisearchSearchResponse = Extract<AdapterResponse, { query: string }>;
export type TypesenseSearchResponse = Extract<AdapterResponse, { found: number }>;
export type PagefindSearchResponse = Extract<AdapterResponse, { results: unknown }>;
export type AlgoliaSearchResponse = { hits: Array<Record<string, unknown> & { objectID: string }>; page: number; hitsPerPage: number; nbHits: number; nbPages: number; processingTimeMS: number; query: string; exhaustiveNbHits?: boolean; [key: string]: unknown };
export function createDocSlurpMeilisearchClient(options: SearchAdapterOptions) {
  const request = transport(options);
  return { index: (workspaceId: string) => ({ search: async (q: string, params: Record<string, unknown> = {}) => {
    const body = { ...params, q }; adapterQuery("meilisearch", workspaceId, body);
    return request<MeilisearchSearchResponse>(`/compat/meilisearch/indexes/${encodeURIComponent(workspaceId)}/search`, body);
  } }) };
}
export function createDocSlurpTypesenseClient(options: SearchAdapterOptions) {
  const request = transport(options);
  const search = async (workspaceId: string, params: Record<string, unknown>) => {
    adapterQuery("typesense", workspaceId, params);
    return request<TypesenseSearchResponse>(`/compat/typesense/collections/${encodeURIComponent(workspaceId)}/documents/search`, params);
  };
  return { collections: (workspaceId: string) => ({ documents: () => withWorkspace(workspaceId, search) }), multiSearch: { perform: async (body: { searches: Array<Record<string, unknown> & { collection: string }> }, common: Record<string, unknown> = {}) => {
    record(body); record(common);
    if (Object.keys(body).some(key => key !== "searches") || !Array.isArray(body.searches) || !body.searches.length || body.searches.length > 10) throw new SearchCompatibilityError("multiSearch accepts 1–10 queries; union searches are unsupported.");
    const searches = body.searches.map(entry => {
      record(entry); const { collection, ...params } = entry;
      const merged = { ...common, ...params }; adapterQuery("typesense", collection, merged);
      return { collection, ...merged };
    });
    return request<{ results: TypesenseSearchResponse[] }>("/compat/typesense/multi_search", { searches });
  } } };
}
function withWorkspace(workspaceId: string, search: (workspaceId: string, params: Record<string, unknown>) => Promise<TypesenseSearchResponse>) {
  return { search: (params: Record<string, unknown>) => search(workspaceId, params) };
}
export function createDocSlurpPagefind(options: SearchAdapterOptions & { workspaceId: string; resolveUrl: NonNullable<SearchAdapterOptions["resolveUrl"]> }) {
  workspace(options.workspaceId);
  if (typeof options.resolveUrl !== "function") throw new SearchCompatibilityError("Pagefind requires resolveUrl to map citations to real public source URLs.");
  const request = transport(options);
  const search: AdapterSearch = input => request<SearchResponse>("/v1/search", input);
  return { search: async (term: string, params: { filters?: Record<string, unknown>; sort?: unknown } = {}) => {
    const response = await runSearchAdapter("pagefind", options.workspaceId, { ...params, term }, search, options.resolveUrl);
    const pagefind = response as Extract<typeof response, { results: unknown }>;
    return { ...pagefind, results: pagefind.results.map(result => ({ ...result, data: async () => result.data })) };
  }, filters: async () => ({}) };
}
export function createDocSlurpAlgoliaClient(options: SearchAdapterOptions) {
  const request = transport(options);
  const searchSingleIndex = async ({ indexName, searchParams = {} }: { indexName: string; searchParams?: Record<string, unknown> }): Promise<AlgoliaSearchResponse> => {
    workspace(indexName); record(searchParams);
    if (searchParams.query === "" || searchParams.query === undefined) return { hits: [], nbHits: 0, nbPages: 0, page: 0, hitsPerPage: integer(searchParams.hitsPerPage, 10, 1), query: "", processingTimeMS: 0, exhaustiveNbHits: false };
    return request<AlgoliaSearchResponse>(`/compat/algolia/1/indexes/${encodeURIComponent(indexName)}/query`, searchParams);
  };
  return { searchSingleIndex, initIndex: (indexName: string) => ({ search: (query: string, params: Record<string, unknown> = {}) => searchSingleIndex({ indexName, searchParams: { ...params, query } }) }), search: async (input: { requests: Record<string, unknown>[] } | Array<{ indexName: string; params?: Record<string, unknown> }>) => {
    const requests = Array.isArray(input) ? input.map(entry => { record(entry); const { params, ...rest } = entry; return { ...rest, ...(params ? record(params) : {}) }; }) : record(input).requests;
    if (!Array.isArray(requests) || requests.length > 10) throw new SearchCompatibilityError("Algolia search accepts at most 10 request objects.");
    for (const entry of requests) { record(entry); workspace(entry.indexName); }
    return request<{results: AlgoliaSearchResponse[]}>("/compat/algolia/1/indexes/*/queries", { requests });
  } };
}
