# Large-PDF production ingestion benchmark: contract

Prepared 2026-10-17 ~03:25 UTC. Baseline: production app `a1d1af5`, core `5972781` (app machine 4 GB, worker 16 GB, no new capacity). **Nothing in this plan has been run against production.** Root controls every run, every production source change and the model eval runner.

## Objective and workload

University catalogs, 100+ MB, ~1000+ pages, real bytes (never regenerated). Sources and `manifest.json` / `queries.json` are written independently by the corpus agent in `/tmp/docslurp-large-docs/sources/`; this plan and the harness never contain document names, queries or expected values (Evaluation Integrity). Each query carries its own oracle (`mustContain`/`mustContainAny` substrings, `expectedPages`, optional `filename`) and a `position` of `beginning | middle | end`.

Two workloads are never compared with each other:

| profile | work | pipeline overrides |
|---|---|---|
| `rag-only` | extract, chunk, contextual chunk preambles (schema default, required work, left on), embed, vector + lexical index | `summarize/pageIndex/propositionIndex/graphRag/graphCommunitySummaries/entityIndex = false` |
| `enriched` | all of the above plus summary, page index, propositions, entities, GraphRAG, community summaries | all `true` |

Both pin `textGeneration: { model: "z-ai/glm-5.3-flash", models: {} }` (user requirement; OpenRouter list price checked 03:21 UTC: $0.04 in / $0.20 out per 1M tokens, allowed). No per-operation override may diverge. Vision/OCR is a separate route (`pipeline.vision.modelUri`, default `llm://openrouter/google/gemini-3.1-flash-lite`); the harness records it but never sends the text model there. Whether a native-text catalog PDF triggers OCR at all is itself a measurement (stage list, not assumed). No work may be disabled to claim a win; any change that reduces required work (page skips, lower index fidelity) is a correctness-gate failure unless the output is shown equivalent.

## Milestones (what is classified and timed)

Clock starts at upload start (`t0`). `bench.mjs watch` writes `timeline.jsonl` (progress every 5 s), `probes.jsonl` (correctness probe every 30 s while any of beginning/middle/end is unsatisfied), `sampler.jsonl` (optional read-only hook), and `report.json` with:

1. `uploadAccepted`: direct-upload `confirm` returned a run in the benchmark workspace (upload MB/s, part count and per-part times recorded separately).
2. `firstPageProcessed`, per-stage start/end/attempts/error from run stages.
3. `firstCorrectResult`: first probe whose results satisfy the oracle (text, page, filename), with pages processed at that moment.
4. `queryable_beginning`, `queryable_middle`, `queryable_end`, `allPositionsQueryable`. A final post-completion pass gives every unsatisfied position a verdict.
5. `runCompleted`: run status `completed`; pages/min over `uploadAccepted..runCompleted`; run cost, tokens, peak RSS from `progress.usageTotals/resourceTotals`.

Search probes are real calls (one query embedding each): count them, and subtract nothing silently. Probe cadence is a measurement cost; keep it identical across arms. Latency/cache: post-completion `probe --repeat 5` reports p50/p95 and marks repeats as cache-eligible.

## Cold versus reused (no cold claim without evidence)

`report.json` sets `classification`, and `coldClaimAllowed` is true only for `cold`:
- `preflight` lists same-sha256 documents already in the org (scans up to 500; if it shows any, the run is not cold).
- The upload response's `dedupedFromDocumentId`/`dedupScope` mark a content dedup (`deduped-workspace|org`).
- The embed stage's `reuseHits/reuseMisses/providerInputs/documentContextReused` classify `cold` (0 hits), `warm-partial-reuse` or `warm-full-reuse`. Reuse is keyed on chunk text + embedding fingerprint at org level, so a different file split from the same bytes, or a second profile over the same document, is **not** cold even in a fresh workspace.
- Consequence: each source file gives exactly one cold sample per profile configuration. With three files, cold runs cannot be repeated per candidate; see schedule.

## Safety and cost gates (frozen)

- One ingestion at a time. Pre-start: `/ready` ok, no other run for this account in `running|queued`, worker idle. Never create API keys; session cookie from the existing fake test account only (`login` stores cookies 0600 in the run dir; credentials are never printed). New workspace per arm (`bench-large-<profile>-<label>`); existing workspaces are untouched. `prepare` exits non-zero and forbids upload if the effective workspace pipeline differs from the request.
- Budget: $9.86 shared API remaining. This benchmark's hard ceiling **$5.00** total, per-run abort at **$3.00** (`--max-cost-cents 300`); also abort when, after 25% of pages, projected cost > 1.5x that ceiling. Abort conditions otherwise: wall > 150 min (`--max-wall-min`), run `failed`, repeated stage retries, worker OOM/restart, readiness failing. The harness records the trip; cancelling the run is root's call unless `--auto-cancel` is given.
- Run and prices are re-checked from the live ledger (`usage_events`/`usage_attribution`, never hand SQL for spend decisions) before each run; the estimate below is a forecast, not a gate.

## Model verification (required for every run)

1. `prepare.workspace.json`: requested vs effective pipeline (`checks.textModel`, no per-operation overrides, `contextualChunkPreambles`, vision route, embedding config).
2. The upload session carries the same `pipeline.textGeneration` override.
3. Authoritative actual-model check after the run (root, read-only): `fly logs` for the worker window grepping `[ai-usage]` lines and requiring every text-metric `model=` to equal `z-ai/glm-5.3-flash`; embedding and vision lines must show only their configured models. The run progress payload does not carry per-call models, so `report.json.modelCheck` is a weak cross-check only. Any other text model, or zero `[ai-usage]` text lines in the enriched profile, invalidates the run.

## Correctness and regression gates (frozen before any candidate)

Correctness (every arm, including the baseline): all `queries.json` queries correct after completion (top-10, oracle satisfied) for beginning, middle and end; page count equals the source's (`pdfinfo`) and manifest sha256 equals the uploaded bytes; zero failed documents/stages; chunk count and distinct-page coverage not below baseline minus 1%; for enriched, summary/proposition/entity/graph artifacts exist for the document and counts are within 5% of baseline. A candidate that is faster but fails any gate is rejected.

Regression limits vs the same-profile baseline: first-correct-result, all-positions-queryable and total time may not rise more than 10%; cost per page not above baseline +10%; peak worker RSS stays under 80% of 16 GB and app RSS under 80% of 4 GB; search p95 not worse than +20%. Minimum worthwhile gain to accept: >=20% lower time-to-all-positions-queryable or >=20% lower total time at equal cost, confirmed on a file not used in screening. A single cold sample per file has unknown run-to-run noise (not estimated; never claim fine-grained gains).

## Experiment schedule

Spend order is chosen because cold samples are consumable.

| step | action | purpose |
|---|---|---|
| E0 | `check` (offline), mock rehearsal, `preflight` | validate inputs, no spend |
| E1 | cold `rag-only` on smallest-page file A | baseline timeline, stage breakdown, bottleneck |
| E2 | cold `enriched` on file B | enriched baseline and stage costs |
| E3 | profile E1/E2 (stage self-time, RSS, queue vs service, upload vs parse vs embed) | choose <=3 hypotheses; root implements as flags |
| E4 | candidate on file C (still cold) vs E1/E2 normalised per page | screening; sizes differ, so compare pages/min and ms/page per stage, not wall clock |
| E5 | warm re-run of file A (reuse path) | measures what reuse already buys; labelled warm, never a cold result |
| E6 | frozen finalist on a held-back cold file, or an end-to-end rerun of A after reuse is excluded | confirmation; if no cold file remains, report confirmation as unavailable |

Stop when the budget ceiling, the three cold files, or the hypothesis queue is exhausted. A minimal arm (parse+chunk+embed only, everything optional off) is recorded as a diagnostic for locating the bottleneck, not as a product win. Expected cost (forecast only, to be replaced with E1 actuals): GLM 5.3 Flash tokens at $0.04/$0.20 per 1M are small next to embedding and any OCR/vision calls.

## Runnable recipe (root)

```
H="node /tmp/docslurp-large-docs/harness/bench.mjs"; A="--label e1-rag-A"   # defaults: base https://docslurp.io, runs in /tmp/docslurp-large-docs/runs
$H check $A                                  # offline: sha256, PDF magic, query oracles, pipeline validated with shared schema
$H login $A --go                             # session cookies only
$H preflight $A --go                         # health, readiness, same-bytes-in-org
$H prepare $A --go --profile rag-only        # new workspace, effective-config verification (exit 3 on mismatch)
$H upload  $A --go --file <manifestId>       # direct upload, one file; writes upload.json
$H watch   $A --go --max-cost-cents 300      # polling, probes, milestones, report.json
$H probe   $A --go --repeat 5                # post-completion latency
$H report  $A --go
```
Flags: `--base`, `--manifest`, `--queries`, `--credentials`, `--out`, `--core`; env `BENCH_BASE_URL`; `--sampler-cmd '<read-only shell>'` (e.g. a `fly status`/`fly machine status` loop; none is built in, none is run by default). `node test/mock-server.mjs 8799` provides an offline stand-in (rehearsed: all milestones, cold/warm, refusal without `--go`).

## Known limitations

- Unverified against production: the exact app origin for `/v1` and `/api/auth/sign-in/email` (default `https://docslurp.io`, override with `--base`), `/v1/documents?limit=` paging for the reuse scan, and the real direct-upload descriptors for 100+ MB (the multipart path follows `app/src/lib/api.ts` but only ran against the mock).
- Worker/app CPU and memory: only run-level `resourceTotals` and stage `adaptiveTuning.resource` are available through the API; no host sampler is built in.
- Per-call model attribution is not in the API; it relies on the root's log/ledger check.
- Source/page counts, the page-level oracle and the queries are only as good as the corpus agent's files; `check` flags missing positions and oracle-less queries but cannot prove the answers are correct.
- `/v1/search` default retrieval flags are used (workspace Retrieval Controls); probes are not chat. Chat/answer latency is out of scope here.
