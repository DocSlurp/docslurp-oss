# Custom Heron training pilot

This is an opt-in experiment, not a trained release or an accuracy claim. It uses
Heron's pretrained document features and replaces its class head with the 14
public document-region classes needed by the runtime. The checkpoint identifies
itself as `docslurp/heron-custom`; its revision is a digest of its safetensors,
configuration and processor, not the original model revision.

The upstream [Heron model card](https://huggingface.co/docling-project/docling-layout-heron/blob/main/README.md)
licenses the weights under Apache-2.0 and documents the RT-DETRv2 architecture.
The pilot pins `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8`. TorchVision SSDlite
was considered for its small architecture, but is not implemented in this arm:
the existing pretrained document features are a better starting point for a
short training budget. No weights download happens inside this script.

## Frozen pilot recipe

- Five epochs, at most 500 optimizer steps, 1,200 seconds including setup and
  optional development selection. Stop at whichever bound is reached first.
- Four images per batch, seed 731, fp32, AdamW with learning rate 0.0001 and
  weight decay 0.0001; gradient norm clipped to 10.
- Backbone and encoder parameters and running statistics frozen throughout;
  decoder and new classifier parameters train. No adaptive unfreezing schedule.
- Use the pinned native image processor and dimensions; no training-only crop
  recognition or filename-based feature enters the model.
- Optional explicit development checkpoint selection: macro F1 over
  truth-present classes at IoU 0.50, confidence threshold 0.30. Otherwise save
  the last checkpoint without reading development data.

The trainer requires a pre-separated **train-only JSONL** manifest. It rejects
mixed splits and has no holdout argument. A separate development manifest must
contain only development rows and share no source ID, document ID, template
instance or image hash with training. Image bytes are hash checked against the
manifest, dimensions checked, and target boxes must be finite and inside the
image. The corpus steward prepares these manifests; the training process does
not open the full mixed manifest or any holdout image/reference.

The model sees pixels and ordinary COCO-format class/box supervision only.
Source identifiers are used for isolation checks, not model inputs. Training
labels and evaluation answers are distinct uses; holdout answers must never be
used to train, choose thresholds or select checkpoints.

## Coordinated smoke and pilot

Run only after the coordinator releases the shared CPU/GPU timing window. Use
the existing PyTorch/Transformers runtime with Pillow, SciPy and safetensors,
and a populated `HF_HOME` cache for the pinned base checkpoint. Install
`scripts/layout-eval/requirements-training.txt` in that inference environment;
it pins Transformers 4.57.6 and bounds SciPy to 1.17.x. RT-DETR training needs
SciPy for Hungarian assignment even when ordinary inference already works. First run a
one-step smoke with the same training-only input and a fresh output directory:

```sh
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 python scripts/layout-eval/train_layout.py \
  --manifest /data/train.jsonl --root /data/corpus --output /results/heron-smoke \
  --device cuda --epochs 1 --max-steps 1 --max-seconds 120
```

Then use the frozen recipe, with development access only when explicitly chosen:

```sh
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 python scripts/layout-eval/train_layout.py \
  --manifest /data/train.jsonl --root /data/corpus --output /results/heron-pilot \
  --device cuda --dev-manifest /data/dev.jsonl
```

The time budget is checked between model steps and development pages; an active
step and final checkpoint write can exceed the stop boundary. An outer process
timeout should allow checkpoint flush and enforce the coordinated hard stop.
The script cannot install dependencies or start a remote host. Failed attempts
retain their own receipt and loss trace; output directories cannot be reused.

Each attempt writes `receipt.json`, per-step `losses.jsonl`, and a `last/`
safetensors checkpoint. Explicit development selection also writes its score
trace and `best-dev/`. Receipts record exact manifest hashes, base revision,
source-code hashes, package versions, loading mismatches, trainable parameters,
optimizer, bounds, elapsed time, peak process RSS and CUDA allocation. Checkpoint
configuration retains that provenance. The final checkpoint can be loaded by
`CustomLayoutDetector` for CPU fp32 or CUDA fp32/fp16 measurements; compare both
latency and quality against the unchanged base model before considering use.

Synthetic templates and photographic assets are reused across source-instance
splits. Even a strong result on this corpus would not demonstrate unseen-template
or real-document generalization. No pixel masks or reading order are trained.
Holdout scoring must wait until the recipe and selected checkpoint are frozen,
and the separate integrity gate must pass again after code changes.
