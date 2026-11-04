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
  shared, so the card carries them and the worker and the probe read the same numbers **[A]**.

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

Hostile-input budgets **[D]**:
- PDF: decompress each form XObject once (cache by object id); per-page budgets for decompressed bytes, form
  invocations and operations; whole-file probe limit 128 MB (peak memory is about 2× the file size). Above the
  limit, return the page count only if it is cheap, otherwise unknown.
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

## Packaging and guardrails **[A][M]**

- `packages/estimate/package.json` stays `"private": true` until the release PR that adds it to
  `releasePackages`, the app package catalog and PyPI trusted publishing. Its script is `build:wasm`, not
  `build`, so a recursive core build never needs Rust.
- CI: a `estimate` job running `cargo test` (golden replay, classifier tests on synthetic PDFs built inside the
  tests, the fuzz corpus), the WASM build with a size budget, a JS smoke test, and a JS-vs-TS differential test
  over random inputs. The job is not path-filtered away.
- An import guard keeps `server/`, `worker/` and `shared` from depending on `@docslurp/estimate`: probing never
  runs on DocSlurp infrastructure.
- The app uses the published npm package plus the card from its own server, so app builds never need Rust.

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
