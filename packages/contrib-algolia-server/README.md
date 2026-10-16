# @docslurp/contrib-algolia-server

[Package docs](https://docslurp.io/docs/packages/contrib-algolia-server) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/contrib-algolia-server) · [npm](https://www.npmjs.com/package/@docslurp/contrib-algolia-server)

Sync Algolia-style settings, synonyms, rules and imports into DocSlurp from a backend job, migration script or API adapter. `createDocSlurpAlgoliaServerClient()` wraps [`@docslurp/contrib-search-compat/algolia`](https://docslurp.io/docs/packages/contrib-search-compat) and adds `searchIndex`, `syncSettings`, `syncSynonyms` and `syncRules`. Use it with a server key; writes are refused for browser keys.

## Install and use

```bash
pnpm add @docslurp/contrib-algolia-server
```

```ts
import { createDocSlurpAlgoliaServerClient } from "@docslurp/contrib-algolia-server";

const client = createDocSlurpAlgoliaServerClient({
  apiUrl: "https://docslurp.io",
  clientKey: process.env.DOCSLURP_API_KEY!, // A server key. The option is named clientKey.
});

const res = await client.searchIndex("product-manuals", { query: "invoice" });
await client.syncSynonyms("product-manuals", [{ type: "synonym", synonyms: ["invoice", "bill"] }]);
```

The index name is a DocSlurp workspace slug, UUID or `default`. For browser search, use [`@docslurp/contrib-search-compat`](https://docslurp.io/docs/packages/contrib-search-compat) with a browser key; see the [Algolia compatibility guide](https://docslurp.io/docs/algolia).

## License

MIT (see [LICENSE](LICENSE)), like the client packages such as `@docslurp/contrib-search-compat`.
