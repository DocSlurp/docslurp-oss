# Page extract records

Every page carries a record of how its text was produced: which pass wrote it, by what method and route, the page class
it was billed in, tags describing the page, and a few quality signals. Records are labels only: they never hold page
text, a document-supplied value or a model id.

## Table

`document_page_extracts` (migration 0187) has one row per (document, page, run, pass), scoped to its organization and
project by composite foreign keys to the document and the run.

| Column | Meaning |
| --- | --- |
| `pass` | `extract` (the primary extractor), `scan-ocr` (OCR of pages without words, inside extraction), `critique` (self-critique correction), `vision` (the vision stage), `human` (reserved for human corrections) |
| `method` | `text-layer`, `ocr`, `ocr-second-read` (page reader or escalation read), `vision`, `correction`, `kept-as-image`, `none` |
| `engine` | Route token: an extractor id or a route word (`page-ocr`, `ocr-escalation`, `gpu-page-reader`, `hosted-ocr`, `vision-model`, `chart-export`, `self-critique`). Never a model id. |
| `member_id`, `region` | The capability-pool member that served the page and its region (not yet populated) |
| `billed_class` | `fast` (Text), `ocr` (Scan), `rich` (Vision): the class the pass's read is billed in |
| `tags` | `scanned`, `table`, `math`, `garbled-text-layer`, `drawn`, `image-only`, `low-confidence`, `escalation-capped`, `escalation-unfunded`, `pii-withheld`, `blank`, `yield-deficit`, `ladder-capped`, `failed`, `truncated`, `rejected` |
| `confidence`, `plausibility` | OCR mean confidence, extraction plausibility, in [0, 1] |
| `text_bytes`, `finish_reason`, `duration_ms` | Size of the final text, the reader's finish (`stop`, `length`, `refused`, `error`, `empty`, `other`), timing |
| `is_final`, `superseded_by_pass` | Exactly one final pass per page: the text the page was indexed with. A later final pass, of this run or a later one, clears `is_final` on the earlier row and names itself. |

`pii-withheld` is added on read for pages whose state is `blocked-pii`.

## Writes

Stages queue records on the workflow state; the next progress checkpoint writes them with the rest of the checkpoint in
one pipelined transaction: one multi-row upsert per 2,000 records and one tag merge, never a statement per page. The
upsert is keyed by the primary key, so retried stages and checkpoints rewrite the same rows. A run without an
organization records nothing.

| Stage | Records |
| --- | --- |
| extract-markdown | `extract` for every page; `scan-ocr` for pages OCR read (confidence, escalation cap or unfunded tags); `critique` for corrected pages |
| classify-route | Tags merged into the page's rows of the run |
| vision-extract | `vision` for pages read (final when reconciliation accepted the read), and non-final rows for selected pages with no output |

## Reads

- `GET /v1/documents/:id/page-extracts?afterPage=&limit=&final=true`: the caller must reach the document's project; API
  keys need `artifacts` and the project. Another organization's document is a 404.
- Ingest report page views carry `extractMethod`, `finalPass` and `extractTags`.
- Metrics `docslurp.pages.extracts` and `docslurp.pages.extract_tags` (docs/pipeline-metrics.md), without organization,
  project or document labels.
