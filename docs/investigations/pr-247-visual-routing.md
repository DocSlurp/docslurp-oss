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

## Follow-up: canonical content preservation

A synthetic regression now supplies chart axes, units, ticks, series, a printed
value table, directed arrows, and containment through the real canonical
reconciliation and extraction-contract rebuilding functions. All survive in
Markdown and raw text; untouched page content also survives. The test passes on
the unchanged implementation. This rules out dropping these Markdown structures
at that seam only; it is not a render/provider end-to-end regression.

`vision-extract.ts` passes `output.text` as replacement Markdown. The runtime
returns text, not a structured chart schema. Default model transcription prompts
explicitly flatten chart labels or forbid descriptions; the specialized
`chart-data` prompt explicitly asks for estimates when labels are absent. These
are concrete prompt-contract gaps relative to faithful visual relationships and
no inferred numeric values, but no model experiment establishes their causal
contribution or validates a replacement prompt. No production prompt changed.

Quality auto and routing auto are separate decisions: the active stored router
plan replaces legacy selection/model choice; routing off/shadow retains legacy
selection. Quality good forces every page in the legacy selector. A rendered
page alone therefore proves neither vision selection nor successful merge.

Fetched main was `7f3ec4e0`, already an ancestor of this branch. Deployed SHA was
not verified in this follow-up. Six reconciliation tests and the worker build
passed. No new security boundary changed; boundary integration coverage listed
above remains outstanding. This follow-up is diagnostic test coverage, not a
claim that the original visual extraction task is fixed.

## General instruction correction (2026-11-01)

Default OCR, markdown/layout, all three model-profile templates, and chart/diagram
templates now require legible axes, units, ticks, series/value associations,
arrows, containment and label relationships. Exact printed values remain distinct
from individually marked approximate readings supported by readable marks and
scales. Hidden values and invented relationships are forbidden; uncertainty stays
explicit in Markdown. No output schema changes.

Explicit named form/schema-form/image-label overrides remain unchanged; unknown
template keys retain the existing OCR fallback. Fallback providers receive the
already constructed prompt. No free-text prompt override is introduced.

There is no prompt-version response cache in this path. Distributed completed
page tasks are persisted per run and rehydrated into the document/page map on
resume; they remain historical evidence and are not invalidated (which could
repeat billed calls). New runs use the corrected instructions. Raster caching
contains images, not prompt responses.

Validation: 23 focused prompt/profile and synthetic canonical-reconciliation tests
passed; shared and worker build passed, including TypeScript checking.
These establish instruction construction and retention of supplied evidence only.
No image-grounded model calls were made and no quality improvement is measured.
Full provider/render boundary integration coverage listed above remains pending.
