# Track C: ingest throughput and cost (2026-10-23)

Branch: core worktree /home/dan/worktrees/docslurp-oss/perf-ingest, `perf/ingest-2026-10-23` (base 62abb757, merged ecc94a48 cleanly).
Caveat: the host ran at load average 20-40 on 8 cores (other agents), so wall times carry +-20-50% noise. CPU-seconds and DB transactions are the primary metrics. No AI spend (local MiniLM/bge-m3 only, vision off). Costs are CPU only, not AI/API.

## Production attribution (SigNoz, 7 d; prod/*.tsv)
Stage-seconds share: embed 39.3% (local bge-m3 + hosted batches), graph-enrich 20.8%, extract-markdown 18.6%, index 5.8%, route-pages 3.2%, document-summary 3.2%, quarantine 2.8%, rest <2%.
Light stages (format-detect, to-canonical, normalize, pdf-tooling) p50 ~0.3-0.45 s each (fixed overhead); quarantine p50 2.5 s. Postgres spans p50 12 ms (SELECT/UPDATE), begin p50 34 ms; S3 Head p50 28 ms, GetObject p50 85 ms (p95 6 s). Embedding models in use: text-embedding-3-small (batch p50 8.8 s), pplx-embed hosted (p50 0.7 s), local bge-m3 (p50 0.6-6.9 s per doc). Temporal schedule-to-start is not exported to SigNoz; run wall minus stage sum is 0-40 s for typical runs.

## Frozen split (fixtures.sha256)
dev: 80p text PDF, 26p + 3p scanned PDF, 1p multicolumn PDF, DOCX, XLSX, EPUB, 6 HTML, PNG. held-out: 21p text PDF, 3p tables PDF, 3p scanned PDF, 10p PDF, DOCX, XLSX, EPUB, 4 HTML, PNG.
Scanned PDFs fail without vision (no extractor text); excluded from comparisons.

## Experiments
| id | change | metric | baseline | candidate | verdict |
|---|---|---|---|---|---|
| exp-01 | ORT intra-op threads 8/4/2/1, bge-m3 q8, batch 8, 24 chunks | CPU-ms/chunk | 10284 | 8435 / 6717 / 5593 | CPU per chunk -46% at 1 thread (spin overhead); wall worse when fewer threads. Needs pool>1 to use cores; memory-bound (prod pins pool=1). NOT APPLIED |
| exp-02 | length-sorted batches (batch 8, intra 2) | CPU-ms/chunk | 6717 | 5549 (-17%) | promising, noisy |
| exp-03 | batch size (intra 2, 24 chunks) | CPU-ms/chunk | b32: 7341/7658 | b1: 4190 (-45%), b4+sort: 5894 | big CPU win, BUT vector cosine vs b32 min 0.986 / mean 0.992 (q8 drift with padding). Quality gate not passed -> opt-in only (DOCSLURP_EMBED_SORT_BY_LENGTH=on, default off) |
| exp-02b | pool 4 x intra 2 | wall | 136 s (pool1) | 92 s | -32% wall, +19% CPU; memory x4 |
| expA/B | prod-like (no stage grouping, canonical order) vs WORKER_GROUP_ADJACENT_STAGES+INDEX_BEFORE_ENRICH, 31 ms DB latency proxy, MiniLM | wall / xacts, dev-tiny (6 docs, 49 pp) | A 113.9, 93.5 s; 1403, 1039 | B 74.1, 89.0 s; 946, 1087 | mean -21% wall, -17% xacts; quality hashes identical |
| held-out | same A/B once on 12 docs, 171 pp | wall / xacts / CPU | A 187.8 s, 2151, 161 s | B 252.1 s, 2491, 229 s | NOT CONFIRMED (B worse; noise-dominated) -> REJECTED as proven win |

Pages/min (full run, local MiniLM, 31 ms DB): dev-tiny ~26-40, held-out 41-55. 100 pages ~2-4 min on this loaded host. Pages per $ not computed (no AI; local CPU only).
Quality gate: page-text and chunk-text md5 identical across A/B on all docs.

## Findings / ranked ideas
1. Local bge-m3 costs ~4-10 CPU-s per ~300-token chunk (~150-300 chunks per 100 pages -> 10-50 CPU-min per 100 pages) vs hosted pplx-embed (<$0.01 per 100 pages). Default hosted is far cheaper in pages/$. Route heavy local-embed workspaces to hosted: est. 5-20x pages/min per worker.
2. Padding waste: batch 1 (or tight length buckets) -45% CPU; needs retrieval eval (drift ~1% cosine) before default.
3. ORT intra-op spin: CPU/chunk +84% at 8 threads vs 1; prefer pool of N x intra 1-2 if memory budget allows.
4. Grouped stages + index-before-enrich: expected fewer activities (12 -> 5) and DB round trips; local evidence mixed, needs load-test A/B.
5. Not tried: xlsx/table chunk size (table text is ~2x tokens/char), S3 reuse, per-shard DB batching.
## Surprises
Postgres max_connections (100) is exhausted by concurrent agents; xlsx 136 KB markdown took >30 CPU-min to embed locally (table text tokenizes densely).
