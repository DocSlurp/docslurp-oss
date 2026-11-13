# Inline free chart extraction: cost against the 2% gate (2026-11-13)

`DOCSLURP_CHART_EXPORT_INLINE=1`. The free chart steps run inside the quarantine-inspect command that every document
already runs in the parser VM. They run in a worker thread with a heap limit and a deadline. So a document with a chart
signal adds no VM boot, exec or Node start, and a document without one adds nothing.

## Method

- **Slice:** the same 75 documents and 176 pages as the free-tier gate (app #484): the public chart-export-real corpus
  plus the same 50 generated documents (`gen-slice.mts`).
- **Measured in a real Modal `runtime: "vm"` sandbox** (2 vCPU, 4 GiB, network blocked). Driver: `run-in-modal-vm.mjs`
  and `bench-vm.mjs`.
- **Arms:** five runs per document, interleaved, a fresh process per command:
  - quarantine-inspect as today;
  - the same command with inline charts;
  - the standalone guest that #363 would run in a separately booted VM.
- **Prices and baseline:** the same as #484.
  - VM: $0.00004609/s (1 core, 1 GiB basis). Worker slot: $0.000035/s.
  - Page-only baseline: 63,878 pages per $1, 200 pages per minute.
  - The second baseline adds the per-document quarantine VM run that every document already pays (75 × $0.000114).
    #484 left it out.

## Results (`results-vm.json`)

| | free off | #363 free (standalone VM) | **inline free** |
|---|--:|--:|--:|
| Extra VM boots per document | 0 | 35 of 75 | **0** |
| Extra wall time for the slice (VM + slot) | 0 | ~49 s + 35 boots | **2.30 s** (median per signalled document +62 ms) |
| Pages per $1, page-only baseline (compute only) | 63,878 | 23,705 (−63%) | **59,833 (−6.3%)** |
| … plus embedding the exported chart text (+14,437 tokens) | | | 58,682 (−8.1%) |
| Pages per $1, baseline including each document's quarantine VM | 15,568 | | **15,316 (−1.6%)**; with embeddings 15,239 (−2.1%) |
| Pages per minute (one slot, serial) | 200 | 93 (−54%) | **191.7 (−4.2%)** |
| Visuals exported (Office, HTML, SVG, JSON) | 0 | 82 | **82** (results identical to the standalone guest) |
| Free-tier documents with no signal | | ~0.1 s of reads each | **0 work** (ledger slot only) |

**Gate (≤2% loss in pages per $1): fails on the page-only baseline (−6.3%) and passes (−1.6%) once the quarantine VM
that every document already pays is counted.** Embedding the chart text adds 2.1% on its own on this deliberately
chart-dense slice. That cost buys content, not overhead, and no compute change can remove it.

## Where the remaining ~60 ms per signalled document goes (`results-probe.json`, same VM)

| step | ms |
|---|--:|
| Node boot (paid once by quarantine already) | 20 |
| Worker thread start | +32 |
| Bundle import | +37 (with a read-only V8 compile cache: +26) |
| Bundle import inside a worker | +68 (with cache: +55) |
| Extraction itself (typical document) | 2–5 |

Main-thread extraction (no worker) would save about 30 ms but loses crash isolation, and its import cost alone (26 ms)
still exceeds the page-only budget (about 19 ms per signalled document on this slice). Next steps, in order:

1. Bake a compile cache into the parser image (about −12 ms).
2. Trim the bundle's import-time work: zod schema construction.
3. Start the worker while the quarantine inspection is still running.

## PDF vector charts (`pdf-figure-words.mjs`, `gen_pdf_truth.py`)

Doppler figure SVGs carry no text, so the free steps yield **0** charts for PDFs today. This branch sends none of them
in inline mode, so PDFs add zero cost. With the new words seam (`{kind: "svg", text, words}`), the words come from the
PDF text layer inside the figure bbox plus 60 pt.

- **Yield:** **12 of 14 SVG figures** in the generated vector-chart PDFs give a chart.
- **Accuracy:** on known-data line charts, **16 of 16 values are exact** (within 2% of range).
- **Doppler gap:** bar and horizontal-bar charts get no figure record from Doppler (0 of 6 pages), so they still yield
  nothing.
- **Production path:** running this inside the Doppler VM figure pass (guest protocol 15) is proposed to the protocol
  14 owner. It is not built here.

## Spend

Modal VMs: about 55 VM-seconds at 2 vCPU and 4 GiB, about $0.01. No model calls.
