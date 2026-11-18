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

Two project settings cap the ladder. The highest rung is also the quality level: `ocr` (the default) is Fastest, `fast` is Fastest with Read scans off, `intelligent` is Smartest, under which a page that needs a read goes straight to the vision model (no OCR step; a share cap lowers it to OCR). Both apply in `auto` only: Fast reads no page, whatever
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

Validation rejects a rung outside the three, a share outside 0 to 1 (or not a finite number) and an unknown key. `null`
removes a share. A share of 0 is a rung limit: `aboveFast: 0` is `maxRung: "fast"`, `aboveOcr: 0` is `maxRung: "ocr"`;
a share of 1 caps nothing, and an `aboveOcr` at or above `aboveFast` caps nothing more (every page above `ocr` is also
above `fast`), so a project's share and an upload's other share always combine. A stored rung that is not one of the
three reads as `fast` (fail closed).

A share allows `floor(share x pages)` pages of a document, and at least 1 page while it is above 0: with `aboveFast:
0.25`, a 10-page document may have 2 pages read, and a 1-page scan, an image or an Office file (before its pages are
measured) 1.

### What a capped page gets

A capped page stays on the highest rung it is allowed, and the document never fails because of a limit:

- **Below `intelligent`**: a figure page is transcribed instead. In the OCR engine's VM when the deployment runs OCR there
  (`DOCSLURP_OCR_MODE=vm`), else by the page image reader when one is on, else by plain page transcription on the
  project's vision route. A project whose vision route is not plain transcription (an output schema or a task prompt)
  and has no OCR reader leaves the page on its text layer.
- **Chart & diagram export** keeps its free tier under any limit (a rung below `intelligent` or a share): the `models`
  tier reads chart candidates outside the page plan, so it is off while a limit is set.
- **At `fast`**: the page is not read. A page with a text layer keeps it; a page without one (a scan) is kept as its page
  image, exactly as Fast keeps it (`kept-as-image`). With `maxRung: "fast"` the whole run reads as Fast.

### Which pages escalate under a share

The share is planned per document before vision fans out, so it holds for a 20,000-page document split into page
tasks:

1. Scanned pages read by the OCR engine during extraction count first. Extraction reads at most the document's
   above-fast budget of them, in document order, and runs only text-layer extractors on a document the share does not
   cover entirely (an extractor that OCRs every page could otherwise pass the cap). An image file is one page and is read; one in a
   format that can hold several frames (TIFF, GIF, WebP), whose frame count is unknown before the OCR engine reads
   every frame, is kept as its page image under an above-fast share, by OCR and vision alike (quotes still price the share's
   budget for it).
2. The rest of the budget goes to the pages triage selected: pages without native text first, then higher triage
   confidence, then document order.
3. Under `aboveOcr`, figure pages keep the `intelligent` rung in the same order while its budget lasts; the others are
   transcribed (still above `fast`).

The first plan a run makes for a document is pinned in the run's artifacts (`<document>:ladder-plan`, stamped with the
run, so a reprocess never inherits an earlier run's plan): the whole-document pass, activity retries and restarts read
only pages it escalated, and on the `intelligent` rung only pages it put there. A page task checks its page against the
pin, or, before one is stored, against the same plan made again from the same stored inputs; a page outside it is skipped
(`ladder-capped`). Extraction counts pages an earlier attempt of the run already sent to the OCR engine first, and
records each batch as it is sent.

Reads that would happen outside the plan are off while a limit is set:

- The page router does not run (its active plans would read pages outside the plan, and routing itself sends page
  thumbnails to decision models). Self-critique, which re-reads pages with a vision model, is off.
- Under an above-fast share, query-time materialization (deferred indexing) and the document map's OCR read no page;
  they have no document-wide plan to count against.
- Page-image embeddings (visual indexing, the map's coarse visual fallback) do not run. Visual indexing mode is refused
  (`visual_mode_quality`, 400) with any ladder limit, as with Fast.

## Who can set a limit

A limit is a project setting. A per-upload `pipeline.ladder` override from a caller who cannot change the project's spend
settings (not an editor, or an API key without the `pipeline:billed-features` or `projects:manage` scope, as for chart
export's `models` tier) can only tighten the project's limits: the run gets the lower rung and the smaller share of
each. While the project has a limit, such a caller cannot raise quality above the project's either (an upload asking
Smartest on a Fastest project is refused, 403, for a caller who may not raise). The override is clamped, not refused; on a visual-mode project a limit the project does not have is dropped from the
run. A replay (reprocess, bulk reprocess, retry as new) and query-time materialization carry an older run's pipeline:
the project's limits as they are now tighten it, whoever asks, and while the project has a limit its quality is capped
at the project's (a Smartest source run replays at the project's Fastest). A stored share or rung that is not a valid value
reads as the tightest limit. Adding a limit to a visual-mode project is refused
(`visual_mode_quality`).

## Billing and estimates

Limits never change prices. A page bills OCR when OCR reads it, Rich when a vision model reads it, and Fast otherwise, as without limits:
the ladder only decides which pages are read.

Estimates follow the limits, so a capped page is not estimated as Rich: `maxRung: "fast"` is quoted as Fast, and an
above-fast share caps an upload quote, the project estimate (`POST /v1/estimate`, setting `aboveFastShare`) and
reprocess or settings-change estimates at Fast plus the Rich surcharge of the pages the share allows. The run cost cap
(`maxCostCents`) applies as before.

Raising a limit (a higher rung, a larger or removed share) is `reindex-recommended`; lowering one applies to new uploads.

## What is recorded

With a limit set, each document's vision manifest (`vision/<document>.json`, field `ladder`) lists every selected page with the rung it
needed, the rung it was read on, why (`no-native-text`, `mixed-scan`, `table-rescue`, `drawn-content`,
`figure:chart-or-figure`, ...) and the limit that lowered it (`max-rung`, `share-above-fast`, `share-above-ocr`).
The `vision-extract` stage stats carry a summary: the limits, rung counts, budgets, capped pages and the first 200
pages. Pages a limit kept off every model are `not-selected` in the page facts, or `kept-as-image` when kept as their page
image (within Fast's per-document and per-run page-image caps; pages past them are `not-read`); extraction logs `[ocr] ladder share cap` and the `ladder-capped-pages` metric, and vision logs one `[ladder]` line
per document. Without a limit nothing new is recorded: stats and manifests keep their shape, and the default ladder is
left out of the pipeline version hash.
