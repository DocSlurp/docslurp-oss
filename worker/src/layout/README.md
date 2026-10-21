# Opt-in image layout boundary

For executable setup and model pinning instructions, see [image layout quickstart](../../../docs/image-layout-quickstart.md).

`detectImageLayout(bytes, options, runner, signal)` executes a separately installed detector CLI through the existing `CommandRunner`. Nothing registers this in the ingestion pipeline or changes a default. `detectImageLayoutAtEndpoint` connects to the resident service described below; `parseImageLayout` validates the shared response contract.

```ts
import { CommandRunner } from "../tools/runner.js";
import { detectImageLayout } from "./image-layout.js";

const result = await detectImageLayout(imageBytes, {
  python: "/absolute/layout-venv/bin/python",
  script: "/absolute/docslurp/scripts/layout-eval/infer.py",
  cacheDirectory: "/absolute/prepopulated/huggingface",
  model: "heron", // also heron-custom, ppv3, pp-small, pp-small-onnx
  device: "cpu", // explicitly cuda for a GPU-capable runtime
  timeoutMs: 120_000,
}, new CommandRunner(), signal);
```

`pp-small` requires `modelPath` pointing to its local Paddle model directory. `pp-small-onnx` requires `onnxPath` pointing to the exported graph. These paths are passed explicitly to the CLI and exposed read-only.

Install the detector dependencies and download approved weights separately before invocation. The adapter exposes the cache and CLI directory read-only, sets offline model loading, and fails when the runtime/cache is missing. Model load/CUDA errors propagate from the CLI; requesting CUDA never authorizes CPU fallback. A provider must expose the required GPU devices and installed runtime; selecting `cuda` does not create hardware access or remote capacity. The host-path setup shown above is for a local provider. Remote sandbox images require matching runtime/cache paths and explicit deployment configuration.

Input is exactly one raster image. Render PDF pages upstream and preserve their page-to-raster transform separately. Images are not auto-rotated: dimensions and normalized xyxy boxes refer to stored pixels, before EXIF orientation. Multiply x coordinates by `image.width`, y coordinates by `image.height` to recover pixel coordinates. Any consumer displaying an EXIF-rotated image must apply that same rotation to boxes. For PDFs, compose with the upstream raster-to-page transform. Bounds must be finite, in [0,1], and have positive area; malformed output is rejected rather than clipped.

Labels are advertised in `supportedLabels`. A generic `figure` does not claim a distinction among `photo`, `logo`, `chart`, `mind_map` or `illustration`; unknown raw classes remain `unknown` with `rawLabel` preserved. No returned region is a pixel mask or recognized text. Image SHA-256 fingerprints exact source bytes, not semantic content or template identity. Optional `imageCoverage` and `coverageKind` describe bounding-box area on the page, not semantic completeness. Optional `fingerprint` is a 64-bit difference hash of the image crop for visual similarity; collisions and sensitivity to changes are possible, so it does not establish identity. `exactCropSha256`, when supplied, identifies the detector’s exact crop representation. The contract does not fabricate orientation, reading order, or completeness scores.

The adapter stages bytes in a private `docslurp-*` directory under the configured OS temp root and cleans it on success and failure. CommandRunner enforces process timeout/output limits and existing usage recording. The JSON artifact is limited to 10 MiB before reading. Image dimensions are checked against the input and the decoder has a 100-million-pixel limit. CPU/GPU inference cost remains subject to the caller's normal worker accounting context.

Run the boundary tests with `vitest run src/layout/image-layout.test.ts` from `worker/`. These tests validate the transport, taxonomy, provenance, cleanup and device enforcement without downloading models. They do not establish detector quality or GPU runtime readiness; the separate layout evaluation harness measures those.

## Resident transport

The CLI fallback starts Python and loads the detector for every invocation. Warm benchmark timings do not describe that cold path. For sustained traffic, explicitly start the resident loopback service with the approved local cache and model paths:

```sh
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HOME=/absolute/cache \
  /absolute/venv/bin/python scripts/layout-eval/server.py \
  --model heron --device cpu --port 8769
```

`GET http://127.0.0.1:8769/health` reports the exact model revision and one-time load duration. Call `detectImageLayoutAtEndpoint(bytes, { endpoint: "http://127.0.0.1:8769/layout", expectedModelId: "docling-project/docling-layout-heron", expectedRevision: "<verified-cache-revision>", device: "cpu" }, signal)` to send original image bytes without base64. The adapter rejects redirects, external hosts, model/device mismatches and a mismatched source hash. It caps input at 25 MiB and streams at most 10 MiB of output before parsing.

The service keeps one model resident and serializes requests. It is a local opt-in utility, not a deployed API or an automatically managed daemon. Use a GPU-capable environment and `--device cuda` explicitly for GPU execution. Process startup/model load, resident idle time and network/client overhead must be counted separately from warm inference. A timed-out client does not interrupt already-started Python inference. The caller must attribute the resident service's compute costs to its normal usage scope; this transport does not pretend an HTTP request has token usage or use the subprocess runner's accounting.

Add `--visual-classifier siglip2` only when the official SigLIP2 cache/dependencies are installed. The optional stage classifies generic detector `figure` crops into photo/chart/logo/illustration/mind-map or abstains to figure; native chart labels remain untouched. It preserves original `detectorLabel`, `rawLabel` and detector confidence and emits a separate `classification` with uncalibrated cosine score/margin, model and prompt version. Its fixed prompts and abstention threshold require measured evaluation; class availability is not a quality guarantee. It cannot recover regions the detector missed. Official model/license source: [Google SigLIP2 model card](https://huggingface.co/google/siglip2-base-patch16-224), Apache-2.0, checked 2026-10-20.

Runtime packaging is explicit: the standard worker Dockerfiles currently copy `worker/scripts`, not this separate `scripts/layout-eval` directory or its ML dependencies/weights. A source checkout can run the examples after installing the relevant requirements and verified weights; a deployed container needs an explicitly built image or separate loopback service containing these files. This change does not make that deployment or add a public route. For ONNX graph identity, set `expectedArtifactSha256` in endpoint options; `model.artifactSha256` carries the graph digest when available. An `unknown` revision alone does not pin an optimized graph.

Optional geometry configuration is shared by the cold CLI and resident service:
`modelSize` sets a Transformers input square (32..2048, multiples of 32),
`orientationOnnxPath` selects a cached orientation graph with optional
`orientationRevision`/`orientationMinimumScore`, and `rectifyPage` enables the
light-paper quadrilateral heuristic with `rectifyMaxEdge` (128..4096 probe pixels).
All remain off by default. Orientation/rectification wrappers inverse-map boxes
and available polygons into stored source pixels; they do not change the returned
source dimensions. `diagnostics.detectorMetadata` retains wrapper configuration
and graph provenance, while `diagnostics.imageTransforms` records actual page
corrections or abstentions. Native `readingOrder` is optional and is never inferred
from box array position. CLI diagnostics include `modelLoadMs` and `cold-cli`;
resident diagnostics distinguish `warm-resident` execution.

The opt-in `heron-custom` model requires an explicit local safetensors checkpoint
directory. Its model identity and revision differ from the upstream Heron model;
configure endpoint expectations using the checkpoint's actual artifact digest.
Training and checkpoint selection remain separate tooling and do not run in the
worker. See `docs/heron-custom-training-pilot.md` for the frozen pilot recipe.
