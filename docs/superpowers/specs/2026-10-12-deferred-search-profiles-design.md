# Deferred search profiles: Index Map and Visual Pages

> Historical design record, classified 2026-10-20. Implementation landed in
> [3334f3f3](https://github.com/DocSlurp/docslurp-oss/commit/3334f3f3).
> Current guidance: [deferred indexing guide](../../deferred-indexing.md).
> The original proposal, rollout instructions and test intentions below are
> retained for context; they are not current implementation or deployment status.

Date: 2026-10-12. Original status: design for review. Branch: `feat/cheap-deferred-search`.
Evidence: `docs/research/cheap-search-page-embeddings-2026-10-12.md`.

## 1. Intent

Two opt-in, ultra-cheap workspace indexing profiles that defer most ingestion
work until a query needs it, trading first-query latency for cost.

- **Index Map** (`map`): read only the structural pages of a document
  (outline, table of contents, index, glossary, front/back matter) to build a
  page map, then parse and index only the pages queries point at. A 4,000-page
  compendium may need ~30 page images up front.
- **Visual Pages** (`visual`): rasterize and embed **every** page image
  with a multimodal embedding model (compact binary vectors), search those, and
  parse/index only the pages that queries retrieve.

What the user asked for (verbatim requirements):

- Processing is **query-driven**: pages are materialized when a query needs them.
  Users can explicitly request a full index; it is deferred by default.
- Search stats distinguish **cold / warm / hot** queries.
- The two profiles are **separate paths** with different prerequisites.
- Requirements are expressed so a future planner can **work backwards** from an
  end state and job scope to the steps required.
- Map discovery is **agent-guided page siphoning** (small page windows, an agent
  decides whether to continue and which ranges to queue), not a fixed % sample.
- Query-time spend limits are configurable **per API key** and via a
  **server-sealed payload** so clients can connect to DocSlurp directly.
- All ten gotchas from the 2026-10-12 review are resolved in this design.

Assumptions (correct if wrong):

- Default remains the full pipeline; the profiles are per-workspace opt-in.
- Map-first ships first; Visual Pages follows (it needs query-time multimodal
  embedding). Jina commercial licensing is assumed to be in place.
- Everything ships behind `DOCSLURP_DEFERRED_PROFILES=1` in a draft PR.

Non-goals: a general-purpose goal planner (only its seam, §2.13); audio/video;
changing the default full pipeline's behaviour.

## 1.1 Choosing an indexing mode

One setting, three choices, the same everywhere (API, SDK, CLI, MCP, settings UI):

| `indexingMode` | Shown as | Up front | At query time |
| --- | --- | --- | --- |
| `full` | **Full index** | every page parsed and indexed | nothing extra (always hot) |
| `map` | **On demand · page map** | reads structure pages (outline, contents, index, glossary) | parses the pages the map points to |
| `visual` | **On demand · page images** | embeds every page image (no parsing) | parses the pages image search finds |

Defaults by account:

- **Free plan**: `map`. Free accounts may pick `visual`; `full` is allowed while
  the org has spendable credits (including starter credits) and is otherwise
  refused with a clear 402-style reason.
- **Paid plans or purchased credits**: `full` by default; `map` and `visual` are
  always available.

Where it is set, most specific wins:

1. Upload request `indexingMode` (applies to those documents only).
2. Workspace setting (`PATCH /v1/workspaces/:id { indexingMode }`).
3. Workspace template (templates may recommend a mode; never locked).
4. Org plan default (above).

The mode is recorded **per document** at ingest (`documents.indexing_mode`), so a
workspace can hold documents ingested under different modes and search handles
each with its own locator (§2.7).

### Changing the mode later (always allowed)

Indexed pages are never thrown away; the page ledger (§2.1) is mode-independent.

| From → to | What happens | Cost |
| --- | --- | --- |
| `map`/`visual` → `full` | a full-index job for every unindexed page (§2.11) | priced and shown before confirming |
| `full` → `map`/`visual` | new uploads follow the new mode; existing documents stay fully indexed (hot) | none |
| `map` → `visual` | background job embeds page images for existing documents; the map keeps serving until it finishes | page-embedding events, estimated first |
| `visual` → `map` | background job builds maps for existing documents; page vectors keep serving until then | page-mapped events, estimated first |

`indexingMode` and `materialization` are excluded from the pipeline version hash
(like `restartFromStage`/`stageSubset` in `withoutStageSelection`), so switching
modes never marks existing chunks stale in `index-staleness`.

### New-workspace UX impact (small)

- No new step in the upload-first flow: drops still create or append to a
  workspace exactly as today; the mode comes from the precedence above.
- Workspace settings get one three-option control with a one-line cost/latency
  hint per option and a cost estimate when switching.
- Workspace picker rows and the selected-workspace header show the mode badge and
  coverage (e.g. "On demand · map · 12% indexed").
- The ingestion activity line for deferred workspaces says pages are processed
  when asked, with an **Index everything** action showing the estimated cost.
- API/SDK `newWorkspace` uploads accept `indexingMode`; the OpenAPI schema and
  SDK types gain the enum.

## 2. Shared foundation (both profiles need it)

### 2.1 Page state ledger

New table `document_page_states` (migration), one row per (document, page):

| column | meaning |
| --- | --- |
| `document_id`, `page_number` (PDF physical index, 1-based) | key |
| `page_label` | printed label (`xii`, `412`, `A-3`) when known |
| `label_source` | `pdf-page-labels` / `ocr-calibrated` / `none` |
| `mapped` | page appears in a document map node (Index Map) |
| `embedded_at`, `embedding_model` | page-image vector exists (Visual Pages) |
| `state` | `unseen` → `claimed` → `parsed` → `pii-checked` → `indexed`, or `failed`/`blocked-pii` |
| `claimed_by_run`, `claim_expires_at` | idempotent claim (§2.3) |
| `materialized_by` | `ingest` / `query` / `full-index` |
| `cost_credits` | credits spent materializing this page |

`document_pages` keeps page text; the ledger is the single source of truth for
"is page N searchable". Workspace and document coverage (% pages indexed,
% mapped) are rollups of this table.

### 2.2 Page-scoped runs (gotcha 3, part)

A run gains `pageScope`: `{ kind: "all" }` (today) or
`{ kind: "pages", pages: number[] }` or `{ kind: "agent", budget }`.
`compilePipelinePlan` already declares stage inputs/outputs; this design adds
the page dimension:

- `split-pages`, `render-images`, `extract-markdown`, `vision-extract`,
  `pii-detect`, `embed`, `page-index`, `index` accept a page set. The PDF
  primitives already exist (`renderSelectedPages`, `contiguousPageRanges`,
  `extractPdfPageRange` via qpdf, per-page `pdftotext`).
- Artifacts become append-per-page: markdown/chunks/vectors for pages N..M are
  written as page-keyed rows, and `index` **appends** page-scoped vector rows
  instead of rewriting the document (removes `alwaysRerun` for page-scoped
  runs; keyed by `(document_id, page_number, chunk_index)`).
- Whole-document artifacts (canonical document, markdown manifest) are built
  lazily as the union of materialized pages, marked `partial: true` with
  coverage until all pages are indexed.

### 2.3 Materialization lane (gotcha 3)

`materializePages({ documentId, pages, reason, policy })`:

- Claims pages with `UPDATE … WHERE state IN ('unseen','failed') OR claim_expires_at < now()`
  so concurrent queries never double-parse; pages already claimed are awaited,
  not re-run.
- Runs on a dedicated high-priority Temporal task queue (`materialize`) with a
  small warm worker pool, one activity per contiguous page range, bypassing
  full-run admission overhead but still recording a run row (`kind: "materialize"`)
  so usage, cost and artifacts attribute normally.
- Streams progress over the existing search/chat SSE channel
  (`page-materializing`, `page-ready`, `materialize-failed` events) with a
  polling fallback (`GET /v1/searches/:sessionId/materialization`).
- Query-time deadline (default 20 s, policy-configurable): results available at
  the deadline are returned with `pending` pages listed; materialization
  continues in the background and later queries benefit (warm).

### 2.4 Query cost policy, per key and sealed payload (gotcha 4 + user addition)

A `QueryMaterializationPolicy`:

```ts
{ maxPagesPerQuery: number;        // default 40
  maxCreditsPerQuery: number;      // default 25 (= $0.25)
  maxPagesPerDay?: number;
  mapRouter: "always" | "auto" | "off"; // default "always" (§3.5)
  deadlineMs: number;              // default 20000
  allowFullIndexRequest: boolean;  // default false for client keys
  allowAgentDiscovery: boolean }   // Index Map siphoning at query time
```

Resolution is **most-restrictive-wins** across, in order:

1. Workspace default (`searchRetrievalDefaults.materialization`).
2. **API key policy**: new `api_keys.materialization_policy jsonb` (server and
   client keys). Client keys default to **40 pages and 25 credits per query**;
   every field is editable under **Advanced** in the API key settings (dashboard
   and key-management API), with the effective resolved policy shown read-only
   next to it.
3. **Sealed client capability** for direct browser/edge connections: a server
   (holding a server key) mints `POST /v1/capabilities` → an opaque AES-256-GCM
   token (same construction as `app/src/api/lib/file-tokens.ts`, distinct AAD
   `docslurp:search-capability:v1`) carrying `{ orgId, workspaceIds, policy,
   issuedByKeyId, boundClientKeyId?, allowedOrigins?, exp (≤ 1 h), jti }`.
   Clients send it as `X-DocSlurp-Capability`. The API decrypts, checks expiry,
   origin, binding and that the issuing key is still live, then narrows the
   policy. A token can only **narrow** the issuer key's policy, never widen it.
   Optional per-`jti` spend counters enforce `maxCreditsPerQuery` across
   retries.

Before any materialization: `canSpend` (degrade to "no materialization,
pending listed") and per-query reservation against `maxCreditsPerQuery` using the
same reservation mechanism as `admitRunSpend`. Usage is recorded through the
worker usage ledger on the materialize run, with
`UsageScope { orgId, workspaceId, sessionId, runId }`, so spend attributes to
both the run and the search session.

### 2.5 Billing semantics (gotcha 4)

The per-page base fee (`DOCSLURP_PAGE_BASE_FEE_USD`) is charged per
**materialized** page, not per uploaded page. Deferred profiles add two small
priced events: `page-mapped` (Index Map, per page actually read) and
`page-embedded` (Visual Pages, per page image embedded). Rates go in
`CREDIT_RATE_CARD` only after `pnpm pricing:validate` and a load-test comparison
(CLAUDE.md "Pricing & Capacity Changes").

### 2.6 Per-batch PII and privacy gates (gotcha 5)

- `pii-detect` runs per materialized page batch before `index`; pages failing
  policy go to `blocked-pii` and are never indexed or returned.
- Visual Pages embeds images **before** any text exists. It is therefore
  unavailable when `privacyMode` is on or the PII policy is `block`, and the
  workspace settings UI says why. Under `redact_artifacts`, page vectors are
  only a locator: results are never returned from a page until its text has
  passed the per-batch PII check.
- Quarantine/malware scanning still runs on the whole file at upload.

### 2.7 Result fusion and provenance (gotcha 7)

Workspaces can mix fully indexed documents (text chunks), Index Map documents
(map hits + materialized chunks) and Visual Pages documents (page vectors +
materialized chunks). Candidate lists from each retriever are merged with the
existing RRF (`app/src/api/search/rrf.ts`), never by raw score. Every result
carries `retrievalStage`: `chunk` / `page-text` / `map-node` / `page-image`, plus
`temperature`, so citations and the UI show how it was found.

### 2.8 Whole-document features in lazy workspaces (gotcha 8)

| Feature | Behaviour in deferred profiles |
| --- | --- |
| Workspace self-titling | From the map (Index Map: title page + ToC) or first page text (Visual Pages); never forces full parse |
| Document summary | Index Map: summarise the map itself; Visual Pages: deferred until full index; labelled "partial" |
| Structured extraction, GraphRAG, entity/proposition index | Disabled until full index; settings show "requires full index" with a one-click request |
| Download as Markdown | Available for materialized pages, with explicit "N of M pages" coverage |

### 2.9 Coverage and fallback (gotcha 9)

- Index Map records **map coverage** = pages reachable from any map node / total
  pages. Below a threshold (default 85%), uncovered ranges get a coarse layer:
  born-digital text → cheap text embedding of those pages; scanned → sparse
  page-image sampling with the Visual Pages model.
- Every query that ends with zero confident candidates triggers a bounded
  fallback (coarse layer, then agent discovery if policy allows) and reports
  `fallbackUsed` in stats.

### 2.10 Query temperature stats

For a query, let C = candidate pages selected by the profile's locator.

- **cold**: no page in C was indexed before the query
- **warm**: some pages in C were indexed
- **hot**: all pages in C were indexed (fully indexed documents are always hot)

Recorded per query in the search session: temperature, |C|, pages materialized,
materialization ms, credits, deadline hit, fallback used. Dashboard rollups:
temperature distribution (histogram per workspace), time-to-first-result by
temperature, pages materialized per query distribution, coverage %, and
credits per 100 queries, consistent with the dashboard philosophy of surfacing
the number.

### 2.11 Explicit full index

`POST /v1/documents/:id/full-index` (and workspace-level equivalent) enqueues a
page-scoped run for all unindexed pages on the batch/backfill lane. Allowed by
policy (`allowFullIndexRequest`); priced like a normal ingest of the remaining
pages; cancellable.

### 2.12 Document versions and staleness

Both profiles key ledger rows by document version. A new version starts with an
empty ledger; staleness detection treats deferred documents as current once
their map / page vectors exist.

### 2.13 Planner seam (backwards from the end state)

Stage 1 (this project): every stage declares page-scoped artifact requirements
(`page-images@all`, `page-images@set`, `page-images@agent`) alongside today's
`consumes/requires/produces`, and each profile's goals are written as
declarative requirement lists (§3.1, §4.1), validated by a test that compiles
each profile's goal set into the expected stage plan.
Stage 2 (later, when a third goal-driven feature appears): `compileGoalPlan(goals,
scope)` walks `requires` backwards over the existing topological stage order and
prices candidates with `forecastRunCost`. Agent siphoning produces new
requirements at runtime, so the Temporal workflow loops plan → execute → replan.

## 3. Profile: Index Map (`map`)

### 3.1 Prerequisites (declared, see §2.13)

`goal: searchable(map)` requires `document-map` + `page-label-map`;
query-time `answer(query)` requires `indexed(pages ⊂ map(query))`.
Page images needed: **only the pages the siphon reads**, rendered on demand.

### 3.2 Map build at upload, cheapest evidence first (gotcha 2)

1. **Free structure**, no model calls:
   PDF outline/bookmarks and `/PageLabels` (via `qpdf --json` / pdf.js, both
   already in the tooling catalogue; verify per tool), the embedded text layer
   (`pdftotext` per page), DOCX/EPUB/HTML heading trees and native TOCs (from
   `to-canonical`). Born-digital documents with an outline usually finish here.
2. **Cost check**: if the document is born-digital (text layer on sampled
   pages), compare (a) the agentic map path against (b) per-page `pdftotext` for
   all pages + cheap text embedding. Choose the cheaper; for large born-digital
   files (b) often wins, and the profile still defers the expensive parsing
   (layout, tables, vision) to query time.
3. **Agent-guided siphon** (scanned or no structure): an agent reads 5-page
   windows (rendered at 1024px; OCR via the cheapest capable vision route) and
   decides per window: `continue-forward`, `jump(range)`, `queue(range)` for
   extraction as map evidence, or `stop`. Starts at the front, then the back
   (indexes and glossaries live at the end), and may jump using printed
   references. Hard bounds: `maxSiphonPages` (default min(60, 5% of pages)),
   `maxSiphonCredits`, wall-clock; every decision is logged with the window it
   saw. Stop when map coverage ≥ threshold or no new structure in two windows.
4. **Map assembly**: nodes `{ title, level, printedRange, physicalRange,
   source, confidence }`; index/glossary entries `{ term, printedPages[] }` →
   physical pages. Stored in a `document_maps` table (JSON tree + term index),
   searchable by text (BM25 over titles/terms) and by embedding (titles/terms only,
   very small).

### 3.3 Printed vs physical page numbers (gotcha 1)

Mapping printed → physical pages uses, in order:

1. `/PageLabels` from the PDF when present (exact).
2. **Offset calibration**: OCR or text-layer the header/footer of sampled pages
   (siphoned pages are free samples) to read printed numbers; fit piecewise
   offsets (roman front matter, plates, volume restarts) and record segments.
3. If neither works, mark `label_source: none`, widen every mapped range by
   ±`labelSlack` pages (default 3), and verify after materialization that the
   page's text matches the map node title/term; mismatches trigger a corrected
   offset and re-materialization of the right pages.

### 3.4 Query flow

1. Route the query against the map (BM25 + small embedding over node titles and
   index terms), then the LLM router in `auto` mode (§3.5).
2. Candidate pages C = union of top node ranges, capped by `maxPagesPerQuery`
   (most specific nodes first).
3. Temperature computed; `materializePages(C − indexed)`; search materialized
   chunks with the normal pipeline; answer with citations at physical pages
   (display printed labels).

### 3.5 LLM map router (`mapRouter`, default `always`)

Impact of routing the query over the map with a small LLM:

| | Cost per routed query | Latency | Effect |
| --- | --- | --- | --- |
| `off` | 0 | 0 | Lexical/embedding match on node titles and index terms only. Misses paraphrased or conceptual queries ("liability caps" vs a chapter titled "Indemnification"), which then fall back or over-materialize. |
| `always` | ~2–4k input tokens (top ~40 candidate nodes with ancestors, not the whole map) on a cheap model, ≈ 0.05–0.2 credits | +0.3–1.5 s | Better candidate pages on every query, including ones lexical match already handled. |
| `auto` | same, only when needed | added only when invoked | Invoked when lexical/embedding confidence is low (top-score margin below threshold), candidates exceed `maxPagesPerQuery`, or the first pass returns nothing. Skipped for hot queries whose candidates are already indexed. |

A wrongly chosen page costs a full page materialization (parse, PII check,
embed, index), which is far more than one router call, so the router pays for
itself whenever it prevents a single unnecessary page. Because these profiles
always defer indexing, `always` is the default (user decision 2026-10-13);
`auto`/`off` are workspace and key options. The router model must be priced
from live provider data, logged and recorded through the Search Session journal,
and checked with `canSpend`. The eval (§7) reports routed-query share,
candidate precision with and without the router, and credits per 100 queries,
so the thresholds are tuned from measurement.

## 4. Profile: Visual Pages (`visual`)

### 4.1 Prerequisites

`goal: searchable(visual)` requires `page-image-vectors(all pages)`,
which requires `page-rasters(all pages)` (transient).

### 4.2 Upload

Render each page at max edge 1024 (JPEG q85, never upscaled) in streaming page
windows; embed; **discard rasters** (re-rendered on demand via the existing PDF
asset cache). Model routes from the benchmark:

| Route | Use | Stored vector |
| --- | --- | --- |
| Jina v5 omni nano on the GPU backfill lane | default | 768-bit binary (96 B) + int8 (772 B) for rescoring |
| Gemini Embedding 2, Batch API, PDF page, **no query prefix** | no-GPU fallback | 3072-bit binary (384 B) + int8 rescoring |
| Voyage multimodal-3.5 | quality tier | 2048-bit binary (256 B) + int8 |

Never on Fly performance CPUs (costlier than the hosted API). LanceDB binary
vectors with Hamming distance must be verified on `@lancedb/lancedb` 0.39 before
implementation; fallback is a packed-bit column with an in-process scan per
workspace (500k pages × 96 B = 48 MB).

### 4.3 Query-time embedding (gotcha 6)

The query must be embedded by the **same** model and revision as the pages. A
`PageQueryEmbedder` service in the app: Gemini route calls the API directly; the
Jina route calls a small always-on GPU/CPU text-only endpoint (text queries are
cheap on CPU: query embedding is text-only, ~20 tokens). Its usage is recorded
through the Search Session journal like `embedQuery`; failure degrades to the
text-only path (materialized chunks + page-text) with `degraded: true`.

### 4.4 Query flow

Hamming top-k (k = 200) → int8 rescore → top pages C (capped) → temperature →
materialize C − indexed → chunk search over C → RRF with page-image ranks →
answer.

## 5. Interfaces

- Workspace pipeline features: `indexingMode: "full" | "map" | "visual"` (§1.1), `materialization` defaults, `visualPages.route`.
- Search API/SDK/CLI/MCP: response adds `temperature`, `candidatePages`,
  `materializedPages`, `pendingPages`, `retrievalStage`, `fallbackUsed`; SSE
  events listed in §2.3; header `X-DocSlurp-Capability`.
- New endpoints: `POST /v1/capabilities`, `POST /v1/documents/:id/full-index`,
  `GET /v1/searches/:sessionId/materialization`.
- API key settings: `materializationPolicy`.

## 6. Error handling

Materialization failures mark pages `failed` with a reason and retry with
backoff (bounded, 3 attempts); queries return partial results plus the failure.
Map-build failures fall back to the coarse layer (§2.9) so a document is never
unsearchable. Budget or policy stops return results so far with
`stoppedBy: "policy" | "credits" | "deadline"`.

## 7. Testing and evaluation

- Unit: ledger claims under concurrency, policy narrowing (a token can never
  widen), capability token tamper/expiry/origin/binding, printed→physical label
  fitting (roman front matter, plates, restarts), plan compilation per profile,
  RRF across retrievers, temperature classification.
- Integration (migrated test DB): page-scoped run appends without touching
  other pages' rows; PII-blocked pages never surface; full-index completes the
  ledger.
- Evaluation (integrity rules apply: no fixture names or expected values in
  production code; run `scripts/evaluation-integrity-judge.mjs`): long scanned
  and born-digital books with external question sets; measure answer recall vs
  the full pipeline, first-query latency by temperature, pages materialized per
  query, credits per 100 queries and up-front cost per 1,000 pages. Visual Pages
  reuses the ViDoRe harness and adds a long-document set.

## 8. Rollout

Env flag `DOCSLURP_DEFERRED_PROFILES`; draft PR; map first, Visual Pages
second; pricing validation before any rate-card change. The former root completion list
is preserved as a [dated historical snapshot](../../history/2026-10-20-completed-work.md).

## 9. Decisions log

- 2026-10-13: client-key defaults confirmed at 40 pages / 25 credits per query,
  configurable under Advanced in API key settings.
- 2026-10-13: Jina commercial licensing assumed in place; Jina nano is the
  default Visual Pages route.
- 2026-10-13: `mapRouter` defaults to `always` in deferred modes (§3.5).
- 2026-10-13: deferred indexing is the default only for free-plan accounts;
  anyone on a paid plan or holding credits can choose any mode (§1.1).
