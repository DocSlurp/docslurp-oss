# Offline JSONL acceptance — 2026-11-15

These are local synthetic acceptance observations, not production throughput or semantic-quality benchmarks. No remote compute or model calls were used. Model/tool reporting costs were not measured. Inputs were generated from repository-owned code and contain no customer documents or third-party corpus data.

The exact runtime is identified by `moduleSha256` and `moduleBytes` in every final benchmark record. Both large-file runs and the many-file run use the same 1,327,885-byte WASM artifact (existing budget 1,500,000 bytes). See the raw logs rather than inferring memory or completeness from elapsed time.

## Workloads and outcomes

- `shared-wasm.jsonl`: 1,075,660,264-byte sparse PDF, 20,000 pages sharing one 32,768² grayscale image. All 20,000 pages inventoried, 1,000 deeply measured, 19,000 explicitly unknown. 2,507,167 bytes requested in 40 reads; largest request 400,178 bytes. Raw JSONL: 957,156 bytes. WASM memory buffer: 18,481,152 bytes; observed Node RSS peak: 98,234,368 bytes.
- `distributed-wasm.jsonl`: 1,076,178,187-byte sparse PDF, 10,000 separate valid bilevel image streams, not shared-image deduplication. All 10,000 pages inventoried, 1,000 deeply measured. 4,010,160 bytes requested in 22,029 reads; largest request 400,158 bytes. Raw JSONL: 605,092 bytes. WASM memory buffer: 19,070,976 bytes; observed Node RSS peak: 98,017,280 bytes.
- `many-wasm.jsonl`: 10,000 independently constructed, variable-size valid PDF Blob snapshots, roughly a few KiB through 131 KiB, sequentially profiled with one reused WASM instance. All 30,000 pages inventoried and deeply measured. Total 37,189 ms, first output 8 ms; per-file histogram is retained separately rather than reduced to a mean. WASM buffer remained 16,777,216 bytes; observed RSS peak 101,904,384 bytes.

The large runs overlapped briefly with local validation work and each other; timing is non-isolated. They are evidence for range behavior and observed memory, not a controlled speed comparison. The many-file workload excludes simultaneous transfers and native file-open overhead because it uses immutable Blob snapshots. Browser Blob reads use the same slice driver; the measurements were run in Node, not a browser performance lab.

`peakWasm` is the allocated WASM memory buffer sampled while consuming records; `peakRss` is sampled process resident memory. Neither equals live parser heap alone, and brief unsampled native transients can be missed. The enforced WASM ceiling remains 256 MiB. Source request totals include repeated windows and are not unique-byte counts. Caches have separate explicit limits; raw cache occupancy appears in the profile-end record and is not a substitute for RSS.

The sparse holes are actual zero-valued pixel data in valid raw image streams, not an imaginary large `size` on a tiny buffer. Their physical disk allocation is small. The separate-image case catches the mistake of reading 64 KiB past every page dictionary into scan payloads. Object-boundary-aware coalescing reads clusters of small objects and stops before large stream bodies. Small header/tail windows can include adjacent payload bytes; no pixel codec or complete image payload is needed.

## Reproduce

From `packages/estimate`:

```sh
cargo run --example generate-range-scale -- /your/scratch/shared.pdf 20000 1024
cargo run --example generate-range-scale -- /your/scratch/distributed.pdf 10000 1024 distributed
node scripts/benchmark-jsonl.mjs large /your/scratch/shared.pdf
node scripts/benchmark-jsonl.mjs large /your/scratch/distributed.pdf
node scripts/benchmark-jsonl.mjs many 10000
```

Use a scratch filesystem with adequate logical/physical quotas; do not store large generated input files in Git. The tracked scale generator and small distribution-read regression are sufficient to recreate them.

The implementation intentionally does not extrapolate targeted outliers into population totals. Byte estimates remain glyph-based, geometric candidate confidence is uncalibrated, and scans without native text cannot yield verified table/caption/chart semantics. These limitations are part of the output contract, not missing-success counters.

`checkpoint.html` displays measured memory/I/O distributions and actual source-page captures. The complete generated three-page source and its JSONL live under `packages/estimate/examples/`; source page 2 exercises a caption and page 3 demonstrates why axes/ticks alone do not make table cells.
