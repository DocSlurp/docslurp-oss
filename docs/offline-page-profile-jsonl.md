# Local page-feature JSONL

`@docslurp/estimate` inventories every PDF page through bounded local range reads and deeply inspects at most 1,000 pages. The stream contains neutral numeric facts, not extracted text or prices. Nothing is uploaded. The existing small quote profile and quote endpoint remain separate.

```js
import { createEstimator } from "@docslurp/estimate";
const estimator = await createEstimator();
for await (const line of estimator.profileJsonl(file, {
  maxDeepPages: 1000, batchPages: 64, rankedPages: 32,
  groups: ["text", "images", "vectors", "tables", "captions", "charts"],
  signal: controller.signal,
})) await destination.write(line);
```

For Node paths use `profilePathJsonl(estimator, path, options)` from `@docslurp/estimate/node`. It retains one file descriptor, verifies identity/size/timestamps around positional reads and closes it on completion, cancellation or failure. Advanced callers can supply `{size, read(offset,length), close?}` to `profileSourceJsonl`; such a source must represent an immutable snapshot.

```python
from docslurp_estimate import Estimator
stream = Estimator().profile_jsonl("local.pdf", max_deep_pages=1000, ranked_pages=32)
try:
    for line in stream:
        destination.write(line)
finally:
    stream.close()
```

Native Rust exposes `local::FileProfileJsonl::new(file, options)` and `next_chunk()`. Dropping it releases state and the handle. Native metadata checks detect ordinary mutations; callers needing snapshot semantics against concurrent writers must provide an immutable file. Customer files on servers still require the mandatory credential-free VM boundary. These local adapters do not authorize host parsing inside a server with secrets.

## Input and lifecycle

The WASM parser asks for a range, the host awaits only that range, then the parser resumes. Browser Blobs use `slice`, never a whole-file `arrayBuffer`. The same cooperative ABI works on the browser main thread or in a worker without synchronous I/O, SharedArrayBuffer or Asyncify. A worker remains useful for UI responsiveness during bounded synchronous parsing calls.

There is one active detailed session per estimator. Use separate instances for concurrency. A slow consumer pauses parsing; it does not queue the rest of the document. JS iterator return and Python explicit generator close release the session. Cancellation is checked between reads and output records. Legacy probes refuse while a detailed session is active. Stale, short or mismatched range supplies refuse; a closed/reopened session has a different request epoch. Traps reset the existing bounded WASM memory and invalidate old ownership tokens.

Input limit: **2 GiB**. The reader supports classic xref tables, xref streams, compressed object streams, hybrid xrefs, indirect stream lengths and bounded incremental revisions. It enumerates actual page leaves rather than trusting authored `/Count`. Damaged/unindexed files, encryption, unsupported structures and limits produce explicit failures or unreadable selected-page evidence. It never silently falls back to whole-file recovery. `startxref` search expands only to a 1 MiB tail window.

The pinned dependency is `otf-pdf-syntax = 0.2.0` (Apache-2.0, Rust >=1.88), used only for public low-level grammar. Its high-level file loader owns complete stream payloads and unbounded object caches, so this implementation does not use it. The adapter isolates its currently unstable subcrate API. The legacy Rust byte-buffer `DetailSession` remains limited to 64 MiB; public JS/Python JSONL paths use the new range reader.

## Records and density

Every line is a JSON object. The first record declares `docslurp-page-profile@3`, numeric column names, scales, feature methods and limits. Reject unknown schema versions rather than guessing positional meanings.

- `header`: document bytes/page count, selected deep count, sampling policy, optional groups, limits, `columns` and `summaryColumns`.
- `pages`: inventory rows plus optional feature rows `[pageNumber, values]`. A batch contains at most `batchPages` inventory rows and eight selected deep pages. Page numbers are 1-based; displayed dimensions use tenths of a point; rotation is degrees; area coverage uses 0–10,000. Null means unavailable, never zero.
- `summary`: `first`, numeric vector `v` in header-declared `summaryColumns` order, and `wordsHistogram`. Ranges contain `max(1,min(10,ceil(pageCount/100)))` pages. Counts and sums describe observed evidence, never an extrapolation over unvisited pages.
- `rankings`: optional bounded lists of `[score,page]`, over measured selected pages only. Page order remains canonical. Default top 32, configurable 0–128. Image/table/caption/chart scores use area coverage; vectors use operation counts.
- `end`: final inventory/deep-work counts, byte/work counters and verbose document totals. `complete:true` means inventory streaming finished; `deepComplete` means every selected page was completely measured, not every document page. Cancelled streams have `complete:false`; exceptions or missing trailers mean interrupted. Exactly one terminal record is emitted.

Status: 0 not selected; 1 complete under declared measurement methods; 2 partial; 3 unreadable; 4 work budget exhausted. Partial page features do not enter complete-observation summary totals. Optional layout groups have their own unknown values/confidence so missing semantic evidence cannot look like a measured zero.

At most 1,000 distinct pages receive deep work. Larger documents allocate 75% to reproducible stratified sampling and 25% to largest direct-content-stream outliers. Outliers are not an unbiased population sample, so no population total or confidence interval is manufactured. `maxDeepPages:0` emits only inventory. `groups:[]` avoids feature sections. The same input/selection produces identical facts independently of host pointer width or transport batch boundaries.

## Features and percentages

Text contains word/glyph/line counts and estimated text bytes. Images contain significant drawn placement counts, estimated encoded stream bytes, union area coverage and a raster indication; repeated furniture is included. Vector counts and optional vector-figure footprints describe drawing geometry, not rendered pixels.

`tables` retains raw ruled-grid facts. `tableCandidates` requires spanning grid evidence or repeated aligned short cells; `unruledTables` isolates candidates without ruling. Axis ticks alone do not establish table cells. `captions` reports short text near image/table geometry. `charts` reports non-table vector-figure candidates with axis/tick evidence, not verified semantic charts. All classifiers are bounded geometric heuristics: short aligned prose, graph paper, decorative vectors or neighboring paragraphs can be false positives. Confidence codes are **uncalibrated** categories, never probabilities.

Scanned image pixels are not inspected or OCRed. Native-layer candidates cannot establish semantic content inside those pixels; pure raster pages without text expose unknown layout features. Unmapped fonts, truncated text and exhausted geometry work also keep those fields unknown. Word extents use estimated half-em advances transformed through text/page matrices, not exact font metrics.

Stored PDF bytes, extracted-text estimates, decoded work and area are separate denominators:

- Direct stored content bytes count unique stream payloads referenced by each page. Shared streams can count on multiple pages; resources/fonts/metadata are separate, so these are not physical file allocations.
- Image bytes describe significant drawn encoded payload, deduplicated by object within a page. The range path uses image dictionaries and validated lengths through adapter-owned side metadata. Bounded header/tail windows may include adjacent payload bytes; no pixel codec or complete image payload is needed.
- Text estimates use two bytes per measured glyph. Table/caption ownership uses positioned word glyphs from that same retained basis. Spaces, punctuation, kerned continuations or other unassigned glyphs remain unattributed; this is not Unicode-aware extraction.
- `composition` partitions the estimated total into table-candidate bytes, caption-candidate bytes, other word bytes and unattributed bytes. Table ownership wins before captions. Components sum to their total when known. Divide a component by that same total; a zero/unknown denominator gives no ratio. Tiny-glyph truncation makes ownership unavailable.
- Within-family area uses geometric union. Different feature families may overlap, so their area shares need not sum to 100%. Composition text ownership is exclusive; area coverage is not.

## Bounds

WASM memory remains capped at 256 MiB. Range requests are <=1 MiB; raw and parsed-metadata caches each have 16 MiB allowances, with an additional bounded per-page payload cache (16 MiB) to retain progress across range suspension. The compact xref index is capped at 250,000 entries; page inventory at 100,000. Limits apply independently of file size.

Cumulative requested input is limited to 512 MiB; parsing/copy/traversal work is charged against a 2 GiB weighted allowance. A selected page materializes at most 512 unique dependencies, 10,000 reference slots, 16 MiB metadata and 16 MiB encoded payload. Image/font payloads are omitted. Failed decompression attempts are conservatively charged. Interpretation retains its stream/page/form-depth limits, 128 MiB cumulative decoded-work allowance and 2,000,000 operations.

Geometry caps include 4,096 words, 64 region candidates per family, 100,000 derived comparisons and 65,536 ruled-grid pair comparisons per page. Over-budget evidence is unknown, not empty. Strict content verification streams tokens instead of collecting an entire operation list, removing the former 256 KiB validation cliff. Inline binary image content that cannot be strictly verified is partial.

## Reproduce

```sh
cargo run --example generate-layout-candidates -- examples/layout-candidates.pdf
cargo run --example profile-jsonl-range -- examples/layout-candidates.pdf
cargo run --example generate-range-scale -- /your/scratch/large.pdf 20000 1024
node scripts/benchmark-jsonl.mjs large /your/scratch/large.pdf
node scripts/benchmark-jsonl.mjs many 10000
```

Run Cargo commands from `packages/estimate`. The scale generator creates a valid sparse file whose hole is a shared zero-valued grayscale image, not a fake byte-source mock. Measurements distinguish requested bytes, cache occupancy, WASM memory and total process RSS. The many-file run uses independent variable-size synthetic Blob snapshots and one reused WASM instance; it does not model simultaneous file transfers. Real-document throughput and semantic accuracy are not established by synthetic acceptance checks.

`examples/layout-candidates.jsonl` contains actual output for our generated three-page unruled-table/caption/vector-plot demonstration, with a source-page capture beside it. JSONL can be compressed with a standard external gzip/zstd stream; the public API emits raw JSONL as requested. `examples/scale-shared.jsonl.gz` preserves the complete 20,000-page example: 957,156 raw bytes in 99,793 gzip bytes (about 90% smaller).


## Completion diagnostics and bounded inline images

Measured selected pages add header-described diagnostics (8 numeric fields) and work vectors. They distinguish interpreter, word/rule retention, grid and derived-stage refusals. Interpreter flags cover byte/operation budgets, transforms, syntax, resources, forms and strict validation. Strict classes0–3: none; lexical/operand/compatibility failure; unverified inline/object-boundary token; unsupported operator. Any requested grid/support/derived refusal remains partial, including captions-only/chart-only requests.

Detailed rules are eligibility-filtered/deduplicated before retention, with actual relevant path truncation reported. The orthogonal sweep charges spatial candidates under65,536 visits rather than all pairs. Dense hostile graphs still refuse. charts.shortEligibleRules counts retained unique eligible rules below20 pt (bundled minimum 8 pt), not all decorative ticks; raw vector operations remain separate.

Small inline streams support strict Group4 masks and Flate/PNG-predicted samples with known resource component counts. Bounds:256 KiB input/normalized content per stream;1,048,576 pixels,1 MiB scan work,1 MiB codec byte work and64 codec calls per page, alongside existing page/document budgets. Exact endpoints, dimensions, aliases, predictors, checksums, padding and EI separators must validate. Encoded lengths remain separate from normalized raw samples. The strict exception only applies to adapter-generated content; unverified original raw-inline recovery remains partial. No OCR or semantic pixel interpretation.

Off-crop word centres leave visible geometry without becoming truncation; glyph estimates remain in the unattributed composition remainder. Complete means declared numeric methods finished, not Unicode extraction or semantic table/chart truth. See [complete real-document confirmation](performance/offline-profile-complete-2026-11-15/README.md) for full-deep throughput/cost and remaining limits.
