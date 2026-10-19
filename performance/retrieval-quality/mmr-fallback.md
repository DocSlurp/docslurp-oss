# Experiment: preserve relevance when MMR has no vectors

Hypothesis: a diversity selector without similarity evidence should preserve the strongest candidates. The existing production caller supplies no vectors; the prior fallback selects even ranking positions before reversed odd positions. That can drop the second-most relevant passage in favor of weaker candidates, regardless of lambda.

Change: when any candidate lacks a vector, retain the highest-scoring top K. Real vector-backed MMR is unchanged. This does not claim semantic diversity; supplying valid vectors remains separate work. Context presentation reordering remains separate from candidate selection.

Validation: 10 focused MMR tests pass, including missing/partial vectors, unsorted candidate scores, all three lambda extremes and input preservation. Replaced three weak fallback tests that only checked length/first item with a regression that asserts preservation of the second-strongest passage.

Status: local correctness candidate, not deployed. No measured corpus gain is claimed. The ongoing existing-options screen measures the original production behavior; its results must not be attributed to this candidate. Confirmation and broader server validation are pending.
