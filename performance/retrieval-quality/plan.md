# Retrieval and multi-search quality tuning

> Historical investigation record from the October 2026 retrieval experiments;
> classified 2026-10-20. Status, deployment, provider prices, available adapters,
> budgets and agent assignments below describe their original checkpoints. They
> are not current operating instructions or renewed spending/delegation authority.
> Current references: [search API](../../docs/search-api.md), [evaluation integrity](../../docs/evaluation-integrity.md) and [development experiment report](../../docs/evals/retrieval-quality/existing-options-experiment.md).
> Reported checks/results and outstanding work are preserved without rerunning
> experiments or claiming that pending verification is complete. Any `/tmp` paths
> are historical external evidence locations; their existence and contents were
> not verified in this cleanup. They have not been relocated. New scratch work
> follows the repository's agent-storage guidance.

## Objective and scope

Recover missing supporting passages and produce cited, defensible answers to direct and multi-step questions. The existing ASU and statutes queries are development evidence: 8/9 and 2/4 strict top-10 passage checks passed. These small samples do not establish production-wide accuracy. Preserve source text, page citations and raw failures; never encode fixture-specific knowledge in product logic.

Baseline production: app 8da538d is merged, deployment pending; core a0f4cc0. Existing large-document indexes use hosted text-embedding-3-small at its configured full dimension, not an assumed 256 dimensions. Confirm actual dimensions before comparisons. GLM 5.3 Flash remains the ingestion and answer model.

## Frozen screening criteria

- Primary: correct supporting passage recall at 10, plus citation identity/page validity; report rank and MRR, not just any matching text.
- No loss of previously correct development queries. A candidate must recover at least one genuine miss without introducing invalid citations or false positive answers on negative controls.
- Answer tests distinguish explicit facts, deductions supported by every cited premise, and unsupported questions that require abstention. A multi-search case must show at least two actual search tool calls, bounded by a documented tool/cost limit.
- Confirm on separately authored, untouched questions and an unchanged corpus after freezing the finalist. No tuning to confirmation failures.
- Report end-to-end query latency distributions, tokens, actual provider usage and billed ledger charges separately. A >2x latency or cost regression needs a quantified quality justification; do not silently trade correctness for speed.

## Experiment design

First diagnose extraction/OCR, chunking, metadata, retrieval ranking and evaluation errors separately. Baseline must retain all failures. Include a minimal lexical/hybrid configuration before adding decomposition, reranking or compression.

Compare one coherent mechanism at a time: retrieval configuration; context compression; embedding model; supported output dimensions. Test 512 and 768 dimensions only for models with verified Matryoshka/output-dimension support. Do not truncate a model arbitrarily or mix incompatible document/query embeddings. Rebuild candidate indexes separately; include model, dimension, normalization and task mode in their identities. Verify the actual provider route and returned vector size.

Check live official DeepInfra BGE/Jina/Omni availability and prices; use supported Gemini default dimensions as an alternative. No unverified catalog aliases, prohibited models or new paid infrastructure. Keep source fixtures outside the repository.

## Historical bounds and evidence

Initial extension: six screening configurations and 90 minutes of active tuning, then reassess evidence. Preserve the prior cumulative $10 API budget; additionally cap this phase at $3 of new provider usage and count all customer-ledger fees against remaining benchmark allowance before any full reingestion. Research and local checks precede paid runs. No unbounded retries. Record actual usage through existing journals/ledgers; do not call providers with unmetered ad-hoc scripts.

Raw evidence: /tmp/docslurp-retrieval-quality-evidence/. Prior corpus and retained runs: /tmp/docslurp-large-docs/. Prior extraction-quality held-out cases remain sealed and are not this task's training material.

Historical task split: missing-passage diagnosis, embedding/provider capabilities, and multi-search/inferred-answer behavior. These assignments ended with that investigation; they do not allocate agents for future work.

## Original experiment protocol and regression coverage

Every experiment has its own commit recording hypothesis, exact source/configuration, results and disposition. Push the experiment branch to preserve its full commit history even when production PRs are squash-merged. Reject changes through forward revert commits; never rewrite or erase failed experiments. Keep durable evidence paths and hashes with each result.

Every discovered miss becomes a versioned development regression case: source provenance/hash, question, expected supporting passage/page, expected answer or explicit abstention, retrieval flags, observed rank/citation and retained raw trace. When original traces were not retained, mark that gap and label fresh replay evidence explicitly. A correction to a faulty oracle creates a new dataset version; it must not silently improve the old score. Newly discovered cases do not enter an already-used confirmation set.

Historical model allocation was GPT-6 Astra for retrieval diagnosis/regressions and GPT-6.1 Sol for embedding-provider comparisons and multi-search evals, with a four-agent runtime limit. This records the original run only; current agent instructions govern new work.
