# Auto ladder

In `auto` quality (`pipeline.quality`, the default) every page is read on the lowest rung that keeps it faithful. The
ladder has three rungs:

| Rung | What reads the page | Pages that need it |
| --- | --- | --- |
| `fast` | The file's own text layer and structure (native extraction): Markdown, embedded images, metadata. No model. | Pages with a trustworthy text layer. |
| `ocr` | The OCR engine (PP-OCRv6 recogniser in its VM, with its escalation), the page image reader, or plain page transcription by the project's vision route. | Scanned and image pages, scans beside native text, text drawn as paths, table rescue, sparse forms. |
| `intelligent` | The hosted vision model reading the page for its meaning. | Pages page triage routes as figures: `chart-or-figure` and `image-heavy`. |

A page's rung comes from page triage (the classification artifact: each page's route and its `ocrDecision` signals) and
from the text-layer trust signals that decide whether a page needs a read at all. Scanned PDF pages are read by the OCR
engine during extraction, before triage; they count as `ocr`.

## Limits

Two project settings cap the ladder. Both apply in `auto` only: Fast reads no page and Good reads every page, whatever
the ladder says.

```json
{
  "pipeline": {
    "quality": "auto",
    "ladder": {
      "maxRung": "ocr",
      "maxEscalationShare": { "aboveFast": 0.25, "aboveOcr": 0.05 }
    }
  }
}
```

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| `ladder.maxRung` | `fast`, `ocr`, `intelligent` | `intelligent` | Highest rung any page may be read on. |
| `ladder.maxEscalationShare.aboveFast` | 0 to 1, or null | unset | Largest share of each document's pages read above `fast` (by OCR or a model). |
| `ladder.maxEscalationShare.aboveOcr` | 0 to 1, or null | unset | Largest share of each document's pages read on the `intelligent` rung. |

Validation rejects a rung outside the three, a share outside 0 to 1 (or not a finite number), an unknown key, and
`aboveOcr` larger than `aboveFast` (every page above `ocr` is also above `fast`). `null` removes a share. A share of 0
is a rung limit: `aboveFast: 0` is `maxRung: "fast"`, `aboveOcr: 0` is `maxRung: "ocr"`; a share of 1 caps nothing.

A share allows `floor(share x pages)` pages of a document, never rounded up: with `aboveFast: 0.5`, a 3-page document
may have 1 page read and a 1-page document none.

### What a capped page gets

A capped page stays on the highest rung it is allowed, and the document never fails because of a limit:

- **Below `intelligent`**: a figure page is transcribed instead. In the OCR engine's VM when the deployment runs OCR there
  (`DOCSLURP_OCR_MODE=vm`), else by the page image reader when one is on, else by plain page transcription on the
  project's vision route. A project whose vision route is not plain transcription (an output schema or a task prompt)
  and has no OCR reader leaves the page on its text layer. Chart & diagram export keeps its free tier: the `models`
  tier, which reads charts with a model, is off below `intelligent`.
- **At `fast`**: the page is not read. A page with a text layer keeps it; a page without one (a scan) is kept as its page
  image, exactly as Fast keeps it (`kept-as-image`). With `maxRung: "fast"` the whole run reads as Fast.

### Which pages escalate under a share

The share is planned per document before vision fans out, so it holds for a 20,000-page document split into page
tasks:

1. Scanned pages read by the OCR engine during extraction count first. Extraction reads at most the document's
   above-fast budget of them, in document order, and runs only text-layer extractors on a document the share does not
   cover entirely (an extractor that OCRs every page could otherwise pass the cap). An image file is read only when the
   share covers all its frames.
2. The rest of the budget goes to the pages triage selected: pages without native text first, then higher triage
   confidence, then document order.
3. Under `aboveOcr`, figure pages keep the `intelligent` rung in the same order while its budget lasts; the others are
   transcribed (still above `fast`).

The first plan a run makes for a document is pinned in the run's artifacts (`<document>:ladder-plan`): page tasks, the
whole-document pass, activity retries and restarts read only pages it escalated. A page task outside it is skipped
(`ladder-capped`). The page router's active plans are not used while a limit is set (the router still records its plan
in shadow), and self-critique, which re-reads pages with a vision model, is off. Query-time materialization (deferred
indexing) has no document-wide plan to count against, so under an above-fast share it reads no page.

## Billing and estimates

Limits never change prices. A page bills Rich only when OCR or a model reads it, and Fast otherwise, as without limits:
the ladder only decides which pages are read.

Estimates follow the limits, so a capped page is not estimated as Rich: `maxRung: "fast"` is quoted as Fast, and an
above-fast share caps an upload quote, the project estimate (`POST /v1/estimate`, setting `aboveFastShare`) and
reprocess or settings-change estimates at Fast plus the Rich surcharge of the pages the share allows. The run cost cap
(`maxCostCents`) applies as before.

Raising a limit (a higher rung, a larger or removed share) is `reindex-recommended`; lowering one applies to new uploads.

## What is recorded

Each document's vision manifest (`vision/<document>.json`, field `ladder`) lists every selected page with the rung it
needed, the rung it was read on, why (`no-native-text`, `mixed-scan`, `table-rescue`, `drawn-content`,
`figure:chart-or-figure`, ...) and the limit that lowered it (`max-rung`, `share-above-fast`, `share-above-ocr`).
The `vision-extract` stage stats carry a summary: the limits, rung counts, budgets, capped pages and the first 200
pages. Pages a limit kept off every model are `not-selected` in the page facts, or `kept-as-image` when kept as their page
image; extraction logs `[ocr] ladder share cap` and the `ladder-capped-pages` metric, and vision logs one `[ladder]` line
per document.
