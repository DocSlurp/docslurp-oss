# Real-document throughput and estimated cost calibration

Measured 2026-11-15 in credential-free, network-blocked Modal VMs: 1 requested/limited physical CPU core, 2 GiB RAM, AMD EPYC 9655, Node 24.22.2. Three repetitions per document, alternating order, reused WASM. Final module SHA256: `b016618c49fac4f4b82307a83fb1fb4f3cafcbdf7a94e9cd697635ef2ef775e7` (1,327,005 bytes).

| Real PDF | Pages | Median pages/sec | Pages/min | Deep complete / partial | Observed vector operations | Estimated profiler USD/1,000 inventory pages |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| IRS 2025 tax tables | 28 | 32.49 | 1,950 | 17 / 11 | 136,666 | 0.001624 |
| Census population tables | 62 | 95.11 | 5,706 | 61 / 1 | 116,657 | 0.000555 |
| TI TPS54302 datasheet | 32 | 141.08 | 8,465 | 28 / 4 | 71,130 | 0.000374 |
| TI BQ25570 datasheet | 46 | 167.93 | 10,076 | 45 / 1 | 90,237 | 0.000314 |

These rates inventory and attempt deep inspection on every page. **No document returned complete deep evidence for every page.** Independent pdfinfo page counts matched. Full-deep rates/costs stay null. Semantic quality was not scored; sparse Census font/word evidence means candidate counts cannot be treated as routing ground truth. These mixed real documents contain substantial tables/vectors, rather than isolating one feature.

`measurements.jsonl` retains every repetition, exact timing, CPU time, I/O, output size, sampled RSS/WASM, statuses and trailers. `calibration.json` retains ranges and runtime identity. The preceding same-build `compatibility-confirmation.jsonl` was slower: medians 27.37 / 75.67 / 101.52 / 125.09 pages/sec. Variation is preserved; no speedup between VM allocations or production SLO is claimed. Ranges across three repetitions are not confidence intervals.

## Native extraction and modeled downstream costs

Separate `pdftotext -layout` runs produced nonempty stable-size output: medians **112 / 267 / 377 / 493 pages/sec** respectively. Estimated native text compute: **$0.000471 / $0.000198 / $0.000140 / $0.000107 per 1,000 pages**. This validates command execution/output size, not faithful tables, chart interpretation or OCR quality. Extracted text was not transferred or committed. Native text extraction is a minimal baseline doing a different job, not an equivalent feature profiler.

[AWS Textract pricing](https://aws.amazon.com/textract/pricing/), checked 2026-11-15, lists US West (Oregon), first-million-page rates of **$1.50/1,000 pages for text OCR** or **$15/1,000 pages for tables including OCR**. These hypothetical alternatives are not additive. Per-document scenarios appear in calibration.json. These are not production DocSlurp prices, measured API charges or predictions of which pages require OCR. Chart interpretation cost remains null. No model/OCR API calls were made.

[Modal Sandbox prices](https://modal.com/pricing/), checked 2026-11-15: $0.00003942/physical-core-second and $0.00000667/GiB-second. At 1 core/2 GiB: $0.00005276/second. Formula: `wallSeconds / pages * 1000 * allocationUsdPerSecond`. Requested allocation is used conservatively; this is not an invoice. Normalization describes these document shapes, not validated large-file scaling.

Three VMs lived 10.671, 16.589 and 14.986 seconds; all terminations verified. Total estimated allocation **$0.00222890**, against the approved $20 cap. Lifecycle includes staging/rendering/idle time; marginal profiler costs exclude those. Existing image reuse required no build. Provider invoice, possible transfer/storage charges, and reporting/tool costs remain unmeasured. No persistent volumes/endpoints, merge or deployment.

## Method and correctness

- Hashing the entire source and running pdfinfo happen before timing, warming I/O. First pass is not disk-cold. Compilation was separately 8.94 ms. Startup, staging, hashing, oracle checks, rendering, native extraction and transfer are outside profiler timing.
- Profiler timing includes range transport and JSONL parsing/first-pass retention. RSS samples include harness allocations and reused process state; not parser-only memory or absolute peak. WASM stayed at 16 MiB.
- `baseline-measurements.jsonl` preserves the rejected Census file without giving failure a throughput. The correction ignores supplemental xref-stream Prev while following the owning table chain, matching [QPDF behavior](https://qpdf.readthedocs.io/en/stable/object-streams.html). Synthetic tests cover absent/differing supplemental pointers, owning-chain newest-revision precedence and cycles.
- Two independent source reviewers found no high issue. Calibration/runtime-mixing, count-validation and regression gaps were fixed. See docs/reviews/offline-profile-jsonl.md. The separate evaluation-integrity gate passed. This experiment does not promote semantic extraction quality.
- Original PDFs/captures are outside this public repository; source URLs, SHA256 and timestamps are in sources.json. Runtime code has no document names, expected page counts or source hashes.

## Reproduce

Download sources outside Git. Run external PDFs only in the mandatory credential-free VM, with package at /job/pkg, manifest at /job/sources.json and inputs at /job/inputs/<id>.pdf:

```sh
node /job/pkg/scripts/benchmark-real.mjs /job/sources.json /job/out
```

After retrieving numeric evidence:

```sh
node packages/estimate/scripts/calibrate-cost.mjs measurements.jsonl rates.json > calibration.json
```

The calibration requires one identified runtime/configuration, validates counts/rates and excludes failed inventory. Recalibrate with representative inputs/current prices before production budgeting.
