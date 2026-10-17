# Large-document and corpus retrieval evaluation

This suite separates **long individual documents** from **large searchable corpora**. Source registry `large-retrieval-sources.json` pins 27 distinct publisher PDFs totaling 58,378 PDF pages. The largest individual document has 7,188 pages. This is not a claim of a 50,000-page individual document, nor a claim that retrieval has already been measured at that scale.

The registry includes academic and course catalogs, repeated catalog editions, dense curriculum listings, and scanned statutes with existing OCR layers. Adjacent editions deliberately introduce similar names and course codes with potentially different answers. They count as distinct source PDFs, but not as independent subject diversity. No artificial replicas count toward the page thresholds.

## Keep evidence external

Follow `docs/evaluation-integrity.md`. PDFs, extracted text, question labels, run outputs and index data live outside the repository, under `DOCSLURP_EVAL_DATA_DIR`. The checked-in registry contains provenance, page counts and checksums only. Public catalog availability does not grant redistribution rights. The builder materializes external sources via hardlinks when possible (copies across filesystems), so removal of a temporary original does not remove the dataset. It checks the PDF hash, `pdfinfo` page count and extracted page count before inclusion.

Use Python 3.10+, Node.js, and Poppler (`pdfinfo`, `pdftotext`). No model API, credentials or paid service is needed to build or score.

```sh
python scripts/evals/large-retrieval/fetch.py \
  --registry docs/evals/large-retrieval-sources.json \
  --cache "$DOCSLURP_EVAL_DATA_DIR/large-retrieval/source-cache" \
  --output "$DOCSLURP_EVAL_DATA_DIR/large-retrieval/source-manifest.json"

python scripts/evals/large-retrieval/dataset.py build \
  --manifest "$DOCSLURP_EVAL_DATA_DIR/large-retrieval/source-manifest.json" \
  --queries /absolute/path/to/development-queries.json \
  --queries /absolute/path/to/provisional-queries.json \
  --output "$DOCSLURP_EVAL_DATA_DIR/large-retrieval/v1"

python scripts/evals/large-retrieval/dataset.py scenario \
  --dataset "$DOCSLURP_EVAL_DATA_DIR/large-retrieval/v1/dataset.json" \
  --pages 50000 --split development \
  --output "$DOCSLURP_EVAL_DATA_DIR/large-retrieval/v1/50k-development.json"
```

Build 10,000-, 25,000- and 50,000-page scenarios with the same command. These are minimum thresholds over whole PDFs; `actualPages` and `documentCount` record the exact totals. Insufficient real source pages cause failure. Actual chunks are supplied by each indexed run because page-image, text and multi-vector indexes have different row counts. A schema-valid manifest is not an indexed corpus or a performance result.

## Labels and challenge coverage

The initial development set contains 31 previously run/inspected source-derived questions, including all three course-catalog failures. Those are regressions, **never held-out evidence**. Existing labels span beginning/middle/end, exact course/plan identifiers, dense curriculum tables, noisy OCR and a contact-email lookup. Full-source support search recomputes alternative matching pages, rather than trusting one manually selected page.

The builder adds one mechanical no-answer identifier for the first source document, checking that it is absent throughout extracted corpus text. This tests abstention plumbing; it does not establish realistic semantic no-answer quality.

The concrete dataset also includes 28 curated, provisional student-goal questions across ASU, UTA and Illinois. These cover nursing pathways and eligibility, start windows, transfer credits, clinical versus device careers, materials and energy specializations, undergraduate versus graduate entry, water infrastructure, agricultural technology, chemistry, spacecraft prerequisites, and unavailable live/future schedules. Each has inspected source-page evidence from at least two colleges plus a rubric of required facts, acceptable alternatives, disqualifying claims, required citation documents and historical temporal bounds. They do not prescribe one subjective “best” college. The final sample keeps six abbreviation candidates and one mechanical negative, rather than letting synthetic controls dominate.

`candidates.py` generates reproducible provisional abbreviation-expansion questions from newly acquired sources, taking the first qualifying initial-letter-matched definition in each document third. It uses no model or retrieval result. Labels are frozen before evaluation and separated with `validation-provisional`; candidates can be ambiguous and require independent human review. They are **not gold**, and should not select production parameters without a separate, untouched acceptance set. Do not combine provisional and development scores into a held-out quality claim.

For cross-document cases, replace the single-document `support_pages`/`support_match_all` with `support_evidence: [{document, support_pages, support_match_all}, ...]`. Attach `rubric: {intent, requiredFacts, acceptableAlternatives, disqualifiers, requiredCitationDocuments, temporalBounds, judging}`. Rubric answers are flagged for independent human review; they are excluded from automatic answer-surface accuracy. Retrieval and required-document citation coverage remain measurable.

Inputs use `{queries: [...]}` with fields `id`, `document`, `question`, `expected_answer`, `support_pages` (one-based PDF indexes), `support_match_all` (NFKC/whitespace-normalized evidence strings), `position`, optional `challenges`, `split` and `label_status`. Imported positive labels lacking answers/evidence or not matching the source pages fail. Import refuses held-out/gold split claims.

For a defensible acceptance release, independently review candidates, add natural paraphrases, abbreviation ambiguities, multi-page answers and realistic unanswerable questions; freeze a new content hash before further tuning. Preserve a distinct-document/edition holdout. Current gold coverage is zero. Image-specific visual questions also remain to be authored: text-derived questions alone cannot validate chart, layout or image-only advantages.

## Run comparable pipelines

Use the same source scenario and query IDs for lexical-only, vector-only, tuned hybrid, and page-image retrieval. Tune fusion weights, candidate depth, rerank depth and abbreviation policy on development only; record the selected configuration before provisional evaluation. Record the full embedding model/version, dimensions, image resolution/patch count, chunker, lexical tokenizer, fusion parameters, reranker and abbreviation policy. Record the actual indexed documents/pages/chunks and completion checks. Never silently skip failed queries.

```sh
node scripts/evals/large-retrieval/run.mjs \
  --dataset /external/v1/dataset.json --scenario /external/v1/50k-development.json \
  --adapter /absolute/path/to/adapter.mjs --config /absolute/path/to/config.json \
  --output /external/runs/hybrid.json
python scripts/evals/large-retrieval/score.py \
  --dataset /external/v1/dataset.json --scenario /external/v1/50k-development.json \
  --run /external/runs/hybrid.json --output /external/runs/hybrid-score.json
```

The adapter exports `async retrieve({id, question, corpusDocuments}, config)`. It receives no answer labels, expected pages or answerability flags. It returns:

```json
{
  "hits": [{"document": "source-id", "page": 12}],
  "answer": "optional generated answer",
  "citations": [{"document": "source-id", "page": 12}],
  "abstained": false,
  "deliveryUsd": null,
  "customerUsd": null
}
```

Hits must be in rank order. Map service-specific document IDs and chunk spans to source IDs and one-based PDF pages inside the adapter. Returned empty hits are a measured miss; transport errors abort the run. The sequential runner measures end-to-end latency and will not overwrite an existing result. Adapter execution can call paid services; it requires the operator's explicit workload/budget authorization. Importing/building/scoring does not do so.

Configuration requires `pipeline` and `index.chunks`; hybrid configuration additionally requires `lexical`, `vector` and `fusion` entries. `index.pages` and `index.documents` must match the scenario; these declared counts document completed indexing (the adapter/operator must verify them against the actual service). `ingestionCosts` is separate from per-query delivery/customer charges. Unrecorded costs stay `null`; zero must mean measured zero. Include infrastructure allocation, storage period and provider receipt provenance in the run config to support an all-in cost claim.

## Scoring contract

- Page-level hit rate@1/5/10/20: any valid supporting page retrieved.
- Page recall@k: fraction of all matching support pages retrieved. Alternatives and duplicate publisher sections can lower this even when the answer is found; interpret alongside hit rate.
- MRR: reciprocal rank of first valid source-document/page match. Multiple chunks from one page are deduplicated before page rank.
- Answer surface match and cited supporting-page overlap are separate from retrieval. Rubric-based recommendations are not automatically judged correct; required-document citation coverage checks evidence breadth, not reasoning quality. The combined rate is a deterministic regression signal, **not semantic entailment or a human correctness score**.
- Negative abstention requires an explicit abstention, no asserted answer and no citations. Positive false-abstention is reported separately.
- Latency p50/p95 and delivery/customer costs use the same complete query set. Missing, duplicate or unknown query IDs fail; missing labels, invalid pages, version mismatch and negative/nonfinite latency/costs fail.

Content hashes bind dataset, scenario and result. Query cost totals remain unknown if any row has unknown cost; known subtotals are reported separately. These are query costs, not ingestion costs or gross-margin proof.

```sh
python -m unittest discover -s scripts/evals/large-retrieval -p 'test_*.py'
node --check scripts/evals/large-retrieval/run.mjs
```
