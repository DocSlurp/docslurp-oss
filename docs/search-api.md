# Search and chat API

`POST /v1/search` (or `GET /v1/search` with query parameters) returns ranked passages with citations. It doesn't generate an answer. The response is `{results, sessionId, availability, noMatch, relevanceFloor, usage}`.

Each result has a `score` (rank-based, so the top hit is always near 1) and a `relevance` from 0 to 1: the strength of the match itself, the best of the embedding similarity (rescaled above the embedding model's unrelated-text baseline) and the share of query terms found in the passage. Unlike `score`, `relevance` does not depend on the other hits, so it is comparable across queries.

- `q` (required): the query, up to 16,000 characters.
- `workspaceId`: omit it, or pass `default`, for your organization's default workspace. Otherwise pass a slug such as `legal-contracts`; UUIDs and former slugs also work ([Workspaces](https://docslurp.io/docs/http#workspaces)).
- `limit`: an integer from 1 to 100.
- `minScore`: the relevance floor, 0 to 1 (default 0.1, or the workspace's retrieval default; `SEARCH_MIN_SCORE` sets the server default; 0 turns it off). Results with a lower raw `relevance` are dropped. When the workspace is searchable but search returns nothing, `results` is empty and the response carries `noMatch: true` with `relevanceFloor: {minScore, dropped}`. That is either because nothing cleared the floor (`dropped` > 0) or because nothing was retrieved at all, for example a filter that matches nothing (`dropped` is 0). A caller can use it to say "no good match" instead of answering from weak passages. `/v1/chat` does this automatically.
- Filters: `documentId`, `runId`, `filenameContains`, `pageFrom`, `pageTo`, and comma-separated `tags` or `mimeTypes`.
- Retrieval flags such as `rerank`, `hyde` or `graphExpansion`: anything you omit (including `limit`) uses the workspace's retrieval defaults, and anything you pass wins.

Search only returns each document's current version; older versions are archived for reading ([versions and retention](document-versions.md)). During a re-index after a config change, documents are served from their previous index until each is rebuilt ([config-change jobs](config-change-jobs.md)).

With the defaults, local reranking and parent-section retrieval are on, and graph expansion follows the workspace pipeline. Provider-backed steps (HyDE, compression, query rewriting and decomposition, step-back, self-query) stay off unless the request or the workspace owner turns them on. Embedding the query can still use a provider; that usage is logged and reported in `usage`.

When `selfQuery` is enabled, `budget tag:finance` searches for `budget` within documents tagged `finance`. Tag labels are case sensitive; quote labels containing spaces, for example `budget tag:"Finance Team"`. Explicit caller `tags` filters take precedence over labels in the query. Consumed labels are excluded from retrieval text, reranking, relevance scoring and derived model prompts; diagnostics retain the original query. Malformed labels and queries containing only tag labels return HTTP 400.

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

The batch contains 1–20 queries; concurrency is an integer from 1 to 8, defaulting to 4 (inside chat, the turn's `agent.searchConcurrency` caps it). The entire envelope is validated before any retrieval starts. The response is `{results: [...]}`, preserving query order even when requests complete out of order. Each result is either `{ok: true, data}`, where `data` is a full search response, or `{ok: false, error: {code, message, status}}`. A valid batch returns HTTP 200 even when individual items fail. Invalid envelopes return HTTP 400.

Every item independently checks the API key's `search` scope and organization/workspace access. Item error codes include `FORBIDDEN` (403), `WORKSPACE_NOT_FOUND` (404), `INVALID_SEARCH_SCOPE` (400), and `SEARCH_FAILED` (500). Unexpected internal errors are sanitized. Disconnecting prevents queued retrieval from starting; in-flight retrieval may finish and record usage. Unstarted items carry `REQUEST_ABORTED` (499) if a response remains deliverable.

## Errors

Every error from the native JSON API (`/v1/*`, including authentication, rate limits, CORS and request-size rejections) answers with one envelope:

```json
{"error": {"code": "invalid_request", "message": "Please check the information you entered and try again.", "details": {"issues": [{"path": "queries.0.q", "message": "...", "code": "invalid_value"}]}, "requestId": "req_123"}}
```

`code` is a closed set you can branch on:

- Request and access: `invalid_request`, `unauthorized`, `forbidden`, `not_found`, `workspace_not_found`, `conflict`, `payload_too_large`, `session_required`, `invalid_search_scope`, `chat_disabled`, `model_not_allowed`.
- Limits: `rate_limited`, `spend_limit_exceeded`, `daily_page_limit`, `ip_temporarily_blocked`.
- Billing: `payment_required`, `credit_exhausted`, `workspace_budget_paused`, `org_budget_paused`, `minimum_credit_required`, `plan_not_entitled`.
- Uploads: `unsupported_type`, `file_too_large`, `unreadable_source`.
- Organizations: `organization_not_found`, `organization_forbidden`, `organization_conflict`, `personal_organization`, `membership_exists`, `membership_forbidden`, `membership_not_found`, `last_owner`, `ownership_transfer_required`, `user_not_found`.
- Anything else: `unavailable` and `internal`.

`message` is reviewed copy for people and may change. `details` is optional and holds only `issues` (the request fields that failed validation) and limit metadata: `retryAfterSeconds`, `category`, `policy`, `limitCents`, `spentCents` on 429s, and `maxBytes` (with `directUpload` on multipart uploads) on 413s. Rate-limit responses also keep `Retry-After`, `RateLimit-Policy` and `RateLimit`. Quote `requestId` in support requests. The SDK exposes `DocSlurpApiError.code` and `.requestId`. Per-item batch errors inside a successful `200` keep their own `{code, message, status}` shape (above).

Protocol surfaces keep the shapes their clients already parse: the OpenAI-compatible `/v1/chat/completions` and `/v1/models`, the MCP endpoint (`/v1/mcp`, JSON-RPC), OAuth (`/oauth/mcp/*`), the search compatibility adapters (`/compat/*`) and the Stripe webhook.

## Grounded chat

`POST /v1/chat` is the canonical workspace chat endpoint. Send `{q, workspaceId?, sessionId?, model?, retrieval?, filters?, agent?}`; an omitted `workspaceId` means your organization's default workspace. `sessionId` and `model` are nonempty strings of at most 256 characters; all fields are checked before model calls. The response includes an answer, citations, and the chat session ID. For streaming, use `/v1/chat/completions` with `stream: true`; omit it for the JSON fallback.

### Model

Omit `model` to use the default (`z-ai/glm-5.3-flash`). Any workspace chat catalog model (`z-ai/glm-5.3-flash`, `anthropic/claude-haiku-5.5`, `deepseek/deepseek-v4.1-flash`, `openai/gpt-6.1-sol`, `openai/gpt-6-luna`) is accepted from anyone. Any other value returns HTTP 400 with code `model_not_allowed`; the server never substitutes the default for a model you named. The same check applies to the streaming chat route (before the stream opens) and the dashboard chat routes.

Operators can list extra OpenRouter ids in `DOCSLURP_CHAT_EVAL_MODELS` (comma-separated; `:free` suffixes allowed) for model evaluations. Only platform admins can request them: a session whose verified email is in `ADMIN_EMAILS`, or a server API key owned by such a user. Client (publishable) keys and organization owners or admins do not qualify. For an evaluation account that should not be a platform admin, list its organization in `DOCSLURP_CHAT_EVAL_ORG_IDS` (comma-separated org ids): a turn whose workspace is owned by a listed organization may then use the eval models and the full `agent` limit range, from a session or a server API key (never a client key). The workspace's owning organization decides, not the caller's memberships, and the setting grants nothing else. When the configuration loads, the server logs and drops ids that match the Pro/Ultra prohibition, ids without a verified price in `packages/shared/src/chat-model-prices.ts` (mirrored from `scripts/lib/model-prices.json`), and ids whose output price is $50 per million tokens or more. An eval model answers on its own: if it fails, chat does not fail over to another model.

### Agent limits

When the search agent answers (the default for `/v1/chat` with `DOCSLURP_PUBLIC_CHAT_AGENT_ENABLED` on and no document, type, tag or date filters), `agent` bounds that turn:

| Field | Default | Range | Meaning |
|---|---|---|---|
| `maxSteps` | 6 | 1–12 | Model calls in the loop. The last one runs with tools disabled, so the agent always ends with an answer. |
| `maxToolCalls` | 12 | 1–24 | Tool calls across the turn. Later calls get `{error, code: "tool_call_limit", limitReached: true}` instead of running. |
| `searchConcurrency` | 4 | 1–8 | Upper bound on the search tool's parallel `queries`, and the value it uses when the model omits `concurrency`. |

Platform admins, and turns in a `DOCSLURP_CHAT_EVAL_ORG_IDS` organization's workspace, can use the full range. For everyone else, a value above the default is lowered to the default and listed in `debug.limits.clamped`; lower values apply as sent. Out-of-range values or unknown fields return HTTP 400 `invalid_request`.

Agent responses add these `debug` fields (other turns omit them):

| Field | Meaning |
|---|---|
| `requestedModel` | The `model` you sent, or `null` |
| `resolvedModel` | The `model` field of OpenRouter's last response (the routed build, for example `deepseek/deepseek-v4.1-flash-20261017` behind the `deepseek/deepseek-v4.1-flash` alias), falling back to the SDK's response model id |
| `resolvedProvider` | The upstream provider OpenRouter routed to, when it reports one |
| `steps` | Model steps run |
| `toolCallCount`, `toolCallsRefused` | Tool calls executed, and calls refused by `maxToolCalls` |
| `searchCallCount`, `searchQueryCount` | Search tool calls, and retrieval queries counting each item of a parallel batch |
| `zeroHitSearchCount` | Search calls that returned no results |
| `stepUsage` | Per step: `{step, model, finishReason, inputTokens, outputTokens, costCents?, toolCalls}` |
| `toolCalls` | Per tool call, in order (refused calls included): `{id, name, status, runtimeMs, queries?, resultCount?, zeroHit?, evidencePages?, costCents?, errorCode?}`. `queries` are the search strings the model sent (never put on spans); `evidencePages` lists the distinct `{documentId, pageNumber}` of the evidence that call returned; `errorCode` is `tool_call_limit`, `invalid_arguments`, `aborted`, `exception`, the tool's own error code or `http_<status>`. |
| `limits` | `{maxSteps, maxToolCalls, searchConcurrency, clamped}` as applied |
| `stopReason` | See below |

On agent turns, `usage.costCents` is the **provider cost** in USD cents of the agent's own model calls (the OpenRouter receipt, or an estimate from verified list prices when the receipt is missing; `usage.costSource` says `provider`, `estimate` or `mixed`). It is not customer credits; credits are derived from the recorded usage events by the rate card. It excludes tool work: the provider cost the tools report for their own work (query embeddings, rewrites, HyDE, reranking, nested answers) is in `usage.toolCostCents` and per call in `debug.toolCalls[].costCents`, and is recorded as separate usage events. A turn's total provider cost is `costCents + toolCostCents`; cached search responses report 0.

`stopReason` is chosen deterministically, without reading the answer's meaning. The first rule that matches wins:

1. `timeout` (the 120-second agent budget ran out) or `error` (any other failure). Both appear only in traces and metrics, because the HTTP response is then an error.
2. `tool_call_limit`: at least one tool call was refused.
3. `step_limit`: the loop ended mid tool call, or the last step ran with tools disabled right after a tool-calling step. With `maxSteps: 1`, tools are disabled from the start, so that does not count as a limit hit.
4. `no_evidence`: the agent searched and every search returned zero results.
5. `answered_without_citations`: the agent searched, but the answer has no `[n]` citation.
6. `answered`: everything else, including answers that needed no search.

```bash
curl -sS -X POST "$DOCSLURP_URL/v1/chat" -H "Authorization: Bearer $DOCSLURP_API_KEY" -H "Content-Type: application/json" \
  -d '{"q": "Which plan covers on-call pagers?", "model": "anthropic/claude-haiku-5.5", "agent": {"maxSteps": 4, "maxToolCalls": 6, "searchConcurrency": 2}}'
```

```json
{
  "answer": "The Team plan covers pagers [1].",
  "debug": {
    "model": "anthropic/claude-haiku-5.5",
    "requestedModel": "anthropic/claude-haiku-5.5",
    "resolvedModel": "anthropic/claude-haiku-5.5",
    "resolvedProvider": "Anthropic",
    "steps": 2, "toolCallCount": 1, "toolCallsRefused": 0,
    "searchCallCount": 1, "searchQueryCount": 2, "zeroHitSearchCount": 0,
    "stopReason": "answered",
    "stepUsage": [
      {"step": 0, "model": "anthropic/claude-haiku-5.5", "finishReason": "tool-calls", "inputTokens": 1830, "outputTokens": 61, "costCents": 0.021, "toolCalls": ["search"]},
      {"step": 1, "model": "anthropic/claude-haiku-5.5", "finishReason": "stop", "inputTokens": 4120, "outputTokens": 92, "costCents": 0.046, "toolCalls": []}
    ],
    "limits": {"maxSteps": 4, "maxToolCalls": 6, "searchConcurrency": 2, "clamped": []}
  }
}
```

### Agent traces

With OpenTelemetry export on, each agent turn emits spans on the `docslurp.chat` tracer that follow the OpenTelemetry GenAI conventions. Attributes hold ids, counts, enums and scores, never prompt, answer or document text.

- `invoke_agent workspace-chat`: `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=workspace-chat`, `gen_ai.provider.name=openrouter`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.request.max_tokens`, summed `gen_ai.usage.input_tokens`/`output_tokens`, `gen_ai.response.finish_reasons`, `gen_ai.conversation.id` (the chat session), `docslurp.chat.steps`, `.tool_calls`, `.tool_calls_refused`, `.search_calls`, `.search_queries`, `.zero_hit_searches`, `.stop_reason`, `.cost_usd`, `.upstream_provider`, `docslurp.chat.limit.max_steps`/`.max_tool_calls`/`.search_concurrency`, and `docslurp.workspaceId`, `docslurp.orgId`, `docslurp.requestId`.
- `chat <model>` per model step (child, kind client): `gen_ai.operation.name=chat`, `docslurp.chat.step`, per-step usage, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons` and `docslurp.chat.cost_usd`.
- `execute_tool <tool>` per tool call (child): `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type=function`, `docslurp.chat.session_id`, and `error.type` on failure (`tool_call_limit` for a refused call). Search calls add `docslurp.rag.query_count`, `.concurrency`, `.result_count`, `.top_score`, `.zero_hit`, `.document_count` (distinct documents) and `.search_session_id`.

The agent span also copies the W3C baggage keys `eval.run_id`, `eval.case_id`, `eval.model` and `eval.arm` from the request's `baggage` header (other keys are ignored; values are capped at 128 characters). `/v1/chat` responses carry a `traceparent` header for the request's trace when tracing is on, so clients can join a turn to its trace.

The `api.search` retrieval spans those calls create carry `docslurp.chat.session_id`, and their `search_sessions.metadata` and search usage events record `chatSessionId`. Metrics: the `docslurp.chat.agent.duration` histogram (seconds, by `gen_ai.request.model` and `docslurp.chat.stop_reason`) and the `docslurp.chat.agent.tool_calls` counter (by `gen_ai.request.model` and `gen_ai.tool.name`).

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


## Search caches

Two in-process caches cut repeated-query latency. Both are per server process and per organization; an entry is never visible to another organization.

- **Query-embedding cache** (on by default). Keyed by organization, provider, runtime, endpoint, model, dimensions, normalization and the query text after trimming and collapsing whitespace (case is preserved). The cache stores only a hash of that key. A hit skips the provider call and records no usage event, so `usage` and `usage_events` still count only provider calls actually made. Workspaces in `strict-privacy` mode always call through, because that mode writes an audit row for every private embedding call; `standard` and `local-only` use the cache. Set `SEARCH_EMBEDDING_CACHE_MAX_ENTRIES` (default 1000, `0` disables) and `SEARCH_EMBEDDING_CACHE_TTL_SECONDS` (default 3600).
- **Vector-result cache** (off by default). Keyed by organization, each LanceDB table's version, the query-vector hash, document scope, `limit` and ANN tuning, so a write to a table produces a new key. Results from a partially failed search are not cached. Enable with `SEARCH_RESULT_CACHE_MAX_ENTRIES` (default 0) and tune `SEARCH_RESULT_CACHE_TTL_SECONDS` (default 30). A hit can be as stale as the LanceDB read-consistency interval (`LANCEDB_READ_CONSISTENCY_SECONDS`, default 30 s) plus the TTL.
- **Privacy and tracing.** `strict-privacy` never reads or writes either cache. The `embed.cache` and `lancedb.result_cache` spans carry `docslurp.privacy.mode`, `docslurp.cache.hit`, `docslurp.cache.bypassed` and `docslurp.cache.bypass_reason` (`strict-privacy`, or `no-org` for the embedding cache), and search timings count `embedCacheBypass` / `resultCacheBypass`.

Hits and misses appear as `embedCacheHit`/`embedCacheMiss` and `resultCacheHit`/`resultCacheMiss` counters in search timings, in the session diagnostics (`embeddingCache`), as `[search-cache]` log lines, and as `embed.cache` and `lancedb.result_cache` spans (`docslurp.cache.hit`).

## Candidate depth and result order

`GET /v1/search` and single or batch `POST /v1/search` accept two optional controls:

- `candidateDepth`: integer from 1 to 200. Bounds each evidence adapter's contribution and the fused candidate window before the relevance floor. This window is independent of `rerank` and the returned `limit`; a depth smaller than the output limit can return fewer hits. Filtering and the relevance floor can reduce the window further; there is no automatic refill.
- `resultOrder`: `"relevance"` keeps the selected results in ranked order; `"prompt"` places high-ranked passages at the beginning and end for prompt assembly. It changes placement of the selected passages, not membership. This does not measure generated-answer quality.

For an equal-candidate comparison, hold `candidateDepth`, `limit`, filters and floor constant while toggling `rerank`:

```json
{
  "q": "pump maintenance interval",
  "workspaceId": "manuals",
  "candidateDepth": 100,
  "limit": 10,
  "rerank": false,
  "resultOrder": "relevance"
}
```

Both controls are also optional workspace retrieval defaults and per-request/thread chat retrieval overrides. The SDK exposes them on `SearchInput`; MCP schemas derive them from the same request contract. Search Session metadata records the chosen controls and adapter, fused-window, floor and ranking-depth counts.

Omitting both controls preserves existing behavior: rerank-enabled searches acquire and rank up to 200 candidates, while rerank-disabled acquisition follows the result limit. Existing postprocessing packs its selected results; unprocessed fusion returns relevance order. Explicit controls are opt-in so this interface change does not claim a new ranking default based on exposed development evaluations. Scores remain the existing reciprocal output-position scores, and confidence is not a calibrated probability of answer correctness.

### Optional hosted learned reranking

Workspace search settings can explicitly select DeepInfra's pointwise
`Qwen/Qwen3-Reranker-0.6B`. Omitted provider settings continue to use local BM25.
With the operator's `DEEPINFRA_API_KEY` configured, an authorized workspace owner
can opt in through `PATCH /v1/workspaces/:workspaceId/search-settings`:

```json
{
  "retrievalDefaults": {
    "useRerank": true,
    "rerankProvider": "deepinfra",
    "rerankModel": "Qwen/Qwen3-Reranker-0.6B",
    "candidateDepth": 100,
    "resultOrder": "relevance"
  }
}
```

Set `rerankProvider` to `"bm25"` to restore local ranking; a request with
`rerank:false` makes no reranker call. Provider/model selection is a workspace
setting, not an arbitrary per-request URL or credential. Search and workspace
chat share the post-retrieval implementation. Existing output-score and citation
contracts are retained; provider scores only choose candidate ordering.

The hosted path preserves the original query and candidate bodies/identities,
uses batches of at most 25 pairs with up to four requests in flight. One shared
provider request deadline covers all waves: 15 seconds by default. Operators may
set `SEARCH_RERANK_CONCURRENCY` (clamped to 1–4) and
`SEARCH_RERANK_TIMEOUT_MS` (clamped to 1,000–30,000 ms); invalid noninteger values
use the defaults. Two concurrent waves cover a full 200-candidate pool at the
default concurrency, instead of eight serial calls. This is scheduling arithmetic,
not a new provider latency measurement. Each pair is bounded to 30,000 combined
UTF8 bytes as a conservative input limit; overlength inputs fall back without
silently truncating evidence. Privacy modes that forbid hosted calls, missing
keys, invalid configuration, exhausted budgets, timeout, malformed output and
provider failures fall back to BM25 without retries. Privacy and scoped spend
checks run before every dispatch. A failure stops new dispatches; every already
dispatched sibling is awaited and its actual returned usage recorded before
fallback or a metering error reaches the caller. A late successful response cannot
clear another request’s unknown-charge diagnostic. Equal provider scores retain
original candidate order regardless of response order. An explicit
`candidateDepth` still controls the same acquisition/ranking pool independently
of the provider. This integration does not assert a corpus-quality improvement.

Search Session diagnostics include `hostedRerank` status, fallback reason,
request/candidate counts, actual tokens, configured concurrency/timeout, duration, and
`possibleUnreceiptedCharge` plus `unreceiptedRequests` when failed calls have no
provider usage receipt.
Raw provider errors, keys and document bodies are excluded from diagnostics.
Actual returned tokens, including billable HTTP failures, are recorded through
that Search Session's usage journal and persisted with its org/workspace/session
scope. A broken usage recorder fails the search instead of hiding a lost usage
event. Provider cost uses the verified default-tier rate of $0.01/M input tokens;
customer ledger charges follow normal billing policy and can differ from provider
cost. [DeepInfra model/pricing](https://deepinfra.com/Qwen/Qwen3-Reranker-0.6B).

Local integration tests exercise actual `hybridSearch`, workspace settings,
authorization, migrated Postgres spend checks, citation mapping and persisted
usage with a mocked provider. They also verify rerank-off, privacy-blocked,
credit-blocked and outsider requests make no provider calls. No deployment or
provider corpus evaluation follows from enabling the implementation in source.

Workspaces that index on demand (page map or page images) add a `deferred` stats block to search results; see [Deferred indexing modes](deferred-indexing.md).
