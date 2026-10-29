# Page-range sharding for long documents

Status (2026-10-28): planner and priors only (`worker/src/temporal/page-shards.ts`,
`page-shard-profiles.ts`). No stage uses them yet.

Document sharding (`document-shards.ts`) spreads whole documents across worker slots, so a
500-page PDF still runs every per-document stage on one executor. In production a 477-page
PDF spends 84–92 s in serial stages; about 148 ms per page of that scales with pages and can be
divided. Page-range shards split one document into contiguous page ranges, run each range on its
own executor and merge the results in page order.

## Measured costs

Production, 14 PDFs (3–477 pages), Theil–Sen fit of checkpoint stage durations:

| Stage | Fixed | Per page | Executor |
| --- | ---: | ---: | --- |
| route-pages (probe; shadow in production) | ≈0 s | 52.8 ms | worker slot |
| vision-extract (already fans out per page) | 2.0 s | 28.6 ms | model provider |
| embed | 2.8 s | 22.4 ms | worker slot / provider |
| extract-markdown (Doppler) | 2.5 s | 12.6 ms | VM, 0.5 core |
| index | 1.3 s | 12.6 ms | worker slot |
| quarantine (whole-file scan, not splittable) | 3.4 s | 10.3 ms | worker |
| render-images | 1.0 s | 6.5 ms | worker slot |

Splitting is not the expensive part. One-pass `qpdf --split-pages=K` splits 998 pages in
≤0.61 s with ≤63 MiB RSS for any K from 8 to 128; a 300-page scan splits in 0.06 s. Opening the
whole file once per chunk costs about 0.37 s per chunk with qpdf and about 30 ms with mutool;
poppler `pdfseparate`+`pdfunite` took 38.6 s for 142 pages with 89× output inflation. Small
chunks duplicate shared fonts and images: 3.4× the source bytes at 8 pages, 1.4–1.8× at 32 and
1.2–1.3× at 128 for text PDFs; scans stay at 1.0×.

Parsers that take page ranges do not need a physical split at all. Doppler extraction with
`-f/-l` on the full file over 8 local workers: 492 pages 2.52 → 0.71 s (3.6×), 998 pages 3.52 →
0.90 s (3.9×); each extra shard costs 20–25 ms to reopen the file. Presplitting first was slower
locally (1.19 s and 1.55 s) because the split is serial. Range shards aligned to 32 pages are
byte-identical to today's sequential 32-page chunks (3 fixtures, 142–998 pages).

## Planner

`planPageShards(pages, profile, capacity, options)` predicts each candidate shard size with a
greedy list schedule over ready executors plus executors that arrive after `scaleUpMs`, and picks:

- shard sizes inside the executor's memory and timeout limits (a document that cannot fit is
  always split);
- at most `maxCostOverhead` extra fixed cost over the unsharded run (this is the pages-per-$1
  versus latency knob);
- splits that save at least 2 s and 25 % of wall time; otherwise the document stays whole;
- among plans within 5 % of the fastest, the fewest shards.

`calibrateShardProfile` refits fixed and per-page cost (and raises memory, never lowers it)
from observed shard timings with Theil–Sen, weighted against the prior, so a cold start or
contended run cannot swing the plan. Profiles are keyed by stage and executor class; a model or
hardware class gets its own profile.

Predicted with the priors (Doppler on 16 VMs, `maxCostOverhead` 1): 477 pages 7.9 → 3.1 s,
998 pages 14.5 → 3.5 s, 3,000 pages 39.7 → 4.3 s; ≤142 pages stays whole.

## Where splitting runs

Splitting and page counting read customer bytes, so they stay behind the VM boundary
(CLAUDE.md, untrusted file processing). The host passes page ranges and never parses the PDF to
plan: the page count it plans with comes from the existing page index. Two transfer modes:

- **range** — every shard VM receives the full file and a page range. No extra work, but each VM
  transfers the whole file; preferred while `file bytes × shards` stays small.
- **presplit** — one VM runs `qpdf --split-pages` and returns the chunks as opaque bytes; each
  shard VM receives only its chunk. Preferred for large files with many shards; needs qpdf in the
  VM image.

Worker-slot stages (route-pages probe, render-images) parse in-process inside the worker today,
which is the known isolation gap; sharding them must not widen it and needs a council review.

## Integration order (each behind a flag, Temporal changes `patched()` per
temporal-workflow-changes.md)

1. Doppler extraction: guest accepts `{first, last, documentPages}` and keeps its 32-page
   internal chunking; host runs the planned shards as parallel VMs, merges in page order, fails
   the document on any shard failure and records usage per VM. Output stays byte-identical.
2. Page-range shard activity: extend `runPipelineStageShard` from document IDs to
   `(documentId, pageRange)` for render-images and embed.
3. Feed observed shard timings back through `calibrateShardProfile` (per stage, executor class).

## Implemented on feat/page-shard-media

- **Media windows** (`MEDIA_WINDOW_CONCURRENCY`, default 1): `media/windows.ts` overlaps the
  remote transcription and frame-description calls of one document, up to
  min(flag, `MEDIA_MAX_CONCURRENT`, windows), and applies results in window order. ffmpeg cuts
  stay serial, so no extra sandboxed processes run. Audio keeps its existing
  `MEDIA_CHUNK_OVERLAP_SECONDS` overlap. Video frame batches get no overlap, because a batch
  description is free text keyed by its frames and repeated context frames could not be
  de-duplicated. Leased capacity stays sequential: its lease is acquired lazily on the first call.
- **render-images page-range shards** (`WORKER_PAGE_RANGE_SHARDS`, default off, capability
  `workflow.page-range-shards`, input field `pageRangeSharding`): `planPageRangeShards` plans
  ranges with the calibrated profile, the workflow fans them out through
  `runPipelineStageShard({ pageRanges })`, and the stage pass then writes the manifest,
  ledger and checkpoints, finding the rendered pages in the per-page raster cache.
  Ranges are validated against the shard's own documents; a foreign document or bad bounds
  rejects the shard before any work.
- **embed: not range-sharded.** Each chunk's embedding input depends on per-document state, an
  LLM-generated contextual preamble and late-chunking windows. Concurrent range shards
  would race to generate, and pay for, the same document context. It needs a document-context
  step that runs once before the shards; until then `embed` stays whole-document, with
  document shards only.

