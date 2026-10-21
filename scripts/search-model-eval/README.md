# Search-agent model comparison

Compares candidate chat models driving the DocSlurp search agent (`POST /v1/chat`)
on a frozen question set, under explicit step/tool-call limits. Three stages,
each a separate process so only the scorer opens gold:

1. `dataset.mjs` builds and freezes `docslurp-search-model-eval@v1`.
2. `run.mjs` executes models x cases x limit arms x repeats.
3. `score.mjs` scores each call, judges answers and writes the report.

Plain Node ESM, no dependencies. Tests: `node --test scripts/search-model-eval/*.test.mjs`
(offline: mock HTTP server, mock OpenRouter, temp files).

Datasets, credentials and run artifacts stay **outside** this repository. The
evaluation integrity judge rejects a dataset inside the repo.

## Price and model policy

Every model (candidate, generator, judge) goes through `assertModelAllowed`
with `scripts/lib/model-prices.json` (or `pricesPath` / `priceOverrides` in the
run config): Pro/Ultra ids are refused, an unknown or unpriced model is refused,
and output price >= $50 per million tokens is refused. The judge may not be one
of the candidate models. Re-check provider prices before quoting a cost.

## Dataset

Case shape:

```jsonc
{
  "id": "gen1-…", "workspaceTier": "mid-5k" | "large-58k", "workspaceId": "…",
  "question": "…", "kind": "single_hop" | "multi_hop" | "unanswerable" | "labeled",
  "gold": {
    "answerable": true, "facts": ["short fact", "…"], "factsStatus": "generator-authored" | "silver-generator-extracted" | "source-labels-fallback" | …,
    "supportMode": "any_of" | "all_of",
    "supportPages": [{ "sourceDoc": "…", "documentId": "…?", "page": 14, "group": 0 }]
  },
  "provenance": { "method": "llm-generated" | "import-labeled", "generatorModel": "…", "sourcePages": [{ "sourceDoc": "…", "page": 14, "pageSha256": "…" }], … },
  "splitGroup": "…", "split": "dev" | "test"
}
```

Support semantics: pages in one `group` are alternatives (OR); with `all_of`
every group must be hit (AND), with partial credit per group. Single-hop and
labeled single-group cases are `any_of`.

`dataset.tiers` holds per-tier settings (overridable at scoring with `--tiers`):

- `workspaceId`
- `citationMatch`: `documentAndPage` (the cited document must be the gold page's
  production document, through `documentId`, `documentMap[sourceDoc]` or the
  `documents` catalog) or `pageOnly` (a workspace of prefix slices of one source:
  any document at the same page number, bounded by that document's `pageCount`
  when known).
- `scope`: `{sourceDocs, maxPage}` of the verified corpus used for absence checks.
- `documentMap` (`sourceDoc -> documentId`) and `documents` (`documentId -> {sourceDoc, sha256, pageCount}`).

### Commands

```bash
E=~/.local/share/docslurp/eval-corpora
OUT=/home/dan/code/17th-street-labs/docslurp-app/performance/search-models/2026-10-20
D=scripts/search-model-eval/dataset.mjs

# Tier config from the ingest state (re-run as ingestion completes; scoring can take --tiers).
node $D tiers --out $OUT/dataset-input/tiers.json --state $OUT/ingest/state.json \
  --mid-workspace 8301880c-dc73-40dd-88f0-e4fc04d33b4f --large-workspace b25b1b82-702b-4d38-9ece-4d41cf8f7f7e \
  --mid-source-doc asu-2025-26-academic-catalog-archive --mid-max-page 4000 [--mid-documents mid-pagecounts.json]

# Generated questions (add --dry-run first for the worst-case generator cost).
node $D generate --pages $E/search-model-eval-2026-10-20/pages-mid-5k.jsonl --tier mid-5k \
  --tiers $OUT/dataset-input/tiers.json --single 50 --multi 15 --cap-usd 1 --out $OUT/dataset-input/mid-generated.jsonl
node $D unanswerable --pages $E/search-model-eval-2026-10-20/pages-mid-5k.jsonl --tier mid-5k \
  --tiers $OUT/dataset-input/tiers.json --corpus $E/large-corpus-recall-58k/pages-text.jsonl \
  --count 20 --cap-usd 1 --out $OUT/dataset-input/mid-unanswerable.jsonl
# (same for large-58k: --single 30 --multi 15; --count 25)

# Imported recall labels with silver facts from support pages.
node $D import-labeled --queries $E/large-corpus-recall-58k/queries-pages.jsonl \
  --source-dataset /tmp/docslurp-large-retrieval-dataset/v4/dataset.json \
  --corpus $E/large-corpus-recall-58k/pages-text.jsonl --tiers $OUT/dataset-input/tiers.json \
  --cap-usd 1 --out $OUT/dataset-input/large-labeled.jsonl

# Freeze: 30% dev / 70% test by seeded hash.
node $D freeze --cases a.jsonl,b.jsonl,… --out-dir $OUT/dataset --seed smeval-2026-10-20 \
  --test-fraction 0.7 --tiers $OUT/dataset-input/tiers.json [--previous $OUT/dataset-v0/dataset.json]
node $D validate $OUT/dataset/dataset.json
node scripts/evaluation-integrity-judge.mjs --dataset $OUT/dataset --output $OUT/dataset/integrity-report.json
```

Generation details:

- **generate** walks the seeded page order until the target count is accepted
  or the call cap (`--max-single-calls`, `--max-multi-calls`, default 2x target)
  is reached, and reports any shortfall. The writer is told to use only the given
  page(s) and to make the question unique in a large corpus. Every gold fact must
  have >= 60% token overlap with its page or the case is rejected. Multi-hop pairs
  share vocabulary (a bridge), live in the same workspace, need a fact from each
  page and exclude pages already used by accepted single-hop cases.
- **unanswerable** perturbs an entity, identifier or value, or asks about an
  adjacent topic. Key terms must be distinctive (>= 4 chars, not a bare number).
  The primary check is exhaustive and local: one streaming pass over the verified
  corpus text (`{sourceDoc, page, pageSha256, verified, text}`), restricted to
  the tier scope, with NFKC/lowercase/punctuation-insensitive whole-token phrase
  matching. Any hit rejects the candidate. With `--search-base URL --credentials FILE`
  a `GET /v1/search` check also runs: a strong match is a key-term hit in the top
  results or relevance >= `--strong-relevance` (0.9) without `noMatch`. Hit
  counts, hit pages, scanned page counts and the corpus file size/mtime are kept
  in `provenance.verification`.
- **import-labeled** reads `queries-pages.jsonl` (support ids
  `<sourceDoc>:page:<n>`; OR within a group, AND across groups) and the source
  dataset for question text (its sha256 must match the queries' provenance).
  All rows become `large-58k` / `labeled`, label status recorded as provisional.
  Facts are **silver**: the generator extracts the short answer from the support
  page text (grounding >= 60%); if it finds none the source labels are used
  (`source-labels-fallback`), otherwise the case is skipped. `--no-silver` uses
  the source labels only and makes no calls.
- **freeze** assigns `split = sha256(seed \0 splitGroup)/2^48 < testFraction ? test : dev`.
  Cases sharing support pages (or a recall `query_group`) share a split group.
  With `--previous`, earlier test cases are carried over unchanged and any
  candidate that would change one fails. It writes `dataset.json`,
  `integrity-manifest.json` (`docslurp-authored-eval@v1`, one source and one
  labels artifact per case under `cases/`) and `freeze-report.json`. Files are
  never overwritten.

Every generator and judge call logs
`[ai-usage] <metric> model=<id> input_tokens=<n> output_tokens=<n>` and appends
`{metric, model, resolvedModel, generationId, inputTokens, outputTokens, costUsd, costSource}`
from the OpenRouter `usage` (with `usage.include`) to `<out>.spend.jsonl`; a budget
guard (`--cap-usd`, log `<out>.guard.jsonl`) admits each call first.

## Runner

```bash
node scripts/search-model-eval/run.mjs --config config.json --dry-run          # matrix size + worst-case cost, no calls
node scripts/search-model-eval/run.mjs --config config.json --out $OUT/runs/<run-id> --smoke 2
node scripts/search-model-eval/run.mjs --config config.json --out $OUT/runs/<run-id>
```

See `config.example.json`. Keys: `credentials: {file, fieldByTier}` (read at
runtime, never written), or `apiKeyEnvByTier`, or a single `apiKeyEnv`.
`--smoke N` runs the first N selected cases per model with the first arm and one
repeat; its cells have the same keys as the full run, so the full run resumes
after it.

Request: `{q, workspaceId, model, agent: {maxSteps, maxToolCalls, searchConcurrency}}`,
no `sessionId` (fresh session per case), headers `Authorization`, a new W3C
`traceparent` per attempt (the server's `W3CTraceContextPropagator` parents its
HTTP span on it) and `X-Request-ID: smeval-<runId>-<cellhash>-a<attempt>` (the
server adopts and echoes it, so SigNoz logs and traces join on request id and
trace id). `baggage` is sent only with `sendBaggage: true`: the server registers
no baggage propagator today, so it would be dropped.

- **Concurrency**: global (default 10), per model (3) and per workspace (6) caps.
- **Budget guard**: hard `budget.capUsd`. Before each attempt it reserves
  `(maxSteps+1) x (inputTokensPerTurn x input price + outputTokensPerTurn x output price) + overheadUsdPerCall`.
  After the attempt it reconciles to the actual cost: `usage.costCents` from the
  response, else response tokens x list price, else 0 for a 4xx (refused before
  any model call), else the estimate stays charged. A reservation is refused when
  actual + reserved + estimate would exceed the cap; the runner then stops
  scheduling. `guard.jsonl` records every reserve/reconcile/refuse; a resumed run
  rebuilds spend from it and charges never-reconciled reservations at their estimate.
- **Resume**: one cell file per `(model, case, arm, repeat)` under `calls/`,
  written with `wx`. Existing cells are skipped; `run-config.json` pins the
  matrix identity and a changed matrix is refused. Budget-refused cells have no
  file and run on resume.
- **Retries**: exactly one, after 1-4 s jitter (or `Retry-After` up to 30 s), on
  429, 5xx and network errors; timeouts (150 s) are not retried unless
  `retry.onTimeout`. Every attempt is kept in the cell and `attempts.jsonl`; a
  successful retry keeps the original error in `errors`.
- **Per attempt**: wall latency, time to response headers (TTFB; equal to latency
  for this non-streaming JSON endpoint), status, recorded response headers, the
  full response JSON, request/trace ids, actual cost, and the model check
  (`requestedModel === model`, `resolvedModel` recorded and `resolvedDiffers`).

Run artifacts (`$OUT/runs/<run-id>/`): `run-config.json`, `run-log.jsonl`,
`guard.jsonl`, `attempts.jsonl`, `calls/<model>.<case>.<arm>.r<n>.json`,
`summary.<time>.<rand>.json`.

## Scorer

```bash
node scripts/search-model-eval/score.mjs --dataset $OUT/dataset/dataset.json --runs $OUT/runs/<run-id> \
  --out $OUT/runs/<run-id>/score [--tiers tiers.json] [--judge-model google/gemini-3.8-flash] \
  [--judge-cap-usd 2] [--judge-cache path] [--judge-audit 30] [--baseline z-ai/glm-5.3-flash] [--seed S] [--no-judge] \
  [--corpus ~/.local/share/docslurp/eval-corpora/large-corpus-recall-58k/pages-text.jsonl] [--case-labels unanswerable-audit.json]
```

Scoring re-reads each attempt's raw response, so normalisation fixes apply to
earlier runs. Every page field uses `pageNumbers` when `pageNumber` is null.
`scores.jsonl` carries `goldPages`, `citedPages` and `evidencePages` per call.

Outputs (never overwritten): `scores.jsonl`, `report.json`, `report.md`,
`histograms.json`, `judge-cache.jsonl`, `judge-spend.jsonl`, `judge-guard.jsonl`,
`judge-audit.md`.

Per-call metrics:

| metric | definition |
|---|---|
| evidence recall | support recall over the retrieved evidence: tool-call evidence pages (`debug.toolCalls[].evidencePages/evidence/results/citations`) united with the response `citations` list, which the agent path fills with all gathered evidence. Tool evidence with no page (`pageNumber: null` and no `pageNumbers`) cannot place a page and is counted in `pagelessToolEvidence`; the union keeps evidence recall >= cited recall |
| cited recall | strict: support recall over citations referenced by `[n]` markers in the answer; any-of = 0/1, all-of = share of groups hit; `citedAll` when every group is hit |
| grounded citation | with `--corpus`: do the cited pages contain the gold facts? Each citation's pages (multi-page chunks joined) are one unit; a fact is grounded at token overlap >= 0.6. any-of: one unit grounds every fact; all-of: every fact is grounded by some unit. Production pages map to source pages through `tiers.documentMap` reversed (`documentAndPage`) or the tier's single source document at the same page (`pageOnly`). Null when no cited page has text. Credits correct answers that cite another page with the same facts; strict cited recall is kept alongside |
| grounded evidence | the same check over all evidence pages |
| citation validity | share of markers that resolve to a citation, whose document/page exist in the tier catalog (null check when no catalog) and that were in tool evidence (null check when tool evidence is not exposed or that document has page-less evidence) |
| abstention | judge `abstained`, else a lexical heuristic or `stopReason: no_evidence`; unanswerable: correct abstain vs hallucinated answer; answerable: false give-up |
| correctness | judge 0/0.5/1 on answerable cases (an abstention scores 0); unanswerable = 1 when abstained; failed calls = 0; `correct` = score 1 |
| persistence | search calls before abstaining; reformulation = >= 2 distinct normalized queries; mean token Jaccard of successive queries |
| limits/protocol | stop reason distribution, limit exhaustion (`step_limit`/`tool_call_limit`), tool error rate, protocol failures (tool errors mentioning invalid/schema/argument/parse) |
| shape | steps, search calls (`debug.searchCallCount`, else counted from tool calls), fan-out = queries per search call |
| speed/cost | latency p50/p90/p95, TTFB, tokens in/out, cost per call (actual, else guard charge), cost per correct answer, correct answers per $1, time per correct answer; pages per $ is not applicable |

The judge sees the question, gold facts (plus alternatives/disqualifiers) and the
answer only: never the model or arm. Judgments are cached by
`sha256(judge model, prompt version, question, gold, answer)`. `--judge-audit N`
writes a seeded sample for human or agent review of the scorer.

### Audited unanswerable cases (`--case-labels audit.json`)

The audit file is `[{id, tier, classification: clean_absent | near_miss | actually_answerable, evidence: [{sourceDoc, page}], note}]`.
Unanswerable cases are then reported as the kind slices `unanswerable_clean`,
`unanswerable_near_miss` and `unanswerable_mislabeled`.

- Headline abstention metrics use clean absences only: correct abstain,
  hallucination, searches before abstaining and limit exhaustion on unanswerable
  cases. Unaudited negatives count as clean. Every unanswerable-gold case, as
  originally labelled, is kept in the `raw` columns and the "Give-up
  intelligence (raw)" table.
- Near-miss cases are graded with a separate judge rubric
  (`search-model-eval-judge-near-miss@v2`, cached separately; the audit note is
  part of the prompt and the cache key; the model name never is). 1 = says the
  asked entity is not found and stops or answers about the related entity while
  flagging the difference; 0.5 = answers about the related entity without
  flagging; 0 = asserts facts about the asked entity. `nearMissFlaggedRate` is
  the share scoring 1.
- Mislabeled (`actually_answerable`) cases are not judged, are unscored and are
  excluded from the clean abstention metrics. They are listed in the report.

Aggregation is by model, model x arm and model x tier x kind x arm, with
seeded percentile-bootstrap 95% CIs (resampling calls), a paired comparison with
the baseline over (case, arm, repeat) (wins/losses/ties and a CI of the mean
score difference), text and JSON histograms (latency, steps, searches, cost), and
the give-up view: answerable/unanswerable x answered/abstained, give-up precision
and recall, searches before abstaining, and limit exhaustion on unanswerable cases.

## Response fields read (all optional; missing = null)

`answer`, `citations[].citation.{documentId, pageNumber, pageNumbers}`,
`citations[].text`, `usage.{inputTokens, outputTokens, totalTokens, costCents, costSource}`,
`runtime.totalMs`, `debug.{model, requestedModel, resolvedModel, steps (number or
per-step array with usage), stepUsage, toolCallCount, searchCallCount, searchQueryCount,
zeroHitSearchCount, stopReason, limits, toolCalls[].{id, name, status, runtimeMs,
args|input|arguments (q|query|queries[]), resultCount, evidence|results|citations, error, errorCode}}`.
