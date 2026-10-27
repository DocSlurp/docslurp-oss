# Workspace settings from chat

The chat assistant can read supported workspace settings and prepare an exact
change when you ask for one. In suggestions mode it also offers a change on its
own when the turn's results show an ingestion or search problem it could fix.
Suggestions mode is on by default in the DocSlurp app (switch it off with the
composer's **Suggestions** toggle) and off for `/v1/chat` callers unless they
send `agent: {suggestions: true}` (see [Agent limits](search-api.md#agent-limits)).
It governs only the chat assistant: an MCP client can call
`proposeWorkspaceSettings` directly whenever its key allows it. A proposal does not save
settings. Review its before/after values, impact and work estimate, then select
**Apply** in the structured proposal card. Assistant prose and document content
cannot approve a change.

For example, ask “Turn on video frame analysis for this workspace.” The assistant
can call:

```json
{"changes":{"pipeline":{"mediaVideo":{"enabled":true}}}}
```

Other supported proposals include:

```json
{"changes":{"chat":{"answerStyle":"detailed","citations":true},"retrieval":{"resultCount":8,"useRerank":true}}}
```

`getWorkspaceSettings` reads the current saved values. `proposeWorkspaceSettings`
only prepares an actor-, conversation- and workspace-bound proposal. There is no
MCP or model tool that applies it. The authenticated UI posts the opaque token to
`POST /v1/workspaces/:workspaceId/settings-proposals/apply`, with a separate
`reprocessExisting` boolean. Tokens expire after ten minutes; expired or stale
proposals must be regenerated, rather than silently replanned or applied to a
new configuration.

Each proposal's `impact.reasons` is worded for the kind of change: answer
settings (`chat.*`) say they change how answers are written from the next
message, retrieval settings (`retrieval.*`) say they change how the next search
ranks and returns passages, and pipeline settings say whether they apply to new
uploads only or can also be applied to existing documents by reprocessing. None
of the chat or retrieval changes reprocesses documents.

Settings that affect existing indexed content show the affected work and cost
estimate. Existing-document reprocessing is unchecked by default and requires
separate explicit consent. If a change requires a reindex, Apply requires that
consent. If reprocessing is optional, leaving it unchecked changes the settings
without queuing that work. An unavailable estimate means unknown cost, not free
work. Video frame configuration currently applies to new uploads; this proposal
flow does not silently reprocess earlier videos. A queued job can remain blocked
by credits, budgets or policy; saving settings does not imply the job finished.

Supported pipeline toggles are video frames, chunk overlap, summaries, embeddings, vector
indexing, table/code/image preservation, PDF region extraction and vision
fallback, plus vision page selection: `vision.forceAllPages` (read every page with
vision, up to `vision.maxPagesPerDocument`, 1 to 32). Vision page selection is
what the [ingest report](api-sdk.md#ingest-report) recommends for scanned pages
that page triage skipped, so its `patch` can be proposed as
`{"changes":{"pipeline":{"visionFallback":true,"vision":{"forceAllPages":true,"maxPagesPerDocument":8}}}}`.
Its impact is `reindex-recommended`: it adds per-page vision cost and applies to
new uploads, existing files keep their text until you reprocess them (optional,
with the usual cost estimate and a separate consent), and reprocessing is never
required. Chat supports enabled state, context mode, answer style, citations and
instructions. Retrieval supports result count, reranking, diversification and
its balance, candidate depth and result ordering. Other settings—including
secrets, ownership, retention, budgets, privacy mode, model selection and
webhooks—are outside this tool's allowlist.

Workspace editor access is required. Server API keys additionally need
`workspaces:manage`, the correct organization and a matching workspace scope;
client and read-only keys cannot apply changes. Proposals also belong to the
current authenticated actor and conversation. The server checks permissions and
state again under its configuration lock, preserves unrelated nested settings,
and records the settings change and audit entry atomically. The next chat turn
reads saved state afresh; the assistant should verify it instead of assuming a
proposal was applied.
