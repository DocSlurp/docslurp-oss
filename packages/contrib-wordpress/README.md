# DocSlurp Search for WordPress

[Plugin docs](https://docslurp.io/docs/search-integrations/wordpress) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/contrib-wordpress) · npm: not an npm package

A WordPress plugin that adds a `[docslurp_search]` shortcode backed by DocSlurp search. It is built from the [`@docslurp/sdk`](https://docslurp.io/docs/packages/sdk) widget and is MIT licensed.

## Install

1. Zip the `docslurp-search` directory (not its parent tests directory): `cd packages/contrib-wordpress && zip -r docslurp-search.zip docslurp-search`. It ships a prebuilt copy of the SDK widget, so there is no build step.
2. Upload the zip in WordPress Plugins and activate it.
3. In Settings → DocSlurp Search, enter the HTTPS API origin (default `https://docslurp.io`), a workspace ID, slug or name of deliberately public content (blank uses the organization's default workspace), and a search-only **server** key (`dslp_priv_…`). A browser key (`dslp_pub_…`) is rejected and the previous key kept.
4. Add `[docslurp_search]` to a page/post Shortcode block. The server key stays out of shortcode HTML and browser requests.
5. Test Unicode, no-match/error states, public source links, mobile layout, and host-level proxy rate limiting on your WordPress installation.

No automatic post ingestion/synchronization, membership gating, or global replacement of WordPress built-in search is included. Ingest published content through the native SDK/URL API and wait for indexing. Do not connect private posts to a public shortcode.

The REST proxy (`POST /wp-json/docslurp/v1/search`, body `{ "q": "…" }`) fixes the workspace and a limit of 6 results, accepts queries of at most 500 characters, disables query expansion, strips internal fields, uses safe HTTPS requests without redirects, and returns generic upstream errors. Throttles (30 searches per visitor and 120 in total per minute) are counted atomically (the object cache's increment, or one `UPDATE` on the options table) and a search that cannot be counted is refused with 503. The visitor is the connection's `REMOTE_ADDR`; behind a reverse proxy or CDN list its address or CIDR range under "Trusted reverse proxies" in the settings, and the visitor becomes the first `X-Forwarded-For` address (from the right) that is not a listed proxy. A header from an unlisted peer is never believed. Still configure CDN/host limits and DocSlurp key budgets. Rotate the protected WordPress option key through your normal secret process.

Validation (isolated PHP 8.3, no WordPress database required):

```sh
docker run --rm --network none -v "$PWD/packages/contrib-wordpress:/wordpress:ro" \
  php:8.3-cli-alpine php -l /wordpress/docslurp-search/docslurp-search.php
docker run --rm --network none -v "$PWD/packages/contrib-wordpress:/wordpress:ro" \
  php:8.3-cli-alpine php /wordpress/tests/plugin-test.php
pnpm --filter @docslurp/sdk test   # checks the bundled widget matches the SDK build
```

The hook/proxy checks are not evidence of a deployed WordPress installation. Verify the plugin on your host/theme before production use. PHP 8+ is recommended. The bundled `search-widget.js` is the SDK build of `@docslurp/sdk/widget` (`packages/sdk/dist/search-widget.js`) followed by one `defineDocSlurpSearch();` call; never edit it independently.
