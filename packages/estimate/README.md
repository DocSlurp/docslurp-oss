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

- **Project settings.** Pass the `profile` that `POST /v1/uploads/estimate` returns to quote with a project's
  quality and features; without one, a new hosted project with default settings is assumed.
- **Price card.** Quotes report the card they used (`card.version`, `card.revision`, `card.source`). Fetch the
  current one from `GET /v1/billing/estimate-card`. A card that needs newer pricing rules is refused with
  `unsupported_rules`, never quoted with stale logic.
- **Errors.** `EstimatorError.code` is `invalid_request`, `invalid_card`, `unsupported_rules` or `crashed`. After
  `crashed`, the estimator has already started a fresh module instance.
- **Memory.** An estimator uses one WebAssembly memory of at most 256 MiB for its lifetime; after a `crashed`
  error it reuses it. Large PDFs are parsed on the calling thread, so run the estimator in a Web Worker or worker
  thread for big batches.

## Development

The pricing rules are ports of `@docslurp/shared` (`quoteUpload`), held to them bit for bit by `golden/cases.json`.
After changing prices or rules there, run `UPDATE_ESTIMATE_CARD=1 pnpm --filter @docslurp/shared test estimate-card`
to regenerate `card.json` and the golden cases, then update the Rust port until `cargo test` passes. Bump
`ESTIMATE_RULES` (TypeScript) and `CARD_RULES` (Rust) together when a formula changes. See `DESIGN.md`.

- `cargo test`: Rust unit, golden-parity and probe-fixture tests.
- `pnpm test:wasm`: build `dist/docslurp_estimate.wasm` (size budget) and run the JS tests.
- `pnpm test:python`: the Python package on the same module.
