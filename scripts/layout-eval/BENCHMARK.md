# Image-only layout benchmark

This harness measures layout regions from raster bytes on CPU and CUDA. It does
not extract text, table cell contents, or semantic image categories that a model
was not trained to distinguish. Synthetic silver results measure controlled
coverage and regressions; they do not establish accuracy on real photographs.

The source schema and corpus generator are in `corpus.py`. `benchmark.py` accepts
both inline `manifest.jsonl` and `manifest.json` with separate reference files.
References are loaded only after image-only prediction finishes, outside timers.
`infer.py` is the cached-model-only CLI used by the opt-in worker adapter.

## Candidates and licensing

- [Docling Heron](https://huggingface.co/docling-project/docling-layout-heron):
  Apache-2.0 RT-DETRv2 checkpoint, around 43 million parameters. The model emits
  `picture`, so the adapter reports `figure` and explicitly does **not** claim it
  distinguishes photograph, logo, chart, mind map, or illustration.
- [PP-DocLayoutV3](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3_safetensors):
  Apache-2.0 checkpoint, Transformers CPU/CUDA adapter. Its image class also stays
  `figure`; an explicit chart prediction is retained as `chart`. Its native postprocessor returns segmentation polygons and logical reading-order
  ranks; both are retained and normalized to stored source pixels. PPv3 needs the
  separately pinned Transformers5.20.2 environment (`requirements-ppv3.txt`).
- [PP-DocLayout-S](https://huggingface.co/PaddlePaddle/PP-DocLayout-S): Apache-2.0,
  around 4.8 MB parameters, 23 source classes. Native PaddleOCR and local ONNX
  Runtime adapters let us test a materially smaller CPU mechanism.

The [official Paddle layout module documentation](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/module_usage/layout_analysis.html)
and [PP-DocLayout paper](https://arxiv.org/abs/2503.17213) describe the supported
models and inference engines. Published timings are hypotheses for this workload,
not measurements used to select our winner. No third-party GPL/AGPL inference
implementation is copied, and no remote model Python is trusted/executed.

## Environments

Use a task scratch directory under `/home/dan/tmp/agents`; set `TMPDIR`, `TMP`,
and `TEMP` before installation or execution. Keep environments/model caches under
`~/.cache` and evidence in the project's durable evaluation storage.

For Transformers, install the host-appropriate official Torch wheel and then
`requirements.txt`. For CPU tiny-model evaluation, use a separate environment
with `requirements-paddle.txt`; mixing Paddle/Torch CUDA distributions is avoidable.
ONNX inference needs only `requirements-onnx.txt` and an exported graph. Never
install `onnxruntime` and `onnxruntime-gpu` together in one environment. Store an
exact `pip freeze` and `nvidia-smi` snapshot alongside every measured campaign.

Official tiny-model export (install `requirements-export.txt`):

```bash
python scripts/layout-eval/export_pp_small.py \
  --model-dir "$HOME/.cache/docslurp/models/pp-small" \
  --output "$HOME/.cache/docslurp/models/pp-small.onnx" --download
```

The exporter records the resolved upstream revision, upstream file digests,
command, graph digest and export time. INT8 calibration defaults to train-only
image pixels (no references and no holdout; explicit `--split dev` is available):

```bash
python scripts/layout-eval/quantize_small.py \
  --model "$HOME/.cache/docslurp/models/pp-small.onnx" \
  --manifest /path/to/corpus/manifest.jsonl --limit 32 \
  --output "$HOME/.cache/docslurp/models/pp-small-int8.onnx"
```

INT8 has to beat the FP32 baseline under the same CPU thread count and preserve
box quality; smaller model bytes alone do not prove faster execution. CUDA ONNX
records potential CPU-node fallback and is not labeled a fully GPU execution.

## Experiment sequence

1. Run original-payload baselines for Heron and PPV3 CUDA FP32/FP16, and tiny CPU.
   Warm up three batches; start batch size 1; confirm successful source dimensions,
   model tensor shape, output boxes, and unsupported-class reporting.
2. Coarse screen 24 fixed dev pages, one repeat, all eight provided payload variants.
   Independently sweep model input sizes and runtime threads/batch sizes, because
   reducing a transfer image does not change a detector's default internal size.
3. Confirm promising configurations on a larger dev sample with paired repeats.
   Inspect raw boxes/overlays and per-family errors, including poor/failed inputs.
4. Freeze configurations, then run heldout families once with `--allow-holdout`.
   Avoid selecting a new winner on holdout; new tuning requires a new holdout.

Example CPU baseline/screen:

```bash
python scripts/layout-eval/benchmark.py --model pp-small --device cpu \
  --manifest /path/to/corpus/benchmark-slice.jsonl --split dev --limit 24 \
  --threads 4 --warmup 3 --repeats 1 --hourly-usd 0.38736 \
  --variants scripts/layout-eval/variants-screen.json \
  --output /path/to/results/tiny-cpu-screen.jsonl
```

For ONNX replace `--model pp-small` with `--model pp-small-onnx --onnx-path ...`.
For GPU replace with `--model heron --device cuda --precision fp16`. Compare
`--model-size 480`, `640`, and the default separately; some architectures only
support specific sizes. `--processor slow|fast` selects the Transformers implementation explicitly and records its real class. Explicit failures remain evidence instead of silently
falling back. Set hourly price to the actual allocated host rate, including the
GPU for a CPU run performed on that rented GPU host. A CPU-only host cost estimate
needs its own verified rate and must be identified as an estimate.

## Evidence and interpretation

Each fresh output gets raw page JSONL, metadata JSON and summary JSON. Existing
JSONL files are never overwritten. CUDA timers explicitly synchronize. Batch
preprocess/inference/postprocess are amortized per page; raw batch count is saved.
The native Paddle adapter reports its fused pipeline rather than invented stage
measurements. Failures count against recall, delivered throughput, and cost.

E2E includes local read, source decode, producer resizing/encoding, payload decode,
and detector work. It excludes network transfer: payload byte counts are real,
network latency is not simulated. Unmodified original bytes are decoded once with zero producer transformation cost;
derived payloads expose producer decode/resize/encode separately from the consumer
decode and model pipeline (`consumer_path_ms`).
Compute cost excludes idle setup, storage/network and provider billing minima;
`measured_wall_compute_usd` includes loop/scoring wall time. Host-wide billing must
be reconciled separately by the remote runner. RSS is process high-water memory,
not instantaneous utilization; Torch CUDA peak allocation excludes driver memory.

Scoring uses normalized source-image boxes and deterministic one-to-one global
IoU-greedy class-aware matching at .50 and .75. It reports per-class P/R/F1,
all-class and explicitly supported-only micro scores, truth-present class macro F1, class-agnostic localization,
matched mean IoU/boundary error, and reading-order pair accuracy when a detector
actually supplies order. These are fixed-confidence metrics, **not COCO mAP**.
Ancillary labels and coarse `figure` outputs are preserved. Unsupported photo/logo
classification remains visible as misses in full-class results.

An optional right-angle correction arm uses the official Apache-2.0
[PP-LCNet orientation ONNX model](https://huggingface.co/PaddlePaddle/PP-LCNet_x1_0_doc_ori_onnx).
Pass `--orientation-onnx-path ... --orientation-revision <pinned revision>` to
benchmark.py. It performs CPU short-edge256/center224 classification, applies the
predicted counterclockwise correction only above the declared minimum model score,
and maps every detected box back to the original stored raster coordinates.
Classification/rotation/inverse-mapping timings are separate. It does not correct
small skew, perspective, page curvature, or camera occlusion. Inspect per-capture
scores; improving rotated pages can still worsen clean pages or add too much cost.

`infer.py` also reports DHash-64 and exact RGB crop SHA256 fingerprints. DHash is
a similarity hint, not semantic recognition or identity. Full/half-page visual
coverage labels are geometric bbox-area heuristics (>=90%, >=40%), apply only to
visual classes, and are explicitly labeled as heuristics.

Run the fast tests without models or network:

```bash
python -m unittest discover -s scripts/layout-eval -p 'test_*.py' -v
```

## Runtime compatibility findings

The first native PP-small readiness probe with Paddle3.3.1 and MKLDNN enabled
failed with `ConvertPirAttribute2RuntimeAttribute ... pir::ArrayAttribute<pir::DoubleAttribute>`
in oneDNN. `--paddle-mkldnn` is therefore an explicit experimental option rather
than an assumed fast default. No silent runtime fallback hides this failure.

Native Paddle ndarray input expects BGR. The adapter converts the decoded PIL
RGB pixels to BGR before PaddleX performs its documented RGB conversion. For
ONNX the official tiny-model `interp: 2` is OpenCV CUBIC (not LINEAR), verified
against the installed predictor mapping. `check_small_parity.py` checks the
path/array predictions and native/ONNX predictions from image bytes without any
reference annotations. Keep failed parity evidence as well as corrected output.

## Predeclared CPU sweep

`cpu_campaign.py` runs serially in an existing CPU Paddle/ORT environment. It
creates a fresh evidence directory and writes its plan before any model work.
It calibrates INT8 on 32 train images, then compares native FP32, ORT FP32 and ORT
INT8 at 1/2/4/8 threads on the same development screen. Runtime eligibility requires
zero failures, macroF1 no more than 2 percentage points below the FP32 reference and
no family macro loss greater than 5 points. It chooses lowest measured consumer
mean, then measures orientation and 19 declared byte variants on that runtime.
This efficiency choice does not waive absolute quality gates or authorize promotion.
All subprocess commands, exit codes, logs, raw predictions and digests are saved;
a wall-time cap terminates the workload. It creates no hosts and performs no
model downloads. Existing evidence directories cannot be reused.

The CPU selector also requires class-agnostic localization F1 and recall to stay
within 2 percentage points of the original FP32 reference. This prevents a codec
from appearing better by deleting coarse visual boxes that strict photo/logo
labels cannot match. The original CPU campaign's additive safeguard was timestamped
before byte results were inspected; its independent review is retained separately.

The first per-channel U8S8 quantization recipe failed severely on this checkpoint.
A bounded continuation tested S8S8, reduced-range U8S8 and U8U8 on the same train
calibration pixels and development images, following the
[official ORT quantization guidance](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html).
All three remained slower and failed quality gates; signedness/range alone did not
repair this recipe. These results do not establish that every INT8 method fails.
Activation-level divergence should be diagnosed before recommending further
calibration, mixed-precision exclusions or QAT. Every failed graph and provenance
receipt remains evidence; none is eligible for promotion.

Optional `--rectify-page --rectify-max-edge 768` wraps the image-only light-paper
quadrilateral prepass and maps predictions back through the inverse homography.
It remains experimental and must be measured on both phone images and clean pages.
`--model heron-custom --model-path <checkpoint>` loads an explicit safetensors
checkpoint with the exact canonical taxonomy contract; it cannot fetch weights or
read reference manifests during prediction. Custom training and evaluation splits
must remain isolated under the training workflow's integrity checks.
