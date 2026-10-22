// Run against a real, already-indexed workspace using a server search key:
// DOCSLURP_URL=... DOCSLURP_API_KEY=... [DOCSLURP_WORKSPACE=legal-contracts] node packages/sdk/examples/search-adapters.mjs
// Index/collection names take a workspace slug, UUID, or "default" (the organization default workspace).
import { createDocSlurpAlgoliaClient, createDocSlurpMeilisearchClient, createDocSlurpTypesenseClient, createDocSlurpPagefind } from '../dist/search-adapters.js';
const { DOCSLURP_URL: apiUrl = 'https://docslurp.io', DOCSLURP_API_KEY: clientKey, DOCSLURP_WORKSPACE: workspace = 'default' } = process.env;
if (!clientKey) throw new Error('Set DOCSLURP_API_KEY; never place server keys in browser bundles.');
const options = { apiUrl, clientKey };
const query = process.argv[2] ?? 'installation';
const algolia = await createDocSlurpAlgoliaClient(options).search([{ indexName: workspace, params: { query, hitsPerPage: 5 } }]);
console.log('Algolia hits:', algolia.results[0].hits.length);
const meili = await createDocSlurpMeilisearchClient(options).index(workspace).search(query, { limit: 5 });
console.log('Meilisearch hits:', meili.hits.length, 'bounded counts:', meili.docslurp.bounded);
const typesense = await createDocSlurpTypesenseClient(options).collections(workspace).documents().search({ q: query, query_by: 'text', per_page: 5 });
console.log('Typesense hits:', typesense.hits.length, 'usage:', typesense.docslurp.usage);
// Supply the actual public URL map from your app; this example uses canonical source URIs.
const pagefind = createDocSlurpPagefind({ ...options, workspace, resolveUrl: hit => {
  const uri = hit.citation.canonicalDocumentUri;
  if (typeof uri !== 'string') throw new Error('Provide a public document URL map for Pagefind.');
  return uri;
} });
const results = await pagefind.search(query);
if (results.results[0]) console.log('Pagefind source:', (await results.results[0].data()).url);
