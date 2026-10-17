# Retrieval and multi-search quality tuning

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

## Bounds and evidence

Initial extension: six screening configurations and 90 minutes of active tuning, then reassess evidence. Preserve the prior cumulative $10 API budget; additionally cap this phase at $3 of new provider usage and count all customer-ledger fees against remaining benchmark allowance before any full reingestion. Research and local checks precede paid runs. No unbounded retries. Record actual usage through existing journals/ledgers; do not call providers with unmetered ad-hoc scripts.

Raw evidence: /tmp/docslurp-retrieval-quality-evidence/. Prior corpus and retained runs: /tmp/docslurp-large-docs/. Prior extraction-quality held-out cases remain sealed and are not this task's training material.

Parallel responsibilities: missing-passage diagnosis; embedding/provider capabilities; multi-search and inferred-answer behavior. Coordinator integrates fixes, arranges independent review and keeps deployment separate from measurements.
