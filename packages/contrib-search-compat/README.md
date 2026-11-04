# @docslurp/contrib-search-compat

[Package docs](https://docslurp.io/docs/packages/contrib-search-compat) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/contrib-search-compat) · [npm](https://www.npmjs.com/package/@docslurp/contrib-search-compat)

Keep your existing search calls and get DocSlurp results with citations. One package, one subpath per client:

| Subpath | Replaces | Entry point |
| --- | --- | --- |
| `@docslurp/contrib-search-compat/algolia` | Algolia (Lite-style and `initIndex()`) | `docslurpAlgoliaClient()` |
| `@docslurp/contrib-search-compat/meilisearch` | Meilisearch | `createDocSlurpMeilisearchClient()` |
| `@docslurp/contrib-search-compat/typesense` | Typesense | `createDocSlurpTypesenseClient()` |
| `@docslurp/contrib-search-compat/pagefind` | Pagefind | `createDocSlurpPagefind()` |

Requires `@docslurp/sdk` 0.3.0 or newer. The Meilisearch, Typesense and Pagefind subpaths are the same adapters you can import from `@docslurp/sdk/search-adapters`. In the browser, pass a browser key as `clientKey`. Workspace references (`indexName`, `index(...)`, `collections(...)`, `workspace`) accept a workspace ID, slug or `default`; the `workspace` option also accepts a name.

Renamed from `@docslurp/compat-algolia`, `@docslurp/compat-meilisearch`, `@docslurp/compat-typesense` and `@docslurp/compat-pagefind`; see [`docs/releases.md`](https://github.com/DocSlurp/docslurp-oss/blob/main/docs/releases.md) for the migration.

## Algolia

Move Algolia search code to DocSlurp without rewriting your calls. This client keeps the current Lite-style methods (`searchSingleIndex`, `search`, `searchForFacetValues`) and the legacy `initIndex()` surface, plus settings, synonym and rule sync, click and conversion events, and imports. Results come from DocSlurp retrieval and keep their citations.

### Search from the browser

```ts
import { docslurpAlgoliaClient } from "@docslurp/contrib-search-compat/algolia";

const client = docslurpAlgoliaClient({
  apiUrl: process.env.PUBLIC_DOCSLURP_API_URL!,
  clientKey: process.env.PUBLIC_DOCSLURP_CLIENT_KEY!, // A browser key: search-only, limited to your allowed websites.
  glossary: { ml: ["machine learning"] } // Optional synonyms, expanded locally before each query.
});

// indexName is a workspace slug, UUID or "default".
const res = await client.searchSingleIndex({
  indexName: "product-manuals",
  searchParams: { query: "ml models", hitsPerPage: 10 }
});
console.log(res.hits);

const facets = await client.searchForFacetValues({
  indexName: "product-manuals",
  facetName: "filename",
  searchForFacetValuesRequest: { facetQuery: "invoice" }
});
console.log(facets.facetHits);

// Report a click on a result.
await client.clickedObjectIDsAfterSearch({ indexName: "product-manuals", queryID: res.queryID, objectIDs: ["doc-1:0"] });
```

### Sync settings, synonyms and rules from your server

Reads such as `getSettings` work with a browser key. Writes (`setSettings`, `saveSynonyms`, `saveRules`, `importIndex`) need a server key with the `workspaces:manage` scope, which only organization owners and admins can grant, and the key owner must be able to edit the workspace. Run them from a backend job or migration script, never in the browser:

```ts
const admin = docslurpAlgoliaClient({
  apiUrl: "https://docslurp.io",
  clientKey: process.env.DOCSLURP_API_KEY!, // A server key with the workspaces:manage scope. The option is named clientKey.
});

const settings = await admin.getSettings({ indexName: "product-manuals" });
await admin.saveSynonyms({ indexName: "product-manuals", synonymHit: [{ type: "synonym", synonyms: ["invoice", "bill"] }] });
await admin.saveRules({ indexName: "product-manuals", rules: [{ objectID: "rule-1", condition: { pattern: "invoice" } }] });
```

[`@docslurp/contrib-algolia-server`](https://docslurp.io/docs/packages/contrib-algolia-server) wraps these writes with server-side helper names.

### Supported call shapes

- Legacy `index.search("query", { hitsPerPage: 10 })` and `index.search({ query: "query", hitsPerPage: 10 })` both work.
- InstantSearch-style `client.search([{ indexName, params: { query } }])` is converted to the API's flat request shape. The current `{ requests }` form works too, with up to 10 requests.
- The client follows common Algolia request and response shapes, but ranking comes from DocSlurp retrieval, not Algolia's ranking.
- `filters` and `facetFilters` support `tags`, `mime_type`, `filename` (exact, case-sensitive match), `filenameContains` (case-insensitive literal substring), `language`, `heading`, `documentId` and `runId` clauses joined with `AND`. `OR` works only between values of one `tags` or `mime_type` attribute, for example `(tags:a OR tags:b)` or `facetFilters: [["tags:a", "tags:b"]]`, because DocSlurp matches any of the listed values; each attribute may appear in one `AND` clause. `numericFilters` (and numeric clauses in `filters`) support `page` with `=`, `<`, `<=`, `>`, `>=` and `page:1 TO 5`.
- Any parameter that narrows results and is outside that subset is rejected, never ignored, so a filter you rely on for scoping cannot silently stop applying. That covers other attributes, `NOT` and `-` negation, `!=`, mixed `AND`/`OR` without parentheses, nested groups, malformed syntax, non-empty `tagFilters`, geo parameters, `restrictSearchableAttributes`, `ruleContexts`, `distinct`, `offset`/`length`, `advancedSyntax`, the URL-encoded `params` string and any unknown or misspelled key (such as `facetfilters`). Limits: `filters` up to 8 KB, 100 clauses in total, 1 KB per clause, 255 characters per filename value, 100 entries per `facetFilters`/`numericFilters` array, arrays nested at most two levels deep and a 1 MB request body.
- Ranking, presentation and analytics parameters that never change which hits match are accepted with any value and ignored: `analytics`, `analyticsTags`, `clickAnalytics`, `getRankingInfo`, `userToken`, `enablePersonalization`, `personalizationImpact`, `enableABTest`, `enableReRanking`, `percentileComputation`, `attributesToHighlight`, `attributesToSnippet`, `snippetEllipsisText`, `restrictHighlightAndSnippetArrays`, `responseFields`, `maxValuesPerFacet`, `sortFacetValuesBy`, `facetingAfterDistinct`, `optionalFilters`, `sumOrFiltersScores` and `aroundPrecision`. `type` is accepted as `"default"` on every route.
- Query-matching parameters change how many hits match, and DocSlurp does not apply them, so they are accepted only with Algolia's default or a more permissive value: `typoTolerance: true`, `allowTyposOnNumericTokens: true`, `decompoundQuery: true`, `minWordSizefor1Typo` up to 4, `minWordSizefor2Typos` up to 8, and any boolean or language list for `ignorePlurals`, `removeStopWords`, `queryLanguages` and `naturalLanguages`. Restrictive values, such as `typoTolerance: false`, `"min"` or `"strict"`, and a non-empty `keepDiacriticsOnCharacters`, are rejected. Empty or disabled defaults such as `tagFilters: ""` and `aroundLatLngViaIP: false` are accepted, so standard InstantSearch requests work.
- Rejections are HTTP 400 with `code: "UNSUPPORTED_SEARCH_OPTION"` and a message naming the clause or parameter, returned before any retrieval runs; in a batched `search()` one bad request rejects the whole batch. The client throws a `SearchCompatibilityError` (exported from this subpath) for these responses, and also for legacy `{ indexName, params }` entries whose `params` is not a plain object.
- Facet counts and `searchForFacetValues` cover `filename` only, counted within the retrieved results. Highlight tags return the passage text without match markup.
- `searchSingleIndex` with an empty `query` returns HTTP 400; batched requests with an empty query or an unknown index name return zero hits.

## Meilisearch

`createDocSlurpMeilisearchClient()` supports `index(workspace).search(q, params)`.

```ts
import { createDocSlurpMeilisearchClient } from "@docslurp/contrib-search-compat/meilisearch";
```

## Typesense

`createDocSlurpTypesenseClient()` supports `collections(workspace).documents().search(params)` and `multiSearch.perform()` (up to 10 searches).

```ts
import { createDocSlurpTypesenseClient } from "@docslurp/contrib-search-compat/typesense";
```

## Pagefind

`createDocSlurpPagefind()` supports `search(term)` with lazy `data()` results. It requires `workspace` and a `resolveUrl` function that maps each citation to a public page URL.

```ts
import { createDocSlurpPagefind } from "@docslurp/contrib-search-compat/pagefind";
```

See the [search integrations guide](https://docslurp.io/docs/search-integrations) for contract limits, source routing, CMS and platform setup, and agent handoffs.
