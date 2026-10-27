# Router integration and measured tuning

The existing worker now has an operator-only, default-off PDF layout **shadow observer**. API, SDK, CLI and MCP uploads continue through their existing workspace pipeline. The observer runs after a valid route plan, records separate evidence, and cannot suppress OCR or change extraction. It is not deployed. Full active routing still needs runtime packaging, exact crop transforms, downstream completeness evidence and a production canary; see [production integration](../../docs/image-layout-production-integration.md).

## Confirmed changes

- Reuse a grayscale histogram for exact brightness/contrast statistics. Independent full-probe confirmation reduced median paired time by **45.1% on tables and 39.9% on math**, with identical complete probe rows excluding timing. [Probe evidence](../probe-pixel-stats-2026-10-21/README.md) retains all five process blocks per slice and the original input raster.
- Deliver newly persisted raster bytes directly to the observer: **one immediate object GET avoided per fresh observed page**, while durable upload remains. Cache hits still read the durable object. This is an operation-count result, not measured S3 dollar savings.
- Cache exact layout observations within tenant/run scope, bounded by entries and bytes; coalesce identical concurrent requests. Pin source, graph, model, device and complete inference profile. Queue saturation, invalid output and timeouts fail open to the existing plan. Surviving callers own queued request accounting after creator cancellation.
- Preserve no-extra-render/inference/artifact-write behavior for pages not selected. Bound observation pages, document wait time and retained evidence. Stored boxes remain normalized raster coordinates with no invented PDF transform.

## Before/after measurements

Local CPU, Node 26.8.2, native-pdf 0.13.0, Tiny ONNX Runtime 1.31.0. The new stage instrument runs the actual RoutePagesStage with real probe, native raster and resident detector, but a local filesystem artifact adapter. It excludes S3, database persistence, Temporal queueing and downstream extraction. It is not full ingestion or a production benchmark.

| Scenario | Before | After | Meaning |
| --- | ---: | ---: | --- |
| Probe: tables, median ms/page | 46.57 | 23.97 | Independent probe experiment; paired reduction 45.1% |
| Probe: math, median ms/page | 44.86 | 28.39 | Independent probe experiment; paired reduction 39.9% |
| Native invoice route stage, off → shadow | 22.01 ms | 23.71 ms | No layout calls or extra raster/object writes |
| Native math route stage, off → shadow | 24.79 ms | 26.28 ms | No layout calls or extra raster/object writes |
| Scan route stage, off → shadow | 28.37 ms | 193.80 ms | Adds one raster + observation; OCR assignment unchanged |
| Deliberate three-use layout cache, 12 completions/block | 1,018.24 ms | 355.59 ms | Direct requests → cache; 12 → 4 HTTP requests/block |

Do not add these gains together. Both stage arms already contain the optimized probe. Native-stage timing variation is small in absolute terms but not evidence of zero overhead; the no-extra-I/O/model-call result is established by counts. The scan's approximately **165 ms added latency** is shadow evidence collection cost, not an extraction saving.

Stage comparisons use five paired blocks in one process, three source documents, plus a separate warmup block. The scenario matrix uses the existing heuristic router for native pages and baseline router for the scan; each before/after pair uses the same policy. Plans match exactly and every final scenario receives an assignment. Five scan observations succeeded, zero failed; fresh raster GET count is zero. These repetitions are not independent documents. Native acceptance here tests behavior preservation, not native content completeness or mathematical correctness.

The cache experiment uses four development images repeated three times across five paired blocks: 60 completions per arm, 60 direct HTTP requests versus 20 cached-arm HTTP requests. Exact semantic region output matched. The artificial 2/3 reuse rate is not a measured production cache-hit rate. Warmup and miss cost remain visible in raw records; a pooled cache-hit latency would hide misses.

## Usage, scope and non-results

No paid host or external model API was used in this tuning session. Local CPU cost and agent/reporting overhead were not independently metered here. The layout service was stopped after measurements. No model-token usage exists for these local detector calls; no tokens are fabricated. Shadow dispatches enter the scoped usage ledger as nonbillable requests. A configured hourly rate can produce an explicitly estimated service-wall-time allocation; queue, startup and idle residency are excluded, and this must not be added again to allocated worker cost.

No avoided OCR/VLM calls, full-ingestion cost savings, GPU improvement or production SLO improvement is established by this work. Neither detector previously passed the general completeness gate, so confidence cannot enable automatic acceptance. The standard worker image still needs explicit resident-service packaging/supervision and pinned weights before a canary. Raw-image routing and a pre-extraction fast path remain separate work.

## Validation and instrument corrections

392 combined routing/layout/raster tests passed, one existing skip. Worker typecheck and production build passed. Focused runtime contract tests and independent review covered identity, profile drift, cancellation, scoped accounting, resource bounds and failure behavior. Integration diagrams rendered and local links resolved.

The independent integrity gate passed on all 32 rich-corpus cases with zero findings after relocating raw evidence to the external evaluation store. The unchanged gate initially classified raw prediction/visualization files under `performance/` as production-scanned content. All reported paths were evidence files, not worker logic. The failed receipt is retained externally; no leakage rule was weakened.

The first stage attempt failed before execution because its package import could not resolve. A later baseline-only diagnostic produced empty native-page plans and is **not valid healthy-page evidence**. A heuristic-only diagnostic failed to exercise scan observation. Neither is used in the table. The final explicit two-policy scenario matrix adds assignment and observation-count assertions so these omissions cannot pass silently. Repeated harness repairs are development measurements, not a held-out quality confirmation.

## Artifacts and rerun

[summary.json](summary.json) contains medians, ranges, operation counts and hashes of authoritative receipts. Full raw results, prediction JSON and raster images are retained at `/home/dan/data/docslurp-evals/runs/router-layout-20261021`; they are deliberately outside product source. The source PDF for the scan is retained there under `sources/menu-scan.pdf`.

Use the pinned local model and resident service from the [quickstart](../../docs/image-layout-quickstart.md). Set all `PAGE_ROUTER_LAYOUT_*` pins, including the reviewed `/health` profile hash, and the native binding's `DOCSLURP_NATIVE_PDF_MODULE`. Set `TMPDIR`, `TMP`, `TEMP` to the machine's approved scratch root. Then, from core root:

```sh
node_modules/.bin/tsx performance/router-layout-2026-10-21/benchmark-stage.mts \
  /absolute/external/results/stage \
  /home/dan/data/docslurp-evals/runs/router-layout-20261021/sources/menu-scan.pdf
node_modules/.bin/tsx performance/router-layout-2026-10-21/benchmark-observer.mts \
  /absolute/external/results/observer
node scripts/evaluation-integrity-judge.mjs \
  --dataset /home/dan/data/docslurp-evals/layout-synthetic-v2 \
  --base 5fe9ac4e --output /absolute/external/results/integrity.json
```

The benchmark scripts are local orchestration, not production inputs. The observer script freezes its model/device/graph and four development inputs; the stage harness requires the explicit environment profile. Update both arms together if runtime or instrument changes. Production rollout requires core merge, app pin update, passing CI and an explicitly requested manual deploy, with correlated SigNoz checks before/during/after.
