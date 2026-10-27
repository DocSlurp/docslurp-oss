# CPU layout engineering findings — 2026-10-20

**Status: engineering evidence only.** The user rejected the first synthetic corpus
as insufficiently rich and realistic. These runs establish runtime behavior and
failure modes; they do not establish production quality, select a production
profile, or authorize holdout confirmation. New benchmark admissions are suspended
until the replacement corpus passes qualitative review.

The completed screen used 160 development images on the rented EPYC/RTX 3090
host, with CPU inference isolated from GPU work. The baseline is official
PP-DocLayout-S exported to FP32 ONNX, four CPU threads. Class labels remain literal:
`figure` does not silently become `photo`, `chart`, or `logo`.

| CPU arm | Consumer ms/page | Local end-to-end ms/page | Strict macro F1, IoU 0.50 | Peak RSS |
|---|---:|---:|---:|---:|
| Native Paddle FP32, 4 threads | 203.98 | 204.39 | 0.2351 | 1,028 MiB |
| ONNX Runtime FP32, 4 threads | 33.59 | 34.02 | 0.2351 | 178 MiB |
| ONNX FP32 + orientation | 35.26 | 35.68 | 0.3060 | 199 MiB |

The ONNX baseline delivered about 29.4 pages/second for this workload, roughly six
times the native runtime throughput. A controlled single-page native/ONNX check
matched all 11 regions (minimum box IoU 0.99999948); full-screen postprocessing
had small numerical differences, so equivalence is not claimed for every input.
The orientation result is exploratory and has no independent confirmation.

The byte screen separately measured source decode, payload production, consumer
decode, model execution, and combined local time. Its fresh original-input arm
averaged 100,896 bytes and 31.24 ms end to end. JPEG at maximum edge 960 and quality
60 averaged 45,555 bytes, a 54.8% reduction. Its consumer time fell to 27.32 ms,
but 23.92 ms of payload production raised combined time to 51.58 ms. It passed the
predeclared development nonregression guards: macro F1 drop at most 2 percentage
points, per-family macro drop at most 5 points, and class-agnostic localization F1
and recall drops at most 2 points. It is a possible transport tradeoff, **not a
measured end-to-end speed improvement**. Network time was not measured. More
aggressive resolutions and several color reductions failed quality guards.
AVIF encoding was unavailable; its recorded failures are runtime support failures.

All four static INT8 recipes tested were slower and suffered severe quality
collapse: initial U8S8, default S8S8 QDQ, reduced-range U8S8, and U8U8. Followups
used the same 32 training images for calibration and 160 development images for
scoring. Followup macro F1 ranged from 0.0024 to 0.0070 versus FP32 0.2351, with
93–100 ms consumer time. Signedness/range changes did not recover this graph.
This does not establish that INT8 is generally unsuitable. The recipes follow the
[official ONNX Runtime quantization guidance](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html);
activation divergence should be investigated before further quantization claims.

The original source-page bootstrap understates dependence. The corrected helper
joins shared procedural templates, continuation documents, and exact source-image
duplicates using metadata alone. The complete development split contains 64
authored source IDs but only 30 effective connected components. Earlier
source-only confidence intervals are superseded for interpretation; repeated
execution blocks do not create additional independent documents. No held-out
predictions were admitted for this report.

Durable evidence lives under
`/home/dan/data/docslurp-evals/runs/layout-image-20261020/`:

- `cpu-screen-v1/`: 15 jobs, raw predictions, timings, errors, source snapshots,
  immutable plan, guard amendment, runtime selection and reviewed byte frontier.
- `cpu-quant-followup-v1/`: three bounded followups, calibration provenance,
  graph hashes, failures and raw outputs.
- `tiny-setup/`: official model/export/configuration and parity receipts.
- `operating-point-dev/duplicate-aware-clusters.json`: metadata-only membership
  and exact template/document/image join receipts.

The first CPU driver consumed 566.20 seconds; quantization followups consumed
156.84 seconds. At the allocated host rate of $0.38736/hour, their combined
runtime corresponds to approximately $0.078. This excludes setup and idle time
and is not a CPU-only hosting price. CPU quality-model measurements for Heron,
PP-DocLayoutV3 and a custom model remain unmeasured in this CPU campaign.

`transport_benchmark.py` now provides reproducible raw-byte resident HTTP versus
fresh-process CLI measurements. It retains source hashes/dimensions, independently
checks crop fingerprints, records cold model load separately, keeps raw responses,
and runs owned HTTP and CLI phases separately. Its local contract tests passed;
no new remote measurements were started after the corpus rejection.
