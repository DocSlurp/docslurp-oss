export type AlgoliaSearchRequest = {
  query: string;
  page?: number;
  hitsPerPage?: number;
  filters?: string;
  facetFilters?: string[] | string[][];
  numericFilters?: string[] | string[][];
  facets?: string[];
  attributesToRetrieve?: string[];
  highlightPreTag?: string;
  highlightPostTag?: string;
};

export type AlgoliaMultipleQueriesRequest = {
  requests: Array<AlgoliaSearchRequest & { indexName: string }>;
};
export type AlgoliaLegacyQueries = Array<{ indexName: string; params: AlgoliaSearchRequest }>;

export type AlgoliaSearchSingleIndexRequest = {
  indexName: string;
  searchParams: AlgoliaSearchRequest;
};

export type AlgoliaSearchForFacetValuesRequest = {
  indexName: string;
  facetName: string;
  searchForFacetValuesRequest: {
    facetQuery: string;
    query?: string;
    filters?: string;
    facetFilters?: string[] | string[][];
    numericFilters?: string[] | string[][];
    maxFacetHits?: number;
  };
};

export type AlgoliaHit = Record<string, unknown> & { objectID: string };

export type AlgoliaSearchResponse = {
  hits: AlgoliaHit[];
  page: number;
  nbHits: number;
  nbPages: number;
  hitsPerPage: number;
  processingTimeMS: number;
  query: string;
  queryID?: string;
  params: string;
  facets?: Record<string, Record<string, number>>;
  exhaustiveNbHits?: boolean;
};

export type AlgoliaCompatSettings = Record<string, unknown>;

export type AlgoliaSynonymEntry = {
  objectID?: string;
  type?: "synonym" | "oneWaySynonym";
  synonyms?: string[];
  input?: string;
};

export type AlgoliaRuleEntry = Record<string, unknown>;

export type AlgoliaFacetHit = {
  value: string;
  highlighted: string;
  count: number;
};

export interface DocSlurpAlgoliaClientOptions {
  apiUrl: string;
  clientKey: string;
  glossary?: Record<string, string[]>;
  fetch?: typeof globalThis.fetch;
}

function expandQuery(query: string, glossary?: Record<string, string[]>): string {
  if (!glossary || Object.keys(glossary).length === 0) return query;
  const norm: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(glossary)) norm[k.toLowerCase()] = v;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let i = 0;
  const alt = (t: string) => `(${[t, ...(norm[t] ?? [])].join(" OR ")})`;
  while (i < tokens.length) {
    if (i + 2 < tokens.length) {
      const tri = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
      if (norm[tri]) { out.push(alt(tri)); i += 3; continue; }
    }
    if (i + 1 < tokens.length) {
      const bi = `${tokens[i]} ${tokens[i + 1]}`;
      if (norm[bi]) { out.push(alt(bi)); i += 2; continue; }
    }
    out.push(norm[tokens[i]] ? alt(tokens[i]) : tokens[i]);
    i++;
  }
  return out.join(" ");
}

export function docslurpAlgoliaClient(opts: DocSlurpAlgoliaClientOptions) {
  const { apiUrl, clientKey, glossary } = opts;
  // Server keys (dslp_priv_…) must never ship to a browser; client keys are dslp_pub_….
  if (typeof window !== "undefined" && typeof document !== "undefined" && clientKey.startsWith("dslp_priv_")) {
    throw new Error("DocSlurp server keys (dslp_priv_…) must never be used in browser code. Use a search-only, domain-restricted client key (dslp_pub_…).");
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const base = apiUrl.replace(/\/$/, "");

  if (!fetchImpl) {
    throw new Error("A fetch implementation is required.");
  }

  async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`${base}${pathname}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${clientKey}`
      }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DocSlurp Algolia-compat request failed: ${res.status} ${text}`);
    }
    return await res.json() as T;
  }

  async function searchSingleIndex(requestBody: AlgoliaSearchSingleIndexRequest): Promise<AlgoliaSearchResponse> {
    return await request<AlgoliaSearchResponse>(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/query`, {
      method: "POST",
      body: JSON.stringify({
        ...requestBody.searchParams,
        query: expandQuery(requestBody.searchParams.query, glossary)
      })
    });
  }

  async function searchForFacetValues(requestBody: AlgoliaSearchForFacetValuesRequest): Promise<{ facetHits: AlgoliaFacetHit[]; exhaustiveFacetsCount: boolean }> {
    return await request(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/facets/${encodeURIComponent(requestBody.facetName)}/query`, {
      method: "POST",
      body: JSON.stringify(requestBody.searchForFacetValuesRequest)
    });
  }

  async function getSettings(requestBody: { indexName: string }): Promise<AlgoliaCompatSettings> {
    return await request<AlgoliaCompatSettings>(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/settings`);
  }

  async function setSettings(requestBody: { indexName: string; indexSettings: AlgoliaCompatSettings }): Promise<{ ok: boolean; settings: AlgoliaCompatSettings }> {
    return await request(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/settings`, {
      method: "PUT",
      body: JSON.stringify(requestBody.indexSettings)
    });
  }

  async function searchSynonyms(requestBody: { indexName: string }): Promise<{ hits: AlgoliaSynonymEntry[] }> {
    return await request(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/synonyms`);
  }

  async function saveSynonyms(requestBody: { indexName: string; synonymHit: AlgoliaSynonymEntry[] }): Promise<{ updatedAt: string; count: number }> {
    return await request(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/synonyms/batch`, {
      method: "POST",
      body: JSON.stringify({ synonyms: requestBody.synonymHit })
    });
  }

  async function searchRules(requestBody: { indexName: string }): Promise<{ hits: AlgoliaRuleEntry[] }> {
    return await request(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/rules`);
  }

  async function saveRules(requestBody: { indexName: string; rules: AlgoliaRuleEntry[] }): Promise<{ updatedAt: string; count: number }> {
    return await request(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/rules/batch`, {
      method: "POST",
      body: JSON.stringify({ rules: requestBody.rules })
    });
  }

  async function getAnalytics(requestBody: { indexName: string }): Promise<{ queries: number; zeroResults: number; clicks: number; conversions: number }> {
    return await request(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/analytics/summary`);
  }

  async function clickedObjectIDsAfterSearch(requestBody: { indexName: string; queryID?: string; objectIDs: string[]; positions?: number[] }): Promise<{ status: string }> {
    return await request(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/analytics/click`, {
      method: "POST",
      body: JSON.stringify({
        queryID: requestBody.queryID,
        objectIDs: requestBody.objectIDs,
        positions: requestBody.positions
      })
    });
  }

  async function convertedObjectIDsAfterSearch(requestBody: { indexName: string; queryID?: string; objectIDs: string[]; eventName?: string }): Promise<{ status: string }> {
    return await request(`/compat/algolia/1/indexes/${encodeURIComponent(requestBody.indexName)}/analytics/conversion`, {
      method: "POST",
      body: JSON.stringify({
        queryID: requestBody.queryID,
        objectIDs: requestBody.objectIDs,
        eventName: requestBody.eventName
      })
    });
  }

  function initIndex(indexName: string) {
    return {
      search: async (query: string | AlgoliaSearchRequest, params: Omit<AlgoliaSearchRequest, "query"> = {}): Promise<AlgoliaSearchResponse> => {
        return await searchSingleIndex({
          indexName,
          searchParams: typeof query === "string" ? { ...params, query } : query
        });
      },
      getSettings: async (): Promise<AlgoliaCompatSettings> => {
        return await getSettings({ indexName });
      },
      setSettings: async (settings: AlgoliaCompatSettings): Promise<{ ok: boolean; settings: AlgoliaCompatSettings }> => {
        return await setSettings({ indexName, indexSettings: settings });
      },
      searchSynonyms: async (): Promise<{ hits: AlgoliaSynonymEntry[] }> => {
        return await searchSynonyms({ indexName });
      },
      saveSynonyms: async (synonyms: AlgoliaSynonymEntry[]): Promise<{ updatedAt: string; count: number }> => {
        return await saveSynonyms({ indexName, synonymHit: synonyms });
      },
      searchRules: async (): Promise<{ hits: AlgoliaRuleEntry[] }> => {
        return await searchRules({ indexName });
      },
      saveRules: async (rules: AlgoliaRuleEntry[]): Promise<{ updatedAt: string; count: number }> => {
        return await saveRules({ indexName, rules });
      },
      searchForFacetValues: async (facetName: string, requestBody: Omit<AlgoliaSearchForFacetValuesRequest["searchForFacetValuesRequest"], "facetName">): Promise<{ facetHits: AlgoliaFacetHit[]; exhaustiveFacetsCount: boolean }> => {
        return await searchForFacetValues({
          indexName,
          facetName,
          searchForFacetValuesRequest: requestBody
        });
      },
      getAnalytics: async (): Promise<{ queries: number; zeroResults: number; clicks: number; conversions: number }> => {
        return await getAnalytics({ indexName });
      },
      clickedObjectIDsAfterSearch: async (payload: { queryID?: string; objectIDs: string[]; positions?: number[] }): Promise<{ status: string }> => {
        return await clickedObjectIDsAfterSearch({ indexName, ...payload });
      },
      convertedObjectIDsAfterSearch: async (payload: { queryID?: string; objectIDs: string[]; eventName?: string }): Promise<{ status: string }> => {
        return await convertedObjectIDsAfterSearch({ indexName, ...payload });
      }
    };
  }

  return {
    initIndex,
    searchSingleIndex,
    searchForFacetValues,
    getSettings,
    setSettings,
    searchSynonyms,
    saveSynonyms,
    searchRules,
    saveRules,
    getAnalytics,
    clickedObjectIDsAfterSearch,
    convertedObjectIDsAfterSearch,
    search: async (requestBody: AlgoliaMultipleQueriesRequest | AlgoliaLegacyQueries): Promise<{ results: AlgoliaSearchResponse[] }> => {
      const requests = Array.isArray(requestBody) ? requestBody.map(({ indexName, params }) => ({ indexName, ...params })) : requestBody.requests;
      return await request(`/compat/algolia/1/indexes/*/queries`, {
        method: "POST",
        body: JSON.stringify({
          requests: requests.map((entry) => ({
            ...entry,
            query: expandQuery(entry.query, glossary)
          }))
        })
      });
    },
    importIndex: async (payload: Record<string, unknown>): Promise<unknown> => {
      return await request(`/compat/algolia/1/import`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }
  };
}

export default docslurpAlgoliaClient;
