# Search and chat API

`POST /v1/search` (or `GET /v1/search` with query parameters) returns ranked passages with citations. It doesn't generate an answer. The response is `{results, sessionId, availability, noMatch, relevanceFloor, usage}`.

Each result has a `score` (rank-based, so the top hit is always near 1) and a `relevance` from 0 to 1: the strength of the match itself, the best of the embedding similarity (rescaled above the embedding model's unrelated-text baseline) and the share of query terms found in the passage. Unlike `score`, `relevance` does not depend on the other hits, so it is comparable across queries.

- `q` (required): the query, up to 16,000 characters.
- `workspaceId`: omit it, or pass `default`, for your organization's default workspace. Otherwise pass a slug such as `legal-contracts`; UUIDs and former slugs also work ([Workspaces](https://docslurp.io/docs/http#workspaces)).
- `limit`: an integer from 1 to 100.
- `minScore`: the relevance floor, 0 to 1 (default 0.1, or the workspace's retrieval default; `SEARCH_MIN_SCORE` sets the server default; 0 turns it off). Results with a lower raw `relevance` are dropped. When the workspace is searchable but search returns nothing, `results` is empty and the response carries `noMatch: true` with `relevanceFloor: {minScore, dropped}`. That is either because nothing cleared the floor (`dropped` > 0) or because nothing was retrieved at all, for example a filter that matches nothing (`dropped` is 0). A caller can use it to say "no good match" instead of answering from weak passages. `/v1/chat` does this automatically.
- Filters: `documentId`, `runId`, `filenameContains`, `pageFrom`, `pageTo`, and comma-separated `tags` or `mimeTypes`.
- Retrieval flags such as `rerank`, `hyde` or `graphExpansion`: anything you omit (including `limit`) uses the workspace's retrieval defaults, and anything you pass wins.

With the defaults, local reranking and parent-section retrieval are on, and graph expansion follows the workspace pipeline. Provider-backed steps (HyDE, compression, query rewriting and decomposition, step-back, self-query) stay off unless the request or the workspace owner turns them on. Embedding the query can still use a provider; that usage is logged and reported in `usage`.

## Citation locators

Every citation (search results, `/v1/chat`, streamed chat citations, `/v1/chat/completions` extension data, Algolia-compatible hits) can carry `citation.locator`, a position inside the source keyed by `kind`:

| `kind` | Fields |
| --- | --- |
| `page` | `pageNumber`, `charStart`/`charEnd` (offsets in the page's extracted text), `boxes` (0 to 1 from the top-left) |
| `slide` | `slideNumber`, `slideCount`, `notes` (true for speaker notes), `title`, `boxes` |
| `sheet` | `sheetName`, `range` (A1, e.g. `B7:D8`; the whole table when exact source rows are unknown), `headerRow` |
| `media` | `media` (`audio` or `video`), `startSeconds`, `endSeconds`, `mode` (`said` or `shown`), `speaker`, `timing` (`word`, `segment` or `chunk`, the finest precision available), `frameSeconds` |
| `image` | `boxes` |

`locator` is `null` or absent for content indexed before locators existed and for sources with no finer position; re-index to get them. Recordings, decks and sheets have no meaningful page, so branch on `kind` instead of reading `pageNumber`. A locator carries at most 32 boxes. `GET /v1/documents/{id}` returns an optional `media` summary for audio and video: duration, word, speaker and segment counts, `timing`, `coverage`, `ingestCostCents`, `diarized`, and (when diarization was requested) `diarization` of `applied`, `skipped` or `failed` with a short `diarizationReason`.

## Partial results while files process

Search starts serving a document before its processing finishes. Once its text is chunked, keyword search covers it; vector search joins when indexing completes. Until every document in scope is ready, `availability.isPartial` is `true` and `availability.status` is `partial` (or `pending` when nothing is searchable yet). Chat responses (`/v1/chat`, the `docslurp` block of `/v1/chat/completions`) carry the same `availability` object.

| Field | Meaning |
| --- | --- |
| `status` | `empty`, `pending`, `partial` or `complete` |
| `isPartial` | `true` while documents in scope are still processing |
| `keywordOnly` | `true` when some searchable documents have keyword results only (no vectors yet) |
| `coverage.searchableDocuments` / `coverage.totalDocuments` | Documents search covered / documents in scope |
| `coverage.indexedDocuments` | Fully indexed documents (keyword and vector) |
| `coverage.keywordOnlyDocuments` | Documents served by keyword search ahead of vector indexing |
| `coverage.pageOnlyDocuments` | Documents served from page text only (progressive page indexing) |
| `coverage.inProgressDocuments` | Documents still processing |
| `coverage.searchablePages` / `coverage.totalPages` | Pages search covered / pages in scope |
| `message` | A sentence such as "Searching 31 of 48 pages (3 of 5 documents); 2 documents still processing, 1 keyword-only until vector indexing finishes." |

A replacement version (reprocess or re-upload) never serves early: the previous version keeps answering until the new one completes and replaces it in one step. Failed, cancelled and PII-blocked documents are never served. Responses with partial coverage aren't cached. Self-hosters can turn early keyword search off with `SEARCH_EARLY_LEXICAL=0`; it is on by default outside production.

Chunks reach keyword search once the embed stage has written every chunk row of a document and stamped it keyword-searchable. By default the worker does this after the embedding calls finish; set the worker variable `DOCSLURP_EARLY_LEXICAL_CHUNKS=on` (exact value, default off) to write the chunks before embedding starts, so a document is keyword-searchable for the duration of embedding. Serving is governed separately by the server's `SEARCH_EARLY_LEXICAL`, so both must allow it. When a failed document is retried, or embed re-runs, its previous marker is lifted until the replacement chunks are complete, and chunk rows left over from an attempt that produced more chunks are removed.

## Batch retrieval

`POST /v1/search` accepts either a single `{ q, ...filters }` input or a batch of search input objects. Supply exactly one form; batch workspace and filter options belong inside each query:

```json
{
  "queries": [
    {"q": "support hours", "limit": 3},
    {"q": "urgent incidents", "workspaceId": "operations-runbooks", "tags": "operations"}
  ],
  "concurrency": 4
}
```

The batch contains 1–20 queries; concurrency is an integer from 1 to 4, defaulting to 4. The entire envelope is validated before any retrieval starts. The response is `{results: [...]}`, preserving query order even when requests complete out of order. Each result is either `{ok: true, data}`, where `data` is a full search response, or `{ok: false, error: {code, message, status}}`. A valid batch returns HTTP 200 even when individual items fail. Invalid envelopes return HTTP 400.

Every item independently checks the API key's `search` scope and organization/workspace access. Item error codes include `FORBIDDEN` (403), `WORKSPACE_NOT_FOUND` (404), `INVALID_SEARCH_SCOPE` (400), and `SEARCH_FAILED` (500). Unexpected internal errors are sanitized. Disconnecting prevents queued retrieval from starting; in-flight retrieval may finish and record usage. Unstarted items carry `REQUEST_ABORTED` (499) if a response remains deliverable.

## Errors

Errors raised while handling `/v1/search*` and `/v1/chat` (not the OpenAI-compatible `/v1/chat/completions`) answer with one envelope:

```json
{"error": {"code": "invalid_request", "message": "Please check the information you entered and try again.", "details": {"issues": [{"path": "queries.0.q", "message": "...", "code": "invalid_value"}]}, "requestId": "req_123"}}
```

`code` is a closed set you can branch on: `invalid_request`, `unauthorized`, `forbidden`, `not_found`, `workspace_not_found`, `conflict`, `payload_too_large`, `rate_limited`, `payment_required`, `credit_exhausted`, `workspace_budget_paused`, `org_budget_paused`, `minimum_credit_required`, `plan_not_entitled`, `chat_disabled`, `invalid_search_scope`, `unavailable`, `internal`. `message` is reviewed copy for people and may change; `details.issues` names the request fields that failed validation; quote `requestId` in support requests. The SDK exposes `DocSlurpApiError.code` and `.requestId`. Per-item batch errors keep their own `{code, message, status}` shape (above).

Requests rejected before routing — invalid authentication, rate limiting, widget CORS, or the body-size limit — may answer with a middleware-specific body instead. When they do, `error.code` can be absent, so treat `DocSlurpApiError.code` as best-effort for those responses and fall back to `status`.

## Grounded chat

`POST /v1/chat` is the canonical workspace chat endpoint. Send `{q, workspaceId?, sessionId?, model?}`; an omitted `workspaceId` means your organization's default workspace. `sessionId` and `model` are nonempty strings of at most 256 characters; all fields are checked before model calls. The response includes an answer, citations, and the chat session ID. For streaming, use `/v1/chat/completions` with `stream: true`; omit it for the JSON fallback.

Independent conversations can run concurrently. Await each reply before reusing its `sessionId` for the next turn. Simultaneous turns in the same conversation have no ordering guarantee. Session ownership must be verified before a caller-provided session can be reused; a database failure fails closed.

All routes use the existing authenticated request actor. API keys remain scoped to their organization and require `search` permission. Batch execution uses direct service calls, without internal HTTP calls or forwarding credentials.

## Retrieval usage and cost

Successful GET/POST `/v1/search` responses include `usage`. Batch responses expose it in each successful item's `data.usage`; MCP `search` accepts the same single or batch forms and returns the same fields.

| Field | Meaning |
| --- | --- |
| `inputTokens`, `outputTokens`, `totalTokens` | Recorded tokens for the retrieval request, including enabled AI enhancements |
| `costCents` | Recorded AI cost in US cents; preserves fractional cents |
| `currency` | `USD` |
| `costSource` | `provider`, `estimate`, `mixed`, `unknown`, or `none` when no AI usage was recorded |
| `scope` | `retrieval` |

This is request metadata, not an invoice. It excludes ingestion, storage, and calls to your own model. Provider-reported costs and estimates remain distinguishable; zero recorded usage does not mean every service operation is free. Native chat's `usage` describes answer generation.

The TypeScript SDK supports direct `for await (const hit of client.search(input))`. Save the search and await it after iteration to read `usage` and `sessionId` without sending a second request.
