# @docslurp/estimate

[Package docs](https://docslurp.io/docs/packages/estimate) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/estimate) · npm · not published yet

The offline DocSlurp file profiler. It measures files on the user's machine (the real file type, page, slide and
frame counts, audio and video duration, and aggregate facts about a PDF's pages) and returns a small **file profile**
per file. Send the profiles to `POST /v1/uploads/estimate` and the server answers with a credit estimate. Nothing is
uploaded, and nothing here prices anything: offline, show the profiles without credits and ask the user to connect
for a quote.

One WebAssembly module serves every host: this npm package (browsers, Node, Deno, Cloudflare Workers), Python through
wasmtime (`python/`), and any other WebAssembly runtime through its JSON ABI (`src/abi.rs`).

```js
import { createEstimator, estimateFiles, requestQuote } from "@docslurp/estimate";

const estimator = await createEstimator();
const result = await estimateFiles(estimator, fileInput.files);          // browser File objects
console.log(result.files.map((file) => file.profile));                   // neutral facts, no credits
const quote = await requestQuote({ files: result.request.files, apiKey }); // the server's estimate
```

```js
// Node: read only the bytes each profile needs.
import { createEstimator } from "@docslurp/estimate";
import { estimatePaths, profilePath } from "@docslurp/estimate/node";

const { profile } = await profilePath(await createEstimator(), "contract.pdf");
```

```js
// Cloudflare Workers: pass the compiled module.
import wasm from "@docslurp/estimate/docslurp_estimate.wasm";
const estimator = await createEstimator({ module: wasm });
```

## What a profile holds

For optional dense per-page evidence, `estimator.profileJsonl(file, options)` yields local-only JSONL through bounded range reads, supports PDFs up to 2 GiB, inventories every page and deeply inspects up to 1,000. Numeric sections include image/vector facts, ruled/unruled table and caption/vector-figure candidates, exclusive text-byte composition, compact chunk summaries and optional top-page rankings. Node paths use `profilePathJsonl` from the `/node` export; Python exposes `Estimator.profile_jsonl(path)`. This is separate from the small quote profile below. See [the JSONL contract and limits](../../docs/offline-page-profile-jsonl.md).

Aggregates only, never file content, never per-page arrays, at most 4 KiB (`fileProfileSchema` in
`@docslurp/shared`; profile schema 1):

| Field | What it is |
|---|---|
| `kind`, `format`, `mimeType?` | The detected format (`pdf`, `docx`, `mp4`, `png`, ...); `mimeType` only when the file's name and declared type say nothing |
| `bytes` | The size the profile was measured on (the server drops a profile whose size does not match the file) |
| `pages?` | Pages, slides or image frames (TIFF), counted from the file's structure (PDF page tree, slide parts, TIFF frames); text files are counted as the API counts them. Never from authored metadata |
| `textChars?` | Characters of a text file (text volume) |
| `encrypted?` | An encrypted PDF: its page facts are not measured |
| `durationSeconds?` | Audio or video length from the container headers |
| `office?` | Images embedded in a Word, PowerPoint, Excel or EPUB package; slide and worksheet parts; uncompressed bytes of the body parts (text volume); and `declaredPages`, the count the document's own metadata claims: informational only, nothing counts or prices from it |
| `pdf?` | Facts over up to 24 pages spread evenly over the document, below |
| `notes?` | Up to 8 short reasons a fact is missing or approximate |

PDF facts (counts are over the sampled pages):

| Field | What it is |
|---|---|
| `sampledPages` | Pages inspected |
| `textLayerPages` | Pages with at least one native (text-layer) word |
| `wordsPerPage` | Histogram of native words per page: 0, 1-10, 11-29, 30-199, 200-499, 500+ |
| `lowTextPages`, `blankPages` | Pages under 30 words; pages with neither words nor a significant image |
| `rasterPages` | Pages the worker's page raster rule finds held by a full-page image (a scan or a photo of the page) |
| `imagePages`, `images` | Pages with a significant image, and significant image placements in total |
| `imageCoverage` | Histogram of per-page image coverage: none, under 15%, 15-50%, 50-90%, 90%+ |
| `furnitureImages` | Images repeated across pages (logos, letterheads, slide backgrounds), excluded from the facts above |
| `layoutHeavyPages`, `vectorHeavyPages` | Pages with large figures or heavy vector drawing (tables, charts); pages with 60+ path operations |
| `unmappedFontPages` | Pages showing text in a font with no Unicode mapping, whose text layer is likely unreadable |
| `drawnContent` | No page has words or images, yet the file carries heavy non-image content per page (text drawn as paths) |
| `budgetExhausted` | A page or the document hit the profiler's content budget; facts are partial |
| `sampledWords` | Native words on the sampled pages in total (text volume: chunks and embeddings) |
| `medianPageAreaSqIn`, `maxPageAreaSqIn` | Visible page area (render, OCR and page-image size) |
| `sampledChars`, `sampledTextLines` | Glyphs shown and text lines started on the sampled pages (text volume as extraction reads it) |
| `charsByFontSize` | Glyphs per effective font size: under 1 pt, 1-4, 4-6, 6-20, 20 pt and up (tiny text) |
| `invisibleChars`, `offCropChars` | Glyphs drawn invisibly (rendering modes 3 and 7), and glyphs placed outside the visible box |
| `textEquivalentsPerPage`, `areaEquivalentsPerPage`, `densePages` | Per-page distributions: sampled pages per text equivalents (1, 2, 3, 4-8, 9-16, 17-64, 65+) and per area equivalents (1 to 8), and pages over 3 text equivalents |
| `medianPageWidthPt`, `medianPageHeightPt`, `maxPageWidthPt`, `maxPageHeightPt` | Visible (CropBox) page dimensions in points |
| `offPageChars`, `tinyCharsDropped` | Glyphs the text extraction drops, as observed with Poppler, and so not counted: placed outside the MediaBox, and glyphs under 3 pt beyond 50,000 a page |
| `textEstimatedPages` | Pages with text the profiler could not read to the end (a content budget): their glyphs are estimated from the content stream's size (2 bytes a glyph) and the text facts are estimates |
| `pageEquivalentsByAllowance` | Page equivalents under a dense-page text allowance of 1, 2 and 3 (core `billedPagePageEquivalents`): each sampled page counts max(its text equivalents when above the allowance else 1, its area equivalents), summed. A twice-Letter page with little text counts 2 under each |
| `maxPageEquivalentsByAllowance` | The largest single sampled page under each of those allowances |
| `imagePpi` | Significant, non-repeated images per placed resolution (pixels over the placed inches): under 100, 100-200, 200-300, 300+ ppi |
| `imageBytesPerPixel` | The same images per stream bytes per pixel, a compression signal (scans are dense, flat art is not): under 0.05, 0.05-0.2, 0.2-0.5, 0.5-1, 1+ |
| `glyphsOverImages` | Glyphs whose run starts inside one of those images' boxes: a text layer over a scan, or captions over a figure |
| `textOverImagePages` | Pages with 20 or more such glyphs |
| `scanBesideTextPages` | Pages the page router reads for a scan beside native text (`mixedScanImage`, docs/page-layout-facts.md): a page with at least the sparse-page word count that places a non-repeated, scan-like image (CCITT, JBIG2, 1 bit per component, or at most 0.15 stream bytes per pixel) covering 20% or more of the visible page, at least 200 px on its short side and 50 ppi on both axes, with at most two text-layer words whose box centre lies inside it |
| `scanBesideTextUnknownPages` | Pages where that rule could not be decided: the page was not read to the end, or it had more words than the walker keeps. Unknown never reads |
| `ruledTablePages` | Pages table-heavy from ruled grids alone: rules (stroked horizontal and vertical lines and rectangle edges, thin filled rectangles; at most 3 pt thick, at least 8 pt long, meeting within 2.5 pt) form a grid of at least 2 horizontals and 3 verticals; a grid of 5 or more rows, or grids covering 40% of the page on a 200 × 200 raster. Tables only the extractor finds are not seen |
| `routePages` | Sampled pages per cost route, as production routes them (`pageCostRoute` in `@docslurp/shared`): `ocr-read` (no text-layer word, something drawn: scan-fill OCR reads it), `ocr-blank` (nothing to read), `table` (ruled grids unknown or table-heavy: the table path), `text`, `unknown` |
| `sampledTextEquivalents`, `sampledAreaEquivalents`, `sampledPageEquivalents`, `maxPageEquivalents` | Page equivalents of the sampled pages by the rule billing measures with (`page-equivalents.ts`): a page counts as the larger of 1, its text pages (60 lines or 3,500 characters a page) and its area in Letter pages (capped at 8). A page packed with tiny, invisible or off-page text, or an oversized page, counts as the pages it holds |
| `pageEncodings` | How math and tables are encoded on the sampled pages: `[mask, pages]` pairs, one per distinct page mask, sorted by mask; the pages add up to `sampledPages`. A histogram, never a per-page array. Bits (`PDF_PAGE_ENCODING_BITS` in `@docslurp/shared`, below); `pdfPageEncodingPages(pageEncodings, "mathFont")` gives the pages with one (a lower bound) and the partial pages without it |
| `taggedFormulas`, `taggedTables`, `taggedMathSources`, `taggedTruncated?` | The whole document's structure tree: /Formula and /Table elements (custom types through the RoleMap), and formulas whose source is recoverable (TeX-like Alt or ActualText, a MathML associated file or MathML structure). 0 when the document is untagged; absent when the document's content budget was spent before the tree was read; `taggedTruncated` when the bounded walk (50,000 elements, 64 levels, each object once, source reads within the content budget) stopped early or met a root or kid that does not resolve, so the counts are lower bounds |

Page encoding bits (a page can carry several; read from the page's own content stream and structure tree, never
rendered; font names, text and element text are only classified into these bits and never leave the profiler):

| Bit | Name | Set when the page |
|---|---|---|
| 0 | `mathFont` | shows glyphs from a math-class font with a Unicode mapping: TeX math families, an OpenType MATH table or a name with "Math", KaTeX/MathJax fonts; Symbol and OpenSymbol only inside a line (never a bullet) |
| 1 | `stackedMath` | has two-dimensional math: math glyphs over each other (baselines 0.3 to 3 em apart, overlapping across) or a fraction bar with text right above and below |
| 2 | `mathSource` | has recoverable formula source: TeX-like ActualText, a tagged formula with TeX-like Alt or ActualText, MathML structure or a MathML associated file, or shows math in a document with a MathML associated file |
| 3 | `actualText` | marks content with ActualText (any replacement text) |
| 4 | `formulaStrip` | places a short, wide image in text: 8 to 100 pt tall, at least 1.6 times as wide, under 6% of the page and 85% of its width, on a page of 10 or more glyphs, not repeated like furniture |
| 5 | `glyphOutlines` | draws three or more small clusters (120 pt a side at most) of filled curve paths with 6 or more curves and 4 per path: text or math converted to outlines |
| 6 | `type3BitmapFont` | shows glyphs from a Type 3 font whose glyph procedures paint images (bitmap fonts) |
| 7 | `unmappedMathFont` | shows glyphs from a math-class font without a Unicode mapping |
| 8 | `ruleGrid` | has a ruled grid (`ruledTablePages`' grid rule, any size) |
| 9 | `horizontalRuleTable` | has a table drawn with horizontal rules only: three or more rules sharing both ends, no vertical rule across them, a header row in the first gap, a gap of two or more rows, and rows with column gaps (lined forms, heading underlines and footnote rules are not) |
| 10 | `taggedTable` | is named by a /Table element or its descendants |
| 11 | `taggedFormula` | is named by a /Formula element or its descendants |
| 12 | `tableImage` | places a lossless (not JPEG) image 48 pt or taller, 5 to 60% of the page and 40% of its width wide, in a page of 30 or more words. A chart in a PNG looks the same |
| 13 | `mathGrid` | has a matrix-like grid of math glyphs: two text-size rows of two or more aligned columns, a delimiter on both sides spanning them (chained extension glyphs, a glyph set large, a short vertical rule or a tall path) and no fraction bar between them. Conservative: a matrix whose brackets are single font glyphs is not seen, and aligned equations, big-operator limits and tables are not matrices |
| 15 | `partial` | was not read to the end, hit a cap or a work budget, showed glyphs from a font whose class could not be read (an unsupported filter, a predictor or external data, a stream cut or corrupt before its answer, too many glyph procedures, the encoding facts' read budget or the font cache spent), checked 1 MiB of ActualText, saved more graphics states than the walker keeps or restored one it never saved, or its structure tree was not read: its bits are a lower bound |

Tables aligned by whitespace alone are not detected: the profiler places words only by estimate (half an em a glyph),
which cannot find column gaps reliably without font metrics.

### Per-page stat stream (local output)

`estimator.profileWithPageStats(file, head, tail)` (Node: `profilePathWithPageStats`; Python:
`profile_with_page_stats` and `profile_path_with_page_stats`; ABI: `ds_probe_pages`) returns the same profile and,
beside it, `pageStats`: JSONL with one object per sampled page, `{"page":12,"mask":3,"counts":1110}`. `page` is the
1-based page number, `mask` the page's encoding bits, and `counts` packs one 4-bit log2 bucket (0 for none, else
`min(15, floor(log2 n) + 1)`) per entry of `PDF_PAGE_STAT_COUNTS`, entry `i` in bits `4i` to `4i+3`: words, glyphs,
math glyphs, images, path operations, ruling lines, glyph-outline clusters, formula strips (`unpackPdfPageStatCounts`
decodes it). It is content-free and bounded like the profile (24 lines at most), for local and SDK use; it is never
part of the profile and the server does not read it.

The thresholds (significant image size, the raster rule, repeated-image detection, the text page rule) come from
`profiler-rules.json`, generated from `@docslurp/shared`, so the profiler and the worker read the same numbers.

## Progress, cancellation and Web Workers

`estimateFiles` reports progress, stops on an `AbortSignal` and never fails the batch for one bad file:

```js
const controller = new AbortController();
const { files, request, stats, partial, cancelled } = await estimateFiles(estimator, fileInput.files, {
  signal: controller.signal,      // stops between files and between 1 MiB reads
  concurrency: 2,                 // files read at once; profiles run one at a time on the one wasm instance
  batchSize: 16,
  maxBufferedBytes: 128 << 20,    // bytes read but not yet profiled
  onProgress: (event) => render(event),
});
```

- **Events**, in order per file: `file-start`, `read-progress` (bytes of the file's read plan), `probe-start`,
  `probe-done`, `file-done`; then `batch-done` per batch and `done` last. Every event carries
  `files: { total, completed, probed, failed, skipped }`, `bytes: { read, planned, files }` and `elapsedMs`. Profiling
  is one opaque call, so its events carry the stage and its time (`probeMs`), never a percentage.
  `estimateEvents(estimator, files, options)` yields the same events as an async iterator with backpressure.
- **Results.** `files[i]` is `{ status: "probed" | "failed" | "skipped", reason?, profile, requestFile, measured,
  bytesRead, plannedBytes, readMs, probeMs, elapsedMs }`. A file that cannot be read or profiled (including an
  estimator crash) is sent with its name, type and size only, with a `reason`. `request.files` is the body for
  `POST /v1/uploads/estimate`. After an abort the result is `partial` and `cancelled`.
- **Stats.** Files profiled, failed and skipped; bytes read against the files' sizes (media is read as head and tail
  only); total, p50 and p95 profile time; files/s and MB/s; pages found; PDF pages sampled; estimator crashes and
  resets; and the bounds the run kept.
- **Web Worker.** `@docslurp/estimate/worker` runs the module and the reads on a dedicated worker;
  `@docslurp/estimate/client` posts `File` handles (no bytes are copied) and relays the events. An aborted worker
  returns its partial result; one that does not answer within `abortGraceMs` is terminated and the result is rebuilt
  from the events received.

  ```js
  import EstimateWorker from "@docslurp/estimate/worker?worker";   // Vite; or new Worker(new URL(...), { type: "module" })
  import { createEstimateWorker } from "@docslurp/estimate/client";

  const client = createEstimateWorker(new EstimateWorker());
  const result = await client.estimate(files, { signal, onProgress });
  ```
- **Node** `estimatePaths(estimator, paths, options)` and **Python** `Estimator.estimate_paths(paths,
  on_progress=..., cancel=threading.Event())` report the same events and stats.
- **Quotes.** `requestQuote({ files, apiKey, project?, speedBoost?, origin? })` posts to
  `POST /v1/uploads/estimate` (an API key with the `ingest` scope). The answer is labelled an estimate: a profile
  never changes what an upload is charged, which the worker measures as it processes the files.
- **Errors.** `EstimatorError.code` is `invalid_request`, `crashed` (a panic, with its message), `out_of_memory` (the
  file needed more than the module's memory), `worker_failed` or `quote_failed`. After `crashed` or `out_of_memory`,
  the estimator has already started a fresh module instance, and `profile` has retried the file once without loading
  the whole document, so a PDF still gets its page count; the error is raised only when that retry fails too.
- **Memory.** An estimator uses one WebAssembly memory of at most 256 MiB at a time; a trap replaces it with a fresh
  one (a memory cannot shrink, and reusing one a file grew to its maximum would starve every later file). A PDF whose
  declared objects would not fit a whole-document load gets its page count from a bounded read of its page tree
  instead, with a note and no page facts. Run big batches through `@docslurp/estimate/worker`: a heavy PDF blocks an inline caller's event loop for
  a second or more, the worker's caller for a few milliseconds (`test/progress.test.mjs` measures both).

## Development

- `cargo test`: Rust unit and profile-fixture tests.
- `pnpm test:wasm`: build `dist/docslurp_estimate.wasm` (size budget) and run the JS tests, including progress,
  cancellation, bounds and the worker's event-loop delay against an inline run.
- `pnpm test:python`: the Python package on the same module.
- `test/page-equivalents.test.mjs` holds the profile's page equivalents to the shared functions billing uses
  (`pageTextEquivalents`, `pageAreaEquivalentsPt`, `pageEquivalents`) on generated stuffed pages.
- After changing a threshold or file-type list in `@docslurp/shared`, run
  `UPDATE_PROFILER_RULES=1 node --test packages/estimate/test/profiler-rules.test.mjs` to regenerate
  `profiler-rules.json`.
