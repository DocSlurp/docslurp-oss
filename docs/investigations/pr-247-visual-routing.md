# PR 247: ineffective selector fix withdrawn

2026-11-01. Status: incomplete; do not merge as an omission fix.

Independent review reported MEDIUM: the selector test fabricated a chart route
with a layout-aware extractor hint. The real classifier assigns vision-rescue
to chart-or-figure; enrichment either preserves that hint or assigns vision-rescue.
The added selector clause therefore does not fix that real pipeline case.

Replaced the fabricated test with buildAdaptiveRoutingDecisionSurface input:
three generic pages, dense prose, a verified blank, and a dense native-text figure
with minor raster evidence. The actual classifier selects page 3 with vision-rescue.
All 28 legacy routing tests pass both with and without the proposed clause.
The clause is removed forward. This is characterization, not red/green proof of
a fixed omission. The previous PR before/after claim is withdrawn.

## Investigation limits and next evidence needed

Classification requires two of three chart signals: chart vocabulary, percentage
notation, and quarter/month notation. Generic diagrams without those combinations
may remain prose; competing form/table/specialized routes precede chart detection.
This is a candidate investigation path, not a demonstrated production root cause.

Raster authorization uses native word counts and coverage thresholds; structured
evidence additionally considers uncovered vector area. Inspect real per-page
evidence and the final decision before adjusting thresholds. Lowering thresholds
without a precision/cost test could add unnecessary calls.

Chart-data and diagram prompts already explicitly request plotted values and
relationships. Generic OCR/markdown prompts emphasize text and structure.
Prompt selection and output completeness need separate tracing; no prompt change
or provider experiment was performed.

Selected-only image manifests do not establish render loss: vision supports
on-demand rendering.

## Required coverage still incomplete

The characterization test verifies selection only. It does not prove selected
page 3 reaches rendering and vision, nor that unselected/blank pages cause no such
calls. No new integration proof covers exhausted/crossed caps preventing later
render/provider calls, malicious/oversized raster isolation rejection, wrong-tenant
or revoked/wrong-scope artifact exclusion, active routing authority versus
shadow/off legacy behavior, or fast mode excluding vision. These are explicit
blockers to claiming the requested implementation complete; no mock selector test
stands in for those boundaries.

No paid calls, held-out reruns, production changes, deployment, global configuration
changes, or subagents. No new general omission fix established. The draft remains
incomplete for coordinator follow-up; no merge requested.
