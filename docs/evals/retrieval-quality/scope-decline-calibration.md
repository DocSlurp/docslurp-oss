# Chat quick-decline calibration: unpromoted evidence

The default `DEFAULT_SCOPE_DECLINE_THRESHOLD` is **0 (disabled)**. The fixed chat instruction still asks the model to decline unrelated requests politely. Explicit workspace or environment thresholds remain experimental opt-ins.

The previous v2 figures did not exercise the real `runSearchSession` pipeline. They do not establish a production false-decline rate and must not be used to promote a threshold. Earlier claims of 42/42 correct declines, 72% recall and zero false declines are withdrawn as production evidence.

The current script composes shipped relevance, fusion, floor and decline helpers, but emulates lexical retrieval and omits graph/page-locator branches. Its self-labelled development probes are exploratory evidence only. It supports `--traces`, `--queries` and optional `--cache`; the previous `--from` command is no longer supported.

```sh
pnpm exec tsx scripts/retrieval-quality/scope-decline-calibrate.mts --traces <evidence root> --queries docs/evals/retrieval-quality/scope-decline-queries-v2.json --cache <local embeddings cache>
```

Before enabling a default, run held-out labelled queries through the real search session runner and adapters, preserve raw results and provenance, and pass the separate evaluation-integrity gate. Cover keyword, phrase, graph and locator evidence, paraphrases, languages, tiny corpora, follow-ups and filtered requests. Report per-class false declines and latency; do not select a threshold using held-out outcomes.
