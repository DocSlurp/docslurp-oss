# Local page-feature JSONL

`@docslurp/estimate` exposes a detailed, local-only PDF stream alongside the existing small quote profile. It never sends the stream to a server. The quote API continues to accept its existing aggregate schema; do not submit detailed JSONL to it.

```js
import { createEstimator } from "@docslurp/estimate";

const estimator = await createEstimator();
for await (const line of estimator.profileJsonl(file, {
  maxDeepPages: 1000,
  batchPages: 64,
  groups: ["text", "images", "vectors", "tables"],
  signal: controller.signal,
})) {
  await destination.write(line); // backpressure: the next batch waits for the consumer
}
```

Run this in a browser worker when UI responsiveness matters. Each call is synchronous inside WASM, so cancellation takes effect between work batches. Each batch contains at most 64 inventory pages and eight selected deep pages. The parser is local WASM with bounded memory; this API must not become an in-process server parser for customer files. Server-side parsing still requires the documented VM boundary.

```python
from docslurp_estimate import Estimator

estimator = Estimator()
stream = estimator.profile_jsonl("local.pdf", max_deep_pages=1000)
try:
    for line in stream:
        destination.write(line)
finally:
    stream.close()  # also releases the parsed PDF when stopping early
```

There is one active detailed session per estimator. Use separate estimators for concurrent files. Breaking out of the JS iterator closes it; Python callers explicitly close generators that they do not exhaust. Legacy probes refuse while a detailed session is active. No background parsing or queued output continues while the consumer is paused.

## Records and units

Every line is a JSON object. The header declares `docslurp-page-profile@2`, column names, units encoded in column names, selected groups, limits and measurement methods. Readers must reject unknown schema versions rather than guessing positional meanings.

- `header`: document bytes, page count, sampling policy, selected deep count and column definitions.
- `pages`: numeric inventory rows and optional feature rows of `[pageNumber, values]`. Page numbers are 1-based. Width/height are displayed dimensions in tenths of a point; rotation is degrees. Coverage is 0–10,000. JSON `null` means unavailable, never zero.
- `summary`: adjacent ranges of `max(1, min(10, ceil(pageCount / 100)))` pages. Coverage counts describe how much evidence actually exists, not estimated population coverage.
- `end`: final inventory and deep-work counts, cumulative work charges, `deepComplete` and totals. `complete:true` means inventory streaming finished; it does not mean every page was deeply inspected. `deepComplete` means all selected pages were completely measured, not all document pages. A cancelled stream ends with `complete:false`. A thrown failure or missing trailer means interrupted. Exactly one terminal record is emitted.

Status codes: 0 not selected; 1 completely inspected under the declared methods; 2 partial; 3 unreadable; 4 skipped because the cumulative work budget is exhausted. A page may expose lower-bound/estimated features when partial, but it does not contribute those features to complete-observation summary totals. Per-group known-page counts distinguish omitted or unknown features from measured zeros. Summary byte sums cover observations only and are not extrapolated to unvisited pages.

At most 1,000 distinct pages receive deep inspection. Larger documents use a reproducible, stratified 75% sample and 25% largest-direct-content-stream outliers; outliers are never treated as an unbiased population sample. Selection is independent of output batch size and uses identical 64-bit arithmetic on native and WASM hosts. `maxDeepPages:0` emits inventory only. Omit optional groups with `groups:[]`.

Direct stored content bytes count stream payload referenced by each page, deduplicated within that page. Shared streams can be counted on multiple pages, and resources/fonts/metadata are not included: this is not the page's physical allocation of file bytes. Image bytes estimate significant drawn stream payload, deduplicated by object within a page; repeated furniture remains included. Neither byte measure is interchangeable with extracted text.

Estimated text bytes use two bytes per measured glyph, not font-aware Unicode extraction. Table text bytes use glyphs of word centres within candidate ruled grids with the same multiplier. This excludes whitespace/punctuation not represented by those word runs and can miss kerned continuations, so the ratio is approximate. Tiny-glyph truncation makes the table estimate unavailable. Area shares can overlap across feature families and must not be normalized to sum to 100%. Empty text denominators yield no ratio.

## Current limits and missing capabilities

This first implementation retains the existing **64 MiB PDF input ceiling**, 256 MiB WASM memory ceiling and a 100,000-page inventory ceiling. It holds a parsed PDF in memory: output streaming does not provide range-based input. Profiling a ~1 GB file still needs a bounded range/object loader; raising the input ceiling would not solve that problem.

Deep content work is charged against a 128 MiB cumulative decoding allowance and 2,000,000 interpreted operations, including conservative byte charges for failed decodes. Existing per-stream, per-page, recursion and operation caps remain. A page reserves sufficient remaining work allowance before it starts. Retained form caches are released after each page. `decodedBytes` includes conservative failed-attempt charges, not just successfully decoded payload.

The dependency's streaming content iterator tolerates malformed suffixes. Detailed profiles therefore perform strict verification on streams up to 256 KiB; larger streams are explicitly partial rather than claiming complete validation. Malformed content, omitted forms and truncated image lists are also partial.

Tables are **ruled-grid candidates**, not verified semantic tables. Vector art can produce false candidates. Unruled tables, captions, semantic charts and OCR content of scanned pages are unavailable. The header says so. There is no automatic OCR, content-bearing output, resource-byte allocation, confidence interval, ranked-page index, or compression codec in this slice. JSONL can be compressed externally without changing its semantics.

## Validation

`tests/detail_jsonl.rs` generates a 1,200-page PDF to verify all-page inventory, the 1,000-page cap, unknown counts, batch invariance, hostile inputs, malformed suffixes, image truncation, rotated pages and explicit session lifecycle. JS and Python tests cover streaming lifecycle, cancellation and reuse. Existing profiler suites remain applicable. These tests do not establish large-file memory scaling or throughput on 10,000-file workloads.

The native `cargo run --example profile-jsonl -- local.pdf` example writes the same JSONL. Use it only on trusted local fixtures; it is not a server parsing boundary.
