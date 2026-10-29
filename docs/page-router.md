# Page router and native-pdf engine (internal design)

Status (2026-10-12, branch `feat/page-router`): everything here is **off by default**. The router runs only when the
worker env ceiling `PAGE_ROUTER_MODE` and the workspace `pipeline.pageRouter.mode` both opt in; `shadow` records
decisions without changing extraction. The native PDF engine runs only when `DOCSLURP_PDF_ENGINE` is set and the
binding is installed. Evidence lives in evals/page-router/RESULTS.md (generated from
`ledger.jsonl`), evals/page-router/HYPOTHESES.md,
evals/page-router/MODELS.md and evals/native-pdf/README.md.
Engine identity and versions are recorded only in those internal eval documents; code, env vars and public surfaces
use the neutral id `native-pdf`.

## What it does

For each PDF page the router decides how to get faithful Markdown at the lowest cost: accept the native text layer
(free), run a native parser, OCR, a local labeler, or one or more hosted VLM targets, optionally per region or inset
image, with at most one escalation. It returns a `RoutePlan` (a set of assignments `{page, scope: page|region|image,
target, role, reason, estimate}`) with cost estimates per assignment and per document chunk, including the router's
own decision-model cost.

Routing decisions come from **decision models** (typed questions answered with calibrated probabilities, input-only
billing) plus free deterministic features. Generative LLMs are never routers; they appear only as extraction targets.

## Flow

```text
split-pages -> classify-route -> route-pages ------------------------> render-images -> vision-extract
                                     |                                      ^                 ^
                                     | page-route-plan artifact (JSON)      |  active mode only: pages needing pixels,
                                     v                                      |  routed groups, executors, cascade
  S0 probe (free)        per-page PageFeatures: text-layer status, OCR-layer flag, glyph/unmapped ratios, images,
                         drawings, tables, H9 unusual features (forms, JS, attachments, layers, Type3, rotation,
                         encryption, links, annotations). In-process native-pdf probe (the only probe; needs the private binding).
  S1 trust (free)        accept the native text layer when status is ok, OCR-layer band re-OCR agreement >= 0.4,
                         math-glyph gate (0.01) and the inset gate allow it (TL1). Never a whole-page model question.
  S1b inset gate         per-image crops of insets covering 2-85% of the page go to the head decision model;
                         text/table/equation kinds get image-scoped assignments (TL2).
  S1c triage             pages the rules do not settle get three content questions (plain_ocr_sufficient,
                         needs_math_extraction, needs_table_structure) from one 384 px page image + facts line +
                         400-char excerpt, through the health-checked decision chain.
  S2 policy              calibrated probabilities -> per-target P(pass) (Beta cells + per-serving-model target
                         mappings in the policy pack) -> objective (cost-quality | cost-speed | quality) under hard
                         gates (capability, privacy mode, availability, budget/margin floor, prohibited models,
                         escalation-only targets).
  S3 cascade             free checks (non-stop, empty, truncated, invalid LaTeX, ragged tables, low-res math) and,
                         when pageRouter.valueUsdPerQualityUnit >= 0.5, the TL3 decision-model verifier trigger at
                         most one escalation. Deterministic content-filter refusals fall back to the next-best
                         target from another vendor.
  table gate (shadow)    PAGE_ROUTER_TABLE_GATE=shadow: validated ruled grid -> accept native table, else crop the
                         region to the table-region target; logged only.
```

Code map:

| Area | Path |
|---|---|
| Contracts (zod, schema versions) | `packages/shared/src/page-routing.ts`, `routing-targets.ts`, `pipeline.ts` (`pageRouterConfigSchema`, `resolvePageRouterMode`) |
| Stage | `worker/src/stages/route-pages.ts` (plan + telemetry), `render-images.ts` / `vision-extract.ts` (execute an active plan via `routing/active-plan.ts`) |
| Probe and page inputs | `worker/src/routing/probe/`, `page-input.ts` (the research-only Python probe lives in `scripts/legacy-page-probe/`) |
| Trust, insets, triage | `trust.ts`, `inset-gate.ts`, `inset-triage.ts`, `triage.ts`, `contact-sheet.ts`, `decision-client.ts` |
| Decision chain health | `routing/health/` (canary, degeneracy, multi-day history, quarantine) |
| Policy and planner | `policy.ts`, `planner.ts`, `estimate.ts`, `validate.ts`, `routers/` (baseline, decision-model, heuristic), `policies/` |
| Execution | `routing/executors/` (native, OCR, labeler, scoped VLM crops), `routed-vision.ts`, `cascade.ts`, `refusal-fallback.ts`, `verifier.ts` |
| Table gate | `routing/gates/` (candidates, validators, ruled-grid-or-crop rule, shadow) |
| Flags | `routing/flags.ts` (router flags), `worker/src/config.ts` (`PAGE_ROUTER_MODE`), `worker/src/native-pdf/` and `pipeline/pdf-asset-cache.ts` (engine and raster flags) |
| Native PDF engine adapter | `worker/src/native-pdf/` (engine-neutral `NativePdfEngine`, binding and poppler engines, repairs, shadow, loader) |
| Eval-only (not wired) | `routing/orientation.ts` (projection heuristic; see TODO) |

## Targets

The catalog (`routing-targets.ts`) admits targets from the live environment and price list: `native:accept-text-layer`,
native parsers (kreuzberg, native-pdf text/Markdown), OCR (`ocr:tesseract`; `ocr:pdf-ocr-fill` / `ocr:pdf-ocr` run
tesseract first and use the native engine's OCR only for scripts tesseract lacks, see below), the local image labeler (Florence-2-small),
env-gated private OCR VLM endpoints, cheap hosted VLMs (GLM-5.3 Flash, DeepSeek V4.1 Flash, Haiku 5.5, Luna),
expensive hosted VLMs for charts and math (Gemini 3.5 Flash), Sonnet 5.5 as an escalation-only target, and skip.
Every hosted call uses the model's lowest verified reasoning effort (`OPENROUTER_LOWEST_REASONING`). Prohibited models
(Pro/Ultra, output price >= $50/M) are rejected at admission.

## Licence classes

Every routing target, decision model and measured OCR route carries a `licenseClass` plus a `license` (`id`, `source`),
resolved from the table in `packages/shared/src/model-license.ts` (`MODEL_LICENSES`). Models missing from the table
fail closed by kind: private VLMs and local labelers are `non-free` until classified, hosted VLMs are `proprietary-hosted`.

| Class | Meaning | `DISABLE_NON_FREE_SOFTWARE=true` |
|---|---|---|
| `free` | OSI/permissive licence (MIT, Apache-2.0, BSD, OFL, AGPL) or our own code | kept |
| `non-free` | Custom addenda, non-commercial, research-only, LFM/Gemma-style terms, no declared licence | rejected (`non-free-disabled`) |
| `proprietary-hosted` | Closed model reached only through a vendor API (Gemini, Claude, GPT, Jev, Clef, pplx-decider) | kept |

The flag covers `non-free` only. Proprietary hosted APIs are governed by the workspace privacy modes
(`standard`, `local-only`, `strict-privacy`; see `docs/model-configuration.md`), not by this flag. Open-weight models we call
only through a hosted API are classed by their verified weights licence (Ling-3.0-flash-VL, DeepSeek V4.1 Flash, GLM-5.3 Flash: MIT, `free`).

With the flag on, the flag is read once (`routing/flags.ts`) and applied in: catalog admission
(`buildRoutingTargetCatalog` / `buildDecisionModelCatalog`, reason `non-free-disabled`, via `buildRuntimeCatalog`),
the decision-model chain (a requested non-free model is unresolved and traced as skipped; the decision client also refuses to call one),
the executor registry (`executorFor` returns null, so a stored plan that names one falls back to the workspace vision model),
and the Extract flat-tier route policy (`isRouteEligibleForFlatTier`, `isMeasuredOcrRouteEligible`, `flatOcrDefaultRoutes`
take `{ disableNonFree }`; dots.ocr leaves the math-page defaults). The app lists no router models; `/extractors` lists
document extractors, all `free`. Workspace-configured embedding and vision models are not enforced by the flag; use
`licenseClassOfModel()` to check them.

| Model | Class | Licence | Source |
|---|---|---|---|
| dots.ocr | non-free | MIT + data-governance addendum | HF `dots-studio/dots.ocr` card |
| Nanonets-OCR2-3B | non-free | none declared (base Qwen2.5-VL-3B is qwen-research) | HF card |
| Qwen2.5-VL-3B-Instruct | non-free | qwen-research (non-commercial) | HF card (API `license_name`) |
| Jina v5 omni small | non-free | CC-BY-NC-4.0 | HF card |
| LiquidAI d1 via OpenRouter (`liquid/d1`) | proprietary-hosted | vendor API terms | hosted route; weights never run by us |
| LiquidAI d1-3B / d1-omni-600M (`liquid/d1:direct`, local) | non-free | LFM 1.0 | HF cards |
| EmbeddingGemma 300M ONNX | non-free | Gemma terms | ai.google.dev/gemma/terms |
| LightOnOCR-3-0.8B, MinerU2.5-Pro, olmOCR-2, DeepSeek-OCR-2, PaddleOCR-VL-1.6, Infinity-Parser2, Qwen3-VL, Qwen2-VL-2B | free | Apache-2.0 | HF cards |
| Ling-3.0-flash-VL, DeepSeek V4.1 Flash, GLM-5.3-Flash (hosted) | free | MIT | HF cards |
| Florence-2, Kreuzberg, Tesseract, native-pdf | free | MIT / Apache-2.0 / internal | project licences |
| Gemini, Claude, GPT-6 Luna, Jev, Clef, pplx-decider | proprietary-hosted | vendor API terms | vendor docs |

## Decision models and the health chain

Default chain (`DEFAULT_PAGE_ROUTER_DECISION_MODELS`): `openai/gpt-6-luna-decisions`, `cloudflare/clef-flash`,
`typesafe/jev-1.13` (text state only), then `perplexity/pplx-decider-v1.1-27b`. Each entry serves only while it is
healthy (known-answer noul and choice canaries, runtime degeneracy checks) and the policy pack has calibrations for it.
The Perplexity decider is quarantined (`QUARANTINED_DECISION_MODELS`) until its canaries pass on three distinct UTC
days (`DOCSLURP_DECISION_HEALTH_HISTORY` persists the history) and it is calibrated in a pack. `liquid/d1` is opt-in
only (calibration AUROC 0.52 / 0.81 / 0.50 on plain_ocr / math / table). When no model qualifies, the no-model
baseline router plans the document. `cloudflare/clef-omni` is used only by the verifier.

Policy pack: the worker ships `page-router-baseline-v1.json` and the current decision-model pack
`page-router-dm-v6.json` (target mappings per serving decision model, overlaying a clef-flash default). Older packs are
fit bases under `scripts/page-router/packs/`; fit scripts are `scripts/page-router/fit_pack_v*.py`.

## Native PDF engine

`DOCSLURP_PDF_ENGINE=off|shadow|native-pdf`. The adapter (`worker/src/native-pdf/`) wraps an engine behind
`NativePdfEngine`; the default implementation is a private, pinned Node binding installed from
`vendor-artifacts/native-pdf/` (sha256 in `manifest.json`, installed by `scripts/install-native-pdf.mjs`). Without the
binding every mode degrades to kreuzberg. Fallback semantics: every engine error maps to a defined outcome
(`ENGINE_ERROR_CODES`); a locked PDF takes the same path as without the engine; unsupported encryption, unsupported
features (for example OCR without models), limits and unknown errors fall back to kreuzberg. A dropout guard rejects
output that lost the text layer (`NATIVE_PDF_DROPOUT`), and layout warnings (multi-column interleave) reroute. The
adapter and the in-process probe open documents under the engine's `worker` limits profile.

Page OCR policy (`NATIVE_PDF_OCR`, `routing/executors/ocr-policy.ts`): tesseract is primary. The engine's OCR matched
tesseract on clean rasters and read CJK the image's tesseract languages cannot (1-CER 0.74 vs 0.00 on a dev zh-TW
page), but lost most text on degraded scans (photocopy 0.02 vs 0.97, phone scan 0.16 vs 0.83), ran about 2x slower
and held ~400-500 MB in-process per call. So with the default `scripts` the engine runs only when tesseract's output
is not word-shaped, and serves only when its output is mostly another script; `prefer` runs it first. Every native
OCR result passes a dropout guard (at least half the page's text layer; sparse output is cross-checked against
tesseract), and calls are limited to one per process (`NATIVE_PDF_OCR_MAX_CONCURRENT`).

Promotion gate (re-run on the pinned binding, evals/native-pdf/README.md): quality and
reading order are at parity or better (routing suite content -0.02 pt, order +0.20 pt; preservation content +2.4 pt),
encrypted fixtures and error handling pass, the integrity judge passes. On test the gate **failed** adapter speed (26.2
vs 20.6 ms/page; the raw engine is 8.1) and probe parity (97.95% status agreement). The adapter now makes one scan
pass per page and fetches spans only when a repair can apply (about 8% of pages), with byte-identical output on 294
dev+cal pages: 11.0 vs 12.1 ms/page for kreuzberg on routing dev and 21.4 vs 70.8 on preservation dev. Speed is
not re-measured on test for this binding, so it stays an open gate item with probe parity and the load test.
Hidden OCR layers that look unreliable (`ocr-layer-unreliable`) become image placeholders, so classify-route sends
those pages to vision rescue instead of passing a bad layer through (5/5 bad layers flagged, 0/101 false on dev/cal).
Keep `DOCSLURP_PDF_ENGINE=off` (or `shadow`) until the gate passes.

## Modes and flags

| Flag | Default | Values | Effect |
|---|---|---|---|
| `PAGE_ROUTER_MODE` | `off` (production: `shadow`) | off, shadow, active | Worker ceiling over the workspace `pageRouter.mode`; the lower of the two wins. The app reads it as the platform default: a new run whose workspace left `pageRouter.mode` unset gets `shadow` (never `active`) when it is shadow or active, so the route-pages stage is planned with no workspace setup. Set it on both `fly.app.toml` and `fly.worker.toml`. |
| workspace `pipeline.pageRouter` | mode unset, router `baseline` | see `pageRouterConfigSchema` | Opt-in, objective, router kind, decision-model chain, tile size, budget per document, margin floor, verifier value. |
| `DISABLE_NON_FREE_SOFTWARE` | `false` | true, false, 1, 0 | Opt-out of non-free-licensed models and engines; see "Licence classes" below. A typo reads as false with one warning. |
| `PAGE_ROUTER_TABLE_GATE` | `off` | off, shadow | Ruled-grid-or-crop table rule in shadow (telemetry only). |
| `VISION_ROUTING_V2` | `off` | off, on, workspace ids | Legacy vision routing v2 (below) for every run or a comma-separated canary list of workspace ids. Worker only, read once per run at run start. A malformed value reads as off with one warning. |
| `VISION_PAGE_ATTEMPTS` | `2` | integer 1..4 (clamped) | Vision provider requests per page and purpose per run, retries and fallbacks included (vision run guard, below). |
| `VISION_REGION_ATTEMPTS_PER_PAGE` | `12` | integer 0..64 (clamped) | Routed region requests per page per run. |
| `VISION_BREAKER_MIN_FAILURES` | `20` | integer 1..10000 (clamped) | Failed or rejected requests before the rejection breaker can stop vision for the run. |
| `VISION_BREAKER_FAILURE_RATE` | `0.25` | 0.01..1 (clamped) | Failed share of the run's requests that trips the breaker. |
| `VISION_ORG_UNCHARGED_LIMIT_CENTS` | `4000` | integer 1..1000000 (clamped) | Worst-case cents of uncharged vision requests per org over a rolling 24 h before vision stops for the org's runs (each request weighs its route's worst case). |
| `VISION_THROTTLE_ALLOWANCE` | `5` | integer 0..20 (clamped) | Unbilled throttles (429, 503/529) one vision call may hand back before the wait goes to Temporal. |
| `PAGE_ROUTER_PREFER_NATIVE_MARKDOWN` | false | 1/true | Accepted text pages take native-pdf Markdown instead of the canonical page slice. |
| `PAGE_ROUTER_LABELER_MODEL` | `microsoft/Florence-2-small-ft` | model id | Local image labeler. |
| `PAGE_ROUTER_MODEL_PRICES_PATH` | shipped list | path | Price list override for estimates. |
| `DOCSLURP_DECISION_HEALTH_HISTORY` | in memory | path | Multi-day canary history for quarantined decision models. |
| `DECISION_LOCAL_SIDECAR_CMD` | none | command | Local decision-model sidecar (eval). |
| `DOCSLURP_PDF_ENGINE` | `off` (production: `shadow`) | off, shadow, native-pdf | Native PDF engine for document extraction (kreuzberg fallback). |
| `DOCSLURP_NATIVE_PDF_INSTALLED` | unset | 1 | Set in images that ship the binding so `/extractors` lists native-pdf. |
| `DOCSLURP_NATIVE_PDF_MODULE`, `DOCSLURP_NATIVE_PDF_DIR` | vendor dir | path | Binding discovery overrides (dev, bench). |
| `NATIVE_PDF_OCR_MODEL_DIR` | unset | path | OCR models for the engine's OCR fill; unset means OCR targets use tesseract. |
| `NATIVE_PDF_OCR_MAX_CONCURRENT`, `NATIVE_PDF_FONTS_DIR` | engine default | number, path | OCR concurrency and fallback fonts for the engine. |
| `NATIVE_PDF_OCR` | `scripts` | off, scripts, prefer | When page OCR may come from the native engine (tesseract otherwise). |
| `PDF_RASTER_ENGINE` | `pdftoppm` | pdftoppm, native-pdf | Page and crop raster engine (native falls back to pdftoppm/sharp). Stays pdftoppm: native renders add 670-810 MB per 8-slot worker process, over the 512 MB off-heap budget, for ~2.4x throughput. |
| `PDF_RASTER_CONCURRENCY` | min(4, cores) | 1-32 | Native render lanes per document render. |
| image build args | off | `DOCSLURP_NATIVE_PDF`, `DOCSLURP_NATIVE_PDF_OCR_MODELS`, `DOCSLURP_NATIVE_PDF_CJK_FONTS` | Ship the binding, OCR models (~30 MB) and CJK fonts (~54 MB); see `vendor-artifacts/native-pdf/README.md` and `fly.worker.toml`. |

`.env.example` lists every flag above with its default.

### Legacy vision routing v2

`VISION_ROUTING_V2` gates the fixes to the legacy (non-router) vision path so production can
enable them for one workspace before everyone. The worker reads it once, when the run starts
(`startRun`), and persists the resolved version as the run artifact `run:vision-routing-version`
(`v1` or `v2`). Extract-markdown, classify-route, vision fan-out and page tasks read that artifact,
so workers with different environments, retries and rehydrated runs route a run the same way
(`worker/src/lib/vision-routing-v2.ts`). The pure routing functions take `{ routingV2 }`; none
of them read the environment. Every comma-separated entry must be a valid workspace id: `ws-a,,`,
`,ws-a` and `ws-a,` are malformed and read as off with one warning.

Gated (v2 only):

- Page triage counts native words from page facts' shared `pdftotext` run, so an OCR'd scan stays
  sparse (`extract-markdown` passes `textLayerPages`; when `pdftotext` failed or its pages do not
  line up, triage keeps the v1 count); uploaded images get full-page raster evidence
  (`imageFilePageEvidence`).
- Document labels use whole-word terms and need two distinct body terms, read from the first
  256 KB of text (`hasDistinctTerms` stops at the answer, so memory does not grow with the upload).
- Page routes: the numeric-row table cue, garbled-text detection, Unicode-math formula signals
  (each scanning the first 64 KB of a page), and keeping structured routes (table, form, formula,
  figure) for OCR'd pages.
- A page without text layer or images whose OCR text has words counts as drawn content.
- `selectLegacyVisionPages` also admits formula pages and lets the text route decide when raster
  evidence does not authorize OCR; v1 lets any page-evidence decision decide alone.

With the flag off, routing is v1 except for these always-on changes, so it does **not** reproduce
`origin/main` exactly:

- A page whose vision output is rejected (degenerate, refusal, truncated) no longer fails the
  document (`shouldFailOpenVisionError`). It keeps its native or OCR text when that text is usable
  (page fact `rejected`); otherwise the page is recorded as `failed`. Its model text is never kept.
- A PDF with no extractable text whose bytes outside embedded images are large
  (`drawnBytesPerPage`: file bytes minus every embedded image's bytes, over pages, from page facts'
  whole-document `pdfimages` listing) nominates its pages as drawn content. Bytes are spoofable, so
  vision-extract calls a model for such a page only if its own render is not blank
  (`renderLooksBlank`); padding, metadata, attachments or a large font buy no vision calls.
- The vision run guard below, and bounded counting in page classification (same counts, no match
  arrays).

#### Vision run guard

Customers pay only for pages vision reads (one Rich page charge per page per run), and the run cost
cap counts only those charges, but every request sent to a vision provider can cost us: rejected and
failed requests, inline 429/5xx retries, the alternate-route retry, the streaming-to-JSON fallback,
self-critique and a second read of a page already charged create no new charge. Provider cost data
cannot bound that (an interrupted stream or a failure before the first chunk reports estimated or no
usage), so the guard counts requests, each weighted by the worst case its route can cost, and reads
no reported cost (`worker/src/lib/vision-attempt-guard.ts`).

Every HTTP request a vision call made through `executeVisionRuntime` sends is admitted before it is
sent, at the lowest common request point: `fetchWithProviderRetry` (each try, inline retries
included; admitted inside its concurrency limiter immediately before `fetch`, so limiter waits,
timeouts and aborts before sending consume nothing) and the local runtime call, through the
`VisionRequestGate` that `executeVisionRuntime` requires (only operator benchmarks pass `null`). That
covers legacy pages, page-router regions and their refusal fallbacks, cascade legs and
workspace-model fallbacks, document-map OCR, extract-markdown self-critique and deferred page
materialization, and every request inside each of them. Other model calls are outside it (see the
end of this section).

Requests the provider refuses before accepting them are handed back and leave every count (page
bound, breaker, org): 429, 503 and 529, and on a streaming request a 400/404/405/415/422/501, which
only says the endpoint does not stream (the same request then goes out without streaming; when that
succeeds, later calls to that endpoint and model skip streaming for the life of the process). A call
may hand back `VISION_THROTTLE_ALLOWANCE` throttles; past that the wait goes to Temporal as a
retryable provider error with its Retry-After. Anything that may have been accepted stays counted:
other 5xx, timeouts and network errors after sending, accepted streams that break.

The counts live in a shared ledger (migration 0101, `worker/src/db/vision-attempt-store.ts`):
admission takes the run's then the org's advisory lock, so every worker of a run and every run of an
org admit against the same rows. The org comes from the run row (its workspace's org when the run has
none; the worker loads the run with that same org, so usage rows and the credit debit use it too); a
run with neither is refused (`unscoped-run`), never run unbounded. A store-backed run whose store
has no ledger refuses every request (`no-attempt-ledger`, logged as an error) instead of counting per
process.

| Setting | Default (range) | Refuses when |
| --- | --- | --- |
| `VISION_PAGE_ATTEMPTS` | 2 (1-4) | the run already sent this many requests for the page and purpose (whole-page read, document-map OCR, self-critique); that page only |
| `VISION_REGION_ATTEMPTS_PER_PAGE` | 12 (0-64) | the run already sent this many routed region requests for the page; that page only |
| `VISION_BREAKER_MIN_FAILURES` | 20 (1-10000) | at least this many of the run's requests failed or were rejected... |
| `VISION_BREAKER_FAILURE_RATE` | 0.25 (0.01-1) | ...and they are at least this share of the run's requests (sticky for the run) |
| `VISION_ORG_UNCHARGED_LIMIT_CENTS` | 4000 (1-1000000) | the org's uncharged requests in the last 24 hours, by worst-case weight, plus this one would pass it |

**Org bound.** A request counts as uncharged from the moment it is admitted. It leaves the count
only in the checkpoint transaction that persists the customer Rich page charge its read created: the
charge (`rich:<run>:<document>:<page>`, deterministic per run and page) carries the request's ticket,
and the checkpoint deletes the ticket's `vision_org_attempts` row only if its insert of that charge
happened (`on conflict do nothing returning id`). A page charged earlier, by another activity or
another path, removes nothing more. Until that checkpoint the request stays counted (and in flight,
so it never makes a refusal sticky): a cancel, a workspace or run deletion, a lost page-task lease
or a crash between the read and its checkpoint leaves it counted. Rejections, failures, retries,
critique and second reads stay counted. The count is keyed by org only, with no foreign key to runs
or workspaces, so deleting either cannot reset it; it holds across runs, reprocessing and
extraction, and another org is never affected.

Weights: each request weighs the worst case its own route can cost at catalog list price, a 16 MP
image (about 23,000 input tokens) plus the prompt and the model's full output cap (enforced as
`max_tokens`). A model without a list price (uncataloged or private) weighs the costliest catalog
model; the in-process local runtime weighs 2 cents. So the most an org can cost us per day in
uncharged requests is the $40 bound, whichever models its workspaces route to: 2,388 requests on the
default `deepseek/deepseek-v4.1-flash-1017` (23,058 x $0.30/M + 8,192 x $1.20/M = 1.675 cents),
1,128 on `gpt-4.1-mini` (3.544 cents), and any mix of the two in one org shares the same bound.

**Refusals.** A refused request is never sent; requests sent before it in the same call record their
billed usage once. A refusal is sticky for the activity only when a count limit is reached: the
breaker, the org bound when finished uncharged requests alone leave no room, `unscoped-run` and
`no-attempt-ledger`. Requests
still in flight never make a refusal sticky (they may yet be charged). Pages it refused keep their
own text and get the page fact `guarded` (ingest report reason `vision-stopped`); the vision manifest
records `visionGuard` with the reason (`page-attempt-limit`, `rejection-breaker`,
`org-attempt-limit`, `unscoped-run` or `no-attempt-ledger`). Document-map OCR leaves a refused page without text (and stops
on a sticky refusal), self-critique is skipped, and deferred materialization releases the page
(`vision-stopped:<reason>`) to be claimed again later. A malformed setting keeps the default with
one warning and an out-of-range one is clamped; the guard cannot be turned off.

Usage records (billing accuracy, separate from the guard): an interrupted stream records the input
estimate plus the output it streamed before the break (`usageSource: estimated`, or provider usage
when a usage chunk arrived), and a 200 stream that broke before its first chunk is recorded with the
non-streaming fallback's usage (attempt outcome `stream-failed`) rather than dropped.

Pages nominated only by drawn-content bytes go to vision only after their render is confirmed to
hold ink: size and pixel dimensions are read from the render file vision would receive (a cached
render carries no dimensions), and a render that cannot be confirmed is not sent
(`unverified-render`, page fact `not-selected`).

Outside the guard: the decision-model verifier (off unless a workspace values quality at or above
0.50 USD per unit; stops at the run cost cap), page-image embeddings and media frame description,
which are not page transcription calls and keep their own bounds.

Telemetry: `classify-route` and `vision-extract` record `routingVersion` (`v1` or `v2`) in their
stage stats, the vision manifest and the `vision-text-density-score`, `vision-fail-open` and
`vision-attempt-failure` performance metadata. Per document, vision-extract logs
`[vision-rejections] org=<id> run=<id> document=<id> rejected=<n> attempted=<n> rate=<r>` and records
the `vision-rejection-rate` metric (alert per org on a sustained rate), plus `vision-page-outcome`
per page without output and `vision-guard-stop` (`[vision-guard]` log line) when the guard stops a
run. Alert on `vision-guard-stop` with tag `org-attempt-limit` (or the `[vision-guard] ...
refused=org-attempt-limit` warning): an org hitting its uncharged-attempt limit is either hostile input or a
provider regression. The manifest's `failedPages` lists each such page with its reason and whether it kept text.

## Economics

- Probe and trust rules are free (CPU). On easy born-digital pages TL1 accepted 26/26 pages on test with 0 false
  trusts; router cost there is about $0.002 per 1,000 pages (list estimate).
- Decision-model triage bills input only (fractions of a cent per 1,000 pages at 384 px single-page states).
- The TL3 verifier pays off only when a quality unit is worth >= $0.50 per page to the workspace; below that, free
  checks capture most of the escalation gain (test replay: free checks $4.77 vs always-escalate $31.26 per 1,000
  pages).
- Hosted targets dominate cost; the router's job is to keep pages on accept-text and cheap targets unless evidence
  says otherwise. H6 (gap closed vs oracle at <= 30% of Gemini cost) is inconclusive on the current test split.
- Native PDF engine: the raw engine is 2.5-7x faster than kreuzberg per page (8.1 vs 20.6 ms routing suite, 18 vs 130
  ms dense pages); with conditional repair passes the adapter is at or below kreuzberg on dev (see the gate).
- Probe: the in-process probe costs 51 ms/page vs 204 ms/page for the Python probe on clean EPYC hardware
  (evals/page-router/remote-perf-2026-10.md), mostly Python start-up;
  H10 (<= 5% overhead) is missed with the Python probe.
- Router replay of the shipped pack (v6) on the held-out split: content 0.927-0.941 at 6.5-7% of always-Gemini cost
  (about $2 per 1,000 pages), cost MAPE 6-12%, Brier 0.13-0.18; gap closed vs the oracle is small (H6 inconclusive).

## How to evaluate

1. Log every measurement as a `ledger@v1` row (`scripts/page-router/ledger.py append`, then `render`). Full model
   ids and versions, dataset id/split/sha, cost source, hardware.
2. Iterate on development splits, choose thresholds on calibration, score the held-out test split once per change.
   Never encode fixture names or content in production code or packs.
3. Router replay against saved outcomes: `scripts/page-router/replay.py` (quality, cost, cost MAPE, Brier, gap closed).
4. Native engine: `scripts/page-router/native_pdf_bench.py run|report|gate` (promotion gate: content and order
   parity vs kreuzberg with a family bootstrap, speed and memory, probe parity, load test, zero unhandled errors,
   integrity judge).
5. Run `node scripts/evaluation-integrity-judge.mjs` for every corpus used in a promotion claim (supports synthetic,
   `licensed-real` and declared non-deterministic assets).
6. Turn on in this order: `shadow` on a few workspaces, compare `page-route-decision`, `page-route-timing` and
   `page-route-chunk-estimate` rows against actuals, then `active` per workspace.

## Production rollout: shadow now, promotion later

Production (`fly.app.toml`, `fly.worker.toml`) runs both features in shadow: `PAGE_ROUTER_MODE=shadow`,
`DOCSLURP_PDF_ENGINE=shadow`, worker image built with `DOCSLURP_NATIVE_PDF=1`, app with `DOCSLURP_NATIVE_PDF_INSTALLED=1`
(set it only while the deployed worker image ships the binding). Shadow records decisions and per-page agreement/timing
(`native-pdf-shadow` in `performance_log`, the route plan artifact) and never changes extraction output. Native OCR models
and CJK fonts stay off; tesseract is the OCR primary.

Workspaces need no setup: the app stamps `pageRouter.mode=shadow` on a new run when the workspace left it unset
(`withPlatformPageRouterMode`), so the stage plan every service compiles includes `route-pages`. A workspace that sets
`off` stays off; `active` stays a per-workspace opt-in under the ceiling. Runs created before the flag change have no
route-pages stage; reprocess to include it.

**Image build.** The pinned binding (`vendor-artifacts/native-pdf/manifest.json`, sha256) is a private release asset.
The deploy workflow's "Fetch native PDF engine" step runs `scripts/fetch-native-pdf-binding.mjs` before the worker deploy
and verifies the sha256; the tarball then reaches the build context and `scripts/install-native-pdf.mjs` installs it
(required, so a missing or unloadable binding fails the build). Repository configuration:

| Name | Kind | Value |
|---|---|---|
| `NATIVE_PDF_FETCH_TOKEN` | secret | token with read access to the private engine repository's releases (fine-grained PAT, Contents: read) |
| `NATIVE_PDF_RELEASE` | variable | `<owner>/<private-release>@<tag>` (asset `<tarball>`) |

Bumping the engine means publishing a new release asset, then updating `manifest.json` (tarball, sha256) and the variable.
Local `flyctl deploy` needs the tarball already in `vendor-artifacts/native-pdf/`.

**Fly secrets the router uses** (already set separately; nothing here changes them): `OPENROUTER_API_KEY` (default
decision chain gpt-6-luna-decisions, clef-flash, jev-1.13 and the hosted vision targets), `PERPLEXITYAI_API_KEY` (only
for the quarantined Perplexity decider), `LIQUID_API_KEY` (opt-in liquid/d1), and the `*_ENDPOINT_URL` variables of any
self-hosted OCR targets. Without a decision-model key the chain is empty and the baseline router plans the document. Shadow
router calls are billed to the platform: watch `usage_events` for the router scope before leaving it on for long.

### Promotion path (shadow to active)

Promote the two features independently and only with evidence; each step is a config change plus a deploy.

1. **Native PDF engine, `DOCSLURP_PDF_ENGINE=native-pdf`** in `fly.worker.toml`. Gates: shadow agreement on production pages
   (no systematic `native-pdf-shadow` disagreement classes), adapter speed at or better than kreuzberg on test (open item,
   see above), the internal pricing validation against the latest `internal research notes` with no regression in pages/min or RSS, the
   evaluation integrity judge passing, and quality at parity on a held-out slice. Rollback: set it back to `shadow`.
2. **Probe**: done. The Python/PyMuPDF probe was removed with PyMuPDF (2026-10-15); `internal research notes`
   holds the last parity run (text-layer status and needs-attention agree on every page of the development slice).
3. **Page router, workspace `pageRouter.mode=active` under `PAGE_ROUTER_MODE=active`**: raise the worker ceiling to `active`
   in `fly.worker.toml` (the app stamp stays `shadow`, so no workspace changes behaviour until it sets `active`). Gates:
   shadow plans on production pages show estimated cost and quality at or better than the legacy path, decision-model health
   canaries green for 3 distinct UTC days (`DOCSLURP_DECISION_HEALTH_HISTORY` set on a persistent path), the integrity judge
   passing, and an active-mode canary workspace with a measured cost-per-1,000-pages and quality delta before wider rollout.
   Make `active` the default for unset workspaces only as a separate, reviewed change.
4. Rollback for any step is the previous value of the flag; shadow output is telemetry only and safe to leave on.

### Default free routing (2026-10-22)

New default settings select the feature-based baseline, avoiding paid decision calls just to classify pages. Explicit decision-model settings remain available. Healthy native prose is retained; substantial unknown embedded images request cropped OCR instead of being assumed decorative. Scans request page OCR once, including tiled scans, and proven blank pages skip extraction. Form/annotation and vector-only pages are not blank. Cost, privacy and quality gates still select and constrain executors; production remains shadow until the promotion checks above pass. These changes do not promote the native PDF engine or claim a measured end-to-end speedup.
