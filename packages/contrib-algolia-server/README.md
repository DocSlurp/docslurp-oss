# @docslurp/contrib-algolia-server

[Package docs](https://docslurp.io/docs/packages/contrib-algolia-server) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/contrib-algolia-server) · [npm](https://www.npmjs.com/package/@docslurp/contrib-algolia-server)

Sync Algolia-style settings, synonyms, rules and imports into DocSlurp from a backend job, migration script or API adapter. `createDocSlurpAlgoliaServerClient()` wraps [`@docslurp/contrib-search-compat/algolia`](https://docslurp.io/docs/packages/contrib-search-compat) and adds `searchIndex`, `syncSettings`, `syncSynonyms` and `syncRules`. Use it with a server key; writes are refused for browser keys.

## License

SSPL-1.0 with an Apache-2.0 grant for each version three years after release (see [LICENSE](LICENSE)). Unlike the client packages (`@docslurp/contrib-search-compat`, MIT), this server-side adapter follows the DocSlurp server license.
