# End-to-end router benchmark with the layout shadow observer

Real ingestion, not a stage harness: API upload → Temporal workflow → built worker (`node dist/temporal/worker.js`) → MinIO + Postgres, with usage, performance, artifacts and spans read back from the same stack. It closes the gap left by [router-layout-2026-10-21](../router-layout-2026-10-21/README.md), which excluded S3, the database, Temporal and downstream extraction. Local only: no production data, deploys or infrastructure changes.

## Method

**Corpus.** 123 documents, 145 pages, development splits only ([select-corpus.mjs](select-corpus.mjs), deterministic, no held-out or test items):

| Kind | Docs | Pages | Source |
| --- | ---: | ---: | --- |
| Born-digital prose, specs, articles (tier 1) | 11 | 22 | routing-suite-v1 dev |
| Mixed: charts, math, sidebars (tier 2) / image insets (tier 3) | 10 | 10 | routing-suite-v1 dev |
| Unusual: forms, annotations, rotation, layers, Type3 (tier 5) | 13 | 13 | routing-suite-v1 dev |
| Scans (none, bad and good OCR layers; clean and degraded) | 17 | 18 | routing-suite-v1 dev, pdfust wild-v1-raster dev |
| Raster-only real pages (papers, catalogs, specs) | 29 | 29 | preservation-suite-95-v3 dev |
| Native and mixed math (context-attention variants) | 12 | 12 | preservation-suite-95-v3 dev |
| Native business documents / PDF quirks | 14 | 20 | pdfust wild-v1 and wild-v1-quirks dev |
| Repository PDF fixtures | 11 | 15 | `worker/testdata/pdf-fixtures` |
| Standalone PNG/JPEG images (150 dpi rasters of dev scans) | 6 | 6 | derived from dev items above |

Gold or silver references exist for 112 of the 123 documents. The repository fixtures have no reference.

**Arms.** Both arms run the current production routing policy on workspace defaults (`pipeline '{}'`): `PAGE_ROUTER_MODE=shadow` with the decision-model router (`openai/gpt-6-luna-decisions` first), `DOCSLURP_PDF_ENGINE=shadow` with native-pdf 0.13.0, Gemini 3.1 Flash Lite vision fallback (max 4 pages/doc), pplx-embed embeddings and Qwen 3.5 Flash contextual preambles.

- **A:** layout off.
- **B:** the same, plus `PAGE_ROUTER_LAYOUT=shadow` with the resident PP-DocLayout-S ONNX service, pinned by model, revision, artifact `e3f62a17…` and profile `d82a86f5…`. Audit pages = 1; other limits are defaults.

Each arm uses its own org, because content dedup is org-scoped. Documents are submitted one at a time and timed from upload to a terminal run status. Blocks run in ABBA order (four blocks), and each worker restart is followed by two excluded calibration-split warmup documents.

Two complete paired runs were made:

- **main**: branch HEAD `e15996da`.
- **postfix**: `755c9d51`, after the three bug fixes below.

**Measurement sources.**

| What | Source |
| --- | --- |
| Tokens and USD | Ledger `usage_attribution`. Provider USD is `metadata.providerCostCents`; customer-priced USD is `cost_cents` and includes the 20% AI markup. |
| Stage time | `performance_log` stage-duration |
| S3 operations | Worker/API OTLP spans tagged `docslurp.runId`, exported to a local OpenTelemetry Collector |
| Stored objects and bytes | Listing of the run prefix |
| CPU | Worker and layout processes, `/proc` utime+stime+cutime+cstime deltas |
| RSS | Sampled every 250 ms |

## Pre-declared policy C

[policy-c.json](policy-c.json) was committed in `f11079ce` before any benchmark run. It skips a page's VLM/OCR call only when all of these hold:

- B has a successful layout observation of that page.
- Every region at confidence ≥ 0.30 is text-like.
- At least one paragraph has confidence ≥ 0.50.
- Text regions cover ≥ 5% of the page.
- The text layer is healthy: probe `textLayerStatus == ok` and ≥ 50 native words.

Missing probe facts mean "not healthy". Quality is bag-of-tokens F1 against the reference. The thresholds were not changed after the results came in.

## Results (postfix; main in parentheses where it differs)

| Per arm | A: layout off | B: layout shadow |
| --- | ---: | ---: |
| Documents completed / failed / timed out | 123 / 0 / 0 (122 / 1 / 0) | 123 / 0 / 0 (122 / 1 / 0) |
| Pages accepted native (no extraction call) | 88 | 88 |
| Gemini VLM page calls | 57 | 57 |
| Separate local OCR calls | 0 | 0 |
| Decision-model router calls (triage, inset, canary) | 96 | 97 |
| Layout requests (local, nonbillable) | 0 | 121 (117) |
| Paid calls / input tokens / output tokens | 404 / 483,566 / 60,696 | 405 / 484,053 / 60,696 |
| Provider USD (customer-priced USD) | $0.1055 ($0.1266) | $0.1055 ($0.1266) |
| End-to-end p50 / p95 / max (s) | 4.07 / 11.07 / 45.2 | 4.59 / 10.83 / 43.7 |
| Pages per minute (sequential, 1 document in flight) | 13.38 (12.86) | 12.46 (12.44) |
| Time to ingest 100 pages | 7.47 min (7.78) | 8.02 min (8.04) |
| Pages per $1 (provider / customer) | 1,375 / 1,146 | 1,374 / 1,145 |
| S3 PUT / GET / HEAD (traced, excl. LanceDB) | 2,953 / 1,718 / 116 | 3,133 / 1,718 / 243 |
| GET bytes | 231.3 MB | 231.3 MB |
| Stored objects / bytes / raster objects | 2,796 / 107.5 MB / 62 (27.2 MB) | 2,976 / 126.3 MB / 125 (44.3 MB) |
| pdftoppm renders (render-images rendered / reused) | 55 (59 / 0) | 130 (4 / 55) |
| Worker CPU-s total (per-doc p50) | 129.9 (0.95) | 138.1 (1.01) |
| Layout service CPU-s total | 0 | 34.6 (0.29 CPU-s/inference) |
| Peak RSS: worker / layout service | 601 MB / 127 MB idle | 591 MB / 154 MB |

Cost by model, provider USD per arm:

| Model | Cost | Share |
| --- | ---: | ---: |
| Gemini Flash Lite VLM | $0.0897 | 85% |
| Qwen preambles | $0.0092 | |
| Router decision calls | $0.0056 | |
| Embeddings | $0.0011 | |

Raster-only pages cost $0.0015 each. Born-digital tier-1 pages cost $0.00005 each. Router decision and embedding costs are `catalog-input-price` / `estimate`, not provider-reported. VLM and preamble costs are provider-reported.

**Stage latency, ms (postfix, A → B).**

| Stage | p50 | p95 | max |
| --- | --- | --- | --- |
| extract-markdown | 334 → 332 | 1,105 → 1,203 | 5,923 → 5,773 |
| route-pages | 483 → 960 | 1,917 → 2,847 | 3,957 → 3,630 |
| render-images | 14 → 13 | 992 → 17 | 2,075 → 2,154 |
| vision-extract | 14 → 13 | 6,079 → 5,935 | 39.5 k → 39.8 k |
| embed | 1,544 → 1,612 | 2,251 → 3,047 | |

Distributions, as document counts:

```text
End-to-end wall per doc   0-2s 2-4s 4-6s 6-8s 8-10s 10-15s 15-20s 20-40s >40s
  A (postfix)               0   60   28   19    7     8      0      0     1
  B (postfix)               0   49   36   17   12     8      0      0     1
Paired B-A delta          <-2s -2..-1 -1..-.5 -.5..0  0..+.5 +.5..+1 +1..+2 +2..+4 >+4
  postfix                   2     8      8      15     34      29      17     10     0
  main                      3     4     10      16     37      28      17      5     2
Provider cents per doc    <.01 .01-.05 .05-.1 .1-.25 .25-.5 .5-1 1-2 >2
  A = B                     45    39      6     23     9     0    0   1
```

**Shadow overhead (paired, postfix; n = 123).**

- **Wall time:** +267 ms median, +390 ms mean, +2.0 s p95 per document. Throughput falls 6.9% (main: 3.3%).
- **route-pages:** +403 ms median. A layout page row costs 401 ms p50 and 1.47 s p95, of which the service's own inference is 59 ms p50 and 91 ms p95. Rendering and raster upload dominate.
- **render-images:** −204 ms mean, because 55 of the shadow's rasters were reused by vision extraction.
- **Renders and storage:** +75 pdftoppm renders, +63 raster objects, +18.9 MB stored, +180 PUTs. GETs are unchanged, which confirms the fresh-byte handoff.
- **CPU:** +8 worker CPU-s, plus 34.6 layout CPU-s for 121 inferences.
- **Extraction and spend:** no change to VLM calls, tokens or spend, as expected for shadow mode.

## Policy C counterfactual

| | main | postfix |
| --- | ---: | ---: |
| Arm A VLM page calls ($) | 57 ($0.0897) | 57 ($0.0897) |
| …with B layout evidence on the same page | 50 | 53 |
| Layout text-only (all three layout conditions) | 13 | 14 |
| Healthy text layer (condition 5) | 0 | 0 |
| **Calls C would skip / USD / tokens / latency avoided** | **0 / $0 / 0 / 0** | **0 / $0 / 0 / 0** |
| Quality loss | none (nothing skipped) | none |

C saves nothing on this corpus, and the reason is structural. Every page the production path sends to a VLM is a page without a usable text layer: raster-only pages, scans, or image-heavy fixtures. Layout often sees "only text" on those pages because they are scanned prose, but there is no native text to fall back on.

A diagnostic that is not the declared policy drops the healthy-text condition. It would skip 14 calls, and on the 11 with references it loses a mean **0.76 F1**, with 9 material losses. Native F1 is 0 on scans, versus 0.80–1.0 for the VLM. Only a filled acroform page would have been near-safe (F1 0.95 vs 0.99).

Layout-gated savings therefore need a different action, for example sending text-only, no-text-layer pages to local OCR instead of the VLM. That needs its own pre-declared evaluation with real OCR outputs; this run produced none.

## Audit findings: candidate wrong native acceptances

The pre-declared rule flags an audit page when layout sees a table, figure, chart, formula, formula_number, code or seal region at confidence ≥ 0.5.

- **main:** 53 candidates, but 45 were not healthy-text pages. They landed in the audit pool mostly because the budget-guard bug below left them unrouted.
- **postfix:** 20 candidates. 8 are router-accepted healthy-text pages that production extraction kept native:
  - 2 tables in rotated pages (F1 1.00);
  - 3 formula pages in mixed-math documents (F1 0.97);
  - 1 table in the mixed-content repository fixture (no reference);
  - 2 attention-journal variants (actualtext-latex and mixed-vector-math) with formulas and charts, where native F1 is **0.81 < 0.90**. These are confirmed incomplete native acceptances.

Across both runs, layout repeatedly flagged native-only pages whose text is badly incomplete. The most severe is `context-attention-journal-85-unmapped-fonts`: native F1 0.046, kept native by production extraction, and with zero router assignments before the fix.

After the fix, the router does want pixels for that page and for 25 other routed pages (counts by kind in `summary.json` → `routedPagesLeftNativeByShadowExtraction`; the page list is in the external `raw-postfix/analysis.json`). These include all `scan-*-bad` pages with garbage OCR layers. The legacy shadow-mode extraction still left all of them native. This is a gap between router and extraction, not a layout result.

Six layout observations timed out at the 2 s default, in both runs. Every one was a degraded-scan page (memo-35, lists-36), which is exactly the class where layout evidence matters. The deadline covers render plus inference. It was not tuned here.

## Bugs found and fixed (separate commits, with tests)

1. **`94c92e18`: the budget guard dropped pages it could not help.**
   - The router's own decision-model cost is billed at 1.2× (margin 16.7%), below the 0.5 floor. The guard therefore deferred a raster page's only local OCR assignment (margin 0.70 on its own).
   - Removing it could never restore the floor, and it left the page with no assignment and no attention entry.
   - In main, 54 of 123 plans had zero assignments; postfix has 4. Routed layout observations rose from 9 to 75.
2. **`1aece870`: worker `performance_log` and `parser_eval_results` metadata were double-encoded.**
   - The values were stored as JSON strings inside jsonb: 60,664 string rows vs 1,168 object rows.
   - As a result, `metadata ->> 'detectedLanguage'` in the ingest report was always NULL, and router/layout evidence was not queryable.
3. **`755c9d51`: low-plausibility extraction escalation never ran.**
   - Retry strategies (native-pdf, poppler, …) hit the in-run content-hash dedup that the failed first attempt had registered.
   - 40 of 123 documents per arm were affected.
   - `context-attention-journal-85-path-only` failed ("no extractor produced text") in both main arms and completes in postfix.

No other bug changes the arms. Every paid call logged `[ai-usage]` and persisted a ledger row, with counts equal for each metric.

## Evaluation integrity

The judge does not accept `catalog.json` corpora, so an external dataset was assembled at `integrity/dataset` in the run directory. It has 112 cases (every corpus item with a reference) and its own `integrity-manifest.json`. Labels are each catalog's reference page Markdown; the 11 unlabeled repository fixtures are excluded.

`node scripts/evaluation-integrity-judge.mjs --dataset <run>/integrity/dataset --base e15996da` **passed with 0 findings** (1,765 files scanned, 1,086 production). The scan covers the three product fixes and this directory.

The first attempt flagged 72 fixture identifiers in a draft `summary.json` that listed per-file evidence. Per-file rows now stay in the external `raw-<tag>/analysis.json`, and the committed summary holds aggregates only. No rule was relaxed. The passing receipt is `integrity/router-e2e-change-set.json`; the failing first receipt was overwritten at the same path, and its 72 findings are recorded only in this paragraph. The product fixes contain no fixture names, content or thresholds from this corpus.

## Limitations

- **Concurrency.** Submissions were sequential with one document in flight. Pages per minute is single-document latency throughput, not fleet capacity under docConcurrency 4.
- **Local hardware.** The worker cost class is `development:unknown`, so local CPU and storage are not priced. Pages per $1 covers paid provider calls only.
- **Production image differences.** `ocrmypdf`, ClamAV, docling and pandoc are absent locally, so quarantine fails open in development. No local SigNoz was available, so traces went to a local collector, not production SigNoz.
- **Not counted.** LanceDB's native S3 traffic is excluded from the operation counts. MinIO server metrics did not update at per-document granularity.
- **Run-to-run variation.** Decision-model chain selection varied slightly between processes (canaries per worker start; clef-flash fallback on some main-run A segments). The cost effect is under $0.002.
- **Quality metric.** Bag-of-tokens F1 is coarse. It cannot judge formula or table structure and splits CJK only at non-alphanumerics, which was declared in advance. Repository fixtures have no references.
- **What C could observe.** C can only act on pages B observed. Per the pre-declared rule, routed pages never count as healthy, because probe facts other than the audit row's `healthyTextLayer` are not persisted.
- **Standalone images.** They bypass route-pages (`unsupported-format`), so layout and C never see them. Their text comes from kreuzberg's in-process OCR, which is not counted as a separate OCR call.

## Rerun

The isolated stack, layout service, env files (`env/base.env`, `env/layout.env`, `env/secrets.env` holding only `OPENROUTER_API_KEY`), MinIO metrics token and raw outputs live outside the repository in `/home/dan/data/docslurp-evals/runs/router-e2e-20261021/`. From core root, with the worker built (`pnpm --filter @docslurp/worker build`), the API running on the env's port, and the resident layout service started per the [quickstart](../../docs/image-layout-quickstart.md) with `--model pp-small-onnx --threads 4 --port 18779`:

```sh
RUN=/home/dan/data/docslurp-evals/runs/router-e2e-20261021
docker compose --env-file $RUN/env/compose.env up -d postgres redis minio createbucket temporal
node performance/router-e2e-2026-10-21/select-corpus.mjs /home/dan/data/docslurp-evals . $RUN/corpus
node performance/router-e2e-2026-10-21/run-bench.mjs $RUN --tag postfix --blocks 4 --spend-cap-usd 4.5
node performance/router-e2e-2026-10-21/analyze.mjs $RUN postfix $RUN/raw-postfix/summary-postfix.json
node performance/router-e2e-2026-10-21/combine-summary.mjs $RUN performance/router-e2e-2026-10-21/summary.json main postfix
```

[summary.json](summary.json) holds both runs' aggregates, distributions, layout statistics, audit findings, the policy C evaluation, spend and the logging check. Per-document rows, layout regions and policy C page rows are in `raw-<tag>/analysis.json`. Total paid spend for all calls, including smoke, pilots and warmups, was **$0.4267 provider USD** ($0.5121 customer-priced) against a $5 cap. The OpenRouter balance was $92.77 before and $92.34 after.
