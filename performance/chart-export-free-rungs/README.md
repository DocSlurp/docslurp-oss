# Free chart-export rungs: guest CPU, memory and throughput (2026-11-13)

Scope: the deterministic, no-model chart rungs (`office-chart-xml`, `embedded-spec`, `svg-geometry`). In production each
document's source file, and separately its batch of Doppler SVG figures, runs through the parser-VM guest
`worker/scripts/chart-export-extract.mjs`, one fresh Node process per VM command.

## Outcome

**The guest spent most of its time loading modules, not extracting charts.** A typical chart needs 1–20 ms of
extraction, but every guest run first loaded the whole `@docslurp/shared` index (~0.3 s CPU, ~25 MB). It then resolved
~200 small ESM files, mostly zod. Two module-layout changes removed most of that. Two exactly-equivalent parser changes
then cut CPU on large and hostile inputs. Outputs are byte-identical across all arms.

**Release note: deploy the worker first, then the parser image.** A new worker host accepts results with or without
the guest's optional `deferred` field; an older host refuses a result that carries it. So deploy the worker, and only
then import the rebuilt parser image.

**Production needs a parser-VM image rebuild.** The guest code runs from the digest-pinned parser image,
not the worker image. Advancing the app's `core` pin and deploying does not change it. The speedup and the hostile-CPU
cap and the SVG density gate are live only after the parser image is rebuilt (`worker-images.yml`), `DOCSLURP_PARSER_VM_IMAGE`
is updated, and the image is re-imported (the Actions deploy path, or `import-parser-vm-image.mjs`). Until then
production keeps the old, unbundled guest with the uncapped marker filter.

Real Modal `runtime: "vm"` sandbox at the parser VM's default size (network blocked). Each arm is interleaved run by
run, 7 runs per workload, with a fresh process per run. All throughput figures are **guest only** (see below):

| free path (20 guest runs, 43 pages, 76 visuals) | base | final | change |
|---|--:|--:|--:|
| guest wall per run, median | 227 ms | 77 ms | −66% |
| guest CPU per run, median | 277 ms | 78 ms | −72% |
| guest CPU per page | 133.7 ms | 41.9 ms | −69% |
| guest CPU per visual | 75.6 ms | 23.7 ms | −69% |
| peak RSS per run: median change across workloads (range) | | −32 MB (−22 to −33) | |
| peak RSS, largest run (40-chart workbook) | 152 MB | 125 MB | −18% |
| **pages per minute (guest only)¹** | **552** | **1,506** | **2.7×** |

¹ Guest process time only; the VM's per-command overhead is not included (below). The 43 pages include the Doppler
set's 13 PDF pages, for which the guest processes only the 11 figure SVGs (footnote ² below).

Per-workload CPU ratio against the baseline: median 0.28 (range 0.25–0.51). Within-arm noise (CPU IQR / median) is
about 2%.

"Guest" means the guest process only. The VM's own per-command cost (exec, input staging, reset) and VM boot are
fixed per command, are not changed here, and are not measured by this harness. End-to-end gains are therefore smaller
in absolute terms.

### By input set (same VM run)

| set | arm | CPU ms / run | CPU ms / page | peak RSS MB | pages / min (guest only) |
|---|---|--:|--:|--:|--:|
| Office (XLSX/PPTX/DOCX, 58 charts) | base | 329 | 82.1 | 152 | 932 |
| | final | 125 | 31.3 | 125 | 2,195 |
| embedded specs (HTML, JSON) | base | 267 | 267.0 | 97 | 275 |
| | final | 70 | 69.8 | 65 | 837 |
| SVG uploads (matplotlib, Vega) | base | 274 | 273.8 | 106 | 266 |
| | final | 81 | 81.2 | 84 | 758 |
| Doppler figures² (2 PDFs, 13 pages, 11 SVGs, one batch each) | base | 314 | 48.3 | 112 | 1,515 |
| | final | 105 | 16.2 | 81 | 3,947 |
| adversarial (6 inputs) | base | 489 | 488.8 | 272 | 158 |
| | final | 250 | 250.5 | 203 | 298 |

² The Doppler rows divide by the PDFs' 13 pages, but the guest run processes only the 11 figure SVGs, so their
per-page and pages-per-minute figures are inflated against the other sets. Per figure SVG: 57 ms CPU (base) and 19 ms
(final). Compare this set by CPU per run or per figure, not by pages.

## Changes kept (one mechanism each, in order)

| # | change | mechanism | measured effect | equivalence check |
|---|---|---|---|---|
| C1 | `d898d4902` guest imports `@docslurp/shared/chart-export` and `/file-sniff` (new subpath exports), not the package index | skips evaluating the whole shared index (OpenTelemetry, pricing, ...) | VM: CPU per run ×0.47, RSS −25 MB (median) | outputs byte-identical (26 workloads) |
| C2 | `3be3eb7ee` worker build bundles the guest (extractors + zod) into `dist/chart-export/guest.bundle.mjs` with esbuild | removes ESM resolution/loading of ~200 files (profile: `url`, `resolve`, `loader`, `package_json_reader`) | VM: CPU per run ×0.28 vs base (×0.60 vs C1), RSS −7 MB more | outputs byte-identical; the build fails on an import outside an allowlist or over 1.25 MB; the VM contract refuses a stale bundle (inputs SHA-256), then imports it and extracts a built-in SVG and XLSX; `__tests__/guest-bundle.test.ts` (CI, after the worker build) runs the real guest script and requires byte-identical output |
| C3 | `0619f3a3f` XML tokenizer: char-code predicates instead of a RegExp test per character | per-character RegExp calls were ~1/3 of `parseXml` | in process: PPTX −17%, XLSX 40 charts −9%, Vega SVGs −18 to −24%, many-rects −21%, many-texts −17%; neutral on matplotlib/Doppler SVGs | 658,778 differential cases (every UTF-16 code unit in 7 positions, 200k fuzz strings, all fixtures): 0 differences; committed: exhaustive test of the three predicates against the old regexes over all 65,536 code units |
| C4 | `fbb6d0077` + council fix: svg-geometry marker/vertex de-duplication: 3-unit grid pruning, exact test unchanged, indexed typed-array grid of distinct vertices; per-SVG pair cap (10⁵), approximated over it; behind the SVG density gate (below) | spread-out vertices: points × vertices → close to points + vertices. Vertices packed into a few cells: still points × packed vertices, now stopped at the cap | Doppler figure extraction −15% in process; spread hostile fixture `markers-vs-lines.svg` (4 MB) **56.7 s → 1.5 s** CPU. Packed-cell scene (council M1, up to 8×10⁹ pair tests within the input limits): the grid alone gave no gain (old 36 s, grid 49 s, loaded host); such SVGs now fail the density gate in O(bytes); the council's 100-SVG page takes 0.57–0.72 s on the parser VM (below) | `analyzeSvgChart` output identical on all fixtures plus 3,000 random scenes; committed: seeded property test against the brute-force filter, pair-count tests of both hostile scenes (`__tests__/equivalence.test.ts`) |

C3 and C4 change guest CPU only within noise on normal documents, where startup still dominates. They pay off on
large workbooks and on hostile input. The old C4 cost reached the guest's 60 s timeout. A timeout is reported as
`guest-unavailable`, which also skips that document's remaining deterministic runs. The density gate below bounds every
SVG instead.

No existing limit was raised; the density gate's limits are new. Every extractor still runs only in the parser VM.
**Reasons:**
- Existing refusal reasons are unchanged. `svg-too-large` keeps its name; its cap is now the gate's 640 KiB instead of 5 MB per SVG.
- Two new closed skip reasons: `svg-too-dense` and `svg-use-bomb`.
- `approximate-marker-dedup` is the `reason` on an approximated visual.
- `svg-document-limit` is the reason on a deferred SVG.
- `svg-marker-limit` is internal only: the guest catches it and approximates.

### SVG density gate: drop the pathological, keep the charts (owner direction, council round 4)

Super-dense or pathological SVGs are not worth recovering. The guest detects them cheaply, before any geometry work,
and skips them; everything else in the document carries on.

**Measured first.** 551 legitimate chart SVGs:
- 452 Doppler figure SVGs from the public bench PDFs;
- 25 arXiv figures;
- 19 Doppler figures from #437's run;
- 19 from #369's slice;
- 21 from this report's corpus (matplotlib, Vega, Doppler-report figures);
- 4 README charts;
- 11 from the test generators (matplotlib, Plotly, Recharts, Highcharts, Vega, Mermaid, Graphviz).

Each was counted exactly as the gate counts it: after `<use>` expansion, every parsed path vertex (glyph outlines included).

| metric | p50 | p90 | p99 | max | gate (≈ 2× p99) |
|---|--:|--:|--:|--:|--:|
| raw bytes | 27.9 KB | 138 KB | 313 KB | 415 KB | **640 KiB** (`svg-too-large`) |
| `<use>` expansions | 0 | 34 | 372 | 483 | **1,000** (`svg-use-bomb`) |
| expanded primitives (rects, points, texts, polylines) | 145 | 755 | 1,782 | 2,113 | **4,000** (`svg-too-dense`) |
| path segments (every parsed vertex) | 1,980 | 10,284 | 23,966 | 32,880 | **50,000** (`svg-too-dense`) |
| frames walked (every `<use>` re-walk and skipped/hidden child; council r5 H1) | 125 | 606 | 1,357 | 1,753 | **3,000** (`svg-use-bomb` inside a `<use>`, else `svg-too-dense`) |
| parsed elements (checked before the diagram and geometry paths; council r5 M1) | 146 | 657 | 1,447 | 2,043 | **3,000** (`svg-too-dense`) |
| `d` / `points` attribute length (council r6 H1) | 598 B | 981 B | 10.6 KB | 42 KB | **64 KiB** (`svg-too-dense`) |
| any other attribute but `href` | 26 B | 45 B | 166 B | 16.2 KB | **32 KiB** (`svg-too-dense`) |
| text directly under one element (not `<script>`/`<style>`/`<metadata>`/`<desc>`/`<title>`) | 0 | 0 | 47 B | 753 B | **4 KiB** (`svg-too-dense`) |
| bytes the walk reads (every frame's attributes and text, re-walks included) | 27 KB | 144 KB | 332 KB | 1.03 MB | **2 MiB** (`svg-use-bomb` inside a `<use>`, else `svg-too-dense`) |
| marker/vertex pair tests | 0 | 0 | 18 | 466 | **100,000** (over it: approximated, not skipped) |

Run through the gated extractor, **0 of the 551** were skipped, deferred or approximated, counting any refusal reason
at all as a skip. Rerun with the worker built:

```sh
node performance/chart-export-free-rungs/svg-density-stats.mjs --generated \
  <Doppler figure SVGs of the public bench PDFs> <arXiv figure SVGs> <#437 run figures> <#369 slice> \
  <gen_fixtures.py output: svg/ vega/ doppler-report/ doppler-single/ (not adversarial/)> <README chart SVGs>
```
`performance/chart-export-free-rungs/svg-density-stats.mjs` reruns this measurement and that check from corpus paths,
with the same counters the gate uses; the corpus stays outside the repository. The tests pin each limit with `toEqual`,
and check that every gate passes at its limit and skips at limit + 1. The owner suggested 50–100 KB for the byte cap, but real Doppler figures reach 415 KB, so the
measured value is used.

**Checks**, cheap and hard, checked while parsing:
- **Bytes:** checked before parsing.
- **Elements:** counted right after parsing, before the Mermaid/Graphviz diagram path and the geometry path.
- **Frames walked:** every frame the scene walk pops, counted before anything can skip it. A `<use>` re-walks its whole
  target, so 999 references to a group of hidden children cost that many frames.
- **`<use>` budget:** counted per expansion, and stops at the first one past the cap; the expansion is never
  materialised.
- **Expanded primitives:** checked before each element is walked.
- **Path segments:** added per parsed path. One giant path counts like many primitives.

An SVG over any check is skipped with a closed reason, and nothing of it is kept. The walk is bounded both in frames and
in the bytes each frame reads (council r6 H1). Beyond the caps, the per-frame helpers do O(small) work by
construction:
- **Raw-text scans are linear** (council r7 H1 and its sweep of every regex or scan over raw input under
  `chart-export/extractors`). These lazy regexes rescanned to the end of the input for every unclosed start: the
  embedded-spec `<script>`/`<metadata>` block finder, the HTML `<svg>` strip, `inlineSvgs`' tag finder, the comment
  signatures, and `parseTransform`. Each is now an `indexOf` scan with cached needles, exactly equal to its regex on
  10,000 seeded random inputs, and O(n) by step count on the hostile shapes.
  - In an SVG, embedded specs come only from its parsed `<script>`/`<metadata>` elements, never from raw text, so a
    comment can't feed the scanner.
  - The Mermaid id regexes skip ids over 256 or 4,096 characters, and the Graphviz `:port` strip uses `lastIndexOf`.
  - The Plotly scan reads a bounded window after each call.
- **The deadline is checked per unit:** each EPUB part, Office media SVG and Office chart part (`guest-deadline-part`),
  each HTML part's embedded scan and each embedded block (counted in `overflow`), and each SVG (`guest-deadline`).
- `normalizeColor` rejects values over 64 characters before its regex.
- `cleanLabel` cuts to 4× its output length before any regex or copy.
- `firstNum` takes the first token with one anchored match instead of splitting the attribute.
- The `groups` string keeps only the last 512 characters. The diagram path is under the element check too, and its id handling is linear: node ids are a
`Set`, an edge id with more than 64 parts is not split, and id collisions resume from the last suffix.

**Quantization (considered, not adopted).** The owner suggested snapping coordinates to a 1/4096 viewBox grid and
de-duplicating. Under the gate it isn't needed: an SVG holds at most 4,000 markers × 50,000 vertices, and the per-SVG
pair cap bounds the matching at ~0.3 ms. Snapping would also move the exact `|dx| < 1.5` match at grid edges, which the
brute-force property test would fail. What was kept: the vertex index collapses **exact** duplicate vertices, which is
lossless (same answer for every marker). Output for ordinary charts is unchanged, and the property test still passes.

**Removed, now that every SVG is bounded:**
- the pass-2 holding (order-keeping slots, held scenes);
- fair-share scheduling and its cheapest-first order;
- the per-input pair budget scaled by pages (`markerBudget`, the `pages` and `markerBudget` options, the host's `pages`
  request field);
- the pair estimate (`markerPairEstimate`);
- the pending-primitive cap and the 6×10⁶ scene ceiling;
- the vertex-count approximation path.

What remains:
- one per-SVG pair cap (approximate over it);
- one per-input count, `maxSvgsPerInput` = 400. An EPUB can hold 200 parts × 200 inline SVGs. Later SVGs are not
  parsed; they are recorded as one counted range, `{ svgIndex: 400, count, reason: "svg-document-limit" }`.
- **Every other per-input cap leaves a counted range too** (council r6 L1):
  - `visual-limit`: the 256-visual output cap. The visuals already found are kept; later visuals and SVGs are counted,
    not produced, and nothing is aborted.
  - `html-svg-limit`: inline SVGs past 200 in one HTML part.
  - `package-part-limit`: Office chart XML parts, media SVGs or EPUB parts past 200 (council r7 L1 added chart parts).
  - `figure-batch-limit` and `figure-unavailable`: Doppler figures past the 40 per document batch, or with no readable
    file. These are recorded by the host one by one with the figure id, where before they were only logged.
  - `overflow`: one count on the result and in the stats for script blocks and JSON regions past 200, embedded blocks
    the deadline skipped, refusals past the 1,000 listed, and deferral entries past 1,000.
  - Every child, empty comments included, costs at least 1 byte in the walk's bytes-touched budget (council r7 L2).
- **The guest deadline** (`guest-deadline`, `svg-too-slow`). The host sends its run's timeout less 15 s, and the guest
  stops there. SVGs not yet analysed become a counted range, and a single SVG still walking stops on its own, checked
  every 256 frames. So a slow input returns everything it produced instead of being killed. Losing the run would set
  `guestDown` and cost the document every free-rung visual. The deadline is a backstop: it fires only far outside
  every gate's measured range, so ordinary output stays deterministic.

### Crash and timeout containment per unit (council round 8, structural)

Rounds 5–8 each found one more hot path. Rather than keep chasing them one at a time, the guest now contains every
unit, so no gate-passing input can take the guest down and cost the document its other visuals.

- **Worker per input.** `scripts/chart-export-extract.mjs` runs each input (the source document, or each Doppler
  figure of a batch) in a `worker_thread` (`scripts/chart-export-worker.mjs`).
  - Each worker gets `resourceLimits` with a 1,536 MB old generation, leaving the 4 GiB VM ample room.
  - Workers keep the V8 flag (`--disallow-code-generation-from-strings` is process-wide) and zod `jitless` (the
    bundle's first import).
- **Units stream as they finish.** The extractor numbers its units in document order: an SVG's analysis, an HTML or
  JSON embedded-spec scan, an Office chart part. It reports each finished unit's output to the parent straight away.
- **One failure, one counted loss.** A worker that crashes, runs out of heap, or overruns a unit (15 s, or the deadline)
  is terminated.
  - That unit is recorded as `unit-crashed` or `unit-timeout`, a counted closed reason with the unit's ordinal.
  - A fresh worker continues after it, skipping every finished or failed unit, with SVG ordinals and the visual cap
    kept where they were.
  - Past the deadline, a last worker only counts what is left.
- **Unchanged output.** With no failure, the worker's own result is returned unchanged, identical to an uncontained run.
- **Host side.** A refused or failed guest run is recorded as `guest-unavailable`: the source, and each figure not run
  because the guest was down. A run the org's free-VM cap turns away is recorded as `vm-cap`. The document's other
  visuals survive either way.
- **Cost:** measured on the parser-VM shape, a worker that imports the bundle and runs one extraction takes **74 ms**,
  against 0.4 ms inline. That is about **74 ms per guest run** (once per input), small next to the VM command itself.
  Batching units into fewer workers would save nothing more: there is already one worker per input, plus one per
  failure.

**Point fixes that keep units cheap (council r8):**
- **Office:** `ptCount` and the point loop are clamped to `maxPathVertices`; a declared 2³²−1 was the loop bound.
- **Numbers:** `finiteOrNull` refuses over 512 characters before any regex, and uses an unambiguous pattern with the
  same language (20,000 seeded equivalence cases).
- **Workbooks:**
  - One resolver per embedded workbook per package, not one per chart part.
  - A per-input cell budget (2,000,000, `workbook-too-large`), checked before each sheet is parsed.
  - Deadline checks in the series loop and while reading sheets.
- **Text:** `richText` joins only innermost paragraphs, each cut to 4 KiB.
- **Scanners:** lowercase ASCII only, so a Turkish `İ` no longer shifts indices (M1). The equivalence test's alphabet
  now has `İ`, `ſ`, the Kelvin sign and astral characters.
- **Embedded specs:** JSON regions past 200 per block, over 2 MiB or too deep, and Plotly calls past 50 are all counted
  in `overflow`. A Plotly data region several calls share is parsed once.

**Measured on the parser-VM shape: every round-5 to round-8 repro through the real contained guest.** Each input was
run by `run-guest-in-modal-vm.mjs` and `guest-repro-run.mjs` exactly as production runs it: Modal `runtime: "vm"`, 2 vCPU,
4 GiB, network blocked, V8 flag, `budgetMs` 45 s, killed at 60 s.

| repro family | worst input | wall | peak RSS | outcome |
|---|---|--:|--:|---|
| r8 Office: `ptCount` 2³²−1 / 300k-digit value / 300 KB Vega 300k-digit value | `multiLvl`, `fin300k`, `finVega300k` | 0.19–0.22 s | 108 MB | both charts exported each time (was OOM / killed at 60 s) |
| r8 embedded workbook: 8 chart parts × a 16 MB workbook | `embwb8` | 2.6 s | 545 MB | good chart exported, 8 parts `workbook-too-large` (was OOM at 39.8 s) |
| r8 Turkish `İ` before an SVG and a Vega-Lite spec | `turkish` | 0.20 s | 91 MB | both exported (one was refused, one lost uncounted) |
| r8 Plotly: 50 calls over one 1.5 MB array / EPUB of 25 × 3 such blocks | `plotlyEpub` (20 MB) | **32.2 s** | 307 MB | 27 visuals, completes before the deadline (was 45.9 s, cut by the deadline) |
| r7 raw-text scans (comment `<script`, 2 MB HTML, 200-part EPUB) | `epubScript200` | 0.63 s | 169 MB | complete |
| r7 L2 empty comments × `<use>` | `emptyCmtEpub90` | 1.7 s | 287 MB | 2 exported, 90 `svg-use-bomb` |
| r6 per-frame cost (`rgb(`, `x` split, deep nesting) | `deepEpub300` | 7.1 s | 280 MB | complete |
| r5 walk / diagram (hidden children, nested `<use>`, Mermaid) | `mermaidEpub200` | 2.1 s | 293 MB | 200 exported |
| gate-passing worst: 400 text-heavy at-cap SVGs | `textEpub400` | 12.2 s | 282 MB | 256 exported, 144 counted `visual-limit` |
| injected crash / hang / out-of-memory in one unit of a 100-chart page | `legit+crash`, `+hang`, `+oom` | 0.33 / 2.3 / 2.7 s | 103 / 111 / **1,632** MB | 99 exported, 1 `unit-crashed` / `unit-timeout` / `unit-crashed` |
| 100 ordinary bar charts | `legit` | 0.24 s | 109 MB | 100 exported |

- **Every input exits 0 with a result.** None ends in `guest-unavailable`.
- **Worst wall time:** 32.2 s (the Plotly EPUB), inside the 45 s deadline. Any longer input is cut at the deadline and
  counted, so the bound is the deadline plus one unit, with the unit itself capped at 15 s by the containment.
- **Worst memory:** 1,632 MB, when a unit is driven out of heap on purpose. That is the 1,536 MB worker cap plus the
  parent, about 40% of the VM, and it is the most any input can use. Without injected faults the peak is 559 MB.
- **Every SVG, part and candidate is accounted for:** exported, skipped with a closed reason, counted in a deferral
  range, or counted in `overflow`.
- **Superseded:** round 7's "12.1 s" walk-bound worst case still holds (12.2 s here), but round 8's Office and number
  repros were not bounded by it. They are now, and containment covers whatever is found next.

### Output bounds (council round 9)

Containment bounds what a unit may cost, not what it may produce. Round 9 found the gap: 32 series sharing one
2,000-row range of 200-character labels serialize to 39.5 MB from an 85 KB XLSX, so the guest exited 1, and a 40-chart
copy was killed out of memory at 3.7 GB. Output is now bounded at three levels, each one cuts or counts and never throws.

- **Per chart.** `finalizeChart` keeps each chart within `maxChartPoints` (20,000) and `maxChartBytes` (512 KiB,
  counted in UTF-8 bytes plus a fixed per-point overhead). Past either it cuts the chart, keeps it and marks it
  `truncated`.
- **Per input.** `pushVisual` keeps an input's visuals within `outputBudget` (default `maxOutputBytes`, 12 MiB, under the
  16 MiB result cap and a small share of the VM's memory).
  - A visual that does not fit is counted under the new closed reason `output-limit`.
  - Once the input is full, later Office chart parts and SVGs are counted without being parsed.
  - Bytes ride the resume skip list (`UnitCharge {visuals, bytes}`), so a worker restarted after a failure starts from
    the right total.
- **Per merge and per batch.** After a failure, the parent re-checks the same budget while merging units, counting
  any excess as `output-limit` or `visual-limit`. The figures of one batch share one budget. The 16 MiB check stays,
  as an assertion only.
- **Per unit in the worker → parent stream.** A unit's message carries only the visuals that fit the budget, so it is
  bounded by the same 12 MiB plus the capped refusal and deferral lists.

**Cheaper on the way:**
- **Office labels.** Series in one chart usually share one category range, so each distinct label is cleaned once per
  chart. `cleanLabel` also skips its code-point copy when nothing needs cutting. Output is identical; the 40-chart
  repro went from 25 s to 2.8 s locally.
- **Plotly windows.** The call windows of one block share one scan budget: 4× the body, at least 16 MiB. A call finds
  its data in the first few regions, so ordinary pages use about one pass. Nested or unclosed calls stop at the budget,
  and the calls left are counted in `overflow`. The r8 Plotly EPUB went from 32–43 s to 14.9 s with the same 27
  visuals.

**Lows:**
- **L1.** Failures no longer stop an input after 7 workers; workers continue until the deadline.
- **L2.** A crash outside any unit is recorded as a counted `unit-crashed` deferral, as well as a refusal.
- **L3.** The fault-injection hooks sit behind the build-time constant `__CHART_GUEST_TEST_HOOKS__`.
  - The production bundle is built with it `false`; the bundle script and the image probe (`testHooks === null`)
    both check this.
  - Workers get an empty environment.
  - No environment variable, `DOCSLURP_PARSER_ENV_ALLOWLIST` included, can enable the hooks; a test sets them all on
    the production guest and gets the ordinary result.
  - The containment tests and the Modal runner build their own hooks-enabled bundle beside copies of the guest
    scripts.
- **L4.** `richText` marks paragraph ancestors in one pass.

**Measured on the parser-VM shape** (same harness as round 8; every round-5 to round-9 input in one run, 35 runs):

| input | what | wall | peak RSS | result | outcome |
|---|---|--:|--:|--:|---|
| `amp1cjk` (85 KB XLSX) | 1 chart, 32 series × 2,000 CJK labels | 0.40 s | 121 MB | 0.49 MB | 1 chart, `truncated` (was exit 1, 39.5 MB) |
| `amp2ascii` | 2 such charts, ASCII labels | 0.49 s | 143 MB | 0.86 MB | 2 charts, `truncated` |
| `amp8small` | 8 charts, 300 rows | 0.43 s | 132 MB | 3.9 MB | 8 charts, `truncated` |
| `amp40cjk` (129 KB) | 40 such charts | 1.4 s | 246 MB | **12.2 MB** | 25 charts, 15 counted `output-limit` (was OOM at 3.7 GB) |
| `dash10` | legitimate 10-chart dashboard, 4 series × 365 dates | 0.36 s | 125 MB | 0.40 MB | 10 charts, none truncated |
| `dash10wide` | 10 charts, 32 series × 2,000 dates | 0.91 s | 221 MB | 1.9 MB | 10 charts, each cut to 20,000 points |
| `plotlyEpub` (20 MB) | r8 Plotly EPUB | **14.9 s** | 293 MB | 0.93 MB | 27 visuals, 2,925 calls counted in `overflow` |
| `textEpub400` | gate-passing worst | 15.3 s | 282 MB | 0.20 MB | 256 exported, 144 `visual-limit` |
| `embwb8` | 8 parts × 16 MB workbook | 4.1 s | 545 MB | — | 1 chart, 8 `workbook-too-large` |
| `legit+oom:svg[50]` | injected out-of-memory | 3.6 s | **1,637 MB** | 65 KB | 99 exported, 1 `unit-crashed` |

- **Every input exits 0.**
- **Worst wall time:** 15.3 s (down from 32.2 s in round 8).
- **Largest result:** 12.2 MB, inside the 12 MiB visual budget plus envelope, under the 16 MiB cap.
- **Worst memory without injected faults:** 549 MB. With a fault it is 1,637 MB, the worker cap plus the parent.
- **Every other round-5 to round-8 repro:** unchanged outcomes, within ±1 s of round 8.
- **Startup:** 92 ms per input on this run (74 ms in round 8; the same order).

### Optional V8 compile cache (for the inline path, #369)

The guest accepts an optional `compileCacheDir` in its request: an absolute, normalized path of at most 512
characters; anything else is refused.
- **Off by default.** Without the field nothing changes.
- **When set,** the parent and each unit worker call `module.enableCompileCache(dir)` before importing the bundle.
  Both import a fixed path, so no new loading surface. Each worker then reuses the bundle's compiled code instead of
  compiling 960 KB again.
- **Flags unchanged.** It caches compilation of the fixed bundle and script files only. `--disallow-code-generation-
  from-strings` and zod `jitless` stay as they are; a test checks that `new Function` and `eval` are still blocked with
  a warm cache.
- **Mount it prepared and read-only.** A cache the guest can write could carry compiled code from one document's run to
  the next. So the directory should be filled ahead of time (for example at image build) and mounted read-only. A
  read-only warm cache measured the same as a writable one.

Measured on the parser-VM shape, in three separate sandboxes (`worker-startup.mjs`, `guest-startup.mjs`; medians of
15):

| | without cache | warm cache | saved |
|---|--:|--:|--:|
| worker startup (spawn, import, one extraction) | 44.6 / 64.3 / 97.3 ms | 40.0 / 53.2 / 89.7 ms | 5–11 ms |
| whole guest command per document (parent + worker, one small SVG) | 131 / 170 / 285 ms | 113 / 146 / 244 ms | 19–41 ms (14–17%) |

- **Cold cache:** the first run, which fills it, costs about the same as no cache (+1–4 ms).
- **Size:** the cache is one file of 326 KB.
- **Caveat:** the VM sandboxes ran as root, so read-only there is enforced by the mount, not by file modes. Locally,
  as an unprivileged user, the read-only cache was 141 ms against 172 ms without one.

### Caps on every result path, stable resume, fair chart cuts, read-only cache (council round 10)

- **M1: one set of field caps, everywhere.**
  - `result-caps.ts` holds the caps: locator 512, sheet 200, generator 40, reason 120, digest 3,200.
  - The extractor's result, each unit delta before it leaves the worker, and `reassembleUnits` all apply them.
    Before this, a unit failure skipped them, so a long EPUB or Office part name made the host reject the whole result.
  - `fitResult` holds any result to a byte budget. It cuts refusals first (counted in `overflow`), then visuals
    (counted as `output-limit`), and never throws.
  - Reassembly uses it, the guest's final 16 MiB guard degrades through it, and a batch is held to an equal share per
    figure.
- **L1: stable unit ids on resume.** Each unit delta and its resume charge carry the input's full state, and a resumed
  worker replays it rather than re-deriving it. A crash after the budget fills now costs exactly that unit: the same
  visuals and the same total count as the run without a fault.
- **L2: real size, fair cuts.**
  - Each point is charged its real JSON size, escapes included.
  - Series fill round-robin by row, so an over-budget chart keeps every series, each cut to the same length.
  - Charts over the budget now use it fully (about 0.5 MB each) with all their series. An input of many such charts
    therefore keeps fewer of them before `output-limit`: `dash30date` keeps 24 of 30, each with all 32 series, where
    before it kept 30 with 4 series each.
- **L3: the cache must be read-only to the guest.**
  - The guest uses `compileCacheDir` only if it cannot write it: a probe write in the directory and its subdirectories,
    plus `W_OK` on each file, catches root on a read-write mount. Entries owned by the guest's own non-root uid are
    refused, because it could chmod them back.
  - Otherwise it runs without the cache, with identical output, and logs the reason. An inherited `NODE_COMPILE_CACHE`
    is refused outright.
  - **Preparing the cache:** `scripts/chart-guest-compile-cache.mjs` prepares it. Node keys the cache by uid, so run it
    as the guest user with the same flag, then chown the directory to root and mount it read-only.
  - **Verified:** a test runs the guest on a prepared read-only mount (`unshare`) and checks, from Node's own
    compile-cache log, that the cached bundle was accepted in both the parent and the worker.
  - **Deployment requirement (council r11 I3).** The in-guest check stops one run leaving compiled code for the next,
    and no more. Use the cache only with **one VM per job**, or with the cache on a **hypervisor-level read-only disk or
    image layer**, and **never under a parent directory the guest can write**. The check cannot cover three cases:
    - a root guest in a long-lived VM could remount the cache read-write;
    - a read-only alias of a path that is still writable elsewhere in the VM passes the probe;
    - concurrent runs under a writable parent can swap the directory between the check and the load.
  - **Host side (council r11 I2).** The host strips every `NODE_*` variable from parser commands, whatever
    `DOCSLURP_PARSER_ENV_ALLOWLIST` says. Node acts on `NODE_OPTIONS`, `NODE_COMPILE_CACHE` and `NODE_PATH` before any
    guest code runs, so the guest's own refusal would come too late.
- **I2:** the Plotly budget test counts characters scanned, not wall time.

**Parser-VM shape, one run, 50 inputs (rounds 5 to 10 plus faults):**
- **Every input exits 0.**

| input | wall | peak RSS | result | outcome |
|---|--:|--:|--:|---|
| `longLocEpub` + crash (64 KB-class part names) | 0.23 s | 91 MB | 1.9 KB | 1 chart kept, 1 refusal, 1 `unit-crashed`; locators ≤ 512 (was `invalid-guest-result`) |
| `divergeEpub` + crash after the budget fills | 0.84 s | 236 MB | 12.19 MB | 28 visuals, as without the fault; 3 `output-limit` + 1 `unit-crashed` = the fault-free 4 |
| `amp200bslash` (escaping labels) | 1.07 s | 269 MB | 12.49 MB | 24 charts each ≤ 512 KiB serialized (was 863 KB each) |
| `dash10date` (32 series × 2,000 days, 10 charts) | 0.82 s | 260 MB | 5.2 MB | 10 charts, every one keeping all 32 series |
| `dash30date` | 1.55 s | 374 MB | 12.49 MB | 24 charts with all series, 6 `output-limit` |
| `plotlyEpub` (r8) | 9.7 s | 350 MB | 0.93 MB | unchanged: 27 visuals |
| `textEpub400` (gate-passing worst) | 9.3 s | 279 MB | 0.20 MB | unchanged |
| injected OOM in 1 of 100 charts | 2.1 s | 1,638 MB | 65 KB | unchanged: 99 kept, 1 `unit-crashed` |

- **Largest result:** 12.49 MB.
- **Worst peak:** 560 MB without injected faults.
- **Whole guest command per document**, run through the same `unshare` wrapper for each mode:

  | cache | median |
  |---|--:|
  | none | 166.8 ms |
  | writable (refused, so run without) | 172.7 ms |
  | prepared, read-only | **151.1 ms** |

  The read-only cache saves about 16 ms (9%).

**Round 11 (council-clear) follow-ups:**
- **Counts-only fallback:** `fitResult`'s fallback is host-valid. It never emits a zero count or `overflow: 0`, and it
  keeps deferrals collapsed to one entry per reason.
- **Cuts with a full deferral list:** visuals cut while the deferral list is full are counted in `overflow`.
- **Coverage:** neither case is reachable in production; the smallest budget the guest uses is about 419 KB. Both now
  have unit tests, plus a seeded invariant that every visual, refusal and deferral stays counted.

### Guest hardening: zod `jitless`, the V8 code-generation flag, code-loading guard, image check

- **zod `jitless`, now effective (council r4 M1).**
  - Round 3 set it in `guest-entry.ts` after its imports had already built every schema, so it was a no-op.
  - zod reads the setting when each schema is constructed. `@docslurp/shared/zod-jitless`, a side-effect module that
    imports only zod, is now the guest's first import, and ESM evaluates imports in order.
  - `guest-bundle.test.ts` counts Function-constructor uses from before the bundle loads until after it extracts a bar
    chart, and requires **0**. Round 3's version made 5.
  - The round-3 "134 vs 141 ms jitless cost" compared two identical configurations; it is withdrawn and was not
    redone.
- **V8 enforcement.** The host runs every guest with `node --disallow-code-generation-from-strings`, so `eval` and the
  Function constructor throw. The real-guest tests run under the flag, and the parser-VM contract passes under it.
- **The source scan is a creep guard, not a boundary (council r4 I1).** The build still fails if our own bundled
  sources (zod excluded) use the Function constructor, `eval`, `process.binding`, `dlopen`, `getBuiltinModule`,
  `createRequire` or `import(`. It misses indirect forms such as `Reflect.construct(Function, …)` or `(0, eval)(…)`.
  The V8 flag is the enforcement.
- **The parser image passes its contract (council r3 I3).**
  - `worker/Dockerfile.lean`, the `worker-images.yml` recipe, was built locally from this branch.
  - `node /app/worker/scripts/parser-vm-contract.mjs` ran inside the image as uid 1000 with no network and exited 0.
    The bundle manifest's paths resolve through the `pnpm deploy` layout, with `@docslurp/shared` under
    `worker/node_modules/.pnpm/...`.
  - With one byte appended to the deployed shared `dist/chart-export.js`, the same run exits 1 ("chart guest bundle is
    stale").

### Deferred pass (design; follow-up PR)

The deferred visuals are picked up later at low priority, off the document's critical path. It reuses the
figure-resume runner pattern from core #365:

- **What it reads:** `visualCandidates.deferred` entries `{ input, svgIndex, reason: "svg-document-limit", pageNumber,
  figureId }`: the SVG's ordinal within its input and a closed reason, never a name from the input (council r4 L1).
- **Queue:** lease columns on the document's extraction row, with no queue table: `chart_deferred_after`,
  `chart_deferred_lease_until` / `_owner`, `chart_deferred_failures` and `chart_deferred_blocked`.
  - They are set in the transaction that commits vision-extract stats with a non-empty `visualCandidates.deferred`.
  - A backstop sweep re-enqueues from `deferredVisualsOf`.
- **Runner:** a worker leader timer, behind `DOCSLURP_CHART_DEFERRED_PASS`, default **off**. While it is off,
  deferred entries stay recorded and nothing is lost.
  - It claims at most one document per organization (`for update skip locked` plus an advisory lock) and skips
    spend-paused organizations.
  - It batches deferred SVGs from several documents into one parser-VM run. Each input is staged from the document's
    source, or from its `doppler-figure:<figureId>` slot, and analyses the SVGs from the recorded ordinal onward,
    with the same per-SVG gate.
- **Merge:** finished visuals are added to the document's chart-export artifact and stats; still-deferred entries
  stay. VM time is a cost-only usage event (`billable: false`). Backoff is 2 min, 15 min, 2 h, then blocked after 3.
- **Not in this PR:** the migration, the runner and the merge. This PR records and persists the deferral, and adds the
  tested reader hook.

### Marker-cap calibration (parser VM shape; round 2, kept for the per-pair-test cost)

The per-pair-test cost (~3 ns) behind `maxMarkerPairTests` was measured with round 2's version of
`marker-cap-bench.mjs`, run through the guest bundle by `run-in-modal-vm.mjs` in a Modal `runtime: "vm"` sandbox (2 vCPU,
network blocked, Node 24.22.3), median of 3. Scenes pack the polyline vertices into one 3-unit cell and put the
markers in the next cell, so no marker short-circuits.

| scene | pair tests | time | per pair test |
|---|--:|--:|--:|
| 1 SVG, 2.5k vertices, no markers (parse + scene only) | 0 | 11 ms | |
| 1 SVG, 2.5k vertices × 4k markers | 1.0×10⁷ | 50 ms | 3.9 ns |
| 1 SVG, 2.5k vertices × 8k markers | 2.0×10⁷ | 62 ms | 2.6 ns |
| 1 SVG, 2.5k vertices × 16k markers | 4.0×10⁷ | 119 ms | 2.7 ns |
| HTML, 10 near-cap SVGs (0.4 MB), round-2 first-come cap | 5.0×10⁷, then refused | 0.41 s | |
| HTML, 100 near-cap SVGs (3.8 MB), round-2 first-come cap | 5.0×10⁷, then refused | 2.9 s | |

At about 3 ns per pair test, 5×10⁷ pair tests take ~0.15 s; the rest of the 100-SVG input is parsing and scene
building, about 27 ms per SVG here. The last two rows are round 2's design, kept for comparison with the schedule
above. Before any shared budget, the same 100-SVG input ran 5×10⁹ pair tests (still running
after 10 minutes on a loaded host, council round 2). The indexed loop over a flat coordinate array replaced a closure
with `for…of` destructuring, which the council measured as roughly 5–14× slower per pair test; the output is the same
(property test).

## Rejected

| experiment | result | why rejected |
|---|---|---|
| `NODE_COMPILE_CACHE` for the guest | 157–164 ms vs 151–154 ms without (import only) | no gain: the cost is module evaluation and resolution, not compilation. Also needs a cache baked into the image, because the VM wipes writes after each command |
| esbuild `--minify` on the bundle | within noise of the plain bundle (e.g. vl-bar JSON 101 vs 106 ms, 4-chart workbook 139 vs 144 ms; both within the ~5% noise) | no measurable gain, and a harder-to-read guest |
| skip `buildScene` for text-free SVGs (Doppler figures yield 0 visuals today) | not built | would change output: a text-free SVG over a limit returns a refusal today |
| drop zod validation from the guest | not built | the host rejects the whole result when one visual's spec fails validation; removing the guest-side check changes outcomes |
| skip the Doppler figure guest run when the figure SVGs contain no `<text>` (council fix round) | not built | needs the host to scan customer SVG bytes, which widens host-side parsing; the Doppler figure index carries no text signal; and a text-free SVG over a limit returns a refusal today, so output would change |

## Correctness gates

- Every workload's guest output (`result.json`) is hashed per run. Every arm produced the same hash on every workload,
  in the local runs (9 runs × 3 arms) and both VM runs (5 runs × 3 arms; 7 runs × 4 arms). No run failed and no output
  was nondeterministic.
- Worker tests: `src/chart-export` and `src/lib/quarantine*` / sandbox suites pass. Under host load average >100, some
  pre-existing tests hit the 5 s vitest timeout; they pass with `--testTimeout 120000` (config unchanged).
- `tsc` on the worker is clean.

## Spend

Three Modal VM runs: 9.8 s (failed: harness file missing), 108 s (3 arms) and 122 s (4 arms), 240 VM-seconds in all,
within the test budget. No model calls.
Round 9: two containment-proof VM runs (169 s and 99 s wall, one VM each) and four short compile-cache startup runs
(about 7 s each). Round 10: one VM run, 94 s wall. No model calls.

## Open findings (not changed here)

1. **`svg-geometry` finds nothing in Doppler figure SVGs.** Doppler emits axis and tick text into the Markdown, not into
   the figure SVG, so every figure returns `no-text` and is dropped. Each document still pays a guest run (~0.1 s VM
   time after this change) for zero visuals. Two options: pass the figure's text spans into the guest, or have Doppler
   record in the figure index whether a figure SVG carries text, so the host can skip the batch without reading the
   SVG bytes (a host-side scan was rejected above). Either way, the
   "Measure the SVG rungs on real vector charts" TODO stays open: this corpus is generated, not real.
2. The other parser-VM guests (`quarantine-inspect`, `table-routing`, `html-embeds`, `structured-json`) import the
   same `@docslurp/shared` index and likely pay the same ~0.3 s per run. Bundling them the same way is a likely
   follow-up; it was not measured here.
3. The VM's per-command overhead (exec, staging, reset) is now likely larger than the guest itself for small inputs.
   Measure it with the provider before batching further (for example, source and figures in one command).

## Reproduce

```sh
# corpus (outside the repo; generated, seeded; only the Office zips differ byte-wise between generations)
uv venv venv && VIRTUAL_ENV=venv uv pip install matplotlib openpyxl python-pptx vl-convert-python
venv/bin/python -I performance/chart-export-free-rungs/gen_fixtures.py "$OUT"
# Doppler figures: pdftomarkdown --images-dir "$OUT/doppler-report" "$OUT/pdf/vector-charts-report.pdf" (same for -single)

# arms: copy worker/dist + worker/scripts per build into worker/.bench-arms/<name>/ (so @docslurp/shared resolves).
# The base arm is not in this commit: build it from the merge base, e.g.
#   git worktree add "$BASE" 0909f1da6 && (cd "$BASE" && pnpm install --frozen-lockfile && pnpm --filter @docslurp/worker build)
#   mkdir -p worker/.bench-arms/base && cp -r "$BASE/worker/dist" "$BASE/worker/scripts" worker/.bench-arms/base/
node performance/chart-export-free-rungs/bench.mjs guest  "$OUT" worker/.bench-arms/base,worker/.bench-arms/final out.json 7
node performance/chart-export-free-rungs/bench.mjs inproc "$OUT" worker/.bench-arms/final inproc.json 15
node performance/chart-export-free-rungs/summarize.mjs out.json            # --time wall inside a real VM
```

The VM confirmation packs each arm's exact loaded-module closure (recorded with a `module.registerHooks` load hook) and
the fixtures into a `node:24-trixie-slim` Modal sandbox (`runtime: "vm"`, the parser VM's default size, `blockNetwork`, no secrets,
isolated app). It runs the same `bench.mjs` there. That load hook and packing script are not committed, so the VM
numbers can be rerun only by recreating them; the local `bench.mjs guest` run reproduces the same arms on a host.
