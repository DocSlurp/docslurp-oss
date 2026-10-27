# Chat quick-decline calibration (2026-10-26, v2)

The chat **quick decline** (`server/src/search/scope-relevance.ts`) is a UX shortcut, not a safety control. On a first, unfiltered, non-web direct-answer turn whose best vector match is below `chat.scopeDeclineThreshold`, chat replies with a templated polite decline and related questions instead of a model call. Every other turn goes to the model, which applies the fixed core rule (decline unrelated requests, suggest related ones). Anyone can phrase a question to avoid the shortcut; that only costs a model call. This note records how the default, `DEFAULT_SCOPE_DECLINE_THRESHOLD = 0.05`, was chosen. It replaces v1, which used lexical word coverage: a council review showed that signal both declined legitimate turns and was trivially bypassed.

## Signal

The best cosine among the vector branch's candidates for the turn, rescaled above the embedding pipeline's measured noise baseline (`(cos - baseline) / (1 - baseline)`, clamped to 0..1). That is the same relevance the search relevance floor uses. Only `transformers.js/Xenova/bge-m3` has a measured baseline (0.65); other pipelines produce no calibrated signal and never take the shortcut. Rerank scores are not used: the local reranker is BM25 relative to its candidate pool, and hosted rerank scores are not exposed or calibrated.

## Data

- **Corpus:** the 496 distinct passages in the recorded production `/v1/search` traces of the two retrieval-quality development workspaces (a university academic catalog and 1969 US public laws). "Tiny corpus" probes use only the 3 shortest passages of the public-laws workspace.
- **Embeddings:** each passage and question embedded locally with the server's own `embedConfiguredText` (bge-m3, transformers.js, normalised). No network or paid calls.
- **Top-k only:** a question's score is its best cosine among the top 8 passages of its corpus, which is what the vector branch returns. Traced on-topic questions use only their own workspace's passages.
- **Questions:** 19 traced on-topic questions, plus authored, **self-labelled** probes in `scope-decline-queries-v2.json`: paraphrases, synonyms, cross-lingual on-topic (Spanish, German, French, Portuguese, Italian), non-English off-topic, unsegmented scripts (Chinese, Japanese, Thai), follow-ups (with history), tiny-corpus related and unrelated, off-topic, near-domain off-topic, and padding attacks (corpus words prepended to an unrelated request).
- **Decision:** every question goes through the shipped `decideScopeDecline`, so the questions it never judges (follow-ups, unsegmented scripts, fewer than three content terms, questions about the workspace's own files) count as answered.
- The agent path has no server-side decline; the model decides there. No numbers apply to it.

Reproduce:

```sh
pnpm exec tsx scripts/retrieval-quality/scope-decline-calibrate.mts --traces <evidence root> --queries docs/evals/retrieval-quality/scope-decline-queries-v2.json
# or re-judge saved scores with the current rules, without re-embedding:
pnpm exec tsx scripts/retrieval-quality/scope-decline-calibrate.mts --from <evidence root>/scope-decline-scores-v2.json
```

## Results

"Unrelated" is the positive class (a decline). Precision is declines that were unrelated; recall is unrelated questions declined, over every class including those never judged.

| Threshold | Precision (unrelated) | Recall (unrelated) | False declines |
|---|---|---|---|
| 0.02 | 1.000 | 0.638 | 0 |
| 0.05 | 1.000 | 0.724 | 0 |
| 0.1 | 0.977 | 0.741 | 1 |
| 0.15 | 0.918 | 0.776 | 4 |
| 0.2 | 0.882 | 0.776 | 6 |
| 0.25 | 0.758 | 0.810 | 15 |
| 0.3 | 0.691 | 0.810 | 21 |

Per class at the default, 0.05:

| Class | Label | Declined at 0.05 | Note |
|---|---|---|---|
| on-topic-traced | related | 0/19 |  |
| on-topic-paraphrase | related | 0/16 |  |
| on-topic-synonym | related | 0/8 |  |
| cross-lingual-on-topic | related | 0/8 |  |
| non-english-off-topic | unrelated | 8/8 |  |
| unsegmented-script | related | 0/2 | never judged (skipped) |
| unsegmented-script | unrelated | 0/2 | never judged (skipped) |
| follow-up | related | 0/3 | never judged (history) |
| follow-up | unrelated | 0/3 | never judged (history) |
| tiny-corpus | related | 0/3 |  |
| tiny-corpus | unrelated | 3/3 |  |
| off-topic | unrelated | 26/31 |  |
| off-topic-near-domain | unrelated | 4/8 | shares a domain word; one skipped as a workspace-meta question |
| adversarial-padding | unrelated | 1/3 | corpus words padded onto an unrelated request |

## Decision

**0.05** (a cosine of about 0.67 for bge-m3): precision 1.00 (42 of 42 declines were unrelated), recall 0.72 (42 of 58 unrelated questions), and no related question declined in any class, including paraphrases, synonyms, cross-lingual questions and the tiny corpus. At 0.1 one cross-lingual on-topic question (French, about the Yuma campus) is declined; from 0.15 synonyms and traced questions start to fall.

Three content terms are required because very short questions embed unreliably: "Where is the Yuma location?" scored below the noise baseline (cosine 0.61) although the corpus answers it. Requiring three terms skips five short unrelated questions too; the model handles those.

Misses are expected and acceptable, because the model still declines them: near-domain questions that share vocabulary ("How many credit cards should I have?" at 0.21), padding attacks (two of three at 0.13), follow-ups and unsegmented scripts (never judged).

## Limits

- Small and self-labelled: 59 related and 58 unrelated questions over two corpora, with probes written by the person choosing the threshold. Treat precision 1.00 as "no false declines observed", not a rate.
- One embedding pipeline. Production workspaces on another pipeline never take the shortcut until a baseline is measured for it (`scripts/calibrate-relevance-floor.mjs`).
- Re-run on the Langfuse retrieval datasets and on `[chat-scope-decline]` production logs (relevance, threshold, top cosine and pipeline per decline) before raising the threshold.
