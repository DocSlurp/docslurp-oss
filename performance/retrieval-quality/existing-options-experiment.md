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


Continuation notes: a first continuation was interrupted before any response was saved after a deployment warning; its possible in-flight call needs ledger reconciliation. The coordinator then confirmed rollout had not started when the 502 occurred, so no deployment cause is established. A second immutable continuation runs remaining BM25 and MMR cases. Deployment-window latency is descriptive only. Request-start records now preserve interrupted request identity; explicit per-arm case IDs avoid repeating completed cases.


## Completed top-10 screen

| Arm | Explicit support @10 | Primary-page match | Source-trace page match | Two-premise support | HTTP failures |
| --- | --- | --- | --- | --- | --- |
| Baseline | 12/13 | 5/13 | 12/13 | No | 0 |
| Local BM25 | 12/13 | 4/13 | 12/13 | Yes | 1 |
| Production positional MMR | 9/13 | 4/13 | 9/13 | No | 1 |

All citation metrics require matching quote text and document identity in the
same result. Primary-page null is common for valid multi-page chunks; its lower
count is not itself a citation error. The source-trace page check agrees with the
expanded union in this screen. Rescores are new evidence at
`options-citation-rescore-v2.json`; original scores are unchanged.

BM25 recovers `asu-08` and both inferred premises but loses `st083-04`. It fails
the no-regression gate. MMR additionally loses `asu-05`, `asu-06`, and `asu-07` and
still misses `asu-08`. Keep production positional MMR off. These data do not
justify changing global rerank defaults: test depth and preservation of strong
support first. This is an observed tradeoff, not proof one approach is generally
better across corpora.

There are 47 successful responses, two retained HTTP 502 responses (one BM25 case
was retried successfully; final MMR future-policy control was not), and one
interrupted possible call with unknown usage. Successful API-estimated costs sum
to 0.0028464 cents (USD 0.000028464), excluding unknown failed/interrupted calls.
Billed-ledger reconciliation remains pending. Neither negative has been passed
as an answer-abstention test. All discovered misses remain versioned development
cases with raw failure observations.

A separate approved screen compares baseline and BM25 at result limit 20. Its
recall at 10, 12 (chat cap), and 20 must be reported separately; larger result
counts cannot be represented as a top-10 improvement.
