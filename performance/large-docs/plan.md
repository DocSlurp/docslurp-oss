# Large-PDF production ingestion benchmark: contract

Prepared 2026-10-17 ~03:25 UTC, reviewed and revised ~03:50 UTC against the real corpus files and the server code. Baseline: production app `a1d1af5`, core `5972781` (app machine 4 GB, worker 16 GB, no new capacity). **Nothing in this plan has been run against production except read-only `login`, `preflight` and `prepare` (root, label `e1-rag-asu`, workspace `9501ddc8-3d8f-4ec9-9b44-b250fc72c394`, effective config confirmed). No upload has happened.** Root controls every run, every production source change and the model eval runner.

## Objective and workload

University catalogs and bound legal volumes, 100+ MB and 1000+ pages where possible, real bytes (never regenerated, padded or concatenated). Five sources in `/tmp/docslurp-large-docs/manifest.json`:

| id | bytes | MB (1e6) | MiB | pages | text layer | queries |
|---|---|---|---|---|---|---|
| `asu-2025-26-academic-catalog-archive` | 98,982,516 | **98.98** | 94.40 | 7,188 | native (8 pages < 100 chars; p30 garbled) | 9 (3 each position) |
| `statutes-at-large-vol-83` | 184,012,284 | 184.01 | 175.49 | 1,114 | scanned images + OCR text (noisy; 20 pages under 100 chars) | 4 |
| `statutes-at-large-vol-109` | 226,884,591 | 226.88 | 216.37 | 2,122 | scanned images + OCR text (noisy; 16 pages under 100 chars) | 9 |
| `asu-2025-26-course-catalog-archive` | 83,947,316 | 83.95 | 80.06 | 3,246 | native | none: not a benchmark arm |
| `uta-2026-2027` | 20,201,438 | 20.20 | 19.27 | 2,456 | native | 3 (middle, end only) |

Size wording: the ASU academic archive, the first planned upload, is **98.98 MB (94.40 MiB), not 100 MB**; ASU's own "94.4 MB" label is MiB. It is the largest text-native file but is 1.02% under 100 MB. The two Statutes volumes are the only sources >= 100 MB (and >= 100 MiB) and are scanned, so they exercise a different pipeline path (OCR text layer plus possible vision); results from them are not comparable with the text-native ones. Do not describe an ASU result as "100 MB-class".

Sources, `manifest.json` and `queries.json` are written independently by the corpus agent; this plan and the harness never contain document names, queries or expected values (Evaluation Integrity). The harness reads the real corpus schema:

- `manifest.json` `documents[]`: `id`, `local_path`, `sha256`, `bytes`, `pdfinfo_pages`, `full_text_file` (pdftotext -layout, pages split on form feed).
- `queries.json` `queries[]`: `id`, `document`, `position` (`beginning|middle|end`, optionally with a document-percent suffix such as `end (79%)`, which the harness normalises to the bucket), `question`, `expected_answer`, `support_pages` (1-based), `support_match_all`.

Two workloads are never compared with each other:

| profile | work | pipeline overrides |
|---|---|---|
| `rag-only` | extract, chunk, contextual chunk preambles (schema default, required work, left on), embed, vector + lexical index | `summarize/pageIndex/propositionIndex/graphRag/graphCommunitySummaries/entityIndex = false` |
| `enriched` | all of the above plus summary, page index, propositions, entities, GraphRAG, community summaries | all `true` |

Both profiles pin, explicitly and identically (user requirement: app ingestion uses GLM 5.3 Flash, not Sonnet, not the shared Gemini vision default):

- `textGeneration: { model: "z-ai/glm-5.3-flash", models: {} }` (no per-operation override may diverge);
- `vision: { modelUri: "llm://openrouter/z-ai/glm-5.3-flash" }` (replaces the schema default `llm://openrouter/google/gemini-3.1-flash-lite`; validated by both shared schemas, target `hosted`);
- `maxCostCents: 250` (server-side per-run cap against billed spend).

Embedding stays on the workspace default, local `transformers.js` `bge-m3` (confirmed effective by root on the prepared workspace): no provider charge, but CPU/RAM on the 16 GB worker. Live OpenRouter catalog (`/tmp/docslurp-large-docs/models.json`, 2026-10-17): `z-ai/glm-5.3-flash` is native multimodal (`text+image+video` in, text out), **$0.049 per 1M input tokens, $0.65 per 1M output tokens**, cache read $0.018. (An earlier revision of this plan said $0.04/$0.20; that was wrong.) It is far below the $50/1M output restriction. `:batch`, `-flashx`, `-prime` and `glm-5.3` are different models and are not used.

Vision on the scanned volumes: their text layer is OCR noise over page images, so vision/OCR rescue is the most likely cost driver and the reason vision is pinned and capped. Vision spend is bounded by `vision.maxPagesPerDocument` (schema default 4, not raised here), by the 250c server cap and by the watcher gates below; whether vision fires, on how many pages, and its cost are measurements (stage list, `[ai-usage]` vision lines), not assumptions. For the native-text ASU file the corpus owner found a text layer on every page; that **does not prove OCR/vision is unnecessary** (figures, image-only tables, garbled font pages such as p30 and the low-alphabetic pages 31 and 460-463 can carry content the text layer lacks). No work may be disabled to claim a win; any change that reduces required work is a correctness-gate failure unless the output is shown equivalent.

## Milestones (what is classified and timed)

Clock starts at upload start (`t0`). `bench.mjs watch` writes `timeline.jsonl` (progress every 5 s), `probes.jsonl` (correctness probe every 30 s while any position is unsatisfied), `sampler.jsonl` (host memory), and `report.json` with:

1. `uploadAccepted`: direct-upload `confirm` returned a run in the benchmark workspace (upload MB/s, part count, per-part times, `warnings`, `temporalDeferred` recorded separately).
2. `firstPageProcessed`, per-stage start/end/attempts/error from run stages.
3. `firstCorrectResult`: first probe whose results satisfy the oracle (below), with pages processed at that moment.
4. `queryable_<position>` for each position that has queries for this document, then `allPositionsQueryable`. A final post-completion pass gives every unsatisfied position a verdict. UTA has no beginning query, so for it `allPositionsQueryable` means middle+end only.
5. `runCompleted`: run status `completed`; pages/min over `uploadAccepted..runCompleted`; cost, tokens, peak RSS from `progress.usageTotals/resourceTotals`; `pagesMatchManifest` (progress page total equals `pdfinfo_pages`).

Search probes are real calls (one query embedding each): count them, and subtract nothing silently. Probe cadence is a measurement cost; keep it identical across arms. Latency/cache: post-completion `probe --repeat 5` reports p50/p95 and marks repeats as cache-eligible.

### Correctness oracle (per query, per result)

A search result is correct only if **all three** hold: (1) `result.citation.documentId` equals the document id returned by the upload `confirm` for this run (real result shape: `{ text, score, citation: { documentId, filename, pageNumber, pageNumbers } }`); (2) the chunk `text` contains every `support_match_all` string (NFKC, case- and whitespace-insensitive, so ligatures match); (3) `citation.pageNumber`/`pageNumbers` contains one of `support_pages`. Empty or missing `support_pages`, `support_match_all` (or an empty string in it), `question` or `document`, a missing ingested document id, or a result without a citation can never pass. `bench.mjs check` runs a built-in judge self-test of these cases and verifies every query offline against the corpus' own page text (each support string occurs on each support page and on no unlisted page; support pages inside `1..pdfinfo_pages`). `expected_answer` is not scored (chunks need not contain the literal answer); it is kept for later chat/answer evaluation. Only queries whose `document` matches the ingested file are used.

OCR caveat for the Statutes volumes: the oracle strings come from the embedded OCR layer. If DocSlurp reads those pages differently (its own text extraction or GLM vision), the right document and page can come back with different characters, a text false negative. The judge therefore records `docPageHitTextMissRanks` (right document and page, text oracle missed) in `probes.jsonl` without counting it as correct. A run with many such rows and missing `queryable_*` milestones is an oracle/extraction-drift finding to inspect by hand, not proof the index is broken; never loosen the oracle after seeing a result (Evaluation Integrity).

## Cold versus reused (no cold claim without evidence)

`report.json` sets `classification`, and `coldClaimAllowed` is true only for `cold`:
- `preflight` lists same-sha256 documents already in the org (full `GET /v1/documents` list, no paging parameter; verified read-only on production by root: 25 documents, no hash match); any match means the run is not cold.
- The upload response's `dedupedFromDocumentId`/`dedupScope` mark a content dedup (`deduped-workspace|org`).
- The embed stage's `reuseHits/reuseMisses/providerInputs/documentContextReused` classify `cold` (0 hits), `warm-partial-reuse` or `warm-full-reuse`. Reuse is keyed on chunk text + embedding fingerprint at org level, so a different file split from the same bytes, or a second profile over the same document, is **not** cold even in a fresh workspace.
- Consequence: each source file gives exactly one cold sample per profile configuration. Four files have queries (ASU academic, Statutes 83, Statutes 109, UTA), but they differ in kind (text-native vs scanned, size), so cold runs cannot be repeated per candidate.

## What comparisons may and may not claim (causality rules)

Pages/min, ms/page or cost/page measured on **different PDFs** do not establish that a candidate change caused a difference. Files differ in size, text density, scanned vs native, chunk counts, vision triggers and cache state; a candidate run on file C compared with a baseline on file A confounds the candidate with the file. Therefore:

- A **causal claim about a candidate** requires a matched pair: same file, same profile, same classification (`cold` vs `cold`, or `warm-full-reuse` vs `warm-full-reuse`), same configuration except the candidate flag, and at least 3 repetitions of each arm so run-to-run noise is measured (warm arms can be repeated; a cold arm cannot, because a cold sample is consumed by its first run). Report per-arm spread and claim a gain only if the arms' ranges do not overlap and the gate thresholds below are met.
- Because cold cannot be repeated or matched on these sources, **any candidate-vs-baseline comparison involving a cold run is diagnostic only** (it can localise a bottleneck, rank hypotheses and size per-stage time, but must not be reported as "the change made it N% faster"). In particular E4 (a candidate on a different cold file than the baseline) is a screening diagnostic, never a result.
- Warm-vs-warm pairs on the same file measure only the non-embedding stages (embedding is reused); label them as such. They say nothing about cold end-to-end time.
- Cross-file normalisation (pages/min, ms/page) is allowed for **describing** where time goes and sizing a hypothesis, labelled as such, never for acceptance. Text-native and scanned files are never pooled.
- If no matched pair exists for a change, the report states "unconfirmed".

## Safety and cost gates (frozen)

- One ingestion at a time. Pre-start: `/ready` ok, no other run for this account in `queued|processing`, worker idle. Never create API keys; session cookie from the existing fake test account only (`login` stores cookies 0600 in the run dir; credentials are never printed). New workspace per arm (`bench-large-<profile>-<label>`; `prepare` already ran for `e1-rag-asu`, do not recreate it); existing workspaces are untouched. `prepare` exits non-zero and forbids upload if the effective workspace pipeline differs from the request (text model, per-operation overrides, vision model URI, `maxCostCents`, profile flags). The upload session sends the same `textGeneration`, `vision` and `maxCostCents` overrides.
- Budget: $9.86 shared API remaining. This benchmark's hard ceiling **$5.00** total across all runs. Per-run server cap `maxCostCents: 250` ($2.50); the watcher's own gate defaults to 250c (`--max-cost-cents`) and also aborts when, after 25% of pages, projected cost > 1.5x the gate. At most two full-cap runs fit in $5.00. Order of spend: ASU academic first (`e1-rag-asu`), then `statutes-at-large-vol-83` only if the live ledger shows enough budget left; vol-109 (2,122 scanned pages, most vision exposure) only after vol-83's measured cost per page projects under the remaining budget.
- Watch abort gates, all enforced by `bench.mjs watch`: cost; projected cost; wall time (`--max-wall-min`, default 150); `failedDocuments > 0`; progress endpoint unreachable 6 polls in a row (cost no longer visible); **host memory**: the optional sampler (`--sampler-cmd`, every `--sample-s`, default 30 s) trips on exit code 2 or any `lowMemory: true` entry, and after 3 consecutive sampler failures (exit other than 0/2, timeout, unparsable JSON, or any entry with `error`), because memory would be unobserved. The sampler is awaited, so a slow one (25 s timeout) delays the next poll. Root's sampler: `node --env-file=/home/dan/code/17th-street-labs/docslurp-app/.env.production /tmp/docslurp-large-docs/resource-sample.mjs` (read-only; JSON array of `{ role, memAvailableKiB, lowMemory, error }`; exit 2 when `MemAvailable` < 256 MiB). Pre-run baseline recorded by root: app 2,191 MiB available, worker 13,322 MiB available.
- What a tripped gate does: with `--auto-cancel`, `POST /v1/runs/:id/control {"action":"cancel"}` (retried 3 times), then the run is polled until terminal or `controlState=cancelled` (`--cancel-verify-s`, default 180 s) and the outcome is stored in `state.json` `cancel` (`accepted`, `confirmed`, attempts). The real API has **no `cancelled` run status**: an immediate cancel (queued/paused) gives `status=failed, controlState=cancelled`; an in-flight cancel first returns `controlState=cancel_requested` and the worker stops later, so a 200 from `/control` is not a confirmation. Without `--auto-cancel` nothing is cancelled and the exact cancel call is printed. Watch exit codes: 0 finished, 4 gate tripped, 5 gate tripped and cancel **not confirmed** (root must cancel manually). Run `failed`, repeated stage retries, worker OOM/restart and readiness failing are otherwise observed in the timeline and judged by root.
- Run costs are re-checked from the live ledger (`usage_events`/`usage_attribution`, never hand SQL for spend decisions) before each run; the forecast below is not a gate.

## Model verification (required for every run)

1. `workspace.json`: requested vs effective pipeline (`checks.textModel`, no per-operation overrides, `visionModelUri`, `maxCostCents`, `contextualChunkPreambles`, embedding config).
2. The upload session carries the same overrides.
3. Authoritative actual-model check after the run (root, read-only): `fly logs` for the worker window grepping `[ai-usage]` lines and requiring every text-metric and vision-metric `model=` to equal `z-ai/glm-5.3-flash` (no Sonnet, no Gemini); embedding lines must show only the configured embedding model. The progress payload carries no per-call models, so `report.json.modelCheck` is a weak cross-check. Any other text or vision model, or zero `[ai-usage]` text lines in the enriched profile, invalidates the run.

## Correctness and regression gates (frozen before any candidate)

Correctness (every arm, including the baseline): all queries for the ingested document correct after completion (top-10, oracle above) for every position present; `pagesMatchManifest` true; manifest sha256 equals the uploaded bytes (checked by `upload`); zero failed documents/stages; chunk count and distinct-page coverage not below baseline minus 1%; for enriched, summary/proposition/entity/graph artifacts exist for the document and counts are within 5% of baseline. A candidate that is faster but fails any gate is rejected.

Regression limits vs the matched same-profile, same-file, same-classification baseline (causality rules above): first-correct-result, all-positions-queryable and total time may not rise more than 10%; cost per page not above baseline +10%; peak worker RSS stays under 80% of 16 GB and app RSS under 80% of 4 GB; search p95 not worse than +20%. Minimum worthwhile gain: >=20% lower time-to-all-positions-queryable or >=20% lower total time at equal cost, from a matched pair with non-overlapping repetition ranges. A single cold sample has unknown run-to-run noise; never claim fine-grained gains from one.

## Experiment schedule

Spend order is chosen because cold samples are consumable.

| step | action | purpose |
|---|---|---|
| E0 | `check` (offline), `node --test test/bench.test.mjs`, `preflight`, `prepare` (done) | validate inputs, no spend |
| E1 | cold `rag-only`, ASU academic (`e1-rag-asu`) | baseline timeline, stage breakdown, bottleneck for a text-native 98.98 MB / 7,188-page file |
| E2 | cold `rag-only`, `statutes-at-large-vol-83` (if budget remains) | scanned/OCR baseline, vision count and cost; first source >= 100 MB |
| E3 | profile E1/E2 (stage self-time, RSS, queue vs service, upload vs parse vs embed vs vision) | choose <=3 hypotheses; root implements as flags |
| E4 | candidate on another cold file | **diagnostic screening only** (confounded by file) |
| E5 | warm re-runs of one file, baseline vs candidate, >= 3 each | the only matched comparison available; non-embedding stages only |
| E6 | `enriched` on a file whose rag-only baseline exists | enriched stage costs; never compared with rag-only |

Stop when the budget ceiling, the cold files, or the hypothesis queue is exhausted. A minimal arm (parse+chunk+embed only, everything optional off) is a diagnostic, not a product win. Cost forecast (replace with E1 actuals): GLM 5.3 Flash is $0.049/$0.65 per 1M tokens, embeddings are local; contextual preambles over thousands of pages and any vision calls on scanned pages are the plausible spend, which is why the 250c cap and gates exist.

## Runnable recipe (root)

```
H="node /tmp/docslurp-large-docs/harness/bench.mjs"; A="--label e1-rag-asu"   # defaults: base https://docslurp.io, manifest/queries in /tmp/docslurp-large-docs, runs in /tmp/docslurp-large-docs/runs
$H check $A                                  # offline: sha256, PDF magic, page counts, oracles verified against corpus text, judge self-test, pipeline schema validation
# login, preflight, prepare: already done for e1-rag-asu (workspace 9501ddc8-...); do not recreate
$H upload  $A --go --file asu-2025-26-academic-catalog-archive   # direct upload, one file; writes upload.json
$H watch   $A --go --auto-cancel --max-cost-cents 250 \
  --sampler-cmd 'node --env-file=/home/dan/code/17th-street-labs/docslurp-app/.env.production /tmp/docslurp-large-docs/resource-sample.mjs'
$H probe   $A --go --repeat 5                # post-completion latency
$H report  $A --go
```
Flags: `--base`, `--manifest`, `--queries`, `--credentials`, `--out`, `--core`, `--progress-s`, `--probe-s`, `--sample-s`, `--cancel-verify-s`, `--max-wall-min`, `--max-probes`; env `BENCH_BASE_URL`. `node --test /tmp/docslurp-large-docs/harness/test/bench.test.mjs` runs 10 offline scenarios against `test/mock-server.mjs` (real manifest/queries/PDF bytes, real response shapes): loaders and judge self-test on the 5-file corpus, pipeline pin, check, `--go` refusal, happy path, wrong document/page never queryable, cost-gate cancel confirmed, no cancel without `--auto-cancel`, ignored and rejected cancel reported unconfirmed (exit 5), sampler low-memory cancel, sampler-failure trip, healthy sampler. All 10 pass.

## Known limitations

Verified in this revision: manifest/queries schema, search result shape (`citation.*`), `GET /v1/documents -> { documents }`, `GET /v1/workspaces -> { workspaces }`, run status enum and cancel semantics, direct-upload descriptors (read from server code), and, by root on production (read-only), `/ready`, the documents list, and `prepare` with the effective pipeline. Still open:

- **Never exercised against production:** the direct-upload multipart path for 94-216 MiB files (the harness only ran against the mock; it does not resume a failed part), session confirm, run progress/cancel on a real run, the real search response in a probe, and the sampler inside `watch` (root tested the sampler script itself).
- **The mock models the contracts, not the server.** It mirrors shapes read from code on 2026-10-17; real timings, `stage.stats` contents in progress payloads (`reuseHits` etc. are read from the embed stage `stats` as written in `worker/src/stages/embed.ts`) and error bodies are unverified until the first live run.
- The cost gate uses `usageTotals.costCents`, which includes an estimated worker-compute charge, while the server cap uses `billedCostCents`; the watcher is more conservative than the cap and can abort first.
- Worker/app memory: only run-level `resourceTotals` and the sampler's 30 s `MemAvailable` snapshots; an OOM spike between samples is not prevented. No CPU or per-process sampler.
- Per-call model attribution is not in the API; it relies on the root's log/ledger check.
- Source/page counts, page-level oracles and queries are only as good as the corpus agent's files. `check` verifies them against the corpus' own pdftotext page text, so they are internally consistent, but they come from reading that extractor's text, not an independent label set. Garbled pages (ASU p30) cannot be queried; UTA repeats course text, so several support pages are listed; for the OCR volumes `support_pages` may miss a duplicate hit whose characters OCR misread.
- The text oracle needs the chunk text to contain the pdftotext strings after NFKC/whitespace normalisation; DocSlurp's Markdown rendering of tables, bullets or hyphenation, or different OCR, can cause false negatives (see the OCR caveat). Inspect `probes.jsonl` before concluding the index is wrong.
- `/v1/search` default retrieval flags are used (workspace Retrieval Controls); probes are not chat. Chat/answer latency and `expected_answer` scoring are out of scope.
- The first planned file is 98.98 MB, not 100 MB; only the Statutes volumes are >= 100 MB and they are scanned, so no text-native >= 100 MB source exists (Utah State candidates, >= 207 MB listed, are blocked by a Cloudflare challenge and were not fetched). The course-catalog source has no queries.
- One watcher polls every 5 s plus an awaited sampler, so probe searches and sampler SSH sessions to both machines are part of what is measured; keep them identical across arms.
- Earlier author limitations retained: no host CPU sampler, no per-call model attribution in the API, source quality depends on the corpus agent, and probes use default retrieval flags.
