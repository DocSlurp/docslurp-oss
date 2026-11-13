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

**Measured on the parser-VM shape** (council round 7 head). Modal `runtime: "vm"`, 2 vCPU, 4 GiB, network blocked,
Node 24.22.3. Each input runs in a fresh process exactly as the production guest is run: with
`--disallow-code-generation-from-strings`, V8's default heap, and the guest's 45 s deadline, via
`marker-cap-bench.mjs` modes. Several rows ran three times; ranges show VM placement noise.

| input | size | wall time | peak RSS | exported | skipped / counted | before |
|---|--:|--:|--:|--:|--:|---|
| r7: SVG whose comment holds `<script ` × 8k / × 80k | 0.06 / 0.64 MB | 5 ms | 60 MB | 0 | 0 (comments are never scanned) | 0.41 s / 20.5 s |
| r7: EPUB: bar chart, 3 such 640 KiB SVGs, bar chart | 1.9 MB | 18 ms | 69 MB | 2 | 0 | 54 s |
| r7: HTML, `<svg ` × 200k / `<script>` × 125k | 1 MB | 8 / 7 ms | 63 MB | 0 | 0 | 23.5 / 13.3 s |
| r7: HTML, a JSON script then `<svg ` × 400k | 2 MB | 16 ms | 66 MB | 0 | 0 | **killed at 60 s** |
| r7: EPUB of 200 parts of ~300 KB unclosed `<script>` | 59 MB | 0.40 s | 319 MB | 0 | 0 | ~ timeout (extrapolated) |
| r7 L2: ~93k empty comments × 999 `<use>` / EPUB of 90 + 2 bar charts | 0.66 / 59 MB | 55 ms / 1.5 s | 89 / 497 MB | 0 / 2 | 1 / 90 `svg-use-bomb` | 234 ms each |
| r6: EPUB of 8 `rgb(`-style SVGs / 9 `x`-split SVGs | 0.16 / 5.9 MB | 39 / 22 ms | 87 MB | 0 | 8 / 9 skipped | > 75 s |
| r6: EPUB of 300 deep-nesting SVGs (no axis, all analysed) | 61 MB | 3.2–6.9 s | 500–503 MB | 0 | 0 | > 75 s |
| r5: EPUB of 20 hidden-children SVGs | 13 MB | 0.47 s | 262 MB | 0 | 20 `svg-too-dense` | 129 s |
| r5: EPUB of 200 hostile Mermaid SVGs | 56 MB | 1.5 s | 448 MB | 200 | 0 | ~230 s |
| EPUB, 400 text-heavy at-cap SVGs | 41 MB | **5.8–12.1 s** | 367–376 MB | 256 | 144 counted `visual-limit` | |
| EPUB, 400 rect at-cap SVGs | 57 MB | 3.9 s | **539 MB** | 256 | 144 counted `visual-limit` | |
| 100 ordinary bar charts | 0.07 MB | 43 ms | 81 MB | 100 | 0 | same |

- **Worst case measured:** 12.1 s and 539 MB peak. Both are inside the 45 s guest deadline and the 60 s host timeout.
- **Memory:** 539 MB is about 13% of the 4 GiB parser VM. The production guest runs with V8's default heap, not the
  1 GiB cap earlier rounds' benches used, so this table matches production (council r7 I2).
- **Fully accounted for:** every input completes. Every SVG, part and candidate is exported, skipped with a closed
  reason, or counted in a deferral range or `overflow`.
- **Known, not a bug (council r7 I3):** draw.io exports carry the whole diagram in the root `content` attribute, often
  over 32 KiB, and a data URI under a non-standard prefix (`ns1:href`) is not exempt. Both are skipped as
  `svg-too-dense`, counted and logged. Neither yields a visual today, because there is no draw.io diagram path.
- **Superseded:** round 6's "5.9 s" was a single run, and round 7 found raw-scan shapes that were killed at 60 s.

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
