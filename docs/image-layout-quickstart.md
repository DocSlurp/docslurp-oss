# Image layout quickstart

The replacement campaign completed on 32 varied pages plus a separate 12-page
ordinary-document corpus. Frozen held-out confirmation did not meet the declared
general-readiness thresholds. The [measured findings](image-layout-confirmation-2026-10-20.md)
separate CPU pool throughput, model quality, service latency and remaining gaps.
These are experimental mechanisms; the rejected first corpus remains engineering
history only.

The explicit CLI, resident local service and worker adapter are usable mechanisms
for running a cached detector on a single raster image. They return labeled boxes,
confidence, source dimensions and optional polygons/order/fingerprints. They are
not registered in the normal ingestion pipeline, deployed by default, or exposed
through a public API. Quality depends on the selected model and document class;
a working runtime or advertised class list is not an accuracy guarantee.

PDF callers render each page first and retain the raster-to-PDF transform. Scans
and photographs can be passed directly as a supported raster. Output coordinates
are normalized to original stored pixels, before EXIF display rotation. This is
region detection, not pixel segmentation, OCR or table-cell extraction.

## Install a separate runtime

Run from an OSS source checkout. Use Python 3.11 or newer and durable model/cache
storage. The following pins a Torch/TorchVision pair supported by the
[official PyTorch installation archive](https://pytorch.org/get-started/previous-versions/).
It is an installation recipe, not a claim that every driver/OS combination was
benchmarked. CPU and GPU runtimes should be isolated; retain `pip freeze` and the
actual driver/provider versions beside measurement artifacts.

```sh
export TMPDIR=/home/dan/tmp/agents TMP=/home/dan/tmp/agents TEMP=/home/dan/tmp/agents
export LAYOUT_RUNTIME="$HOME/.cache/docslurp/layout-runtime"
export HF_HOME="$HOME/.cache/docslurp/layout-models"
python3.11 -m venv "$LAYOUT_RUNTIME"
"$LAYOUT_RUNTIME/bin/python" -m pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cpu
"$LAYOUT_RUNTIME/bin/python" -m pip install -r scripts/layout-eval/requirements-training.txt
"$LAYOUT_RUNTIME/bin/python" -m pip freeze > "$LAYOUT_RUNTIME/requirements-frozen.txt"
```

For an NVIDIA runtime, use a different virtualenv and replace the Torch install
index with the official wheel matching the host (for example `cu128` for the
listed CUDA 12.8 wheels). Check `torch.cuda.is_available()` before requesting
`--device cuda`. Selecting CUDA neither provisions a GPU nor fixes a driver.
The ordinary inference requirements omit SciPy; the training requirements add it
because RT-DETR's training loss requires Hungarian assignment. PPv3 needs its
separate `requirements-ppv3.txt` environment and Transformers 5.20.2; do not
replace the pinned Heron training runtime in place.

Download the pinned Apache-2.0 [Heron model](https://huggingface.co/docling-project/docling-layout-heron)
explicitly during setup, then switch runtime calls offline:

```sh
"$LAYOUT_RUNTIME/bin/python" - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download('docling-project/docling-layout-heron',
    revision='8f39ad3c0b4c58e9c2d2c84a38465abf757272d8',
    allow_patterns=['*.json', '*.safetensors', 'README.md', 'LICENSE*'])
PY
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
```

No invocation silently downloads missing models. Keep the full revision and file
hashes in the runtime manifest. Custom checkpoints use their own content digest
and identity `docslurp/heron-custom`, never the upstream revision. The
[training pilot](heron-custom-training-pilot.md) documents train/dev isolation,
recipe, loss traces and retained failures; its outputs need independent quality
evaluation before promotion.

## Cold CLI and warm service

```sh
"$LAYOUT_RUNTIME/bin/python" scripts/layout-eval/infer.py \
  --model heron --device cpu \
  --revision 8f39ad3c0b4c58e9c2d2c84a38465abf757272d8 \
  --image /absolute/page.png --output /absolute/layout.json

"$LAYOUT_RUNTIME/bin/python" scripts/layout-eval/server.py \
  --model heron --device cpu \
  --revision 8f39ad3c0b4c58e9c2d2c84a38465abf757272d8 --port 8769
```

With the service running, another terminal can inspect readiness and submit raw
bytes:

```sh
curl --fail http://127.0.0.1:8769/health
curl --fail -H 'Content-Type: application/octet-stream' \
  --data-binary @/absolute/page.png http://127.0.0.1:8769/layout \
  --output /absolute/layout.json
```

Use `--device cuda` explicitly with the GPU runtime; `--precision fp16` is an
additional measured option for Transformers GPU inference. The CLI loads a model
on every call. The service loads once, accepts one request at a time and reports
model load separately from warm work. Neither is a daemon managed by this repo.
Clients use a literal loopback Host; browser Origin requests and other hosts are
rejected. The service is for trusted local programs, not an authenticated public
endpoint. A client timeout does not cancel inference already running in Python.

Both paths cap image bytes at 25 MiB, decoded pixels at 100 million, and JSON
output at 10 MiB. A request represents one image frame/page. JSON contains model
identity/revision, `device`, `image`, `coordinateSpace`, `supportedLabels`,
`regions` and diagnostics. Invalid model output geometry fails clearly before
crop fingerprints are computed.

## Worker integration

Use the resident transport for repeated calls in a worker process that shares
the service's loopback namespace:

```ts
import { readFile } from "node:fs/promises";
import { detectImageLayoutAtEndpoint } from "./layout/image-layout.js";

const result = await detectImageLayoutAtEndpoint(await readFile("/absolute/page.png"), {
  endpoint: "http://127.0.0.1:8769/layout",
  expectedModelId: "docling-project/docling-layout-heron",
  expectedRevision: "8f39ad3c0b4c58e9c2d2c84a38465abf757272d8",
  device: "cpu",
  timeoutMs: 120_000,
});
```

The adapter verifies model/device, source dimensions and SHA-256 of the request
bytes. `expectedArtifactSha256` additionally pins an ONNX/custom artifact when
provided. The [worker boundary README](../worker/src/layout/README.md) shows the
CLI fallback through `CommandRunner`, sandbox paths and cost-accounting
responsibilities. Standard worker Dockerfiles do not package these root-level
Python scripts or weights: deployment needs an explicitly built runtime image
or separately managed service. No pipeline feature flag currently calls this
boundary automatically.

## Geometry options and exported graphs

Orientation and rectification are **off by default**. Add only measured options:
`--orientation-onnx-path /absolute/orientation.onnx` with its revision and minimum
score; `--rectify-page --rectify-max-edge 768`; or `--model-size 640` for a
Transformers detector. Orientation requires ONNX Runtime/OpenCV dependencies;
rectification requires OpenCV. The orientation graph's digest and decision,
rectification decision and model tensor size remain in diagnostics. Wrappers
map boxes/polygons back to the source image. Crop fingerprints describe the
source-image bounding rectangle, including background inside a perspective
polygon; they are not hashes of the rectified crop or semantic identity.

For tiny-model ONNX inference, create a separate environment using
`requirements-onnx.txt`, then run `--model pp-small-onnx --onnx-path /absolute/model.onnx`.
Use `onnxruntime-gpu` instead of the CPU package only for an explicitly tested
CUDA provider. GPU graphs may execute some nodes on CPU; inspect recorded
providers and compare complete timings. Orientation itself currently uses CPU.

Export uses a separate Paddle environment with `requirements-export.txt`:

```sh
python scripts/layout-eval/export_pp_small.py \
  --model-dir /absolute/pinned-paddle-model --output /absolute/model.onnx \
  --revision '<full reviewed upstream commit>'
```

This command uses existing model files. `--download` is a separate explicit setup
option. Retain the generated provenance JSON, input-file hashes, export command
and ONNX digest; verify the model source revision independently. A successful
ONNX checker is structural validation, not numerical parity: compare native and
exported boxes/confidence on independent images before replacing a runtime.
Quantized graphs likewise require separate quality/parity checks and no holdout
calibration. Pin the resulting graph hash in the worker caller.

Generic `figure` output does not distinguish photos, logos or mind maps. Optional
SigLIP crop classification can abstain and cannot recover missed regions. Custom
Heron class outputs remain experimental. Reading order is preserved only when a
model actually supplies it. Full/half-page coverage is a box-area heuristic, and
perceptual hashes can collide. These limits remain visible even when throughput
or synthetic-corpus scores improve.
