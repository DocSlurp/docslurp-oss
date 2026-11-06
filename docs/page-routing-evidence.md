# Page routing on evidence about the page

A PDF page is read by a vision/OCR model, and bills Rich, only when facts about the page say its content is not in its
text layer. No keyword, substring, filename or ASCII-class rule authorizes or vetoes a read. Text routes (`table-heavy`,
`form`, `formula-heavy`, `code-heavy`) still label pages for the ingest report; a page is `table-heavy` when a table has
5 or more rows or tables cover 40 % of it ([page-layout-facts.md](page-layout-facts.md)).

Rule: `decidePageRaster` in `packages/shared/src/page-raster-routing.ts`, thresholds in `PAGE_RASTER_ROUTING`. The worker
collects the facts (`worker/src/lib/page-image-evidence.ts`), classify-route applies the rule
(`buildEvidencePages`), render selection and vision selection both read its decision, billing reads the usage ledger, and
the offline estimator mirrors the thresholds from the estimate card (`packages/estimate/src/probe/pdf.rs`).

## Facts, per page

- **Native words** from the PDF's own text layer (`pdftotext`, shared with page facts), counted by Unicode script
  (`pageWordCount`: runs of two or more letters or digits in spaced scripts, two characters to the word in Han, Kana, Thai,
  Lao, Khmer, Myanmar). Pages past the page-facts range, or runs without page facts, fall back to the extractor's text.
- **Images** from `pdfimages -list` and `pdfinfo` page sizes: per image the object id, pixel size and placement ppi, so
  placed area is exact without decoding. An image is *significant* with a shorter side of 32 px and 2 % of the page.
- **Repeated images.** An image object drawn on at least 3 pages and on at least 20 % of the pages listed is page
  furniture (logo, letterhead, slide background) and leaves the scan evidence; a scan is a different image on every page.
  Inline images have no object identity and are never repeated. The listing covers pages 1 to min(pages, 1000), so
  repetition is judged over the document, not over the sparse pages alone.
- **Text-layer quality** (`assessTextLayer`, [page-text-layer-quality.md](page-text-layer-quality.md)).
- **Drawn content:** a document with fewer than 3 native words per page whose bytes minus its embedded images are at least
  16 KiB per page, or a text-less page whose render OCRs to 10 or more words. This only nominates a page; vision-extract
  still skips it unless its render shows ink.

## Decision

1. Text layer `garbled`: read. `suspect`: read only if an OCR of the page disagrees; unchecked is reported, never charged.
2. Unknown words or an unknown image listing: not read (`evidence-unknown`); unknown is never zero.
3. 30 or more native words: a text page, Fast, unless its layout facts show a scan placed beside the text (a large,
   scan-like, non-furniture image with no native words over it): read. See [page-layout-facts.md](page-layout-facts.md).
4. Sparse pages: no words and a largest image of 25 % (or images totalling 35 %): a scan. 10 words or fewer (a stamp, a page
   number) and an image of 50 %: a scan. Fewer than 30 words and an image of 85 %: a scan.
5. No words, no significant image, no drawn-content hint: **blank**, never rendered, never read. A page with a little real
   text and no scan-sized image is a native-text page, Fast. Minor images never make a scan.

The old rules disagreed about the same facts (full-page image 0.85 / 0.8 / 0.6 / 0.3; sparse 30 / 20 / 10 / 5 words; inset
0.02 vs 0.004; five word counters). The shared table is the only copy the worker and estimator use; the shadow router's
math and agreement thresholds derive from `TRUST_RULE`.

## What changed in behaviour

- A document label (`classifyTextAndFilename`) no longer gates reads (`visionAllowedForDocument(..., { evidenceRouting })`).
- Render selection pre-renders exactly the pages vision will read.
- Page boundaries must be known: with text that does not line up with the page count, no page labels are made and no
  boundaries are invented (`pageAlignedTexts` returns null).
- Without routing evidence, a document that has text keeps it; the characters-per-page density rule that read every page of
  a sparse document is retired for evidence runs.
- Per-run version: new runs pin `v3` (this routing) in `run:vision-routing-version`; the previous release's `v2` (keyword canary) is never read as this routing, and an old worker that sees `v3` routes the run as `v1`. `v1` stays only for runs already in
  flight and states without a pin; `VISION_ROUTING_V2` is gone, since a switch would only bring the keyword triggers back.

Not covered (decided with the owner): formula, chart and form pages are no longer read on their words; vector-chart evidence
(drawing density, ruled grids) is a follow-up that needs the native probe. A single full-page photo with a title is still read
(no text-over-image position evidence in the Poppler listing; repeated backgrounds are caught).

## Billing

A page bills Rich only when a vision/OCR model read it, recorded per page in the usage ledger
(`PipelineUsageEventLedger`, deterministic id per run, document and page). `recordPageBaseFee` bills every other page Fast,
per page: Rich reads outside `1..page_count` or repeated reads cannot cancel another page's Fast charge. The `scanned`
(`text_bytes = 0 and image_count > 0`) and image-file rules are gone. An uploaded image the extractor OCR'd records its
read on the ledger in extract-markdown, so it bills Rich through the same rule.
