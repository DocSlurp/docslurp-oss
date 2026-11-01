# DocSlurp MCP

Connect directly to `https://docslurp.io/v1/mcp` using Streamable HTTP. OAuth is the default interactive sign-in flow; unattended agents can use `Authorization: Bearer YOUR_SERVER_API_KEY`. Copy client-specific snippets from the profile's MCP section or [the MCP documentation](https://docslurp.io/docs/mcp). Browser widget keys do not grant MCP access.

Choose a tool based on the result you need:

| Tool | Result | AI generation |
| --- | --- | --- |
| `listWorkspaces` | Authorized workspaces, slugs, default, document/page counts and processing status | None |
| `upload` | Storage transfer descriptors for up to 10 files, small inline files, or direct server-side ingestion from remote URLs | Workspace ingestion settings |
| `completeUpload` | Optional single-PUT completion fallback; normal uploads finalize automatically | Workspace ingestion settings |
| `suggestQueries` | Prior queries and suggestions | None |
| `search` | Portable text passages with document/page citation metadata | None |
| `chat` | Grounded answer, citations, conversation session and usage | Workspace-configured model |
| `openUploader` | MCP Apps upload widget; only listed when `DOCSLURP_MCP_APPS_UI_ENABLED=true` ([details](#mcp-apps-uploader-openuploader)) | None |
| `getUploadStatus` | Session acceptance with `sessionId`, or how the workspace's files processed: pages, text and images per page, vision, searchable pages with reasons, settings and recommendations | None |

Search and chat need only a question:

```json
{"q":"What are the support hours?"}
```

Without `workspace`, tools use the organization default workspace. Add `"workspace":"legal-contracts"` (a workspace ID, slug or name: `"Legal Contracts"` finds the same workspace) to target another one. The `upload` tool creates the workspace when a name matches none of yours, so agents should pass a new name only when the user asks for a new workspace; every other tool answers `workspace_not_found`. See [Workspaces](https://docslurp.io/docs/http#workspaces).

Continue a chat by passing its returned `sessionId`. Search is independent of the answer model: pass the returned text and citations to any LLM for your own RAG workflow. Retrieval can incur embedding usage; chat additionally incurs generation usage. `search` requires the `search` scope and `chat` requires the `chat` scope; both check workspace access against the authenticated organization. OAuth clients get both unless they request narrower scopes (`search`, `chat`, `read`, `ingest`).

Run multiple retrieval queries in one call:

```json
{
  "queries": [
    {"q":"Support hours?"},
    {"workspace":"legal-contracts","q":"Escalation process?"}
  ]
}
```

Parallel retrieval defaults to at most four in-flight queries; set `concurrency` from 1 through 4 when needed. Each query supports optional `workspace`, `limit`, `minScore` (relevance floor, 0 disables it; responses carry `noMatch` when nothing relevant remains), `documentId`, `filenameContains`, and comma-separated `tags`. The batch envelope is validated before retrieval starts. Results stay in input order:

```json
{
  "results": [
    {"ok":true,"data":{"results":[],"sessionId":"SEARCH_SESSION_ID","availability":{}}},
    {"ok":false,"error":{"code":"WORKSPACE_NOT_FOUND","message":"Workspace not found","status":404}}
  ]
}
```

Read-only estimate tools (`updateEstimate`, `searchSettingsEstimate`, `reprocessEstimate`, `fullIndexEstimate`, `indexingModeEstimate`, `graphRebuildEstimate`, `uploadEstimate`) price an operation before you start it, and `getJob` reads a background job; `getJob` needs a `search` or `ingest` key. An estimate tool is listed only to keys that could perform the operation: `updateEstimate`, `indexingModeEstimate` and `graphRebuildEstimate` need `workspaces:manage` on a server key, `fullIndexEstimate` and `uploadEstimate` need `ingest`, `reprocessEstimate` needs `ingest` on a server key, and `searchSettingsEstimate` is available to signed-in sessions only. See [config-change jobs](config-change-jobs.md).

The remote endpoint supports modern per-request MCP and stateless legacy Streamable HTTP clients. Stdio-only clients can use `docslurp mcp-server` from `@docslurp/cli`; its native REST adapters expose the same tools. Transport and adapter calls share the same authorization and search/chat implementation, without an internal network hop or forwarding credentials.

## MCP Apps uploader (openUploader)

`openUploader` shows a file-upload widget inside hosts that render MCP Apps. The user drops local files into it, the widget uploads them straight to your object storage and shows processing progress. Use it when the user has files the model cannot read, such as attachments on their own machine.

Which hosts render it: hosts that implement the MCP Apps extension (`io.modelcontextprotocol/ui`), such as Claude on the web and desktop, and ChatGPT. Support varies by host and version, so check the host's own documentation. Hosts without MCP Apps support ignore the widget and keep working: the model falls back to `upload` with `urls`, or to the presigned PUT flow (`upload`, PUT, `completeUpload`).

What it does:

- `openUploader` is read-only. It resolves an existing workspace (default if omitted), lists up to 50 workspaces the caller may upload to and returns the limits (10 files per batch, 5 GiB per file). It never creates a workspace and never returns upload URLs. An unknown workspace name fails with `Workspace not found`.
- The workspace list and the resolved workspace follow the same rule as the upload route: members who can write to a workspace, and viewers of the default workspace, may upload. Viewers of other read-only shares may not, and those workspaces are not listed.
- The widget calls `uploadEstimate` and `upload` through the host, PUTs each file directly to the presigned URL from the browser, then calls `completeUpload` and polls `getUploadStatus`. The widget requests single-part uploads (`singlePart: true`), so every file is one PUT and the 32 MiB multipart threshold does not apply. The server rejects a single-part file over 5 GiB, so larger files fail at `upload`; use the CLI or SDK for those.
- Presigned URLs live 15 minutes (900 s). The widget does not send file bytes through DocSlurp or the MCP endpoint.
- Widget tool calls carry `_meta` `docslurp/origin: "mcp-app-upload"` and `docslurp/widgetVersion`. The server records both values in the MCP request log and span, so widget traffic can be told apart from model traffic. Only these two whitelisted values are recorded, never tool arguments. Hosts may strip `_meta`; a missing tag means the origin is unknown, not that the call came from the model.

### Enable it

| Variable | Default | Effect |
| --- | --- | --- |
| `DOCSLURP_MCP_APPS_UI_ENABLED` | `false` | When `false`, `openUploader` is missing from `tools/list` and the REST manifest, and `ui://docslurp/upload` is missing from `resources/list` and `resources/read`. Existing tools are unchanged. |
| `MCP_UI_CONNECT_DOMAINS` | empty | Comma-separated extra `http(s)` origins added to the widget's `connectDomains`. Entries that are not valid `http(s)` origins are dropped with a one-time warning in the server log. |

The flag accepts `1/true/yes/on` and `0/false/no/off`; other values count as off.

Set the flag to `true` and restart. To turn it off, unset it or set it to `false` and restart; no redeploy is needed. Hosts cache widget templates, so a host may keep showing a widget it already loaded until its cache expires. The resource URI is versioned by content: `ui://docslurp/upload/<first 12 hex characters of the SHA-256 of the widget source>`. Any widget change produces a new URI, the tool `_meta` points at it, and `resources/read` serves only the current URI, so hosts fetch the new widget on their next `tools/list`.

If the flag is on but the widget bundle is unavailable, `openUploader` is hidden on every surface (MCP, REST manifest, `/tools`, `POST /tools/openUploader`) rather than listed and broken.

### Changing the widget (contributors)

`server/src/mcp-ui/upload.html` is the authored source. The server serves a generated module, `server/src/mcp-ui/upload-bundle.generated.ts`, so it works when server code is bundled and no HTML file sits beside it. After editing `upload.html`, run `pnpm -C server build:mcp-ui` and commit both files; a test fails if they are out of sync. The widget's connect-src is a placeholder in the source and is filled in per request from the connect domains below (an empty list becomes `'none'`).

### Content Security Policy

The server returns `_meta.ui.csp.connectDomains` on the `ui://docslurp/upload` resource. The host enforces it; without it, a widget has no network access. The list contains only the origins your presigned URLs point at, derived from `STORAGE_URI`:

- With an `endpoint` parameter, the endpoint's origin. If `pathStyle=false`, also the bucket virtual-host origin (`https://<bucket>.<endpoint host>`).
- AWS S3 without `endpoint`: the regional origin (`https://s3.<region>.amazonaws.com`) and the virtual-hosted origin (`https://<bucket>.s3.<region>.amazonaws.com`).
- With `DOCSLURP_STORAGE_PUBLIC_BUCKET_URL`, also the HTTPS bucket-alias origin. The alias takes precedence over `STORAGE_PUBLIC_ENDPOINT` when signing both single PUTs and multipart parts.
- Plus every origin in `MCP_UI_CONNECT_DOMAINS`.
- If `STORAGE_URI` has an `endpoint` that is not a valid URL, the server logs it once and derives no storage domains; it does not fail other MCP requests.

The API and MCP origins are never included, and `*` is never used. The widget has no external scripts, fonts or images, so no `resourceDomains` are declared.

### Bucket CORS rule

The browser PUT is cross-origin, so the bucket must answer CORS preflight. Without a rule, the widget's uploads fail in the browser even though everything else works. Use one rule:

- `AllowedMethods`: `PUT` only.
- `AllowedHeaders`: `content-type` only. The widget sends the exact `Content-Type` that was signed.
- `ExposeHeaders`: `ETag`.
- No credentials. Presigned URLs need none.
- `AllowedOrigins`: either `*`, or an allowlist of host sandbox origins.

Why `*` is acceptable: CORS only controls which pages a browser lets read or send cross-origin requests. The presigned signature authorizes the write: it covers one object key and one `Content-Type` and expires after 15 minutes. Anyone holding a URL can already PUT with `curl`, so a wildcard origin gives nobody without a URL any new ability. Keep the rule PUT-only, and keep the bucket private for reads.

Tighter option: list the host sandbox origins. Claude renders MCP Apps on `*.claudemcpcontent.com` (the subdomain is derived from the MCP server URL), so `https://*.claudemcpcontent.com` covers it. ChatGPT's sandbox domain (documented as `*.oaiusercontent.com`) is unverified; confirm it against OpenAI's current documentation before relying on it. Desktop and IDE hosts may send an opaque `null` origin, which an allowlist cannot match; use `*` if you need those. Add your dashboard origin if the dashboard uploads to the same bucket, since it already PUTs presigned URLs from the browser.

Examples. The R2, Tigris and S3 syntax below comes from each provider's documentation; adjust bucket names and origins.

**Cloudflare R2** (`cors.json` for the dashboard JSON tab; this uses the PascalCase S3-style fields):

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 600
  }
]
```

Wrangler uses a different, lowercase file shape (`{"rules":[{"allowed":{"origins":[...],"methods":[...]}}]}`) and `npx wrangler r2 bucket cors set <BUCKET> --file cors.json`. R2's page documents only `origins` and `methods` for that shape, so set headers in the dashboard if you need to restrict them.

**Tigris** (S3 API; Tigris documents `PutBucketCors` through the AWS CLI with an `--endpoint-url https://fly.storage.tigris.dev`):

```bash
aws s3api put-bucket-cors --bucket YOUR_BUCKET \
  --endpoint-url https://fly.storage.tigris.dev \
  --cors-configuration '{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["PUT"],"AllowedHeaders":["content-type"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":600}]}'
```

Tigris evaluates rules in order and returns headers from the first match. Replacing the configuration replaces all rules, so include any existing rule (for example your app origin) in the same call. Tigris's page does not list `ExposeHeaders` in its field list; check with `aws s3api get-bucket-cors` that it was kept.

**AWS S3** (`cors.json`; the S3 console takes the bare array, `put-bucket-cors` takes the `CORSRules` wrapper):

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["content-type"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 600
    }
  ]
}
```

```bash
aws s3api put-bucket-cors --bucket YOUR_BUCKET --cors-configuration file://cors.json
```

To allowlist instead, replace `"*"` with `["https://*.claudemcpcontent.com"]` (S3 allows one `*` per origin string).

**MinIO**: MinIO documents bucket CORS for AIStor with an XML file; I could not confirm the same command on community builds, so run `mc cors set --help` first.

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>content-type</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

```bash
mc cors set myminio/YOUR_BUCKET cors.xml
```

Otherwise use the server-wide setting `MINIO_API_CORS_ALLOW_ORIGIN` (comma-separated origins, default `*`).

Self-hosted MinIO caveat: the Compose stack signs URLs against `http://minio:9000`, which only exists inside the Docker network. A browser cannot reach it, and an https widget cannot call plain http. Set `STORAGE_PUBLIC_ENDPOINT` to a browser-reachable origin that proxies to MinIO (for example `https://storage.example.com`). Upload URLs are then signed against that origin, and the widget's `connectDomains` uses it instead of `STORAGE_URI`'s endpoint. Server-side reads and writes still use `STORAGE_URI`. The proxy must pass the `Host` header through unchanged, because the signature covers it. The value must be a bare http(s) origin; anything else fails at startup. An https host (Claude, ChatGPT) cannot PUT to plain `http://`, so use https outside local testing.

### Rate limits

Every widget tool call is one POST to `/v1/mcp`. The limiter classifies by URL path, and every `/v1/mcp` path falls in the `search` bucket (`classifyRateLimitCategory`), so widget calls share the limit with the model's own searches. The widget polls `getUploadStatus` every 2 s at first, backing off to 5 s, pauses while the widget is hidden, and stops after 30 minutes or when the run finishes. One open widget uses roughly 12 to 30 calls per minute while polling. A 429, or a run paused for credits, slows polling to every 30 s; other transient errors back off up to 15 s. Uploads themselves go to the bucket and do not touch the limiter. Moving status polling into the `read` bucket is a planned follow-up.

## Upload files and follow completion

Call `upload` with file metadata, including the exact `sizeBytes`. Save its
`sessionId` and transfer bytes using the returned descriptors: one PUT for
`mode: "single"`, or the listed part URLs and byte ranges for `mode: "multipart"`.
Never send your DocSlurp API key or OAuth token to storage.

Call `getUploadStatus({ sessionId: "UPLOAD_SESSION_ID" })` until the session has
an accepted `result`, or reports `failed` or `aborted`. The server assembles
known-size multipart files and starts ingestion automatically. `completeUpload`
is an optional fallback for single-PUT sessions; it is not a required next step.

Acceptance means a run exists, not that extraction has finished. Follow the
returned run ID for processing progress. If a status request times out, check
the same session before starting another upload. For unknown-size streams, use
the SDK's `upload()` or the [HTTP stream completion flow](https://docslurp.io/docs/http#streams-without-a-known-size).

### Public URLs and clients without network access

For a file that is already public, call `upload({ urls: ["https://…/report.pdf"] })`.
DocSlurp's server downloads each URL itself with an SSRF-checked direct fetch. It
does not use the web search or crawl tools, and the agent needs no network access.
Redirects are refused, so pass the final URL.

Some hosted agents run code in a sandbox whose firewall blocks storage hosts, so
signed PUTs fail even though every other tool works. Allowing the upload host
(`f.docslurp.io` on hosted DocSlurp) in the client's network settings fixes the
PUT path. Without that, send small files inline:

```json
{ "inlineFiles": [
  { "filename": "notes.md", "text": "# Meeting notes\n…" },
  { "filename": "scan.pdf", "contentBase64": "JVBERi0xLjcK…" }
] }
```

Each item carries exactly one of `text` (UTF-8) or `contentBase64` (standard or
URL-safe). Up to 10 files and 512 KiB of decoded bytes per call fit the 1 MiB MCP
request limit. `mimeType` is optional; the extension decides when it is omitted.
Inline files go through the same intake as multipart uploads, so ingestion starts
immediately. The response carries workspace and run IDs for `getUploadStatus`;
there is no `sessionId`. Reuse `idempotencyKey` when you retry.

## Testing with real clients

`pnpm test:mcp` runs the MCP and OpenAI-compatible client tests. None of them needs
API keys, a database service or paid model calls: databases are migrated in-memory
Postgres (PGlite), models are scripted, and the document backend behind the tools is
a stub.

- `server/src/__tests__/mcp-oauth-client.db.test.ts` uses the official
  `@modelcontextprotocol/client` SDK over Streamable HTTP against the real OAuth
  routes and `/v1/mcp`: protected resource and authorization server discovery,
  dynamic client registration, PKCE authorization with consent, code exchange,
  `search` and `chat` tool calls, transparent refresh after the access token
  expires, revocation (`401` with `error="invalid_token"`), browser
  re-authorization after a dead refresh token, and refresh-token reuse handling.
- `server/src/__tests__/mcp-pi-agent.db.test.ts` runs the
  [Pi coding agent](https://pi.dev) (`@earendil-works/pi-coding-agent`) the way a
  user configures it: an `mcp.json` entry with only the endpoint URL. Pi's own MCP
  client signs in through its loopback OAuth callback (`/mcp login`), lists the
  DocSlurp tools, calls `search` in an agent turn with Pi's faux model, and refreshes
  the access token mid-session.
- `server/src/lib/mcp-pi.test.ts` wraps discovered tools for Pi's agent loop and
  checks argument validation and error delivery.
- `server/src/__tests__/chat-completions-openai-sdk.test.ts` drives `/v1/models` and
  `/v1/chat/completions` with the official `openai` SDK: `workspace:default` and
  `workspace:<slug>`, streaming to `[DONE]`, and the SDK's 401/404/400 error classes.

To try Pi against a running server by hand (a real sign-in in your browser; model
calls are billed by whichever provider Pi uses):

```bash
pi mcp add docslurp --url http://localhost:4321/v1/mcp   # or https://docslurp.io/v1/mcp
pi mcp login docslurp
pi mcp list                                             # connects and lists the tools
```

### OAuth behaviour clients rely on

- `GET` and `DELETE` on `/v1/mcp` answer `405` without asking for credentials: the
  server is stateless and offers no standalone SSE stream.
- A `401` carries `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`, plus
  `error="invalid_token"` when a token was presented but refused.
- Access tokens last 15 minutes and refresh tokens 30 days. Refresh tokens rotate on
  every use. Presenting an already-rotated refresh token within 30 seconds (two
  processes sharing a credential store, or a retried request) is refused without
  revoking anything; presenting it later revokes the whole grant, and the client must
  sign in again. Token errors are RFC 6749 JSON with an `error_description`, and the
  server logs `[mcp-oauth] token_rejected reason=…` without the token.
- Loopback redirect URIs may use any port (RFC 8252). The `resource` parameter
  defaults to the MCP endpoint and any other value is refused, except that the
  first-party DocSlurp CLI (`docslurp-cli`) may request the REST API (`<origin>/v1`).
  CLI tokens (`dscli_`) also work on `/v1/mcp`, a sub-resource; MCP tokens never
  work on the REST API. `docslurp mcp` uses a stored `docslurp login` without an
  API key. See [OAuth access tokens](api-sdk.md#oauth-access-tokens-cli-login).

## Dashboard chat and WebMCP

Signed-in dashboard chat uses the same tool handlers with the current user's
permissions. Its answering agent retrieves evidence through batch-shaped search calls
(including single-query batches) and synthesizes the answer itself; it does not
invoke the separate MCP `chat` answer generator as a nested tool. Chat-only API
keys retain the direct grounded-answer path without acquiring raw-search scope. Supported browsers also receive WebMCP tools through
`document.modelContext` from `/v1/session-tools`, the same catalog with each
tool's `readOnly` and `consequential` hints (upload and completeUpload ask for
confirmation); unsupported browsers retain the normal interface. Set
`DOCSLURP_WEBMCP_ENABLED=false` to turn it off.
Neither path requires creating a server API key. Remote `/v1/mcp` remains
bearer-authenticated.



See the integration notes and remaining tool gaps
for authentication boundaries, feature flags and the API parity roadmap.

## Protocol and file-handling conventions

These are application tools over standard MCP, not a custom transport or a proposed MCP file-upload method. Metadata stays in bounded JSON tool arguments; file bytes go directly to storage, except for small `inlineFiles` from clients that cannot reach it. Signed PUT URLs are short-lived, per-object write credentials, not readable MCP resource links. Do not log or share them. Native intake sanitizes filenames, applies file-type and size policy, isolates storage keys and verifies stored size before ingestion. The server verifies stored files before starting ingestion; it does not trust an agent's claim that PUT succeeded.

The catalog uses valid case-sensitive tool names, deterministic scope-filtered discovery, JSON Schema inputs, mutation annotations, structured results with text fallback, and `isError` for execution failures. Authorization remains enforced server-side independently of annotations; OAuth tokens are not forwarded to storage.

References: [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [MCP security](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices), [presigned URL guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/overview.html).

### One search surface

Use `search({ q: "notice period" })` for one query or `search({ queries: [{ q: "notice period" }, { q: "eligibility" }], concurrency: 2 })` for a batch. Batches accept 1–20 queries, preserve input order, and return `{ results: [{ ok, data?, error? }] }`. Put workspace and filters inside each query. The SDK and `POST /v1/search` accept the same two forms.
