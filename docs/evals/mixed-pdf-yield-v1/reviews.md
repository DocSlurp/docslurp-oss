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

The attempt-4 Builder completed the 18-PDF / 180-page prototype at
`mixed-pdf-fools-gold-a4/round-3`. The coordinator reran the frozen structural checker:
18 PDFs, 180 pages, zero reported misses. Seven focused contract tests also passed.
The repeat invocation delivered 18 byte-identical PDFs; label bytes differ because
they retain actual execution paths and producer-history hashes, while the Writer
native export retains its actual export timestamp. Immutable authoring/world hashes
match. The independent source-visible audit is still pending, so these observations
do not establish fixture acceptance or extraction quality.

The artifact directories preserve four generation invocations: an initial failed
pixel check, an intermediate build, the final build and its repeat. Frozen sources
used by the final and repeat builds are retained with their hashes. Two current
repository helpers additionally contain unexecuted enriched-class corrections;
neither enriched outputs nor the balanced pilot/full corpus have been validated.
Independent review must use the frozen source snapshot for prototype provenance.

The first attempt-4 external audit found no observed delivered render/gold
contradiction and a source-relative native block IoU minimum of 0.718 across 321
comparable blocks. It found one high build-caused validation gap: schema-valid
interval AST bounds and cell units could disagree with the world/printed reference
while the checker passed. All 30 actual interval references passed its independent
checks; this is a validator counterexample, not evidence of corrupted delivered
values. The skill score was 85, revise-build. A source-blind validator-only correction
is active; original PDFs, labels and snapshots remain immutable.

The auditor confirmed repeat label differences are provenance-only, with no semantic
page differences. Capitalization-based entity flags were individually adjudicated
as ordinary technical/directional words; original raw overlap failures remain intact.

The harness now has a v4 reference projection and a per-printed-formula occurrence
gate, tested with invented long-prose operator/grouping/deletion mutations and merged
cell/reading-order errors. A wrapped standalone multiplication operator is retained
instead of being mistaken for a Markdown list marker. The focused evaluation suite
passes 32 tests. These scorer changes precede accepted measurements; all code and
label identities must be frozen again before tuning.

The validator-only revision now binds prototype interval endpoints, tolerances,
printed symbols and table/formula units to frozen worlds and source-layout records.
Unit comparisons retain exact conversion scales as well as dimensions. Unsupported
enriched binding contracts fail closed; this revision is scoped to P prototypes.
The new external `semantic-revalidation-r1.json` receipt binds validator/dependency
hashes, the original manifest, all checked worlds/authoring records and label files.
The coordinator confirmed changed-code hashes match the receipt. It reports all
30 authoring and 180 label pages passing, 1,317 protected artifacts unchanged, and
11 tests with six valid controls and 62 rehashed/schema-valid negative probes.
A fresh independent review is pending; this receipt does not grant acceptance.

The fresh independent review resolved the prior high finding and reported no new
misses. It verified the receipt, all 1,317 protected artifacts, 30 authoring pages,
180 label pages and rejection of both original counterexamples. The skill scorer
recorded attempt 4 / audit round 2 as 100, pass. This is the audit gate only; the
independent final visual judge is running. The coordinator independently reran all
11 validator tests successfully. Unsupported enriched classes remain unaccepted.

`seal_v4.py` prepares a separate immutable evaluation view after exact stage
inventory, corpus-bound approval, distinct audit/judge decisions and a matching
semantic validation receipt pass. It preserves original generation records and
copies input PDF bytes. Negative checks cover omitted whole families, changed
class/split membership, duplicate cases, path traversal, altered evidence and using
an audit decision as a judge decision. No view has been promoted or measured.

The final independent visual judge reported no substantive misses after reviewing
all 30 base-page layouts, all 30 hard-scan technical regions and the screenshot,
outline and rotation classes. It confirmed all 1,317 protected artifacts unchanged.
The script recorded the final judge stage as 100, pass. The three matched P
prototypes therefore clear both required fixture gates at 100; this is fixture
fidelity evidence, not extraction accuracy or a measured speed improvement.

The corpus-bound prototype approval and separate training-only factorial-pilot
authorization are retained externally. The Builder is extending semantic checks
for E1–E5 before the 18-family / 108-PDF / 1,080-page pilot. Full generation remains
gated on pilot acceptance. The accepted prototype's sealed evaluation view is
`prototype-evaluation-view-v2`; the first integration view is superseded because its
family namespace and raster-share metadata did not match the harness interface.
No extraction result was produced from that superseded view. The corrected view
retains class/layout/producer metadata and emits the independent integrity manifest.

## V4 source-only council, round 1

Independent adversarial and methods Sol reviews of fixed commit `2919d7d8` found
three remaining tooling issues: review decisions lacked corpus binding, semantic
receipts were checked only at summary level, and cross-split source checks ran after
protected reads. Both also reproduced mathematical distinctions lost through prose
normalization (case and line-leading or horizontal-bar operators). Neither accessed
datasets or found production leakage. These findings block tooling promotion; they
do not establish corruption of the independently observed prototype values.

The correction introduces corpus-bound review envelopes with original report/score
hashes, checked semantic-validator snapshots/dependencies and every case/family
outcome. Available PDF/layout/world/authoring/native identities now reject cross-split
reuse in inventory preflight. Multi-split inputs additionally require predeclared
canonical page identities, including reordered-page rejection, before label access.
Mathematical matching now uses a separate case/operator-preserving tokenizer.
37 focused harness tests pass; fresh independent council review remains pending.
Older approval envelopes/views are superseded for promotion. Their raw calibration
predictions remain retained, with scores provisional under the earlier normalization.

Full corpora intentionally reuse explicitly identified, code-identical training-pilot
reviews, plus their own complete automatic semantic receipt. This scope is distinct
from claiming a manual judge read heldout content. Pilot/template and generated corpus
hashes, code identities and review scope must agree before the view can be sealed.

## Enriched derivative preflight

The 1,080-page pilot has not been delivered. Strict preflight found incompatible
formula support targets: a short 9-point monospaced expression cannot fill the
specified occupied width at IoU 0.70, and another constraint's maximum character
count similarly bounds its support below the target. Failed diagnostics, natives,
previews and all 132 negative semantic probes are retained; the original accepted
prototype artifacts remain unchanged. Attempt 5 is correcting enriched geometry
contracts constructively while preserving the accepted P contract. Source-blind
generic production/validation runtime may be reused as project tooling; dirty
reports, original source material and failed candidate outputs remain excluded from
the fresh Builder handoff.

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

### Council round 2: evidence scope and expression boundaries

Both source-only reviewers requested changes on `8c71a9fd`. One audit report
could satisfy both stages; score decisions were not tied to their actual report.
An approval could also point to a protected label and open it before failing
schema validation. The preflight used separate native/delivered PDF namespaces,
and formula substring matching credited meaning-changing extensions.

The next revision requires a separately selected, isolated evidence index before
any approval-controlled file access. The index pins copied evidence, original-path
aliases, reviewer identities and stages. Resolved symlink escapes are rejected
before hashing or reading. Audit and judge reports and reviewer IDs must differ;
the binder recomputes the skill's arithmetic against those exact reports and
records the scorer/report association. Native and delivered PDF digests share
one identity namespace. Primary printed-formula preservation now checks adjacent
expression context and prevents overlapping occurrence reuse.

The index is trusted coordinator configuration, not a cryptographic defense
against a malicious coordinator who rewrites both code and the index. Original
reports and receipts stay byte unchanged. Earlier v2 approval envelopes and views
are superseded for promotion. A new training-only proof bundle and projected view
exercise the new contract; no heldout evidence, thresholds or savings are accepted.

Focused validation: 41 invented-input tests pass, including unauthorized-path
and symlink probes that assert no target hash/read occurs. The CLI now requires
`seal_v4.py --evidence-index ...` in addition to the approval. A fresh independent
council must review the fixed commit before promotion.

### Enriched builder checkpoint, not accepted fixtures

Attempt 4's enriched tooling adds world-to-literal/AST/unit/visibility validation,
Writer fixes, canonical page-content identities and a strict pilot receipt.
Its reported controls pass, but the native pilot preflight does not meet the
occupied-glyph geometry contract. The 1,080-page pilot was not generated.
These mechanisms are retained as a provisional checkpoint, not accepted evidence.

Attempt 5 corrects the distinction between placement containers and expected
occupied support, with pre-export font-metric witnesses for all 15 enriched
class/layout contracts. The unchanged matched P parent remains separate. A fresh
source-blind builder receives a hashed clean bundle: the corrected specification,
generic mechanisms and the passed P factory; previous enriched writing and
fixture-reading selftests/preflight scripts are excluded. New attempt 5 work is
isolated under `worker/test/mixed-pdf-eval/a5/` until reviewed.

### Council round 3: bind the authored formula occurrence

The adversarial reviewer reproduced a remaining formula false positive on
`8ebd43f0`: prose containing a longer alternative expression supplied an anchor
for a corrupted standalone formula. Swapping case-sensitive formulas in repeated
contexts also passed. Seven evidence-scope probes found no additional bypass.

The format adapter now projects explicit character spans from each declared
formula block. The scorer verifies those spans and checks them through one
case-sensitive, monotonic page alignment including surrounding prose. A prose
mention cannot consume the same output occurrence again for a formula. Legacy
references without explicit spans require unambiguous occurrence counts and
fail closed otherwise. Expression boundary checks and nonoverlapping use remain.
The two new mutations and authored-block projection control are covered by the
44 passing focused tests. Scores from earlier scorer revisions remain provisional
and must be recomputed under a new immutable identity before promotion.

The round-3 methods reviewer independently reproduced formula swaps and found a
scorer provenance race: the binder copied a script but executed its original
path. The binder now executes the copied snapshot and verifies its attested hash
immediately before and after the invocation. The regression mutates the original
concurrently, verifies the snapshot was invoked, and rejects a mutation of the
snapshot itself. All 45 focused tests pass. A new proof bundle records fresh score
executions; previous evidence is retained rather than overwritten.

### Council round 4: repeated formula mention accounting

The adversarial reviewer reproduced a deleted authored formula plus following
block being credited from a surviving explanatory repetition at `6bb055a0`.
A greedy alignment alone did not establish preservation of the declared copy.
Primary formula recall now also accounts for every matching literal occurrence
in the gold stream, including prose mentions. It is bounded by their output
multiplicity recall, so one surviving copy cannot replace two expected copies.
Exact repeated output remains valid. The reported four-block projection is a
regression control: the deletion receives formula recall .5 and fails acceptance;
exact output passes. All 46 focused tests pass. No extraction measurements are
promoted by this change; the revised scorer needs a fresh identity when run.

The round-4 methods reviewer supplied another ownership counterexample involving
recased prose, already rejected by the subsequent repeated-mention accounting.
That exact projection now has a dedicated regression. The reviewer also identified
a replace-and-restore race between snapshot path hashing and execution. The binder
now reads one byte buffer, hashes that buffer and executes those same bytes via
the isolated Python subprocess's stdin; it does not reopen the path for code.
A real subprocess control replaces the path with raising code during execution,
restores it afterward, and confirms that only the verified buffer executes.
Persistent snapshot changes still reject. All 48 focused tests pass. Earlier
proof bundles are retained; any new promotion must use fresh execution provenance.
