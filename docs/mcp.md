# DocSlurp MCP

Connect directly to `https://docslurp.io/v1/mcp` using Streamable HTTP. OAuth is the default interactive sign-in flow; unattended agents can use `Authorization: Bearer YOUR_SERVER_API_KEY`. Copy client-specific snippets from the profile's MCP section or [the MCP documentation](https://docslurp.io/docs/mcp). Browser widget keys do not grant MCP access.

Choose a tool based on the result you need:

| Tool | Result | AI generation |
| --- | --- | --- |
| `workspace.search` | Portable text passages with document/page citation metadata | None |
| `workspace.search-many` | Ordered results for up to 20 retrieval queries, with per-query errors | None |
| `workspace.chat` | Grounded answer, citations, conversation session and usage | Workspace-configured model |
| `workspace.ingest-report` | How the workspace's files processed: pages, text and images per page, vision, searchable pages with reasons, settings and recommendations | None |

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

Parallel retrieval defaults to at most four in-flight queries; set `concurrency` from 1 through 4 when needed. Each query supports optional `workspaceId`, `limit`, `documentId`, `filenameContains`, and comma-separated `tags`. The batch envelope is validated before retrieval starts. Results stay in input order:

```json
{
  "results": [
    {"ok":true,"data":{"results":[],"sessionId":"SEARCH_SESSION_ID","availability":{}}},
    {"ok":false,"error":{"code":"WORKSPACE_NOT_FOUND","message":"Workspace not found","status":404}}
  ]
}
```

The server also offers query suggestions, cross-workspace aggregate retrieval, and asynchronous automation tools. Discover their schemas with `tools/list`; tools outside your credential's scopes are omitted. Automation tools return operation handles for polling, while `workspace.chat` directly returns its answer.

The remote endpoint supports modern per-request MCP and stateless legacy Streamable HTTP clients. Stdio-only clients can use `docslurp mcp-server` from `@docslurp/cli`; its native REST adapters expose the same tools. Transport and adapter calls share the same authorization and search/chat implementation, without an internal network hop or forwarding credentials.

## Testing with Pi

Run `pnpm test:mcp` for the protocol tests and the Pi agent integration test in
`server/src/lib/mcp-pi.test.ts`. The integration test starts a loopback HTTP server
at `/v1/mcp` using the production MCP handler, discovers tool schemas with the
official MCP client, and wraps those tools for Pi's agent loop. It checks tool
arguments, result delivery to the next model turn, adapter errors, unexpected
backend failures, and argument validation against the discovered schema.

The test uses Pi's scripted faux model and a stub document backend. It needs no
API keys, database, or paid model calls. It covers agent/transport interoperability;
it does not exercise the mounted endpoint's authentication or document retrieval.

For an explicit paid smoke test, run `pnpm test:mcp:live` (or append
`--model z-ai/glm-5.3-flash` to select one model). This runs DeepSeek V4.1 Flash
and GLM 5.3 Flash through OpenRouter against the local production MCP handler
with synthetic suggestions. GLM uses low reasoning and the DeepInfra FP4 route.
The runner requires OpenRouter and Langfuse credentials from `.env`, checks the
live catalog prices, limits each model to three turns of 512 output tokens,
reserves at most $0.10 across the run, and disables automatic provider retries.

Each run saves model transcripts, tool results, provider billing receipts, a
scoped SQLite `usage_events` database, and a durable Langfuse outbox under
`.tmp/mcp-pi-live/`. Langfuse receives agent, generation and tool observations
with actual usage and available provider-reported costs. The runner verifies
observation counts by reading the traces back. Telemetry or billing reads never
replay a model call. The default command does not connect to production workspaces.

For an explicitly authorized production test, append
`--production --workspace WORKSPACE_ID`. This uses `https://docslurp.io/v1/mcp`
and `.env.production`'s database, creates a temporary organization-scoped
search-only API key, and revokes it during cleanup. The workspace's returned
suggestions are sent to OpenRouter and Langfuse. Model usage is also persisted
through the scoped production usage ledger. Baseline results and key-revocation
receipts are saved beside the run evidence; credentials are never saved in traces.

## Dashboard chat and WebMCP

Signed-in dashboard chat uses the same tool handlers with the current user's
permissions. Supported browsers also receive WebMCP tools through
`document.modelContext`; unsupported browsers retain the normal interface.
Neither path requires creating a server API key. Remote `/v1/mcp` remains
bearer-authenticated.

`ai.operation.get` accepts `{ "operationId": "<uuid>" }` and returns the current
operation snapshot, including pending approval or the final result. Use it to
poll automation submissions from tool-only clients. Automation schemas now expose
source URLs, dry runs, cost limits and advanced output controls through discovery.

See the integration notes and remaining tool gaps
for authentication boundaries, feature flags and the API parity roadmap.
