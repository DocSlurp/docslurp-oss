# Free chart-export rungs: guest CPU, memory and throughput (2026-11-13)

Scope: the deterministic, no-model chart rungs (`office-chart-xml`, `embedded-spec`, `svg-geometry`). In production each
document's source file, and separately its batch of Doppler SVG figures, runs through the parser-VM guest
`worker/scripts/chart-export-extract.mjs`, one fresh Node process per VM command.

## Outcome

**The guest spent most of its time loading modules, not extracting charts.** A typical chart needs 1–20 ms of
extraction, but every guest run first loaded the whole `@docslurp/shared` index (~0.3 s CPU, ~25 MB). It then resolved
~200 small ESM files, mostly zod. Two module-layout changes removed most of that. Two exactly-equivalent parser changes
then cut CPU on large and hostile inputs. Outputs are byte-identical across all arms.

**Release note: production needs a parser-VM image rebuild.** The guest code runs from the digest-pinned parser image,
not the worker image. Advancing the app's `core` pin and deploying does not change it. The speedup and the hostile-CPU
cap (`svg-marker-limit`) are live only after the parser image is rebuilt (`worker-images.yml`), `DOCSLURP_PARSER_VM_IMAGE`
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
| C4 | `fbb6d0077` + council fix: svg-geometry marker/vertex de-duplication: 3-unit grid pruning, exact test unchanged, pair tests capped at `maxMarkerPairTests` (5×10⁷, refusal `svg-marker-limit`) | spread-out vertices: points × vertices → close to points + vertices. Vertices packed into a few cells: still points × packed vertices, now stopped at the cap | Doppler figure extraction −15% in process; spread hostile fixture `markers-vs-lines.svg` (4 MB) **56.7 s → 1.5 s** CPU. Packed-cell scene (council M1, up to 8×10⁹ pair tests within the input limits): the grid alone gave no gain (old 36 s, grid 49 s, loaded host); the cap refuses it after 5×10⁷ pair tests | `analyzeSvgChart` output identical on all fixtures plus 3,000 random scenes; committed: seeded property test against the brute-force filter, pair-count tests of both hostile scenes (`__tests__/equivalence.test.ts`) |

C3 and C4 change guest CPU only within noise on normal documents, where startup still dominates. They pay off on
large workbooks and on hostile input. The old C4 cost reached the guest's 60 s timeout. A timeout is reported as
`guest-unavailable`, which also skips that document's remaining deterministic runs. With the cap, a packed-cell SVG is
refused as `svg-marker-limit` for that SVG only.

No limit was raised; `maxMarkerPairTests` is a new one. Every extractor still runs only in the parser VM, and refusal reasons are unchanged.

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
