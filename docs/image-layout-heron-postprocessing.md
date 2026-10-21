# Heron repeated-box diagnosis

The adapter follows the pinned model’s recommended postprocessor. No adapter bug
was established, and no decoding change was made. The Heron configuration at
`8f39ad3c0b4c58e9c2d2c84a38465abf757272d8` specifies 300 queries and focal loss.
Its example invokes the standard processor with default focal behavior. Switching
`use_focal_loss=False` would change to softmax despite this training configuration;
it is not a supported correction. See the [pinned model configuration](https://huggingface.co/docling-project/docling-layout-heron/blob/8f39ad3c0b4c58e9c2d2c84a38465abf757272d8/config.json)
and [pinned usage example](https://huggingface.co/docling-project/docling-layout-heron/blob/8f39ad3c0b4c58e9c2d2c84a38465abf757272d8/README.md).

The [Transformers 4.57.6 processor](https://github.com/huggingface/transformers/blob/v4.57.6/src/transformers/models/rt_detr/image_processing_rt_detr.py#L1030)
computes sigmoid scores across query/class combinations, selects the highest 300
combinations, and gathers boxes using their query indices. Multiple labels may
therefore intentionally reuse one query’s box. The adapter calls this API directly.
The [original RT-DETRv2 postprocessor](https://github.com/lyuwenyu/RT-DETR/blob/main/rtdetrv2_pytorch/src/zoo/rtdetr/rtdetr_postprocessor.py)
also selects across the flattened query/class scores. One-label-per-query decoding
would be a new output policy, not restoration of the documented behavior.

Retained V2 CPU development predictions, repeat 0, all 24 images:

| Model | Predictions | Extra exact boxes | Extra canonical-label/box pairs | Extra raw-label/box pairs |
|---|---:|---:|---:|---:|
| Tiny ONNX | 625 | 36 | 4 | 0 |
| Heron | 1,347 | 322 | 39 | 0 |
| PP-DocLayoutV3 | 728 | 37 | 2 | 1 |

“Extra” is count minus distinct count within each page, summed over pages.
Heron’s 39 apparently same-label repetitions are entirely taxonomy aliases:
20 `section_header`/`title` combinations map to `title`, and 19
`document_index`/`table` combinations map to `table`. No Heron exact box repeats
with the same raw class. This distinction matters when diagnosing precision;
canonical duplication is not proof that the adapter appended a detection twice.

Saved regions lack original query IDs, and their normalized coordinates are clipped.
The source code explains a mechanism consistent with repeated cross-class boxes;
geometry alone cannot prove that any particular pair came from the same query.
Retain raw labels/confidences and predictions. A future generic deduplication or
single-label ablation requires an explicit ontology/output policy and paired
quality checks, including recall/localization guards. It must not overwrite these
baselines or become a data-specific rule.

Hash-bound counts and pinned official-source receipts:
`/home/dan/data/docslurp-evals/runs/layout-image-20261020/v2-postprocessing-diagnosis/diagnosis.json`.
This diagnosis used retained development outputs only; no inference, holdout reads,
annotation changes or production runtime changes were performed.
