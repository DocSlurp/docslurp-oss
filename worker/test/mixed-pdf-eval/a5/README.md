# Attempt 5: source-blind native preflight

**Unaccepted. All four build rounds are used. Do not run a fifth round or advance to pilot/full.**

The final round attempted all 15 authorized training families: IDs 1–17 except 6 and 12, ten authored pages each. Thirteen families passed the implemented native gates. E4-A and E4-B failed rendered visibility: each has 454 authored meaningful glyphs without dark rendered ink. Read-only inspection found later opaque paints over the failed glyphs in both the complete original Writer export and the native stream rewrite. The rewrite preserves those original pixels; it does not repair a producer's incorrect intersecting-object order.

The E2 first-page narrative also declares four observations despite six matrix rows. Its narrative interval describes the initial four-row range while the expanded matrix extends beyond it. These are unresolved Builder findings, not a defect shown to be inherent in the spec.

No acceptance or audit/judge score is assigned. A coordinator must decide the next attempt. A fresh Builder must not receive this attempt's E prose, worlds, labels or PDFs; sanitize reusable mechanisms separately.

## Scope and provenance

- Input: the 14 hash-verified allowlisted files from `a5-clean-r2`, plus its allowlist.
- `clean-inputs/` is a local ignored copy of the byte-identical external supplied runtime/spec snapshot. Restore it from `/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a5-clean-r2` and verify `allowlist.json` before historical reproduction. It includes the unchanged accepted P factory. No repository sibling v4 module is imported.
- New E authoring and mechanisms live only here. No other repository files were edited for this task.
- Durable output: `/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a5`.
- The Builder ran no pilot/full corpus, heldout/customer access, model API, paid workload or delegation, and made no Git commits. The coordinator later saved this failed implementation as a historical code checkpoint; inputs and generated artifacts remain external.
- Three local family workers maximum. All temporary variables point to `/home/dan/tmp/agents`.

The complete original Writer exports are retained as `native.writer-export.pdf`, alongside editable FODT/ODT. The final native PDF uses an E-only structural stream rewrite, with truthful pikepdf producer history. That step keeps original Writer paint operators/resources and exact pixels at 150 DPI; it orders disjoint fixed-envelope components according to a plan frozen before export. Graphics-state prefixes contain no text-show or paint operations. ReportLab owns its own complete native document directly.

## Implemented checks

Pinned cmap/advance/composite-outline support; simultaneous word/character/line and containment checks; strict authoring/world/support-plan schemas and hashes; exact table values, spans, separators, units and arithmetic; formula AST, rational result and recipe checks; native embedded-font/GID/origin measurement; leaf and semantic-parent IoU; actual chart boundaries, all colored data segments and legend associations; editable Writer cell/span references; 300 DPI visible-ink checks; opaque-cover geometry/color/order; independently frozen native stream permutations; 150 DPI canonical/permuted pixel comparison; 150 DPI whole-panel screenshots and native-origin outlined-body probes with omission/leakage and 300 DPI render comparisons.

Raw per-codepoint IoU is diagnostic. The spec's 0.70 IoU gate is applied to its defined occupied-support leaves, blocks and semantic parents. Meaningful glyph presence is exact; font-size and origin tolerances remain 0.3 pt and 2 pt. No numeric spec tolerance was relaxed.

## Entrypoints

These commands document the run; they do not authorize another attempt or stage.

```bash
export TMPDIR=/home/dan/tmp/agents TMP=/home/dan/tmp/agents TEMP=/home/dan/tmp/agents
# Use a graphics Python with the exact versions/hashes in round-4/tools.json.
python preflight.py --round 4 --workers 3 --scratch "$TASK_SCRATCH"
# Only after the complete native gate is clean:
python extras.py /path/to/round --workers 3
# Read-only reconciliation, with no PDF exports:
python postflight.py /path/to/round-4
python -m unittest discover -s . -p test_contracts.py -v
```

The existing fourth-round directory is immutable and cannot be rerun. The native driver exposes no pilot/full stage. Eleven focused negative tests passed; these do not substitute for actual multi-page native gates.

## Receipts

The output root contains `final-preflight-receipt.json`, `HANDOFF.md`, `round-history.json` and the original clean-input snapshots. Each round keeps worlds, authoring, support plans, source layouts, builder snapshots, tools/package/font hashes, native files and provisional failures. Round 2's initial native-clean assertion was invalidated when actual images exposed missing plot paths and stricter reference checks were added. Round 3 retained a failing Writer chart. Round 4 fixed that chart but exposed the two multi-page E4 visibility failures.

Final-round counterfactual producer pairs and native visibility probes were not promoted or completed after the failed native gate. Earlier constructed probes remain labeled diagnostics, not acceptance evidence.
