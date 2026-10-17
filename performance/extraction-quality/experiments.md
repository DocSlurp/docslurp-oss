# Experiment ledger

Production baseline: core `5972781`. Dataset and thresholds are frozen separately in `plan.md`. This ledger records hypotheses before outcomes; an empty result is not a success. Raw evidence is external under `/tmp/docslurp-extraction-quality/runs/`.

| ID | Mechanism | Prediction | Disconfirmation / disposition |
| --- | --- | --- | --- |
| B0 | Unchanged generation paths and default budgets, with user-selected GLM 5.3 Flash | Establish proposition/summary/graph quality | 12/12 completed; independent semantic review pending |
| E1 | Disable optional reasoning and raise graph visible-output allowance to 4096, with a reasoning-only ablation | Fewer `length` finishes; actual directed relations replace heuristic co-mentions | Reject if quality/grounding regresses; distinguish budget from model effects |
| E2 | Unicode-safe graph identity and bounded entity mentions | Preserve non-Latin names and avoid short aliases matching inside unrelated words | Require behavior regressions and untouched-language confirmation; do not transliterate or merge unrelated names |
| E3 | Explicit paragraph identity and context for propositions | Eliminate positional source attribution and short factual paragraph omissions | Reject unsupported coreference or attribution drift; preserve source paragraphs |
| E4 | Grounded summary content selection and completion validation | Preserve salient facts, qualifiers and attribution in a single paragraph | Reject empty/truncated or invented summaries; format alone cannot win |
| E5 | Source-fidelity contract for graph, key-point and summary prompts: keep modality, conditions and direction; no implied attribution (see "E5 hypothesis"). Supersedes the earlier minimal-graph-output idea, which is unscheduled | Fewer proposals/requests/estimates restated as outcomes, fewer dropped qualifiers, fewer inferred actors, fewer reversed edges, without losing supported coverage | Reject on any new contradiction or a coverage loss of more than two points on any target; compare against B0 and E4 under the same blind review |
| E6 | Affordable alternate model on the same frozen instructions | Resolve residual semantic failures independently of parser changes | Only if budget/time remain; explicit model substitution, never describe as a code-only gain |

The six candidate IDs are a queue, not a promise to run every candidate. Configuration screens and ablations count toward the six-screen bound; skip lower-priority arms when earlier screens consume it. Candidate commits and exact result paths will be appended as runs finish. Rejected code is removed through revert commits, while this evidence remains.

## Independent static diagnosis

The Sonnet 5.5 diagnostic worker found output-budget exhaustion, ASCII-only graph normalization, substring-based chunk mentions, blank-line proposition alignment, dropped short paragraphs, summary empty/truncation handling, and delayed proposition usage recording. These are leads to verify, not measured quality gains. Its report is `/tmp/docslurp-extraction-quality/diagnosis.md`; no held-out inputs were consulted. Live model pricing is rechecked by the runner before paid work.

Minimal-arm consideration: current summary and proposition prompts are already brief, so faithful context and source identity are more plausible improvements than further shortening. Graph JSON includes self-rated confidence and aliases, making a simplified graph output arm informative if budget exhaustion remains after E1. A complete pipeline rewrite is unnecessary for this bounded pass.

## E2 baseline reproduction (03:09 UTC)

Two independent mocked-provider behavioral regressions fail on the unchanged production extractor: a graph containing Japanese entities loses both nodes and its directed relationship; a short Latin name is attributed to an unrelated chunk because it appears inside longer words. These are deterministic storage/identity defects, independent of model quality or the authored eval corpus. Evidence: `/tmp/docslurp-extraction-quality/entity-identity-baseline.log`. The failing regression commit is intentional experiment evidence; production code remains unchanged pending the full baseline.

## B0 GLM baseline and E2 candidate (03:33 UTC)

The user selected `z-ai/glm-5.3-flash` for ingestion tests. The frozen v1 development baseline completed 12 cases / 36 provider calls in 67.347 seconds, with no graph fallbacks or unpersisted usage. Ledger cost was 0.785034 cents; provider cost was 0.654195 cents. Evidence: `runs/b0-glm-development/` beneath the external evidence root. The earlier one-case instrumentation smoke cost 0.055518 ledger cents and is not a full-suite quality result. Automated scoring has 170 open review items; its unmatched graph claims and flagged summary contradictions are not final semantic judgments. Independent label and output review are required before promotion.

E2 preserves Unicode letters, marks and numbers under NFKC normalization and checks word boundaries for Latin/numeric entity names when assigning chunk mentions. Non-spaced scripts retain substring matching. Both previously failing identity regressions pass. This candidate is not promoted yet; run the graph suite, development comparison and untouched confirmation. The archived baseline source identity remains in `b0-glm-development/run.json` for a fresh paired confirmation.

E2 screening completed all 12 graph generations in 36.753 seconds with zero fallbacks and 0.4976235 ledger cents (0.41468625 provider cents). Evidence: `runs/e2-glm-identity/`; this graph-only duration must not be compared with B0's three-operation total as a speedup. All 14 graph tests, worker typecheck and worker build pass. The package-manager script could not find `tsc` in this checkout, so validation invoked the installed repository-compatible TypeScript 6.0.3 compiler directly after building shared, then ran `worker/scripts/copy-routing-assets.mjs`. Semantic review and untouched confirmation remain outstanding.

## E4 screening treatment: existing grounded profile

Independent source review confirmed four unsupported baseline graph edges and two unsupported prose units, while finding the automated contradiction flags unreliable. Before changing prompts, screen the existing `grounded-low` workspace profile on GLM Flash across all three operations. It adds a general source-faithfulness instruction and requests low reasoning; this is a bundled configuration treatment, not an isolated prompt-effect claim. Keep all original operation output budgets. Prediction: fewer unsupported assertions without losing supported facts. Reject if critical unsupported claims remain or the frozen quality/latency/cost gates fail. Use the same repaired scorer and independent adjudication on both baseline and treatment; no fixture-specific production instructions are added. Identity fix E2 remains in this treatment, so graph comparisons also use the E2 screen. No production configuration is changed by this experiment.


## Frozen v2 labels and strict review (03:58 UTC)

The independent label audit corrected the gold for all 20 cases. Every automatic quality score against v1 gold is invalid; retain those files only as superseded evidence. All source texts are unchanged, so previously captured model outputs, latency and usage remain usable without another generation call. Frozen v2 combined manifest SHA-256: `59969bcb10907ef8d206d3ade8efb95592a3f5bc1dd3cadff991a7f4000d32d5`. The source mapping is in the external dataset's `supersedes.json`. The independent integrity gate passed with zero findings.

The strict scorer now requires independent, hash-bound semantic judgments for every output unit, edge, gold fact and relation; deterministic term matches alone earn no quality credit. B0 and E4 are undergoing blinded review of 468 and 477 items respectively. No candidate is promoted. Held-out sources and labels remain unavailable to the tuning coordinator.

E4 completed 12 cases / 36 calls in 74.819 seconds with no fallback, costing 0.844722 ledger cents (0.703935 provider cents). These are execution measurements, not evidence of quality improvement. Total recorded quality-generation spend including smoke, B0, E2 and E4 is 2.1828975 cents ($0.021828975); coding-agent and infrastructure costs are excluded.


## Complete blind v2 development review: B0 and E4

An independent reviewer adjudicated all 468 B0 items and 477 E4 items before running the scorer. Every binding was accepted, with no remaining review items. External evidence: `blind-v2/sample-b-review.json` (B0) and `blind-v2/sample-a-review.json` (E4).

| Strict reviewed measure | B0 | E4 grounded-low + E2 |
| --- | --- | --- |
| Graph precision / recall | 0.940 / 0.840 | 0.941 / 0.940 |
| Key-point coverage / soundness | 0.902 / 0.984 | 0.920 / 0.983 |
| Summary coverage / soundness | 0.878 / 0.895 | 0.976 / 0.941 |
| Contradictions | 0 | 1 |
| Confirmed unsupported items | 12 | 10 |

Both candidates fail the frozen grounding gates. E4 is rejected as a production-default change despite higher coverage; its configuration screen remains archived. No production default was changed, so no code revert is required. General failure classes are modality loss (proposals and estimates stated as outcomes), omitted conditions, inferred attribution and reversed graph direction. Reviewer judgement remains a limitation: some paraphrases were accepted liberally, and split facts required one supporting unit. These limitations do not erase confirmed failures; do not relax the gates to promote either candidate. Held-out confirmation has not been consumed.


## E5 hypothesis (recorded before source edits, 2026-10-17)

**Aggregate diagnosis (no case-level inputs consulted).** Reviewed B0 and E4 failures fall into four general classes: (1) modality loss, where proposals, requests and estimates are restated as completed outcomes; (2) omitted conditions and limits; (3) attribution or names supplied that the text does not state; (4) reversed graph subject/object. E4's bundled `grounded-low` profile raised coverage but added one contradiction, and its generic "use only facts explicitly supported" wording does not address these classes specifically.

**Production-path observations.** The three prompts invite the failures: the summary asks for "main topics, entities, and purpose" (rewards abstraction over qualifiers); the key-point prompt asks for "self-contained" statements of "fact or claim" (rewards resolving pronouns to names and flattening hedges to facts); the graph prompt asks for "short verb phrases" (discourages qualifiers) and never states that the triple must read as a true sentence in subject-to-object order. The graph contract already lets a qualifier ride in the free-text `predicate` (`kg_edges.predicate`, `normalized_predicate` keep qualifier words; edges key on the normalized predicate, so "funds" and "may fund" stay distinct), so no schema or contract change is needed. Predicates are currently unbounded and sit in a btree-indexed column, so qualified predicates need a length bound.

**Treatment.** One short shared source-fidelity clause appended to the output contract of each of the three operations, adapted per operation: keep each statement's certainty (proposed, requested, estimated, possible, reported); keep conditions, exceptions, limits and negation attached to what they qualify; name an actor or resolve a pronoun only when the text states the referent; add no implied facts; for graph, make `subject predicate object` read as a true sentence in that direction, put modality/negation/condition in the predicate, and omit a relationship whose direction or certainty cannot be stated. Deterministic change: graph predicates are whitespace-collapsed and relationships with an empty or over-long predicate are dropped (never truncated, since truncation could cut a qualifier). No model, profile, reasoning or token-budget change; the app model stays `z-ai/glm-5.3-flash`.

**Prediction.** Against B0, the confirmed unsupported-item count and contradiction count fall (B0: 12 and 0; target zero unsupported) while graph recall, key-point and summary coverage stay within two points. Qualified predicates raise predicate cardinality slightly; expected cost change under 10% from a longer prompt.

**Scope and generalization.** Prompt text names only abstract linguistic categories (modality, condition, negation, attribution, direction), never documents, fields, values or fixtures. It applies to any corpus. It is independent of E4's profile, so the screen runs without `grounded-low` to isolate the prompt effect.

**Disconfirmation.** Reject if any contradiction appears, unsupported items do not fall, coverage drops over two points, summary stops being one paragraph, latency exceeds 2x or cost 3x baseline median, or predicates become sentence-like enough to hurt graph precision. A pass at screening is not promotion: the integrity gate and untouched confirmation still apply.
