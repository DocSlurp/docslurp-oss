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
- Attempt 2, audit round 3 (artifact revision a2-r5): score 75, rewrite-spec.
  Structural checks passed all 180 pages and native-document tell/overlap checks
  passed, but the independent Terra audit found missing monospaced technical rules
  and formulas (high, spec), generic producer metadata (medium, build), and chart
  section order inconsistent with readingOrder (medium, build). Earlier chart gold,
  outline, occlusion and rotation gaps improved. These prototypes remain unaccepted.
- Attempt 3: strengthened source-free spec explicitly requires technical formulas,
  software metadata and aligned gold ordering. Spec overlap checks passed for all
  three authorized sources (zero shared eight-word sequences). A fresh Terra Builder
  completed 18 PDFs / 180 pages in a3-r2; prior code and artifacts were excluded from
  its inputs. Structural rerun passed and all 383 artifact hashes were independently
  confirmed, but the independent audit found four high misses: source-relative
  two-column geometry and body length (spec), subtitle-only LibreOffice production
  and conflicting side-panel reading order (build). Repeated content was a medium
  miss. The scorer returned 35, stop, with three spec attempts exhausted. The best
  recorded audit score was 75 in attempt 2; no attempt passed acceptance.

The attempt-3 reports, manifest, history, spec and concrete corrections are archived
under `mixed-pdf-fools-gold-audit/rejected/attempt-3`; original PDFs and source artifacts
remain intact. No frontier judge, full expansion, accepted threshold search or savings
measurement followed the rejection. The user extended the skill's attempt limit to
20 on 2026-10-27 and selected GPT-6.1 Sol. A measured specification rewrite is active
on Sol after Terra failed at capacity before starting. Independent visual validation
must precede any expansion; the first three attempts remain rejected.

## Attempt 4 measured handoff

The Sol Describer measured all 30 authorized development pages, including rendered
outlined text and screenshot regions. The clean contract distinguishes the three
matched prototypes from 15 enriched class/layout contracts, with block geometry,
text budgets, table/formula semantics, complete producer paths, strict provenance
schemas and all 90 family assignments. This is a design contract, not an earned
quality score. Raw measurements and overlap history remain coordinator-only.

The isolated Builder handoff is stored outside the repository at
`mixed-pdf-fools-gold-handoffs/a4/`. Its exact file hashes are:

- `spec-a4.md`: `dfa72c7c2afe2f6d3b8374d96c3153a9ef4a91ebd93f880a1036750c6f8a4c42`
- `spec-a4.json`: `befb3b2dc772644da912dbe6ffd04e2757ce986eb7c13e7449d5e3cfcd2b0c6c`

All six final skill overlap checks passed with zero matching eight-word sequences,
maximum shared run three words and zero entity hits. Earlier ordinary-word flags
were preserved, rephrased in the handoff and rechecked. The Describer reports 23
schema behavior fixtures and 19 contract fixtures passing. A fresh source-blind
Sol Builder is implementing the contract and may generate only the three training
prototypes before independent review. No full expansion or measurements are accepted.

Before measuring the new corpus, the sealer must validate realized decoys against
immutable authoring plans. Current sealing deliberately rejects the a2-r5 schema's
plan/exclusion differences; no measurement has bypassed this check.

Exact machine-readable audits, score decisions, overlap reports and original rejected
artifacts remain in external evaluation storage under `mixed-pdf-fools-gold-audit`.

## Production verification council, 2026-10-27

Independent GPT-6.1 Sol reviewers `/root/stack_adversarial_review` (adversarial)
and `/root/stack_correctness_review` reviewed integrated stack `f014a95a` and
Poppler head `f41d3db2`, without external corpus inputs or labels. Both blocked
reconciliation that combined one policy's quality with another policy's timing.
The adversarial reviewer also blocked promotion using partial heldout panels.

Fix `579c2799` binds reports to policy, evaluation identity and completed inventory,
revalidates hash-bound case results and recomputes the quality gates. Promotion
requires every manifest heldout family and exactly 18 families. Negative tests
reject wrong policies, splits, identity/inventory hashes, changed summaries and
omitted families. Both independent reviewers approved round two with no unresolved
high or medium findings. They did not certify the existing parser isolation gap.

The correctness reviewer also requested explicit Linux `poppler-data` installation;
this is fixed in `41c72912`. Local checks passed 52 routing tests, six prerequisite
negative tests, 28 evaluation tests and 13 integrity-screen contract tests. Runtime
image verification, deployment and measured production costs remain separate gates;
no corpus acceptance, extraction-quality gain or dollar-saving claim follows from
these checks.
