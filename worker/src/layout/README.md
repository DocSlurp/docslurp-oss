# Opt-in image layout boundary

`detectImageLayout(bytes, options, runner, signal)` executes a separately installed detector CLI through the existing `CommandRunner`. Nothing registers this in the ingestion pipeline or changes a default. `parseImageLayout` also validates results from a future service transport.

```ts
import { CommandRunner } from "../tools/runner.js";
import { detectImageLayout } from "./image-layout.js";

const result = await detectImageLayout(imageBytes, {
  python: "/absolute/layout-venv/bin/python",
  script: "/absolute/docslurp/scripts/layout-eval/infer.py",
  cacheDirectory: "/absolute/prepopulated/huggingface",
  model: "heron", // also ppv3, pp-small, pp-small-onnx
  device: "cpu", // explicitly cuda for a GPU-capable runtime
  timeoutMs: 120_000,
}, new CommandRunner(), signal);
```

`pp-small` requires `modelPath` pointing to its local Paddle model directory. `pp-small-onnx` requires `onnxPath` pointing to the exported graph. These paths are passed explicitly to the CLI and exposed read-only.

Install the detector dependencies and download approved weights separately before invocation. The adapter exposes the cache and CLI directory read-only, sets offline model loading, and fails when the runtime/cache is missing. Model load/CUDA errors propagate from the CLI; requesting CUDA never authorizes CPU fallback. A provider must expose the required GPU devices and installed runtime; selecting `cuda` does not create hardware access or remote capacity. The host-path setup shown above is for a local provider. Remote sandbox images require matching runtime/cache paths and explicit deployment configuration.

Input is exactly one raster image. Render PDF pages upstream and preserve their page-to-raster transform separately. Images are not auto-rotated: dimensions and normalized xyxy boxes refer to stored pixels, before EXIF orientation. Multiply x coordinates by `image.width`, y coordinates by `image.height` to recover pixel coordinates. Any consumer displaying an EXIF-rotated image must apply that same rotation to boxes. For PDFs, compose with the upstream raster-to-page transform. Bounds must be finite, in [0,1], and have positive area; malformed output is rejected rather than clipped.

Labels are advertised in `supportedLabels`. A generic `figure` does not claim a distinction among `photo`, `logo`, `chart`, `mind_map` or `illustration`; unknown raw classes remain `unknown` with `rawLabel` preserved. No returned region is a pixel mask or recognized text. Image SHA-256 fingerprints exact source bytes, not semantic content or template identity. The contract intentionally does not fabricate orientation, reading order, crop hashes, or completeness scores.

The adapter stages bytes in a private `docslurp-*` directory under the configured OS temp root and cleans it on success and failure. CommandRunner enforces process timeout/output limits and existing usage recording. The JSON artifact is limited to 10 MiB before reading. Image dimensions are checked against the input and the decoder has a 100-million-pixel limit. CPU/GPU inference cost remains subject to the caller's normal worker accounting context.

Run the boundary tests with `vitest run src/layout/image-layout.test.ts` from `worker/`. These tests validate the transport, taxonomy, provenance, cleanup and device enforcement without downloading models. They do not establish detector quality or GPU runtime readiness; the separate layout evaluation harness measures those.
