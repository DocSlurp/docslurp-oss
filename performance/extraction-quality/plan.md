# Extraction quality experiment contract

Started 2026-10-17 02:54 UTC against core `5972781`. The user requests iterative improvement of directed knowledge graphs, factual key points (the existing proposition-index stage), and one-paragraph document summaries. Every experiment, including failures, gets a commit; rejected production changes are reverted with new commits. Never rewrite history.

## Workload and evidence

An independently authored corpus contains 12 development and 8 untouched confirmation cases. It spans directed/reciprocal relations, aliases and pronouns, negation, temporal changes, numeric qualifiers, multilingual text, multiple paragraphs/windows, and documents with no relationships. Source text, authored gold, provenance, immutable hashes, model responses and measurements live outside the repository in `/tmp/docslurp-extraction-quality/`. The dataset worker owns confirmation content; candidate development receives only aggregate confirmation results.

The checked-in compiler and scorer are generic evaluation tooling, never production heuristics. Run `scripts/evaluation-integrity-judge.mjs` as a separate gate before promoting results. Semantic correctness takes priority over exact JSON shape. Test the scorer with reversed edges, incorrect numbers, lost negation, empty answers and unsupported additions before trusting it. Pattern matching is a diagnostic, not proof of arbitrary prose entailment: independently review unmatched claims and all confirmation outputs against their source.

## Frozen decision criteria

- Primary objective: factual quality. Directed relationship precision target >= 95% and recall >= 90%; explicit unsupported or contradicted edges are failures. Report document-macro and pooled counts, including empty/no-relation controls.
- Propositions: supported atomic-fact recall target >= 90%, with no numeric, attribution, polarity or temporal contradictions. Unknown support must be adjudicated, never silently counted as correct. Preserve source paragraph identity.
- Summaries: one paragraph preserving the document's main purpose and required salient facts; target >= 90% salient-fact coverage, zero contradicted or unsupported claims. Word/paragraph limits are diagnostic and cannot outweigh correctness.
- A candidate must improve development quality by at least five percentage points on its target, or eliminate a demonstrated correctness failure, without degrading another target by more than two points or introducing a critical contradiction.
- Confirmation compares the frozen baseline and finalist on all eight untouched cases, with two independent generations per case. A failed confirmation is not recycled as a new development win. If no candidate passes, retain the best confirmed baseline and report the remaining limits.
- Record per-document wall time, actual input/output/reasoning tokens, finish reason, fallback rate, provider cost and ledger cost. Latency and cost are secondary; reject > 2x baseline median latency or > 3x baseline per-document cost unless a substantial quality gain warrants an explicit tradeoff decision. Do not claim statistically precise tail latency from this small suite.

## Experiment sequence

1. Validate independent dataset/scorer and prove the existing generation paths are exercised. Capture unchanged graph, proposition and summary baselines, including failures and heuristic fallbacks.
2. Rank at most six coherent screening treatments. Consider a minimal faithful prompt arm, output/reasoning budgets, source-anchored entity/coreference instructions, paragraph context/attribution, and summary content selection. Separate model substitutions from prompt changes.
3. Commit each candidate before measurement; retain exact source identity, parameters, commands, raw outputs and failures. Revert rejected changes with `git revert`, retaining the result record.
4. Freeze the finalist, run the separate integrity gate and fresh confirmation, then test the combined implementation and a small authorized production canary.

## Execution bounds and accounting

Initial window: 02:54–04:24 UTC, maximum six screening candidates. Stop earlier when no worthwhile hypothesis remains. Extend only with an explicit recorded reason within existing authorization; no unconfirmed last candidate ships at the deadline. The cumulative API experiment ceiling remains $10, including the preceding acceptance exercise's recorded $0.131995; standing infrastructure, unpriced local compute and coding-subagent charges are separate and not represented as zero. Limit concurrent provider calls to two initially and four maximum. No new capacity purchases.

Use actual production generation functions with synthetic inputs and the existing scoped usage ledger. Check spending before calls, persist successful provider usage even if parsing fails, and retain a local receipt if persistence fails. Never use prohibited Pro/Ultra or >= $50/million output-token models. Verify live prices before selecting a new evaluation model. Sonnet 5.5 is the user's requested coding-subagent model, not an automatic change to the app's extraction model.

The coordinator owns runtime changes and experiment decisions; a Sonnet 5.5 worker owns independent dataset/oracles; another owns ingestion-panel auto-collapse; a third provides bounded diagnosis/review/reporting. No candidate worker reads confirmation labels. Publish measured progress at least every five minutes with no claim of an unattended timer.

## User model selection, 2026-10-17

The user selected **GLM 5.3 Flash for app ingestion and tests**, while retaining **Sonnet 5.5 for coding subagents**. Use the explicit OpenRouter route `z-ai/glm-5.3-flash` for the new quality baseline and benchmark workspace text-generation configuration. Record effective configuration and actual provider usage to verify that selection; do not silently substitute another model. This is a scoped test selection, not an application-wide default change. Existing Qwen observations remain historical evidence, not the new baseline. OpenRouter's model page checked during this selection lists minimum input/output pricing of $0.04/$0.20 per million tokens; the runner must still obtain current catalog prices and actual usage at execution time. Source: https://openrouter.ai/z-ai/glm-5.3-flash.
