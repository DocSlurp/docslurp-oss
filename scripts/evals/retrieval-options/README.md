# Retrieval option evaluation

This directory contains a reproducible offline replay and a bounded production pilot. Development labels are already exposed: neither experiment is a held-out quality result. No scripts change workspace configuration or deploy services.

## Offline replay

```sh
node scripts/evals/retrieval-options/offline.mts \
  --input /tmp/docslurp-embedding-20261017/raw \
  --queries /tmp/docslurp-embedding-20261017/queries.json \
  --judge /tmp/docslurp-large-docs/harness/bench.mjs \
  --output /tmp/retrieval-options-offline-fixed.json
node --test scripts/evals/retrieval-options/contracts.test.mts
```

`--input` accepts a saved candidate JSON or directory; `--arm` defaults to `parent-no-rerank-wide`. External queries and judge are mandatory. Input and implementation SHA-256 hashes are saved. Original candidate order is the saved public response order, not a recovered raw vector ranking. Parent text is available as evidence consistently across ranking arms. This uses the original judge's document, page and required text checks, not generated-answer correctness.

| Ranking, same saved pool | Correct@5 | Correct@10 | Correct@20 | Correct@50 | MRR@10 |
|---|---:|---:|---:|---:|---:|
| Saved order | 21/28 | 23/28 | 24/28 | 25/28 | .618 |
| Chunk BM25 | 24/28 | 24/28 | 25/28 | 25/28 | .798 |
| Parent-aware BM25 | 25/28 | 25/28 | 25/28 | 25/28 | .851 |
| RRF saved + parent BM25 | 25/28 | 25/28 | 25/28 | 25/28 | .759 |
| Parent-aware BM25 + exact-parent/text deduplication | 25/28 | 25/28 | 25/28 | 25/28 | .851 |
| Original positional MMR fallback | 20/28 | 22/28 | 24/28 | 25/28 | .589 |

Original fallback results were identical at lambda 0, .25, .5, .75 and 1. Saved responses have no vectors, and the original production call path stripped vectors before MMR. Thus these are **positional fallback tests**, not genuine vector MMR. Lambda=1 incorrectly demoted relevance. The separate server fix now preserves relevance when vectors are missing or invalid; the fixed replay restores 23/28 for the saved ranking and retains 25/28 for parent BM25. Genuine vector diversity still needs vector-bearing retrieval inputs and quality evaluation.

Artifacts: `/tmp/retrieval-options-offline.json` (before fix), `/tmp/retrieval-options-offline-fixed.json` (after). The contract tests fail against the original HEAD snapshot and pass against the corrected implementation. Red/green logs are in `/tmp/docslurp-retrieval-options-20261017/`. Use `MMR_MODULE=/absolute/path/to/mmr.ts` to reproduce the red test against a selected implementation.

Parent-aware reranking reaches the observed pool ceiling at k=5. This supports testing a 5–10-result profile, not globally reducing result count: three failures have no passing candidate even at 50. Larger k cannot recover missing candidates. RRF does not improve recall here and ranks the first correct evidence lower. Exact deduplication has no measured gain. Position reordering changes MRR without changing selected evidence, so no answer-quality benefit is inferred.

## Control inventory and interpretation

| Control | Evidence status / limitations |
|---|---|
| `limit` / resultCount | Offline 5/10/20/50 measured; defaults use 8. API accepts up to 100, workspace defaults cap 50. Fresh wider retrieval can change candidate pools and is not this replay. |
| `rerank` | Local BM25 measured, including chunk versus parent text; no trained cross-encoder evidence. `rerankRemote` is a BM25 fallback stub. |
| `mmr`, `mmrLambda` | Original positional fallback quantified; missing-vector fix covered by contracts. Genuine vector MMR remains unevaluated. |
| Parent retrieval | Offline parent evidence/ranking and live on/off measured; must evaluate citation scope and longer answer prompts separately. |
| RRF | Actual implementation measured on saved order + lexical order; this does not recreate independent lexical and vector retrieval pools. |
| Exact dedupe | Offline identical-parent/text grouping measured; semantic dedupe not implemented in this experiment. |
| Lost-in-middle reorder | Actual function replayed; retrieval membership unchanged. Answer-quality impact needs generation eval. |
| HyDE | Live one-at-a-time pilot; requires helper model and new embedding/retrieval calls. |
| Query rewrite | Live one-at-a-time pilot; stochastic development results need repeat/held-out confirmation. |
| Query decomposition | Live flag accepted, but six-query pilot has only six query embedding events: no evidence of expanded compound retrieval. Planner splits heuristically only when multiple valid subqueries are produced. A no-op is not a successful decomposition test. |
| Stepback | Live flag tested; new generalized query plus merged original retrieval, provider-backed. |
| Summary seed | Live flag tested; current planner searches LanceDB, aggregates scores by document and narrows to five document IDs. It does not demonstrate a dedicated summary index; single-document workspaces provide little opportunity for this control. |
| Self-query | Live flag tested; can change filters and hurt recall if inferred filters are wrong. |
| Compression | Live flag tested; up to 20 helper calls/search. Retrieval and exact-text oracle effects differ from answer quality. |
| Iterative multihop | Live flag tested; usefulness depends on actual iteration/chain diagnostics, not a boolean request alone. |
| Graph/community expansion and graphHops | Flags accepted in live pilot, but benchmark pipelines report graphRag/entityIndex/community summaries false: efficacy unmeasured. Need graph-enabled ingestion. |
| `minScore` | Fixed to 0 in live pilot to isolate other flags. Calibration sweep not measured; response records dropped counts. |
| Document/run/workspace and metadata filters | Scope fixed; filename, MIME, tags, pages, language, heading, date filters are exposed but relevance sweeps not measured. Filters alter the eligible corpus. |
| Glossary / abbreviation expansion | Separate agent owns implementation and tests. External glossary supported in POST input; this GET pilot does not claim glossary evaluation. |
| `variant` / experiments | Exposed experiment selector, not an independent retrieval algorithm; fixed here. |
| Embedding model/dimensions, chunking, OCR, parent construction | Ingestion choices; need fresh comparable indexes, handled by the separate dataset campaign. |
| Trained reranker, image retrieval | Not represented by the current local BM25 switch; require actual model integration/evaluation. |

## Live run ownership and budget

`live.mjs` is a campaign-specific operator script, not an automatically run test. It uses the existing authorized benchmark cookie jars and read-only GET search requests, which create metered search usage events. It refuses to overwrite prior results. Maximum 100 requests, concurrency 2, no retries, 90-second request timeouts, 15-minute admission deadline, $8 authorization cap, $7.50 admission reservations and usage stop threshold. Output is `/tmp/docslurp-retrieval-options-20261017/live.json`.

The production model was verified from the running image: GLM 5.3 Flash, with today's rate receipt of $0.15/M input and $0.50/M output tokens. No deployment occurred. Six queries cover three course questions, one academic question, and two statutes questions. Sixteen arms change one control at a time at k=10. Session diagnostics and `usage_attribution` reads distinguish actual provider calls and missing capabilities. A caller-side timeout does not cancel server execution; reservations include in-flight work, and final session usage must be reconciled.

Results and exact attributed costs are summarized separately in `/tmp/docslurp-retrieval-options-20261017/summary.md`. Candidate profiles remain development hypotheses until the separate large held-out evaluation confirms them.

Self-query caution: the pilot regressed `st109-01` because a quoted passage was treated as `filenameContains`. Persisted diagnostics confirm the inferred filename filter excluded the relevant document. This is a concrete failure mode for quoted-content searches, not merely a lower aggregate score.

## Completed broader production comparison

The subsequent 28-query comparison completed 112 searches, all HTTP 200, using the same explicit k=10, parent retrieval on, rerank on, minScore=0, and other controls off. Baseline and rewrite each passed 24/28; stepback passed 26/28; stepback+rewrite passed 27/28. Stepback recovered course-early and course-middle; the combination also recovered course-late. Neither regressed a baseline-passing question. The remaining failure was statute85-middle.

Higher recall did not mean better rank: MRR was .763 baseline, .765 rewrite, .684 stepback, .636 combination. Median latency was 3.32s, 3.90s, 4.89s, 5.09s respectively (p95 4.95s, 5.17s, 6.75s, 7.82s). All three course questions were recovered by the combination in this invocation; this remains a development finding requiring held-out confirmation and repeated stochastic trials.

Exact session-attributed broad cost: customer $0.0041063496, provider $0.003421958. Combined with the 96-search pilot: **208 searches, customer $0.0173698392, provider $0.014474866**. These are recorded usage prices, excluding shared infrastructure and independently reconciled invoices. No requests remain in flight; no resources were provisioned and no services were deployed.

Candidate profiles to test on the separate held-out dataset:

- Economical default candidate: parent-aware lexical reranking, 5–10 evidence results, genuine vector MMR off until wired and measured, no automatic self-query/compression. Local candidate scoring still needs live validation after integration; its offline scores cannot be combined with the production helper results as if measured jointly.
- Higher-recall option: k=10, parent retrieval and rerank on, stepback+rewrite. This recovered 3 additional development questions but increased median latency by 1.77s and reduced MRR. Keep it optional until held-out evaluation establishes the tradeoff.
- Avoid enabling all switches: compression, positional MMR and graph switches on graphless indexes showed no recall gain; self-query introduced a concrete regression. Query decomposition needs compound-question tests; document narrowing needs multi-document tests.

Final detailed results: `/tmp/docslurp-retrieval-options-20261017/summary.md` and `/tmp/docslurp-retrieval-options-20261017/broad/summary.md`. The runner is campaign-specific and refuses to overwrite receipts; the offline CLI accepts external input/labels/judge and stores source hashes.
