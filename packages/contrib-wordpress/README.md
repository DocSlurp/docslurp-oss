# DocSlurp Search for WordPress

[Plugin docs](https://docslurp.io/docs/search-integrations/wordpress) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/contrib-wordpress) · npm: not an npm package

A WordPress plugin that adds a `[docslurp_search]` shortcode backed by DocSlurp search. It is built from the [`@docslurp/sdk`](https://docslurp.io/docs/packages/sdk) widget and is MIT licensed.

## Install

1. Build the SDK and run `node scripts/package-wordpress-search.mjs` from the repository root.
2. Zip the `docslurp-search` directory (not its parent tests directory), upload it in WordPress Plugins, and activate it.
3. In Settings → DocSlurp Search, enter the HTTPS API origin, a workspace of deliberately public content, and a search-only **server** key.
4. Add `[docslurp_search]` to a page/post Shortcode block. The server key stays out of shortcode HTML and browser requests.
5. Test Unicode, no-match/error states, public source links, mobile layout, and host-level proxy rate limiting on your WordPress installation.

No automatic post ingestion/synchronization, membership gating, or global replacement of WordPress built-in search is included. Ingest published content through the native SDK/URL API and wait for indexing. Do not connect private posts to a public shortcode.

The REST proxy fixes workspace/limit, strips internal fields, rejects unsupported inputs, uses safe HTTPS requests without redirects, and returns generic upstream errors. Transient throttles are best-effort; configure CDN/host limits and DocSlurp key budgets. Rotate the protected WordPress option key through your normal secret process.

Validation (isolated PHP 8.3, no WordPress database required):

```sh
docker run --rm --network none -v "$PWD/packages/contrib-wordpress:/wordpress:ro" \
  php:8.3-cli-alpine php -l /wordpress/docslurp-search/docslurp-search.php
docker run --rm --network none -v "$PWD/packages/contrib-wordpress:/wordpress:ro" \
  php:8.3-cli-alpine php /wordpress/tests/plugin-test.php
node scripts/package-wordpress-search.mjs --check
```

The hook/proxy checks are not evidence of a deployed WordPress installation. Verify the plugin on your host/theme before production use. PHP 8+ is recommended. The bundled JavaScript is generated from the SDK widget; never edit it independently.
