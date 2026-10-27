# Evaluation review disposition

Status: draft; no accepted corpus measurements, production threshold, or savings.
The standalone integrity screen passed the earlier exploratory v2 corpus (540 cases,
1,113 production files). That does not accept the new Fool’s Gold corpus.

Two independent source-only reviewers ran each council round. They used invented
examples and did not open corpus inputs, labels, or stored predictions. Rounds 1–3
used GPT-6 Astra; their records are preserved. After live pricing established that
model reached the evaluation exclusion threshold, subsequent reviewers used GPT-6.1
Sol. No further Astra evaluation delegation is authorized.

| Findings | Disposition |
| --- | --- |
| Receipt existence alone permitted heldout access | Validate policy, code/tool identity and completed tuning inventory before access |
| Stale case scores could receive new provenance | Immutable complete per-case identity; original provenance retained |
| Hidden text survived case/line-wrap changes | Normalized exclusion matching and negative tests |
| Token bags accepted reversed prose and table rows | Sequence-sensitive sections, ordered table rows and primary order checks |
| Missing labels/pages or entire families could disappear | Exact page identities, source binding, panel membership and result hashes |
| Renamed or reordered pages crossed splits | Canonical individual-page content identity checked across splits |
| Baselines could be faster than the selected ladder | Fixed baselines and exact 20% proxy participate in selection |
| Aggregate eligibility hid hard-share acceptance regressions | Per-hard-share quality and acceptance gates |
| Font/mask ownership and image area were incomplete | Indirect stream traversal, deduplication, union area and rotation tests |
| Nonapplicable tables forced prose scores to zero | Explicit null dimensions excluded from gates |
| Numeric substitutions, distant context swaps and grouping loss passed | Primary numeric, ordered numeric, authored-statement and operator/grouping checks; mutation tests |
| Timing reused cache entries and trusted a stored environment | Explicitly disable cache reads; recompute live extraction identity before timing |

Round 5's two reviewers reported only the numeric context-window and grouping issues;
the subsequent regression fixes preserve grouping and bind numbers to complete authored
statements. These are strict preservation checks rather than paraphrase judging. The
final corpus and fresh timing still require their own checks; source review establishes
neither an extraction-quality result nor a measured speedup.

The latest focused suite contains 27 tests. The real Mastra wrapper returns score 1
on a separate invented exact-reference self-check. Reports require paired fresh
timing with immutable sample hashes, heldout relative quality constraints, and absolute
quality floors before marking an improvement accepted.

## Fool’s Gold attempts

- Attempt 1: rejected; score 0, rewrite-spec. Full scans retained underlying text,
  gold omitted printed content, and the generator did not complete required features.
- Attempt 2, revision 2: independent audit plus coordinator findings yielded score 55,
  revise-build. Tell and overlap checks passed; chart text references and layer/rotation
  coverage require corrections. Three training families, 18 PDFs / 180 pages, passed
  structural checks. This is provisional evidence only.
- Attempt 2, revision 3: builder active. Independent final visual judge and full
  corpus expansion remain pending.

Exact machine-readable audits, score decisions, overlap reports and original rejected
artifacts remain in external evaluation storage under `mixed-pdf-fools-gold-audit`.
