# DocSlurp MCP

Connect directly to `https://docslurp.io/v1/mcp` using Streamable HTTP. OAuth is the default interactive sign-in flow; unattended agents can use `Authorization: Bearer YOUR_SERVER_API_KEY`. Copy client-specific snippets from the profile's MCP section or [the MCP documentation](https://docslurp.io/docs/mcp). Browser widget keys do not grant MCP access.

Choose a tool based on the result you need:

| Tool | Result | AI generation |
| --- | --- | --- |
| `listWorkspaces` | Authorized workspaces, slugs, default, document/page counts and processing status | None |
| `upload` | Up to 10 presigned file PUT URLs, or start ingestion from remote URLs | Workspace ingestion settings |
| `completeUpload` | Verify uploaded files and start ingestion | Workspace ingestion settings |
| `suggestQueries` | Prior queries and suggestions | None |
| `search` | Portable text passages with document/page citation metadata | None |
| `chat` | Grounded answer, citations, conversation session and usage | Workspace-configured model |
| `getUploadStatus` | How the workspace's files processed: pages, text and images per page, vision, searchable pages with reasons, settings and recommendations | None |

Search and chat need only a question:

```json
{"q":"What are the support hours?"}
```

Without `workspaceId`, tools use the organization default workspace. Add `"workspaceId":"legal-contracts"` (a workspace slug; UUIDs, former slugs and `default` are also accepted) to target another workspace. See [Workspaces](https://docslurp.io/docs/http#workspaces).

Continue a chat by passing its returned `sessionId`. Search is independent of the answer model: pass the returned text and citations to any LLM for your own RAG workflow. Retrieval can incur embedding usage; chat additionally incurs generation usage. These tools require `search` scope and check workspace access against the authenticated organization.

Run multiple retrieval queries in one call:

```json
{
  "queries": [
    {"q":"Support hours?"},
    {"workspaceId":"legal-contracts","q":"Escalation process?"}
  ]
}
```

Parallel retrieval defaults to at most four in-flight queries; set `concurrency` from 1 through 4 when needed. Each query supports optional `workspaceId`, `limit`, `minScore` (relevance floor, 0 disables it; responses carry `noMatch` when nothing relevant remains), `documentId`, `filenameContains`, and comma-separated `tags`. The batch envelope is validated before retrieval starts. Results stay in input order:

```json
{
  "results": [
    {"ok":true,"data":{"results":[],"sessionId":"SEARCH_SESSION_ID","availability":{}}},
    {"ok":false,"error":{"code":"WORKSPACE_NOT_FOUND","message":"Workspace not found","status":404}}
  ]
}
```

Discover schemas with `tools/list`. `upload` and `completeUpload` require `ingest` scope; `listWorkspaces` and `getUploadStatus` accept `ingest` or `search`; retrieval, chat and suggestions require `search`. New default OAuth consent requests include ingest access; existing read-only connections must reauthorize with ingest scope to discover upload tools. Explicitly requested read-only scopes stay read-only. The `docslurp://capabilities` resource returns the same catalog with each tool's scopes.

## Upload files from an agent

1. Call `upload` with `files` metadata (1–10 files). Omit `workspaceId` for the default workspace, or explicitly request a new one with `workspaceName`:

   ```json
   {"files":[{"filename":"manual.pdf","mimeType":"application/pdf","sizeBytes":123456}]}
   ```

2. The response contains `sessionId` and `files`, each with an `id`, `putUrl`, `method`, required `headers`, and `expiresInSeconds`. PUT each file's raw bytes to its URL with its declared `Content-Type`. URLs expire after 15 minutes. Each file gets one URL, including large files (up to 5 GiB, subject to account limits). Keep signed URLs private. Local file paths and base64 are not tool arguments.
3. After every PUT succeeds, call `completeUpload` with `sessionId` and `fileIds`. The server verifies object sizes and starts ingestion only after all files complete. Use the returned workspace/run IDs with `getUploadStatus`, then `search` or `chat`. An already confirmed session cannot be submitted again.

For files already hosted online, call `upload` with `{"urls":["https://example.com/manual.pdf"]}`. This starts ingestion directly. An optional `idempotencyKey` deduplicates URL-ingestion retries; it does not apply to signed-upload session creation.

The remote endpoint supports modern per-request MCP and stateless legacy Streamable HTTP clients. Stdio-only clients can use `docslurp mcp-server` from `@docslurp/cli`; its native REST adapters expose the same tools. Transport and adapter calls share the same authorization and search/chat implementation, without an internal network hop or forwarding credentials.

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
  defaults to the MCP endpoint and any other value is refused.

## Dashboard chat and WebMCP

Signed-in dashboard chat uses the same tool handlers with the current user's
permissions. Supported browsers also receive WebMCP tools through
`document.modelContext` from `/v1/session-tools`, the same catalog with each
tool's `readOnly` and `consequential` hints (upload and completeUpload ask for
confirmation); unsupported browsers retain the normal interface. Set
`DOCSLURP_WEBMCP_ENABLED=false` to turn it off.
Neither path requires creating a server API key. Remote `/v1/mcp` remains
bearer-authenticated.



See the integration notes and remaining tool gaps
for authentication boundaries, feature flags and the API parity roadmap.

## Protocol and file-handling conventions

These are application tools over standard MCP, not a custom transport or a proposed MCP file-upload method. Metadata stays in bounded JSON tool arguments; file bytes go directly to storage. Signed PUT URLs are short-lived, per-object write credentials, not readable MCP resource links. Do not log or share them. Native intake sanitizes filenames, applies file-type and size policy, isolates storage keys and verifies stored size before ingestion. A completion call verifies the whole batch; it does not trust an agent's claim that PUT succeeded.

The catalog uses valid case-sensitive tool names, deterministic scope-filtered discovery, JSON Schema inputs, mutation annotations, structured results with text fallback, and `isError` for execution failures. Authorization remains enforced server-side independently of annotations; OAuth tokens are not forwarded to storage.

References: [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [MCP security](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices), [presigned URL guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/overview.html).

### One search surface

Use `search({ q: "notice period" })` for one query or `search({ queries: [{ q: "notice period" }, { q: "eligibility" }], concurrency: 2 })` for a batch. Batches accept 1–20 queries, preserve input order, and return `{ results: [{ ok, data?, error? }] }`. Put workspace and filters inside each query. The SDK and `POST /v1/search` accept the same two forms.
