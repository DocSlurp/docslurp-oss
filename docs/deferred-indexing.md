# Deferred indexing modes

By default DocSlurp parses and indexes every page when a file is uploaded (`full`). Two opt-in modes defer most of that work until a query needs it, trading first-query latency for a much cheaper upload. The modes ship behind `DOCSLURP_DEFERRED_PROFILES=1`; with the flag off, `indexingMode` is accepted but treated as `full`.

Design: [deferred search profiles](superpowers/specs/2026-10-12-deferred-search-profiles-design.md). Embedding evidence: [page-image embeddings](research/cheap-search-page-embeddings-2026-10-12.md).

## Modes

| `indexingMode` | Shown as | Up front | At query time |
| --- | --- | --- | --- |
| `full` | Full index | Every page parsed and indexed | Nothing extra (always hot) |
| `map` | On demand · page map | Reads structure pages (outline, contents, index, glossary) and builds a page map | Parses the pages the map points to |
| `visual` | On demand · page images | Embeds every page image (no parsing) | Parses the pages image search finds |

`map` and `visual` are PDF-only for now. Indexed pages are never thrown away: a per-page ledger records what is mapped, embedded, parsed and indexed, independent of the mode.

## Defaults

- **Starter organizations** (only the free starter credits): `map`. They can pick `visual` (never a default: no template or credit balance selects it for you). `full` is allowed while the organization can spend credits (including starter credits); otherwise the API returns 402 with `code: "credits_required_for_full_index"`.
- **Funded organizations** (have bought credits): `full`. `map` and `visual` are always available.

Pages are billed as they are indexed, at the same per-page prices as `full` (5 credits per 1,000 text pages, 250 per 1,000 pages read by OCR or embedded as images). A page is billed once, whether a query or a full index materializes it.

The mode is resolved most-specific first: the upload request's `indexingMode` (those documents only), the workspace setting, the workspace template's recommendation, then the organization default. The mode is stored per document, so one workspace can hold documents ingested under different modes.

## Switching modes

Set it with `PATCH /v1/workspaces/:id { "indexingMode": "map" }`, or in workspace settings (a three-option control with a cost hint). The switch never marks existing chunks stale.

| From to | What happens | Cost |
| --- | --- | --- |
| `map` or `visual` to `full` | A full-index job indexes every unindexed page | Estimated and shown before you confirm |
| `full` to `map` or `visual` | New uploads follow the new mode; existing documents stay fully indexed (hot) | None |
| `map` to `visual` | Background job embeds page images for existing documents; the map keeps serving meanwhile | `page-embedded` events, estimated first |
| `visual` to `map` | Background job builds maps for existing documents; page vectors keep serving meanwhile | `page-mapped` events, estimated first |

**Index everything** (activity line in the chat home) and the full-index API request the same job. The UI always shows the estimate and asks for a second confirmation before spending.

## Query-time spend policy

Each query that materializes pages is bounded by a `MaterializationPolicy`:

| Field | Meaning | Client-key default |
| --- | --- | --- |
| `maxPagesPerQuery` | Pages a single query may materialize | 40 |
| `maxCreditsPerQuery` | Credit ceiling per query | 25 |
| `deadlineMs` | Results available at the deadline are returned with pending pages listed; work continues in the background | 20000 |
| `allowFullIndexRequest` | Whether the caller may request a full index | `false` (server keys: `true`) |
| `allowAgentDiscovery` | Allow the page-map agent to read more pages at query time | `true` |
| `mapRouter` | LLM routing over the page map: `off`, `auto`, `always` | `always` |
| `maxPagesPerDay` | Reserved. Accepted and stored, **not enforced yet** | none |

### Precedence

The effective policy is resolved in this order, and **the most restrictive value wins** at each step (lowest number, AND of booleans, and the lower router setting, with `off` < `auto` < `always`):

1. Workspace default (`searchRetrievalDefaults.materialization`).
2. API key policy (`materializationPolicy`, editable under Advanced in API key settings, with the effective policy shown read-only).
3. Capability token (below). A token can only narrow its issuer's policy, never widen it.

A query that is blocked by policy or by credits does not fail: it returns the results already indexed and reports why in `deferred.stoppedBy`.

## Capability tokens

A server (holding a server key with the `search` scope, or a dashboard session) mints a sealed token so a browser or edge client can search directly with a narrower policy. Client keys cannot mint.

```bash
curl -X POST https://docslurp.io/v1/capabilities \
  -H "Authorization: Bearer $DOCSLURP_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceIds": ["ws_01hxyz"],
    "policy": { "maxPagesPerQuery": 20, "maxCreditsPerQuery": 10, "allowFullIndexRequest": false },
    "ttlSeconds": 900,
    "boundClientKeyId": "key_client_123",
    "allowedOrigins": ["https://app.example.com"]
  }'
# {"token":"...","expiresAt":"2026-10-13T20:00:00.000Z","policy":{...}}
```

The client then sends the token with its search requests:

```bash
curl -X POST https://docslurp.io/v1/search \
  -H "Authorization: Bearer $DOCSLURP_CLIENT_KEY" \
  -H "X-DocSlurp-Capability: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"limitation of liability","workspace":"ws_01hxyz"}'
```

The token is AES-256-GCM sealed and expires within one hour (`ttlSeconds` defaults to and is capped at 3600).

Security notes:

- Without `boundClientKeyId` and `allowedOrigins` the token is a **bearer token**: whoever holds it can use it until it expires.
- `allowedOrigins` checks the `Origin` header, which is spoofable outside browsers. Treat it as a guard against other websites, not against a determined non-browser client.
- Tokens issued from a dashboard session are not re-validated for the user's workspace membership before `exp`. Keep the TTL short.

## Streaming materialization

When a search needs pages that are not indexed yet, the search stream emits:

| SSE event | Meaning |
| --- | --- |
| `page-materializing` | Pages were claimed and are being parsed and indexed |
| `page-ready` | A page is now searchable |
| `materialize-failed` | A page failed (it is retried by later queries) |

Polling fallback for clients without SSE: `GET /v1/searches/:sessionId/materialization` returns the same progress (pages pending, ready and failed).

## Search response: `deferred` stats

Search responses for workspaces with deferred documents add a `deferred` block:

| Field | Meaning |
| --- | --- |
| `temperature` | `cold`, `warm` or `hot` (below) |
| `candidatePages` | Pages the locator selected |
| `indexedCandidatePages` | Candidate pages that were already indexed before the query |
| `materializedPages` | Pages parsed and indexed by this query |
| `pendingPages` | Pages still materializing when the deadline hit |
| `materializeMs` | Time spent materializing, in milliseconds |
| `creditsSpent` | Credits spent materializing pages for this query |
| `routerUsed` | The LLM map router ran for this query |
| `fallbackUsed` | The bounded coarse fallback ran because no candidate was confident |
| `stoppedBy` | `policy`, `credits` or `deadline` when a limit ended materialization early, otherwise `null` |

Each result carries `retrieval.stage`, how it was found: `chunk` (full index), `page-text`, `map-node` or `page-image`.

Temperature is computed over the candidate pages C:

- **cold:** no page in C was indexed before the query.
- **warm:** some pages in C were indexed.
- **hot:** every page in C was indexed. Fully indexed documents are always hot.

## Page-image embedding is opt-in

Embedding page images is the expensive pass (billed per page), so it runs only when you explicitly ask for it:

- `indexingMode: "visual"`, chosen by hand. Switching to it shows an estimate that includes the embedding cost; you confirm by saving.
- `pipeline.visualPages.coarseFallback: true` (default `false`), an advanced toggle under the page-map option. With it on, `map` mode also embeds the uncovered pages of scanned documents whose map covers little. With it off, `map` mode makes no embedder calls, even for scanned documents.

`full` mode never runs the page-embed stage. Templates never set either option, and neither affects version hashes.

## Visual pages: embedding models

Pages are rendered at a 1024 px long edge (never upscaled), JPEG quality 85, embedded, and the rasters discarded. Stored per page: sign bits (Hamming first stage, top 200) plus int8 for rescoring. Route `auto` prefers a registered Jina v5 omni nano private endpoint and falls back to Gemini Embedding 2 (needs `GOOGLE_GENERATIVE_AI_API_KEY`; not allowed in strict privacy modes). Page images are never embedded on Fly performance CPUs.

- **Jina via vLLM:** serve the model with `--hf-overrides '{"task":"retrieval"}'`, or it runs as a generic model and the vectors are wrong. Queries use the prompt `Query: ` and pages `Document: `.
- **Gemini:** send the query text with **no task prefix**. A prefix lowers recall.

The query must be embedded by the same model as the pages.

## Configuration

See `.env.example`: `DOCSLURP_DEFERRED_PROFILES`, `TEMPORAL_MATERIALIZE_TASK_QUEUE`, `WORKER_MATERIALIZE_CONCURRENCY`, `DOCSLURP_PAGE_MAPPED_FEE_USD` (internal cost only, never billed), `DOCSLURP_EST_PAGE_MATERIALIZE_CREDITS` (per-page budget estimate; defaults to the Rich page price), `DOCSLURP_FULL_INDEX_CREDITS_PER_PAGE` and `GOOGLE_GENERATIVE_AI_API_KEY`.
