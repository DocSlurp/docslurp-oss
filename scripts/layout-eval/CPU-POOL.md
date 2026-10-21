# Resident CPU process-pool measurement

This helper tests aggregate throughput across independent CPU worker processes.
It is separate from single-page latency, single-core performance and a production
routing/precheck. No reference content is sent to a worker. A spawned worker gets
only image path, expected SHA, dimensions and opaque page/repeat identity; each
owns an offline FP32 ONNX session. No image base64 or image array crosses IPC.

Use the coordinator-frozen `common-clean-v1/dev.jsonl` (16 pages, 14 source
clusters; SHA `f340b0735b9e1fa0233d8f216a345749e61ad15233d948bcac71a5544ed8d3cf`).
It overlaps existing V2 development data and is not a new independent or
traffic-representative set. Its acquisition/construction eligibility was declared
before the pool runs. Preserve `common-clean-v1/RECEIPT.json` and source closure.

Run arms serially in an isolated timing window. First fix threads=1 and compare
workers=1/2/4/8. Then test threads=2/4 only on a useful worker count; do not start
with all 12 combinations. For 16 pages, 64 repeats gives 1,024 requests, allowing
roughly 10 seconds at 100 pages/second while remaining bounded. Reduce repeats or
stop on the existing host deadline; this recipe grants no extra time or spend.

```bash
python scripts/layout-eval/benchmark_cpu_pool.py \
  --manifest FROZEN_COMMON_CLEAN_DEV --split dev \
  --workers 1 --threads 1 --repeats 64 --warmup 3 \
  --onnx-path /workspace/layout-campaign/models/pp-small.onnx \
  --revision 8ac289e66575bb9bba6e15c53719d8b15cc9b3b2 \
  --max-seconds 180 --hourly-usd .38736 \
  --output FRESH_RESULTS/worker1-thread1.jsonl
```

Later pool arms add `--audit-serial FRESH_RESULTS/worker1-thread1.jsonl` using the
same manifest, repeats and threshold. The audit checks image/graph identity,
class-aware approximate boxes (IoU>=.999), exact raw class and scores within 1e-4.
Absolute normalized coordinate differences must also stay within 1e-5.
For the existing two-repeat benchmark JSONL use `--audit-ignore-repeat`; every
pool repeat is compared with the lowest serial repeat per page. Legacy rows read
the graph identity from the adjacent `.metadata.json`. It checks invariance to
pooling, not correctness against truth. A mismatch blocks
claiming equivalent extraction; all raw outputs and audit failures remain saved.

Startup and per-worker warmup are outside the timed resident throughput interval,
but included in allocated-host cost. The timed wall interval includes submission,
queueing, worker image read/hash/decode/preprocessing/model/postprocessing, output
serialization/IPC, parent JSON decoding, JSONL writes and final fsync. Per-request
caller completion includes queue delay and is distinct from worker execution
latency. IPC collection timing includes scheduling/parent-consumption delay; it
is not a pure wire-time estimate. Report both throughput and these distributions.

The summary records process CPU time (worker functions and coordinator), cgroup
CPU quota/affinity snapshots, actual model/runtime/graph identity and every worker
high-water RSS. Maximum worker RSS is explicitly **not aggregate RAM**. Simultaneous
aggregate RSS is null because it was not sampled. Failed/missing requests remain
in the summary with exact image identities; completed failures remain in JSONL.
No holdout manifest, classifier, source-aware routing, model download, or runtime
precision change is supported by this helper.
