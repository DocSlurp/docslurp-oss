# @docslurp/estimate

[Package docs](https://docslurp.io/docs/packages/estimate) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/estimate) · npm · not published yet

Offline DocSlurp credit estimates. Probe files on the user's machine (PDF pages and how many are scanned, audio and
video duration, Word and PowerPoint page counts, the real file type) and price an upload with the published price
card, exactly as `POST /v1/uploads/estimate` would. Nothing is uploaded.

One WebAssembly module with no imports serves every host: this npm package (browsers, Node, Deno, Cloudflare
Workers), Python through wasmtime (`python/`), and any other WebAssembly runtime through its JSON ABI
(`src/abi.rs`).

```js
import { createEstimator, fetchEstimateCard } from "@docslurp/estimate";

const estimator = await createEstimator();                       // bundled price card
// const estimator = await createEstimator({ card: await fetchEstimateCard() });
const quote = await estimator.quoteFiles(fileInput.files);       // browser File objects
console.log(quote.estimate.credits, quote.card.version, quote.warnings);
```

```js
// Node: read only the bytes each probe needs.
import { createEstimator } from "@docslurp/estimate";
import { quotePaths } from "@docslurp/estimate/node";

const quote = await quotePaths(await createEstimator(), ["contract.pdf", "call.mp3"]);
```

```js
// Cloudflare Workers: pass the compiled module.
import wasm from "@docslurp/estimate/docslurp_estimate.wasm";
const estimator = await createEstimator({ module: wasm });
```

### Progress, cancellation and Web Workers

`quoteFiles` and `probeBlob` stay the simple, non-streaming calls. For uploaders and big batches, `estimateFiles`
reports progress, stops on an `AbortSignal` and never fails the batch for one bad file:

```js
import { createEstimator, estimateFiles } from "@docslurp/estimate";

const controller = new AbortController();
const { quote, files, stats, partial, cancelled } = await estimateFiles(await createEstimator(), fileInput.files, {
  signal: controller.signal,      // stops between files and between 1 MiB reads
  concurrency: 2,                 // files read at once; probes run one at a time on the one wasm instance
  batchSize: 16,                  // a provisional quote follows each batch (batch-done)
  maxBufferedBytes: 128 << 20,    // bytes read but not yet probed
  onProgress: (event) => render(event),
});
```

- **Events**, in order per file: `file-start`, `read-progress` (bytes of the file's read plan), `probe-start`,
  `probe-done`, `file-done`; then `batch-done` per batch and `quote-done` last. Every event carries
  `files: { total, completed, probed, failed, skipped }`, `bytes: { read, planned, files }` and `elapsedMs`. The
  probe is one opaque call, so its events carry the stage and its time (`probeMs`), never a percentage. Files
  skipped by cancellation emit no events. `estimateEvents(estimator, files, options)` yields the same events as an
  async iterator that pauses the run when the consumer falls `highWaterMark` events behind.
- **Results.** `files[i]` is `{ status: "probed" | "failed" | "skipped", reason?, probe, quoteFile, measured,
  bytesRead, plannedBytes, readMs, probeMs, elapsedMs }`. A file that cannot be read or probed (including an
  estimator crash) is priced from name, type and size with a `reason`. After an abort the result is `partial` and
  `cancelled`, and `quote` covers the finished files plus size-only assumptions for the rest (`sizeOnlyFiles`).
- **Stats.** Files probed, failed and skipped; bytes read against the files' sizes (media is read as head and tail
  only); total, p50 and p95 probe time; files/s and MB/s; pages found; mix confidence; estimator crashes and
  resets; and the bounds the run kept (`peakInFlight`, `peakBufferedBytes`).
- **Web Worker.** `@docslurp/estimate/worker` runs the module and the reads on a dedicated worker;
  `@docslurp/estimate/client` posts `File` handles (no bytes are copied) and relays the events. An aborted worker
  returns its partial result; one that does not answer within `abortGraceMs` is terminated and the result is
  rebuilt from the events received, with `quote: null`.

  ```js
  import EstimateWorker from "@docslurp/estimate/worker?worker";   // Vite; or new Worker(new URL(...), { type: "module" })
  import { createEstimateWorker } from "@docslurp/estimate/client";

  const client = createEstimateWorker(new EstimateWorker());
  const result = await client.estimate(files, { signal, onProgress });
  ```
- **Node** `estimatePaths(estimator, paths, options)` and **Python** `Estimator.estimate_paths(paths,
  on_progress=..., cancel=threading.Event())` take the same options and report the same events and stats.

- **Workspace settings.** Pass the `profile` that `POST /v1/uploads/estimate` returns to quote with a workspace's
  quality and features; without one, a new hosted workspace with default settings is assumed.
- **Price card.** Quotes report the card they used (`card.version`, `card.revision`, `card.source`). Fetch the
  current one from `GET /v1/billing/estimate-card`. A card that needs newer pricing rules is refused with
  `unsupported_rules`, never quoted with stale logic.
- **Errors.** `EstimatorError.code` is `invalid_request`, `invalid_card`, `unsupported_rules` or `crashed`. After
  `crashed`, the estimator has already started a fresh module instance.
- **Memory.** An estimator uses one WebAssembly memory of at most 256 MiB for its lifetime; after a `crashed`
  error it reuses it. Large PDFs are parsed on the calling thread, so run big batches through
  `@docslurp/estimate/worker`: a heavy PDF blocks an inline caller's event loop for a second or more, the worker's
  caller for a few milliseconds (`test/progress.test.mjs` measures both).

## Development

The pricing rules are ports of `@docslurp/shared` (`quoteUpload`), held to them bit for bit by `golden/cases.json`.
After changing prices or rules there, run `UPDATE_ESTIMATE_CARD=1 pnpm --filter @docslurp/shared test estimate-card`
to regenerate `card.json` and the golden cases, then update the Rust port until `cargo test` passes. Bump
`ESTIMATE_RULES` (TypeScript) and `CARD_RULES` (Rust) together when a formula changes. See `DESIGN.md`.

Routing and evidence thresholds (`PAGE_RASTER_ROUTING`, `PAGE_TABLE_ROUTING`) are not priced and live in
`profiler-rules.json`: after changing them, run `UPDATE_PROFILER_RULES=1 pnpm --filter @docslurp/shared test estimate-profiler-rules`.
The probe routes with these rules (`src/rules.rs`, `estimator.rules()`); `cargo test` and `pnpm test:wasm` check that Rust and
the WASM module read the committed file exactly.

- `cargo test`: Rust unit, golden-parity and probe-fixture tests.
- `pnpm test:wasm`: build `dist/docslurp_estimate.wasm` (size budget) and run the JS tests, including progress,
  cancellation, bounds and the worker's event-loop delay against an inline run.
- `pnpm test:python`: the Python package on the same module.
