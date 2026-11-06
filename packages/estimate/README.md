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

Aggregates only, never file content, never per-page arrays, at most 4 KiB (`fileProfileSchema` in
`@docslurp/shared`; profile schema 1):

| Field | What it is |
|---|---|
| `kind`, `format`, `mimeType?` | The detected format (`pdf`, `docx`, `mp4`, `png`, ...); `mimeType` only when the file's name and declared type say nothing |
| `bytes` | The size the profile was measured on (the server drops a profile whose size does not match the file) |
| `pages?` | Pages, slides or image frames (TIFF), when counted; text files are counted as the API counts them |
| `encrypted?` | An encrypted PDF: its page facts are not measured |
| `durationSeconds?` | Audio or video length from the container headers |
| `office?.embeddedImages` | Images embedded in a Word, PowerPoint, Excel or EPUB package |
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
- **Quotes.** `requestQuote({ files, apiKey, workspace?, speedBoost?, origin? })` posts to
  `POST /v1/uploads/estimate` (an API key with the `ingest` scope). The answer is labelled an estimate: a profile
  never changes what an upload is charged, which the worker measures as it processes the files.
- **Errors.** `EstimatorError.code` is `invalid_request`, `crashed`, `worker_failed` or `quote_failed`. After
  `crashed`, the estimator has already started a fresh module instance.
- **Memory.** An estimator uses one WebAssembly memory of at most 256 MiB for its lifetime; after a `crashed` error it
  reuses it. Run big batches through `@docslurp/estimate/worker`: a heavy PDF blocks an inline caller's event loop for
  a second or more, the worker's caller for a few milliseconds (`test/progress.test.mjs` measures both).

## Development

- `cargo test`: Rust unit and profile-fixture tests.
- `pnpm test:wasm`: build `dist/docslurp_estimate.wasm` (size budget) and run the JS tests, including progress,
  cancellation, bounds and the worker's event-loop delay against an inline run.
- `pnpm test:python`: the Python package on the same module.
- After changing a threshold or file-type list in `@docslurp/shared`, run
  `UPDATE_PROFILER_RULES=1 pnpm --filter @docslurp/shared test estimate-profiler-rules` to regenerate
  `profiler-rules.json`.
