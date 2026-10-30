# Workspace settings from chat

This is a feature of the DocSlurp app's signed-in chat only. The chat
assistant there can read supported workspace settings and prepare an exact
change when you ask for one. In suggestions mode it also offers a change on its
own when the turn's results show an ingestion or search problem it could fix.
Suggestions mode is on by default in the app (switch it off with the composer's
**Suggestions** toggle). A proposal does not save settings. Review its
before/after values, impact and work estimate, then select **Apply** in the
structured proposal card. Assistant prose and document content cannot approve a
change.

The settings tools are never available outside the app: not to API keys of any
type (server or publishable), MCP clients, the OpenAI-compatible endpoint,
capability tokens or the SDK, and `agent.suggestions` is ignored there (see
[Settings suggestions are app-only](search-api.md#settings-suggestions-are-app-only)).
The server decides this from authentication (a Better Auth session of the app),
never from a request field, so a product built on DocSlurp cannot hand these
tools to its own end users. To change settings from code, use
`PATCH /v1/workspaces/:id` with a server key that has `workspaces:manage`.

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
MCP or model tool that applies it. The app posts the opaque token to
`POST /v1/workspaces/:workspaceId/settings-proposals/apply` (signed-in sessions
only; API keys are refused), with a separate
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
fallback, plus processing quality: `quality` (`fast` reads the text layer only and
keeps scanned pages as page images, $0.05 per 1,000 pages; `auto`, the default, reads
each page the cheapest faithful way, $0.05 to $2.50; `good` reads every page with
vision, $2.50; there is no per-file page limit). Quality is what the
[ingest report](api-sdk.md#ingest-report) recommends for scanned pages that page
triage skipped or that Fast kept as images, so its `patch` can be proposed as
`{"changes":{"pipeline":{"visionFallback":true,"quality":"good"}}}`. A retired
`vision.forceAllPages: true` patch is accepted and proposed as `quality: "good"`;
`vision.forceAllPages: false` is proposed as `quality: "auto"` on a Good workspace
and changes nothing on any other.
Raising quality is `reindex-recommended`: it adds per-page cost and applies to
new uploads, existing files keep their text until you reprocess them (optional,
with the usual cost estimate and a separate consent), and reprocessing is never
required. Chat supports enabled state, context mode, answer style, citations and
instructions. Retrieval supports result count, reranking, diversification and
its balance, candidate depth and result ordering. Other settings—including
secrets, ownership, retention, budgets, privacy mode, model selection and
webhooks—are outside this tool's allowlist.

Workspace editor access is required, from a signed-in app session; no API key
can prepare or apply a proposal. Proposals also belong to the current
authenticated user, session and conversation. The server checks permissions and
state again under its configuration lock, preserves unrelated nested settings,
and records the settings change and audit entry atomically. The next chat turn
reads saved state afresh; the assistant should verify it instead of assuming a
proposal was applied.
