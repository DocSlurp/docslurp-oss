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

Reads such as `getSettings` work with a browser key. Writes need a server key, so run them from a backend job or migration script, never in the browser:

```ts
const admin = docslurpAlgoliaClient({
  apiUrl: "https://docslurp.io",
  clientKey: process.env.DOCSLURP_API_KEY!, // A server key with the search scope. The option is named clientKey.
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
