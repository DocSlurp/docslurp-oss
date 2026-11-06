# Offline credit estimator — design (v2, after council review 2026-11-03)

Probe files on the customer's machine and quote an upload with the published price card, exactly as
`POST /v1/uploads/estimate` would. Targets: our uploader (A), customer apps, SDK, CLI and edge runtimes (B),
and SDKs in other languages, Python first (C).

Reviewed by a three-member council (Architect, Ruthless Minimalist, Detail Detective). Changes from v1 are
marked with the reviewer who found them: **[A]**, **[M]**, **[D]**.

## What moves the price

Only four inputs change credits **[M]**:

| Input | Profiles where it matters |
|---|---|
| Page count | all |
| Scanned-page share | `auto` only: scanned pages bill Rich, 50× Fast. In `good` every page is Rich; in `fast` every page is Fast |
| File is an image | `auto`, `good`: image files bill Rich (`worker/src/db/page-base-fee.ts`) |
| Media duration | all |

The `complex` page class changes only the time estimate. Probe effort goes where the money is.

## Source of truth

- TypeScript in `@docslurp/shared` stays canonical. Rust ports `quoteUpload` and the `estimateIngest` core it
  calls, and is held to them by golden cases compared for **exact bit equality** **[D]**.
- **Rules that need only name, type and size live in TypeScript**, so the server quote improves too, with no WASM
  needed **[M][A][D]**:
  - One media extension list taken from the worker's accepted formats (`worker/src/media/prepare.ts`: adds flac,
    ogg, opus, aac, mov, mkv, avi, …), exported from shared. The card and `uploadMediaKind` both read it; no
    hand-copied literal.
  - An image file (by MIME type or extension) counts as 1 scanned page unless `pages` is given (today a 4 MB photo
    is quoted as ~55 pages).
- The worker's routing thresholds the PDF probe mirrors (raster coverage, stamp and sparse word limits) move into
  shared, so the worker and the probe read the same numbers **[A]**. They now live in the neutral `profiler-rules.json`
  (`buildProfilerRules`: page raster and table routing, no prices), which the probe reads; the card keeps only its frozen,
  published copy of the first twelve thresholds and is not regenerated with new routing fields.

## The card

- Shape: `{ schema, rules, version, revision, … }` **[A]**.
  - `schema`: card JSON shape. `rules`: formula version, bumped whenever TypeScript pricing logic changes.
  - `version`: `PRICE_CARD_VERSION`. `revision`: a sha256 of the card's content, so a constants-only change is visible.
- Rust rejects a card whose `schema` or `rules` differs from its own. A newer card with the same rules is accepted.
- Served unauthenticated at `GET /v1/billing/estimate-card` with an ETag (the prices are already public on the
  pricing page). `POST /v1/uploads/estimate` also returns `cardRevision`.
- Every quote reports `card: { version, revision, source: "bundled" | "supplied" }` and `warnings`, e.g.
  `profile-card-mismatch` when `profile.cardVersion` differs from the card in use.

## Contracts fail closed **[A][D]**

- `EstimateProfile` and `QuoteFile` are validated: an unknown quality, an unknown document feature, a partial mix
  or an out-of-range field is an error, never a silent fallback to `auto` or to free (today these under-quote).
  This matches the server, which already returns 400 for them.
- The route imports shared `quoteFileSchema` / `estimateProfileSchema`; the SDK types gain `mix`,
  `mixConfidence` and `profile`. A JSON Schema generated from zod (`z.toJSONSchema`) feeds the npm `.d.ts` and
  the Python stubs (follow-up).
- The golden generator moves out of shared's exported index into a test-only module.

## One artifact, three hosts **[M]**

- A single `docslurp_estimate.wasm` with a plain JSON C ABI: `alloc`, `dealloc`, `probe`, `quote`, `card`. No
  wasm-bindgen, no PyO3 or maturin, no per-platform wheels. Built with `getrandom_backend="unsupported"`.
- Hosts: a JS wrapper (`@docslurp/estimate`: browser, Node, Deno, Workers via `WebAssembly.Module`), Python on
  `wasmtime` (pure-Python wheel), and Go on wazero (later, at no extra cost).
- Public API v1: `createEstimator({ card?, module? })` → `{ probe, quote, card }` **[A]**. `estimateIngest` is not
  exported in v1 **[M]**.
- **Traps are expected.** WASM aborts on panic and `catch_unwind` does nothing, so it is removed **[D][M]**. The
  wrappers catch a trap, discard the instance and re-create it. In browsers, probes run in a Web Worker with a
  timeout.

## Probes: bounded and closer to the worker

Hostile-input budgets **[D]**, tightened after the merge council (adversarial H1/M2):
- The module imports its memory (`env.memory`, at most 256 MiB). Each host creates one memory per estimator and,
  after a trap, zeroes it and instantiates the module into it again, so anything that escapes a budget (lopdf also
  decodes object streams lazily while resolving indirect `/Length` values, outside the load hook) costs one bounded,
  reused memory, never a fresh allocation per crash waiting for the garbage collector.
- PDF: object streams are decoded inside lopdf's load hook, with lopdf's own name parsing and filter chain, against a
  64 MiB document budget (lopdf only limits each stream; a raw-text preflight was bypassed by `#`-escaped names and
  nested filters in the council re-review). Encrypted files, whose load path skips the hook, are not loaded;
 page content and forms share a 32 MiB document budget; each form XObject is
  decompressed once; per-page budgets for interpreted bytes (16 MiB), form invocations and operations; whole-file
  probe limit 64 MB. Over a budget, the probe reports the page count it can and no mix.
- Media: all offset arithmetic in `u64` with checked operations (a WAV chunk size of `0xFFFFFFF9` wraps today).
  A faststart MP4 whose `moov` is larger than the head slice still yields `mvhd` from the head.

PDF classifier accuracy against the worker **[D]**:
- Coverage over the CropBox (inherited, clipped to the MediaBox), as the worker measures it.
- Words come from text runs, with gaps inserted on text-position moves, so a title drawn one character at a time
  counts as words, not 30 tokens.
- Remove the "vector-only page means scanned" rule: the worker treats such pages as blank, which bills Fast.
- Known unmodelled cases, which lower confidence: sparse form and table pages routed to vision, and dense scans
  billing 2+ Rich pages.

Probe output includes `mimeType`, which `apply()` copies into `QuoteFile.type`, so measured durations are used
even when the host knows no MIME type **[A][D]**.

Format scope v1 **[M]**: PDF (pages + mix), media (duration), docx and pptx (page and slide counts from
`docProps/app.xml`; `zip` with `deflate-flate2`, not zopfli). Images and text formats need no probe; the rules
above handle them.

## Billing rules added after the merge council (boundary H1/H2) — rules version 2

- A PDF page with no text layer and any image, however small, bills Rich in auto and good (`page-base-fee.ts` page
  facts), so the probe classifies it scanned.
- Text files (text MIME types, or text extensions with no specific type) bill `max(lines/60, chars/3500)` pages
  (`server/src/services/source-metadata.ts`, now `textPageCount` in shared). Quotes use `size/3500` without a probe;
  the probe reads text files whole (up to 32 MB) and counts exactly.
- Image and text detection trust a specific declared MIME type over the extension, as billing reads the stored type.

## Packaging and guardrails **[A][M]**

- `packages/estimate/package.json` stays `"private": true` until the release PR that adds it to
  `releasePackages`, the app package catalog and PyPI trusted publishing. Its script is `build:wasm`, not
  `build`, so a recursive core build never needs Rust.
- CI: a `estimate` job running `cargo test` (golden replay, classifier tests on synthetic PDFs built inside the
  tests, the fuzz corpus), the WASM build with a size budget, a JS smoke test, and a JS-vs-TS differential test
  over random inputs. The job is not path-filtered away.
- An import guard keeps `server/`, `worker/`, `shared` and the SDK (a server dependency) from depending on
  `@docslurp/estimate`: probing never runs on DocSlurp infrastructure. The app's browser bundle may import it;
  its server-side code must not (app review rule, not yet automated).
- The app uses the published npm package plus the card from its own server, so app builds never need Rust. Until
  the package is published, the app takes it from the workspace and loads the module by URL inside a Web Worker;
  a build without `dist/` serves no module, and the uploader falls back to the server's size-based quote.

## Progress and cancellation (2026-11-04)

`estimateFiles` wraps the four ABI calls in a bounded, observable run; the ABI is unchanged.

- **Truthful progress.** Only reading is measurable, so only reading reports bytes (`read-progress`, per 1 MiB of
  the read plan). A probe is one synchronous call that cannot report partial progress: its events give the stage
  and the time taken, never a percentage. Plans are computed up front, so the byte denominator is real from the
  first event.
- **Bounds.** One estimator (one 256 MiB memory) per thread. Batches run in order; inside a batch, `concurrency`
  files read at once while the previous one probes; bytes read but not yet probed stay under `maxBufferedBytes`
  (one larger file runs alone). Nothing is queued past the current batch, and the event iterator applies
  backpressure. The run yields to the event loop after each file.
- **Fail per file, never per batch.** Unreadable files, refusals and traps price that file from name, type and size
  with a reason; a trap also resets the instance (`health()` counts both). Only a request the module refuses
  outright (a profile for a newer card) rejects, and it does so before any read.
- **Cancellation.** The signal is checked before each file and between reads; a probe in progress finishes (its
  budgets bound it). The result is `partial`, quoting finished files plus size-only assumptions for the rest. The
  Web Worker client gives an aborted worker a grace period, then terminates it and rebuilds the result from the
  events it already received.

## Delivery order

1. Shared rule fixes (media list, image files, thresholds, card identity, fail-closed schemas) plus the server
   card endpoint and SDK types. These are useful on their own and need no WASM.
2. The crate per this design, the JSON ABI, the JS wrapper and the CI job (package private).
3. The Python `wasmtime` wrapper.
4. The release PR (npm + PyPI), then the app uploader probing in the browser and sending the results to the
   existing estimate call.

## Found along the way

- Worker bug **[D]**: `parsePdfImagesList` (`worker/src/lib/page-image-evidence.ts`) drops inline images
  because the `[inline]` object column shifts the fields. Scans built from inline images are then routed as
  blank and never read. Tracked separately.
