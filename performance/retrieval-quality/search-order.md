# Experiment: preserve retrieval order before consumer caps

> Historical investigation record from the October 2026 retrieval experiments;
> classified 2026-10-20. Status, deployment, provider prices, available adapters,
> budgets and agent assignments below describe their original checkpoints. They
> are not current operating instructions or renewed spending/delegation authority.
> Current references: [search API](../../docs/search-api.md) and [development experiment report](../../docs/evals/retrieval-quality/existing-options-experiment.md).
> Reported checks/results and outstanding work are preserved without rerunning
> experiments or claiming that pending verification is complete. Any `/tmp` paths
> are historical external evidence locations; their existence and contents were
> not verified in this cleanup. They have not been relocated. New scratch work
> follows the repository's agent-storage guidance.

Hypothesis: search results must retain relevance/selection order so consumers taking a shorter prefix do not discard strong evidence. The shared post-retrieval step previously moved the second-ranked passage to the final position as a prompt-positioning optimization, then rewrote scores to that order. Ordinary chat subsequently keeps only six citations. This can remove a strong premise before the model sees it.

Change: remove prompt-position reordering from shared search results. Retain BM25 or selected MMR order; any future prompt positioning must happen after the final consumer's evidence selection. No model, index, threshold or result-count defaults change.

Validation: a synthetic three-passage regression failed in both MMR modes before the change because a two-result prefix omitted the second-strongest passage. Both pass afterward; 21 search-session/MMR tests pass. Existing corpus depth experiments independently observed supporting passages moved to the end of 20-result responses. Reconstructed pre-position ranks are diagnostic, not a fresh live quality measurement.

Status: local candidate, not deployed. No claim that this alone recovers all missing candidates or resolves semantic answers. Frozen confirmation and independent review remain required.
