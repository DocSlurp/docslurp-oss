# Page layout facts (`pdf-layout-facts@1`)

Structural geometry per PDF page that routing reads beside the evidence in
[page-routing-evidence.md](page-routing-evidence.md). One open walker computes it, `worker/scripts/pdf_layout_facts.py`
(`layout_facts`): the worker runs it in the parser sandbox in local mode (`worker/src/lib/page-layout-evidence.ts`), the
routing eval runs it on public fixtures, and the PDF VM guest of a sandboxed deployment runs the same file from the pinned
core commit. Routing parses the payload with `parsePageLayoutFacts` (`worker/src/lib/page-layout-facts.ts`) and applies
`mixedScanImage` (`packages/shared/src/page-raster-routing.ts`) and `isTableHeavy`
(`packages/shared/src/page-table-routing.ts`). An estimator that mirrors routing computes these definitions.

**Inputs, structure only:** the page tree and content streams (placement), `pdfimages -list` (stream facts), the text
layer's word boxes and Doppler's ruling lines (`pdftotext -bbox-layout`, `-rules`), and the extractor's Markdown. Never
document metadata (Info, XMP, file names) and never words that name a table. Bounded: at most 5,000 pages per call, 64
images and 64 tables per page, a caller-given deadline; anything it cannot establish is `null` (unknown), never `0`.

## Per page

- `known`: the walker placed the page (otherwise the page is omitted or carries `reason`).
- `words`: the text layer's word count on the page (`null` without word boxes).
- `widthPt`, `heightPt`: the visible page box, crop box ∩ media box, in displayed points (rotation applied, origin top-left).
- `images[]`, one per drawn listed image:
  - `bbox` and `coverage`: the draw's box in displayed points and its share of the visible page (`null` when the draw
    could not be placed);
  - `widthPx`, `heightPx`, `bitsPerComponent`, `colorSpace`, `encoding`, `ppi`, `streamBytes` from the listing, and
    `bytesPerPixel` = `streamBytes / (widthPx × heightPx)`;
  - `repeated`: page furniture, an image object drawn on at least 3 pages and at least 20 % of the pages considered;
  - `wordsInside`: text-layer words whose box centre lies inside `bbox` (`null` when either is unknown).
- `tables[]`: each table in the extractor's Markdown (GFM pipe rows without the separator, or HTML `<tr>` rows) with
  `rows`, `columns` and `coverage`: the box of the text-layer words its cell tokens match in reading order, as a share of
  the visible page (`null` when under half the tokens match).
- `grids[]`: ruled grids from ruling lines. A rule is horizontal (or vertical) when at most 3 pt thick and at least 8 pt
  long; rules within 2.5 pt meet; a connected set with at least 2 distinct horizontals and 3 distinct verticals is a grid
  with `rows` = horizontals − 1 and `columns` = verticals − 1. `null` without ruling lines.
- `tableCoverage`: the union of the table boxes and grid boxes as a share of the visible page, measured on a 200 × 200
  grid so overlaps count once. `null` without ruling lines.

## Rules that read them

- **Scan beside native text** (`mixedScanImage`): a page with at least the sparse-page word count is read when it has an
  image that is placed, not `repeated`, covers at least 20 % of the page, has at most 2 `wordsInside`, a shorter side of
  200 px and at least 50 ppi on both axes, and is scan-like: CCITT or JBIG2, 1 bit per component, or at most 0.15
  `bytesPerPixel` (ink on paper compresses; photographs do not). Colour space alone does not decide it. The decision
  returns the image's box as the page region.
- **Table-heavy** (`isTableHeavy`): some table or grid has 5 or more rows, or `tableCoverage` (else the sum of known table
  coverages) is at least 40 %. Without layout facts, rows come from the Markdown alone.

## Chunked callers

`layout_facts(..., repeated=)` takes a furniture set computed over a longer range (`repeated_objects` over that range's
listing rows); the VM guest passes one per shard while it walks 32-page chunks. Repetition is therefore judged per shard
for very long documents.

`layout_facts(..., pages=)` (CLI `--pages 3,5,9-12`) walks and reports only the listed pages of `first..last`, in page
order; every listed page's entry is the one a run over the whole range gives (with the same `repeated`), and no other page
gets an entry, so the caller answers those itself. The XHTML still covers the whole range. A caller that already knows
which pages need the walker (from facts of its own) passes them per chunk, so the walker's cost follows the pages that
need it rather than the chunk. The list is strict: digits and ascending ranges inside the range only, at most 5,000 items,
checked before anything is expanded; anything else is refused.

## The offline profiler

`@docslurp/estimate` (`packages/estimate`) applies the scan-beside-text rule in the browser from the same thresholds:
it reads `pageRasterRouting` and `layout` (these grid constants, and `MAX_ANCHOR_WORDS`) from the neutral
`profiler-rules.json`, generated from `PAGE_RASTER_ROUTING`, `PAGE_TABLE_ROUTING` and `LAYOUT_GRID_RULES` and checked
against them and against this walker's constants (`estimate-profiler-rules.test.ts`; the committed file by `packages/estimate/test/profiler-rules.test.mjs`). The Rust parser refuses unknown
fields, so a new threshold fails the build until the profiler handles it.

It computes the same geometry from the content stream: the displayed page space, each image's clipped coverage, pixel
size, per-axis ppi and stream bytes per pixel, words at their box centres (half an em a glyph along the baseline, so
`wordsInside` is an estimate of the text layer's), and ruling lines from stroked horizontal and vertical segments,
rectangle edges and thin filled rectangles, clipped to the page, built into grids exactly as above. It reports
`scanBesideTextPages`, `scanBesideTextUnknownPages` (undecided: never read, a wider quote) and `ruledTablePages`
(table-heavy from grids alone; tables only the extractor finds stay unknown in the browser).
`packages/estimate/tests/layout_walker.rs` cross-checks it against this walker's output on the routing fixtures, recorded by
`scripts/layout-walker-snapshots.mjs`; `test/layout-walker-snapshots.test.mjs` fails when a recording is stale.
