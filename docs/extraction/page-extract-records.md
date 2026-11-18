# Page extract records

Every page carries a record of how its text was produced: which pass wrote it, by what method and route, the page class
it was billed in, tags describing the page, and a few quality signals. Records never hold page text or a
document-supplied value. The model that served a pass is recorded in two operator-facing columns (`model_uri`,
`model_class`) that the API does not return; every other column is a label.

## Table

`document_page_extracts` (migration 0188) has one row per (document, page, run, pass), scoped to its organization and
project by composite foreign keys to the document and the run.

| Column | Meaning |
| --- | --- |
| `pass` | `extract` (the primary extractor), `scan-ocr` (OCR of pages without words, inside extraction), `critique` (self-critique correction), `vision` (the vision stage), `human` (reserved for human corrections); and one contributing pass that is never final: `video-frames` (migration 0193, the vision model's read of a video's sampled frames, merged into the transcript) |
| `method` | `text-layer`, `ocr`, `ocr-second-read` (page reader or escalation read), `vision`, `transcription` (audio and video), `correction`, `kept-as-image` (Fast pages without a text layer, textless images), `none` |
| `engine` | Route token: an extractor id or a route word (`page-ocr`, `ocr-escalation`, `gpu-page-reader`, `hosted-ocr`, `vision-model`, `chart-export`, `self-critique`). Never a model id: that is `model_uri`. |
| `member_id`, `region` | The capability-pool member that served the page and its region (not yet populated; not served by the API until they hold tier-safe values) |
| `model_uri`, `model_class` | Migration 0191, operator-facing, never returned by the API: the model that served the pass as an `llm://provider/model` URI (the same provider and model as the read's usage event; an OCR read is named by its reader), and the run's levels at the time (`quality=…;visionProfile=…`). Null for a text layer and for rows written before the columns existed. |
| `billed_class` | `fast` (Text), `ocr` (Scan), `rich` (Vision): the class the pass's read is billed in |
| `tags` | `scanned`, `table`, `math`, `garbled-text-layer`, `drawn`, `image-only`, `low-confidence`, `escalation-capped`, `escalation-unfunded`, `pii-withheld`, `blank`, `yield-deficit`, `ladder-capped`, `failed`, `truncated`, `rejected` |
| `confidence`, `plausibility` | OCR mean confidence, extraction plausibility, in [0, 1] |
| `text_bytes`, `finish_reason`, `duration_ms` | Size of the final text, the reader's finish (`stop`, `length`, `refused`, `error`, `empty`, `other`), timing |
| `adopted` | The pass's text was taken for the page in its run (a retry that rejects the pass withdraws it) |
| `is_final`, `superseded_by_pass` | Exactly one final row per page once its document completes: the highest adopted pass (extract < scan-ocr < critique < vision < human, `PAGE_EXTRACT_FINAL_PASSES`) of the document's current run. A contributing pass (`video-frames`) has no rank and is never final. The page's other adopted rows, contributing ones included, name the final pass. |

`pii-withheld` is added on read for pages whose state is `blocked-pii`, and their `textBytes` is withheld.

## Writes

Stages queue records on the workflow state; the next progress checkpoint writes them with the rest of the checkpoint in
one pipelined transaction: one multi-row upsert per 2,000 records and one tag merge per 2,000 merges, never a statement
per page. Queueing is O(1) per record (a 20,000-page document queues and builds its statements in about 0.2 s). The
upsert is keyed by the primary key, so retried stages and checkpoints rewrite the same rows. A run without an
organization records nothing.

| Stage | Records |
| --- | --- |
| extract-markdown | `extract` for every page; `scan-ocr` for pages OCR read (confidence, escalation cap or unfunded tags); `critique` for corrected pages; `transcription` for audio and video, plus a `video-frames` row (method `vision`, engine `media-video-frames`, the frame batches' summed text size and request time, named by the vision model) when a video's frames were read |
| classify-route | Tags merged into the page's rows of the run |
| vision-extract | `vision` for pages read (adopted when reconciliation accepted the read), and unadopted rows for selected pages with no output |
| query-time materialization | the pages it publishes (text layer or model read), kept-as-image pages, and unadopted rows for blocked or failed pages. A published read another claim made and kept is named by its reading run's usage row (`metadata.modelUri`; null for a read recorded before usage rows carried it) |

## Finalization

Stages only record what they adopted; `is_final` is set by one statement (worker/src/pipeline/page-extracts.ts
`finalizePageExtracts`) in the transaction that publishes the content:

- when a document completes (its index stage, or run completion for pipelines without one), for documents whose current
  run (`documents.run_id`) is the completing run: a failed or stale reprocess never finalizes, so the previous run's finals
  stay;
- when a query-time materialization publishes pages (deferred/materialize-pages.ts), for those pages.

A page a newer run (by creation time) already finalized is left alone, so a late or retried older run never takes it back.
A completion clears older finals on pages the run has no adopted row for (past a shorter reprocess's page count); a
query-time read whose page failed keeps the older final, and clears it only on a page it found PII on. A partial unique
index allows at most one final row per page; finalization demotes before it promotes. A release older than migration 0193
ranks no contributing pass and would write `is_final = NULL` on one; a trigger (it fires only on NULL) keeps it false, so a
rollback still finalizes video documents.

Lock order: every writer of extract rows holds the document's row lock first (FOR NO KEY UPDATE, the lock a completion's
documents UPDATE takes): completions update the document before finalizing, a query-time read locks the document before
its page rows and extract rows, and checkpoint upserts and tag merges lock their documents (in id order) in the same
statement before touching extract rows. A finalization that finds no run in the organization logs
`[page-extracts] finalize-skipped`. The ingest report
flags a page with records but no final on a completed document (`missing`) or with more than one (`duplicate`).

## Retention

Rows hold labels only and stay with their document; the document's deletion cascades to them. Nothing prunes earlier
runs' rows yet: a later retention job may drop non-final rows of runs whose artifacts were purged.

## Reads

- `GET /v1/documents/:id/page-extracts?after=&limit=&final=true&run=`: keyset pages by (page, run, pass), the primary key order; `run` is
  `current` (default: the document's current run plus every page's final row), `all`, or one run id. The caller must
  reach the document's project; API keys need `artifacts` and the project. Another organization's document is a 404.
  SDK: `getDocumentPageExtracts`.
- Ingest report page views carry `extractMethod`, `finalPass` and `extractTags`.
- Metrics `docslurp.pages.extracts` and `docslurp.pages.extract_tags` (docs/pipeline-metrics.md), without organization,
  project or document labels.
