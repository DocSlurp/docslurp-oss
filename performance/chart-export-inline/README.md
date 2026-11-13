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

## Council fix round re-measure (`results-vm-steps.json`)

- **Slice:** the 75 documents above plus 20 more (council M3): 6 JSON specs (Vega-Lite and Plotly), 6 JSON API exports,
  3 JSON row arrays, 3 EPUBs with charts and 2 without. That makes 95 documents and 196 pages.
- **VM:** the same Modal VM shape, 2 vCPU and 4 GiB. These are the parser VM's provider defaults
  (`DOCSLURP_MODAL_CPU`, `DOCSLURP_MODAL_MEMORY_MB`), so production runs at the size measured.
- **Price, at that size:** VM $0.00010552/s plus worker slot $0.000035/s.
- **Per-document quarantine VM (boot and staging, 1.4 s):** $0.000197.
- **Runs:** five per arm, interleaved with the order rotated, a fresh process per command.

| step | inline time per signalled document (median) | documents that started a worker | pages per $1, the gate as defined (page-only baseline 63,878) | pages per $1 counting each document's quarantine VM (baseline 9,008) | pages per minute (baseline 200) |
|---|--:|--:|--:|--:|--:|
| v0: before this round | 62 ms | 52 | 55,240 (−13.5%) | 8,814 (−2.2%) | 189.0 (−5.5%) |
| v1: + JSON spec-key prefilter, spec schemas in their own module, transfer, RSS watchdog | 61 ms | 46 | 56,028 (−12.3%) | 8,834 (−1.9%) | 190.1 (−4.9%) |
| **v2: + compile cache (shipped)** | **51 ms** | **46** | **57,052 (−10.7%)** | **8,859 (−1.7%)** | **191.5 (−4.3%)** |
| (v3: + SVG worker started during the inspection) | 50 ms | 46 | 57,114 (−10.6%) | 8,860 (−1.6%) | 191.6 (−4.2%) |

Every step exported the same 94 visuals.

**What each step bought:**
- **JSON prefilter (v1):** the 6 API exports no longer start a worker; their cost went from ~58 ms to ~4 ms each.
- **Spec schemas in their own module (v1):** within noise. A CPU profile of the import puts zod schema construction at
  ~20% of it, and the guest still builds the spec schemas it validates with.
- **Compile cache (v2):** −10 ms on every signalled document.
- **Pre-start (v3):** ~1 ms, so it was removed from the guest.

**Gate.** As defined (≤2% loss on the page-only baseline), the shipped guest **fails: −10.7%**. It is −6.3% on the
original 75-document slice at the 1-core price used before; the 2 vCPU / 4 GiB price and the JSON and EPUB documents make
it worse here. Counting the quarantine VM that every document already pays, it is −1.7% (the earlier figure was −1.6%).
Which baseline applies is the owner's decision.

**EPUB:** each EPUB starts a worker (~50 ms), with or without a chart. Nothing in the ZIP listing shows a chart signal.

## Threat model note (council L6)

The XML, SVG and JSON extractors now run in a worker thread of the quarantine-inspect process, before the ClamAV verdict,
in the parser VM's pooled lanes (reused across documents of the same activity, wiped between them).
- **Risk:** a V8-level compromise through the extractor could forge this document's inspection result, or try to
  persist into a later command in the same VM.
- **What bounds it:**
  - the VM is the boundary;
  - the host cross-checks the inspection (magic bytes, intake facts) and validates the chart answer field by field;
  - ClamAV runs in its own scanner session;
  - the lane is wiped between documents.
- **Same trust level** as the existing parser commands, which run customer bytes in the same pooled VMs.
- **Not done here:** marking a VM that ran inline charts as not reusable for another document's quarantine.

## Council round 2 re-measure (`results-vm-r2.json`, `results-probe-r2.json`)

- **Slice:** the 95 documents above plus 11 realistic no-chart documents, 106 documents and 207 pages in all:
  - 2 `{"data": ...}` envelopes;
  - 2 JSON:API documents, whose `data` items have `type`, which the extractor does read;
  - 3 `ensure_ascii` exports;
  - 4 saved web pages with analytics, framework and JSON-state scripts.
- **Same VM shape and prices** as round 1.
- **Arms:**
  - `before`: the round-1 guest as it shipped, without the V8 flag;
  - `now`: this round's guest, run as the host runs it, with `--disallow-code-generation-from-strings` on the quarantine command. Compile cache on in both.

| | Σ added time | workers started | visuals | pages per $1, the gate as defined (63,878) | counting each document's quarantine VM (8,591) | pages per minute (200) |
|---|--:|--:|--:|--:|--:|--:|
| before | 2.73 s | 57 | 96 | 57,110 (−10.6%) | 8,457 (−1.6%) | 191.6 (−4.2%) |
| **now** | **3.52 s** | **43** | **90** | **55,409 (−13.3%)** | **8,418 (−2.0%)** | **189.3 (−5.4%)** |

Per class, as the median added time per document, and for `now` the loss on a single-page document of that class against
its full cost (page cost + its quarantine VM):

| class (n) | before | now | now: workers | now: 1-page document |
|---|--:|--:|--:|--:|
| Office with charts (25) | +49 ms | +74 ms | 25/25 | −4.7% |
| SVG with charts (5) | +46 ms | +74 ms | 5/5 | −4.7% |
| HTML with charts (5) | +44 ms | +71 ms | 5/5 | −4.5% |
| JSON specs (6) | +44 ms | +71 ms | 6/6 | −4.5% |
| JSON:API with `type` (2, no chart) | +43 ms | +71 ms | 2/2 | −4.5% |
| web pages with scripts (4, no chart) | +44 ms | +7 ms | 0/4 | −0.5% |
| `{"data": ...}` envelopes (2) | +43 ms | +4 ms | 0/2 | −0.3% |
| `ensure_ascii` exports (3) | +44 ms | +5 ms | 0/3 | −0.4% |
| EPUB without an SVG file (5; 3 of them hold inline charts) | +47 ms | +7 ms | 0/5 | −0.5% |
| Office, HTML, JSON without a signal (21) | ~0 | ~+5 ms | 0/21 | −0.3% |

**What changed:**
- **Prefilters (exact) and the EPUB rule:** 14 fewer workers. The realistic negatives now start none, except JSON:API,
  which the extractor really reads.
- **The EPUB rule (an EPUB runs only with a `*.svg` file) costs visuals:** the 3 generated chart EPUBs carry their charts
  inline in XHTML, so 6 visuals are no longer exported. This is the documented difference (`inline-guest.ts`). Lifting
  it brings back about 50 ms per EPUB.
- **The V8 flag costs about 25–35 ms per worker** (probe: worker plus bundle import 72 → 106 ms with the compile cache,
  85 → 124 ms without; the main thread only +6 ms). It is the mandated H1 fix, kept as is. The compile cache still
  applies under the flag (−18 ms).

**Gate:**
- As defined (page-only): **fails, −13.3%**.
- Counting the quarantine VM: **−2.0%**, at the edge of the ≤2% budget.
- A signalled single-page document loses 4.5–4.7% of its full cost; an unsignalled one 0.3–0.5%.
- The owner decides the baseline.

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

## Council round 3 re-measure (`results-vm-r3.json`)

- **Same slice** (106 documents, 207 pages), **same VM shape and prices** (2 vCPU / 4 GiB: VM $0.00010552/s plus worker
  slot $0.000035/s; quarantine VM $0.000197 per document). Five runs per arm, interleaved, a fresh process per command.
- **Arms:**
  - `before`: round 2's guest pack, run as the driver runs a baseline (without the V8 flag);
  - `now`: this round's guest, run as the host runs it (`--disallow-code-generation-from-strings`).
- **Changes measured:**
  - the linear script-tag prefilter (H1);
  - every inspectable EPUB runs (M3);
  - the worker's soft deadline (M2);
  - the inspection written before charts (L1).
  The table compares `now` with round 2's `now`, the like-for-like arm (both under the flag).

| | Σ added time | workers started | visuals | pages per $1, page-only (63,878) | counting each document's quarantine VM (8,591) | pages per minute (200) |
|---|--:|--:|--:|--:|--:|--:|
| round 2 `now` | 3.52 s | 43 | 90 | 55,411 (−13.3%) | 8,418 (−2.0%) | 189.3 (−5.4%) |
| **round 3 `now`** | **3.52 s** | **48** | **96** | **55,409 (−13.3%)** | **8,418 (−2.0%)** | **189.3 (−5.4%)** |

Median added time per document, by class (round 3 `now`):

| class (n) | added | workers |
|---|--:|--:|
| Office (32: 25 with charts, 7 without) | +67 ms | the 25 with chart parts |
| SVG (5) | +65 ms | 5/5 |
| EPUB (5) | +67 ms | 5/5 (was 0/5) |
| HTML (14) | +6 ms | those with a signal |
| JSON (22) | +6 ms | those with a signal |
| no inline kind (28: images, PDFs) | 0 ms | 0 |

- **M3:** every EPUB now starts a worker, +67 ms each. The 6 inline-XHTML visuals lost in round 2 are back (96 visuals).
  The cost per EPUB page shrinks with its length; the generated EPUBs here are 1–2 pages, the worst case.
- **H1:** the linear prefilter costs nothing measurable (HTML and JSON stay at +6 ms). It plans 5 MiB of hostile
  `<script` tags in 25–29 ms; the old regexes took 7.9 s on 160 KB.
- **Workers ran faster this round** (+65–67 ms against +71–74 ms in round 2, same code path). Within run-to-run noise on a
  shared Modal host, that offsets the 5 EPUB workers, so Σ is unchanged.
- **Gate:** unchanged from round 2.
  - Page-only, as defined: −13.3%, a fail.
  - Counting the quarantine VM every document pays: −2.0%, at the ≤2% edge.
  - A signalled one-page document still loses ~4.5% of its full cost; an unsignalled one ~0.3%.
- **Modal spend this round:** 70.5 VM-seconds, about $0.01.

`pdf-figure-words.mjs` now reads a point's category from whichever coordinate is a string: the extractor writes
`x` = category and `y` = value for horizontal bars too. With Doppler #41's tightened bar rule (3341aa747), the truth PDF
still scores 52 of 60 values exact, 9 of 9 figures.

## Unit containment re-measure (`results-vm-r4.json`, #364 faf4d33ba)

- **Same slice** (106 documents, 207 pages), **same VM shape and prices**, five interleaved runs per arm.
- **Arms:**
  - `before`: round 3's guest pack, run as the driver runs a baseline (without the V8 flag);
  - `now`: the contained guest, run as the host runs it.
- The contained guest runs #364's unit worker (`chart-export-worker.mjs`), which streams units under the supervisor in
  `chart-inline.mjs`.

| | Σ added time | workers started | visuals | pages per $1, page-only (63,878) | counting each document's quarantine VM (8,591) | pages per minute (200) |
|---|--:|--:|--:|--:|--:|--:|
| round 3 `now` (one worker, no containment) | 3.52 s | 48 | 96 | 55,409 (−13.3%) | 8,418 (−2.0%) | 189.3 (−5.4%) |
| **contained `now`** | **6.73 s** | **48** | **96** | **49,449 (−22.6%)** | **8,267 (−3.8%)** | **180.4 (−9.8%)** |

Median added time per signalled document, contained `now`:

| class | added |
|---|--:|
| Office | +133 ms |
| EPUB | +135 ms |
| SVG | +129 ms |

Round 3 measured +65–67 ms for the same classes. Unsignalled documents are unchanged: HTML and JSON +7–9 ms, no inline
kind 0 ms.

- **The extra start-up is about +65 ms per signalled document,** with no failures in the slice: it is not restarts.
- **What I know about it:**
  - #364's worker does not enable the V8 compile cache, which the round 3 worker did (−10 to −18 ms measured then).
  - The bundle is 11 KB larger.
  - The rest is unattributed. A local comparison was too noisy on a loaded host to split it.
- **Next step:** let #364's worker take a compile cache path, as round 3's did. That is an upstream change to #364's
  file. Then measure each step in the VM (`probe-vm.mjs`) before tuning further.
- **Visuals are unchanged** (96).
- **Modal spend:** 121.5 VM-seconds.

**The Doppler path** (app #510) contains units in the guest instead: the Python guest watches the chart child's progress
lines and starts a fresh child after a lost figure. On the normal path it adds nothing: the step's median was 82.6 ms over
9 real figures in a Modal VM, against about 116–125 ms for the uncontained child. A crash, an out-of-memory and a hang in
one figure were each lost alone (`results-p15-units.json` in the app).

## Compile cache and output budget (`results-vm-r5.json`, #364 93c080686 / 694e4d195)

- **Same slice** (106 documents, 207 pages), **same VM shape and prices**, five interleaved runs per arm.
- **The bench now runs as uid 10001,** the parser VM's command user. V8 keys its compile cache by uid, and the inline path
  refuses a cache it can write, which root always can.
- **The cache is built as production builds it:** as root at "image build", filled as uid 10001 under the guest's V8 flag,
  then root-owned 0555/0444.
- **Arms:** the current tree (contained, with the output budget):
  - `nocache`: no cache;
  - `now`: the read-only cache.

| | Σ added time | workers started | visuals | pages per $1, page-only (63,878) | counting each document's quarantine VM (8,591) | pages per minute (200) |
|---|--:|--:|--:|--:|--:|--:|
| round 3, one worker, no containment | 3.52 s | 48 | 96 | 55,409 (−13.3%) | 8,418 (−2.0%) | 189.3 (−5.4%) |
| round 4, contained | 6.73 s | 48 | 96 | 49,449 (−22.6%) | 8,267 (−3.8%) | 180.4 (−9.8%) |
| contained + output budget, no cache | 5.98 s | 48 | 96 | 50,731 (−20.6%) | 8,302 (−3.4%) | 182.4 (−8.8%) |
| **contained + output budget + read-only cache** | **5.34 s** | **48** | **96** | **51,863 (−18.8%)** | **8,331 (−3.0%)** | **184.2 (−7.9%)** |

Median added time per signalled document, read-only cache:

| class | added |
|---|--:|
| Office | +104 ms |
| SVG | +104 ms |
| EPUB | +104 ms |

That is against +133 ms in round 4 and +66 ms in round 3. HTML and JSON stay at about +9 ms.

- **The cache saves about 13 ms per signalled document** (0.64 s over 48), below #364's 19–41 ms. The inline step loads
  only the worker and the bundle; the parent's own modules are small.
- **The output budget changes nothing measurable,** and the visuals are unchanged.
- **Gate:**
  - Counting the quarantine VM every document pays: −3.0%, still over the ≤2% budget. Containment costs about +38 ms per
    signalled document net of the cache.
  - Page-only, as defined: −18.8%.
- **Modal spend:** 121.7 VM-seconds.

**Doppler child** (app #510): a read-only cache filled at image build, as uid 0, the single-document job's uid. On a Modal
VM the 9-figure chart step went from 123 to 103 ms and the smoke from 85 to 65 ms.
