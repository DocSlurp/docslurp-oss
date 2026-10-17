# Experiment ledger

Production baseline: core `5972781`. Dataset and thresholds are frozen separately in `plan.md`. This ledger records hypotheses before outcomes; an empty result is not a success. Raw evidence is external under `/tmp/docslurp-extraction-quality/runs/`.

| ID | Mechanism | Prediction | Disconfirmation / disposition |
| --- | --- | --- | --- |
| B0 | Unchanged Qwen generation paths and default budgets | Reproduce graph fallback and establish proposition/summary quality | Pending independent dataset and instrument verification |
| E1 | Disable optional reasoning and raise graph visible-output allowance to 4096, with a reasoning-only ablation | Fewer `length` finishes; actual directed relations replace heuristic co-mentions | Reject if quality/grounding regresses; distinguish budget from model effects |
| E2 | Unicode-safe graph identity and bounded entity mentions | Preserve non-Latin names and avoid short aliases matching inside unrelated words | Require behavior regressions and untouched-language confirmation; do not transliterate or merge unrelated names |
| E3 | Explicit paragraph identity and context for propositions | Eliminate positional source attribution and short factual paragraph omissions | Reject unsupported coreference or attribution drift; preserve source paragraphs |
| E4 | Grounded summary content selection and completion validation | Preserve salient facts, qualifiers and attribution in a single paragraph | Reject empty/truncated or invented summaries; format alone cannot win |
| E5 | Minimal faithful graph prompt compared with existing verbose schema | More completed grounded triples per output token | Only test if E1 leaves material failure; removing confidence fields cannot remove grounding requirements |
| E6 | Affordable alternate model on the same frozen instructions | Resolve residual semantic failures independently of parser changes | Only if budget/time remain; explicit model substitution, never describe as a code-only gain |

The six candidate IDs are a queue, not a promise to run every candidate. Configuration screens and ablations count toward the six-screen bound; skip lower-priority arms when earlier screens consume it. Candidate commits and exact result paths will be appended as runs finish. Rejected code is removed through revert commits, while this evidence remains.

## Independent static diagnosis

The Sonnet 5.5 diagnostic worker found output-budget exhaustion, ASCII-only graph normalization, substring-based chunk mentions, blank-line proposition alignment, dropped short paragraphs, summary empty/truncation handling, and delayed proposition usage recording. These are leads to verify, not measured quality gains. Its report is `/tmp/docslurp-extraction-quality/diagnosis.md`; no held-out inputs were consulted. Live model pricing is rechecked by the runner before paid work.

Minimal-arm consideration: current summary and proposition prompts are already brief, so faithful context and source identity are more plausible improvements than further shortening. Graph JSON includes self-rated confidence and aliases, making a simplified graph output arm informative if budget exhaustion remains after E1. A complete pipeline rewrite is unnecessary for this bounded pass.
