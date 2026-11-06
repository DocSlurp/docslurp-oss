# Offline file profiler — design (v3, 2026-11-05)

Measure files on the customer's machine and send aggregate facts to the server, which quotes them. Targets: our
uploader (A), customer apps, SDK, CLI and edge runtimes (B), and SDKs in other languages, Python first (C).

v3 replaces the v2 offline credit estimator. v2 shipped the price card and a Rust port of the quote; v3 ships no prices
and no quote logic. The server quotes with its pricing provider (`docs/billing/pricing-provider.md`).

## What the profiler emits

A **file profile** (`fileProfileSchema` in `@docslurp/shared`, schema 1) per file: neutral, aggregate facts only.

- **Facts, not classes.** Counts, two fixed-size histograms and flags: no credit-relevant class, no "free" or "zero"
  flag, no price. The server decides what the facts mean for an estimate.
- **Bounded.** No per-page arrays; PDF facts are taken over at most 24 pages spread evenly over the document. At most 8
  notes of 160 characters; a serialized profile stays under 4 KiB.
- **No content.** No text, no file names beyond what the request already carries, no image data.

The README lists every field.

## Heuristics kept in the profiler

They describe pages, not prices, and the worker reads the same thresholds (`profiler-rules.json`, generated from
`@docslurp/shared` and checked against the committed file by this package's `test/profiler-rules.test.mjs`):

- **Page raster rule** (`decidePageRaster`, `page-raster-routing.ts`): a sparse page whose content is held by
  significant, non-repeated images is a full-page raster page (`rasterPages`).
- **Furniture-image exclusion**: an image object drawn on at least `repeatedImageMinPages` sampled pages and
  `repeatedImageMinShare` of them is page furniture and counts for nothing (`furnitureImages`).
- **Significant images**: images under `minSignificantImagePixels` or `minSignificantImageCoverage` count for nothing.
- **Text-layer quality**: fonts with no Unicode mapping (`unmappedFontPages`). The full text-layer detector
  (`text-layer-quality.ts`) needs Unicode text, which the profiler does not decode; it stays in the worker.
- **Drawn content**: no words or images anywhere, yet heavy non-image bytes per page (`drawnContent`).
- **Text page rule**: text files counted exactly as the API counts them.

## Contracts fail closed

- The server validates every profile strictly (unknown fields refused), clamps it against the file it claims to
  describe (`normalizeFileProfile`: a size mismatch or inconsistent histogram drops it, counts are clamped to the pages
  sampled) and uses it only to estimate. Billing is measured by the worker; a profile never changes a charge.
- The JSON ABI refuses malformed requests with `invalid_request`.

## One artifact, three hosts

- A single `docslurp_estimate.wasm` with a plain JSON C ABI: `ds_alloc`, `ds_free`, `ds_info`, `ds_read_plan`,
  `ds_probe`. No wasm-bindgen, no PyO3 or maturin, no per-platform wheels.
- Hosts: a JS wrapper (`@docslurp/estimate`: browser, Node, Deno, Workers via `WebAssembly.Module`), Python on
  `wasmtime` (pure-Python wheel), and Go on wazero (later, at no extra cost).
- **Traps are expected.** WASM aborts on panic. The wrappers catch a trap, discard the instance and re-create it. In
  browsers, profiles run in a Web Worker with a timeout.

## Probes: bounded

- The module imports its memory (`env.memory`, at most 256 MiB). Each host creates one memory per estimator and,
  after a trap, zeroes it and instantiates the module into it again.
- PDF: object streams are decoded inside lopdf's load hook against a 64 MiB document budget; encrypted files are not
  loaded; page content and forms share a 32 MiB document budget; each form XObject is decompressed once; per-page
  budgets for interpreted bytes (16 MiB), form invocations and operations; whole-file limit 64 MB. Over a budget, the
  profile reports the page count it can and `budgetExhausted`.
- Media: all offset arithmetic in `u64` with checked operations. A faststart MP4 whose `moov` is larger than the head
  slice still yields `mvhd` from the head.

## Progress and cancellation

`estimateFiles` wraps the ABI calls in a bounded, observable run.

- **Truthful progress.** Only reading is measurable, so only reading reports bytes (`read-progress`, per 1 MiB of the
  read plan). A profile call is one synchronous call: its events give the stage and the time taken, never a percentage.
- **Bounds.** One estimator (one 256 MiB memory) per thread. Batches run in order; inside a batch, `concurrency` files
  read at once while the previous one is profiled; bytes read but not yet profiled stay under `maxBufferedBytes`.
- **Fail per file, never per batch.** Unreadable files, refusals and traps leave that file without a profile, with a
  reason; it is still sent by name, type and size.
- **Cancellation.** The signal is checked before each file and between reads; the result is `partial`. The Web Worker
  client gives an aborted worker a grace period, then terminates it and rebuilds the result from the events received.

## Guardrails

- `packages/estimate/package.json` stays `"private": true` until the release PR that adds it to `releasePackages`, the
  app package catalog and PyPI trusted publishing. Its script is `build:wasm`, not `build`, so a recursive core build
  never needs Rust.
- CI: an `estimate` job running `cargo test`, the WASM build with a size budget, the JS tests and the Python tests.
- An import guard keeps `server/`, `worker/`, `shared` and the SDK from depending on `@docslurp/estimate`: profiling
  never runs on DocSlurp infrastructure.
