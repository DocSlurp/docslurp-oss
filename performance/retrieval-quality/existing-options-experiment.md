# Existing retrieval options: development screen

This experiment compares the same 16 version-2 development questions and unchanged
indexes across three explicitly frozen configurations: baseline, local BM25
reranking, and current production MMR. No corpus uploads or model changes occur.
All provider-backed enhancements are false, `minScore=0`, `limit=10`, and
`parentRetrieval=true`. The two negative cases test the evaluation protocol and
preserve retrieval evidence; search-only outputs cannot establish answer
abstention. Their status must remain unmeasured for answer correctness.

Raw evidence is external at
`/tmp/docslurp-retrieval-quality-evidence/options-v1/`. Each response retains the
request URL (no authentication), timestamp, elapsed time, exact response text,
search session ID and API usage. Per-arm score files retain response hashes.
Dataset versions and source provenance remain under the adjacent `dataset/`.

Run the generic runner with an explicit external configuration and `--go`:

```
node scripts/retrieval-quality/compare-options.mjs DATASET CONFIG OUTPUT --go
```

The config contains `base`, `maxEstimatedCostCents` (at most 10), `targets`
(`workspaceId`, external `cookiePath`) and `arms` (`id`, `overrides`). The allowlist
permits local-option changes only. The approved plan uses 48 serial calls with no
retries. The API's usage estimate is reported separately from billed-ledger
reconciliation; the runner stops when its cumulative estimated bound is reached.

## Interpretation constraints

- The prior 8/9 and 2/4 results used stricter original labels. Corrected act
  attribution and removal of an unnecessary in-chunk heading requirement are
  oracle corrections, not gains from retrieval changes.
- `rerank=true` invokes local BM25 with adjacent-term bonuses. It also changes the
  post-fusion candidate cap from `limit*2` to 200; this is an existing-option
  comparison, not an isolated scoring-formula experiment.
- Production MMR receives no vectors. It uses positional selection, and
  `mmrLambda` has no effect on that fallback. Do not describe it as semantic MMR.
- Either enabled postprocessing path applies lost-in-the-middle ordering.
  Reported support rank and reciprocal rank measure presentation order, not
  original relevance order. Recall at 10 remains the primary measure.
- Parent retrieval expands citation page unions. A cited page union is weaker
  evidence than a validated exact source location. Source text hashes and quotes
  remain the reference; page-union checks alone do not prove citation accuracy.
- `minScore=0` deliberately reproduces the screening baseline and disables
  no-match filtering. Negative cases require an answer/abstention stage before
  any promotion claim.
- Sequential single observations do not establish a latency distribution under
  load or prove embedding-model quality. Latency quantiles describe these calls.

First attempt stopped at HTTP 502 on BM25 `asu-03`, after all 16 baseline calls and two successful BM25 calls. The failed response is retained unchanged. Baseline has 12/13 explicit supporting passages, misses the two-premise deduction, and leaves both negative answers unassessed. A separate bounded continuation will preserve this failure in the operational denominator.
