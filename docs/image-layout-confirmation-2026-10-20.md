# Image layout: confirmed runtime, limited extraction quality

The opt-in image-layout mechanism is usable for engineering integration: images produce source-coordinate labeled boxes through a cached local CLI or resident HTTP service, on CPU or GPU. **It is not validated as general, complete layout extraction.** Neither locked model profile passed the predeclared absolute quality requirements. It is not enabled as the default ingestion pipeline.

Use [the image-layout quickstart](image-layout-quickstart.md) for installation, model pins, CPU/GPU commands, the TypeScript boundary and explicit orientation/rectification options. The mechanism detects layout; it does not by itself provide OCR, faithful Markdown, table cell extraction or validated reading order. Generic `figure` output does not establish photo/chart/logo/illustration identity. Crop fingerprints identify image content or visual similarity, not semantic document identity.

## Locked confirmation

Across the rich and common corpora, the campaign contains 44 cases: 35 native authored pages, 8 derivatives and 1 manual historical page, grouped into 32 source clusters. The locked held-out comparison below covers 12 of those images in 11 clusters; it is not 44 independent confirmation documents.

Finalists were frozen at 2026-10-21T02:56:52Z, before launch at 02:58:30Z. No tuning followed these results. The rich set contains 8 held-out images in 7 source clusters; the common-document set contains 4 held-out images in 4 clusters. Three timing blocks repeat these same documents; they do not increase independent sample size. All 24 jobs and 144 image attempts completed without inference failures.

The CPU comparison is PP-DocLayout-S ONNX, 4 threads versus 1 thread, original bytes. The GPU comparison is PP-DocLayoutV3 FP32, batch 1 versus batch 4 plus the pinned orientation model, original bytes. All use confidence threshold 0.3. Fixed-threshold greedy class-aware IoU 0.5 scores are not COCO mAP. Unsupported labels count as misses; supported-only scores cannot replace the literal all-label score.

|Held-out set|Model|Literal macro F1|Localization F1 / recall|Macro 95% source-cluster interval|
|---|---|---:|---:|---:|
|Rich: 8 images / 7 clusters|Tiny CPU|.3542|.6260 / .6649|[.2854,.4967]|
|Rich: 8 images / 7 clusters|PPv3 GPU|.4416|.7193 / .7135|[.3466,.6376]|
|Common: 4 images / 4 clusters|Tiny CPU|.5826|.6968 / .8571|[.5440,.8800]|
|Common: 4 images / 4 clusters|PPv3 GPU|.5092|.5986 / .6984|[.4587,.7141]|

Reference and finalist quality counts are identical for each row. Their paired macro and micro F1 deltas are 0, with percentile bootstrap intervals [0, 0] on these observations. That establishes observed parity on these pages, not population equivalence. The intervals use 2,000 paired source-cluster draws, seed 417, with membership from the frozen split receipts. Sparse class support and development-based selection limit generalization.

The frozen general-readiness requirements were macro F1 ≥ .85 and strict recall ≥ .90 for **each** critical class: table, photo, chart and paragraph. Missing critical classes cannot pass. Both profiles fail:

|Set/model|Table recall|Photo recall|Chart recall|Paragraph recall|
|---|---:|---:|---:|---:|
|Rich/Tiny|.8000|.0000|1.0000|.4318|
|Rich/PPv3|1.0000|.0000|1.0000|.5227|
|Common/Tiny|1.0000|not represented|not represented|.7941|
|Common/PPv3|1.0000|not represented|not represented|.6176|

Rich critical support is only 5 table regions across 4 clusters, 2 photos across 2 clusters, 1 chart in 1 cluster, and 88 paragraphs across 7 clusters. Common support is 4 tables across 3 clusters and 34 paragraphs across 4 clusters. Counts here are unique source-image regions, not three-block totals. Perfect chart/table recall with this support is not a broad reliability claim. The common set cannot assess photo/chart behavior at all.

## Timing: distinguish single model, pool and transport

Held-out local mean E2E milliseconds, across the three blocks:

|Set|Tiny 4 threads → 1 thread|PPv3 batch 1 → batch 4 + orientation|
|---|---:|---:|
|Rich|52.5 → 78.3|77.0 → 72.6|
|Common|51.4 → 74.1|78.0 → 71.8|

One CPU thread is slower for a single worker; it was selected for a separate concurrent-worker profile. GPU batch timings are amortized per image and do not measure single-request queue latency. The held-out sample contains too few sources to establish a universal throughput ranking.

A **separate development pool** used 8 CPU workers with 1 thread each, repeating 16 clean development images for 1024 jobs per block. Three blocks delivered 93.45, 95.15 and 93.63 pages/s, with 1,024/1,024 successful jobs in each and serial prediction audits retained. This is aggregate local pool throughput, not held-out HTTP throughput, new independent documents, or full ingestion throughput. Simultaneous aggregate RSS was not available in these receipts; per-worker maxima must not be mislabeled as a measured simultaneous total.

A **separate transport experiment** compared cold CLI launches with a warm resident loopback HTTP service, four development inputs × two repeats per configuration. All 40 CLI/HTTP pairs across five configurations passed source identity, region parity and crop-fingerprint verification, with no failures. Mean caller E2E:

|Configuration|Cold CLI ms|Resident HTTP ms|
|---|---:|---:|
|Tiny CPU|735.1|84.3|
|PPv3 CPU|7815.3|1407.3|
|PPv3 CPU+orientation|7879.1|1499.3|
|PPv3 GPU|7428.8|96.1|
|PPv3 GPU+orientation|7561.6|108.2|

These warm-service gains come from reusing the loaded model; they do not improve extraction accuracy. This is local loopback timing, not internet or production load testing. Model load, service concurrency and pool throughput are different measurements.

## What the development research explains

- Semantic distinctions are unfinished. PPv3 often finds a photo or illustration box but returns generic figure. Captions frequently become paragraphs/footnotes; lists become paragraphs. Localization scores therefore exceed strict-label scores.
- Whole-form and whole-mind-map annotations deliberately target composite regions. Detected internal text becomes a literal false positive under that policy even when it corresponds to visible content. Keep those errors; a future component-level task would be a different evaluation. Form and mind-map development singletons have no held-out class coverage.
- Heron's repeated exact boxes were traced to official focal top-k query-by-class alternatives and canonical-label collisions, not established adapter duplication. Original scores were preserved; no post-holdout deduplication was applied.
- Rotation and blur produce genuine misses, especially for Tiny. PPv3 orientation improved development results, but the locked held-out comparison showed quality parity, not an additional gain.
- No tested byte transcode improved local producer-plus-consumer E2E. Some PPv3 palette/WebP variants substantially reduced payload while preserving aggregate point guards, but class-specific recall regressed. AVIF failed all 48 attempts per model because the encoder route was unavailable; 96 failures remain in evidence. Network/storage tradeoffs were not measured.
- Clean acquisition is not a completeness guarantee. On 16 native development images, Tiny achieved 17.33 warm serial local pages/s but only .7829 localization recall. High-confidence false positives existed, so confidence or box-area coverage alone is not a validated automatic-acceptance gate.

## Evidence and reproduction

The durable campaign root is `layout-image-20261020/` in the evaluation run store. Preserve these artifacts together:

- `final-evidence/results/confirmation/finalists-freeze.json`: timestamped model/configuration/dataset/runtime pins before launch.
- `final-evidence/results/confirmation/`: 24 raw prediction files, summaries, logs and matching references; originals remain unchanged.
- `final-analysis/analyze_locked.py`, `locked-spec.json`, `locked-confirmation.json`: reproducible analysis, exact input hashes, per-class counts, missing support, failure denominators, absolute and paired cluster intervals.
- `final-evidence/results/v2-cpu-confirm/` and `v2-transport/`: separate pool and transport evidence.
- `v2-baselines/diagnosis.md`, `clean-dev-diagnosis.md`, `v2-ablations/paired-cluster-report.md`, `v2-bytes/bytes-diagnosis.md`: development diagnosis and rejected configurations.

The analyzer verifies the frozen manifest/lock hashes, launch-after-freeze timestamps, threshold, CPU graph/thread configuration, GPU revision/batch/orientation configuration and paired references. Integrity, publication rights and annotation-confidence evidence remain separate from model quality. Agent visual review is not represented as human review; ordinal annotation confidence is not a correctness probability.

For current use, retain an explicit opt-in experimental layout stage, preserve unsupported labels and source coordinates, and keep quality review/escalation available. No general-ready label, default deployment or production acceptance heuristic follows from this campaign.

## Resource closure

The coordinator's retained infrastructure receipt records the owned host destroyed at 2026-10-20 21:03:39 America/Denver (2026-10-21 03:03:39 UTC), with remote inventory empty and the deadline timer inactive. Allocated duration was 2.516 hours; at the recorded compute-plus-disk rate $0.387362963/hour, estimated allocated cost was $0.9747. This is an estimate from allocation time, not a final provider bill. Egress and built-in image-generation charges are unknown and are not folded into that figure.

The approximately 5 MB Tiny ONNX graph and 6.8 MB orientation graph were retained locally with the evidence. No additional model tuning or remote work followed confirmation. The separate content/Markdown-judge request was withdrawn; no new content judge was delivered as part of this campaign.
