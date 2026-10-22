# @docslurp/contrib-astro

[Package docs](https://docslurp.io/docs/packages/contrib-astro) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/contrib-astro) · [npm](https://www.npmjs.com/package/@docslurp/contrib-astro)

Add cited DocSlurp search to an Astro site with one component. It renders a small framework-free widget, so it needs no React hydration.

```astro
---
import DocSlurpSearch from "@docslurp/contrib-astro";
---
<!-- PUBLIC_DOCSLURP_CLIENT_KEY holds a browser key, safe to ship in page HTML. -->
<DocSlurpSearch clientKey={import.meta.env.PUBLIC_DOCSLURP_CLIENT_KEY} />
<!-- To search a named workspace: <DocSlurpSearch clientKey={...} workspace="product-manuals" /> -->
```

| Prop | Default | Notes |
| --- | --- | --- |
| `clientKey` | Required | A browser key: search-only and restricted to your allowed websites. Server keys are refused in the browser. |
| `workspace` | `default` | A workspace ID, slug (such as `product-manuals`) or name, or `default`, the key organization's default workspace. See [Workspaces](https://docslurp.io/docs/http#workspaces). |
| `apiUrl` | `https://docslurp.io` | The service origin. |
| `placeholder` | `Search documents…` | Search box placeholder. |

Use a browser key for public content. The same component is also exported as `@docslurp/sdk/astro`. For setup steps, see the [Astro guide](https://docslurp.io/docs/search-integrations/astro).

## Index your rendered Astro docs at build time

`@docslurp/contrib-astro/build` is an optional build integration for sites that use the **Astro Node standalone adapter**. After the build, it:

1. Renders the routes you list on a temporary local server.
2. Keeps each page's `<main>` content, including headings and code, and drops scripts, styles, navigation, asides and search controls.
3. Uploads the pages to DocSlurp, using each canonical page URL so a rebuild replaces the previous version instead of adding a duplicate. A content-based idempotency key makes retrying an identical submission safe.
4. Waits up to ten minutes for the run to finish.

Your server key is used only during the build. It never ends up in the generated files or public configuration.

```js
// astro.config.mjs (output: 'server' with the @astrojs/node standalone adapter)
import docslurpDocsIndex from '@docslurp/contrib-astro/build';

integrations: [docslurpDocsIndex({
  routes: ['/docs', '/docs/getting-started'], // List every public page to index.
  site: 'https://docs.example.com',           // Origin used for canonical page URLs.
  apiUrl: 'https://docslurp.io',
  apiKey: process.env.DOCSLURP_API_KEY,       // Server key with the ingest scope.
  workspace: 'Product documentation',          // ID, slug or name; created on the first build if none matches.
})]
```

Without `apiKey`, the build still writes `.docslurp/docs-index.json` and skips the upload. With a key, any indexing failure fails the build. A successful upload writes `docslurp-docs-search.json` (`{ "workspace": "<workspace ID>" }`) to the client output, so your search component can find it. Use `renderEnv` to pass environment variables that only the page renderer needs.

Pages are indexed as text: the upload asks for `{ visionFallback: false, preserveImages: false, summarize: true }`, so rendered HTML skips page images and vision and gets per-page summaries. Pass `pipeline` with other pipeline overrides to change that.

To index a site after it deploys (for example when the build has no API key), crawl the live pages instead:

```bash
DOCSLURP_API_KEY=... DOCSLURP_DOCS_WORKSPACE_ID=<workspace id> \
  node node_modules/@docslurp/contrib-astro/index-docs.mjs --site https://docs.example.com --routes routes.json --output .docslurp/docs-index.json
```

`--routes` is a file or URL with a JSON array of paths. Only those paths on the site's own origin are fetched, and redirects are refused. Elements marked `data-search-exclude` (repeated boilerplate) are left out of the index.

This integration does not render protected pages, discover dynamic routes, delete documents for removed pages, or support other Astro adapters, so list your public documentation routes explicitly. Keep public documentation in its own organization, and use keys from that organization for both indexing and search.

For how DocSlurp indexes its own website, see [Dogfood docs search](https://github.com/DocSlurp/docslurp-oss/blob/main/docs/docs-search.md).
