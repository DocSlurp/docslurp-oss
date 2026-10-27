# Chat scope-decline threshold calibration (2026-10-26)

Chat declines a question politely, with two or three related questions and no
citations, when the best evidence covers less than `chat.scopeDeclineThreshold`
of the question's subject terms (`server/src/search/scope-relevance.ts`). This
note records how the default, `DEFAULT_SCOPE_DECLINE_THRESHOLD = 0.34`, was
chosen.

## Why not search's `relevance`

Search already reports a per-result relevance (`search/relevance.ts`), but in
production it is saturated: a vector hit from an embedding pipeline without a
measured noise baseline counts as a full match. Every recorded production
trace in the retrieval-quality evidence has relevance 1 on nearly all of its
top ten results, so it cannot tell an unrelated question from a related one.
The scope signal is lexical coverage instead: the share of the question's
distinct subject terms (stemmed, stop words and generic request words such as
"write", "explain", "best" and "today" removed) found in a passage's text,
heading path or filename, taking the best passage.

## Data

- **On-topic, traced (19):** every distinct question in the recorded production
  `/v1/search` traces of the retrieval-quality development workspaces (a
  university academic catalog and 1969 US public laws), scored on the top ten
  results each actually retrieved.
- **On-topic paraphrases (16), off-topic (31) and off-topic near-domain (8):**
  authored probes in `scope-decline-queries-v1.json`, scored against the pool
  of all 155 distinct passages in those traces. The pool is a superset of any
  top ten, so off-topic scores are an upper bound: real recall can only be
  equal or higher. Paraphrases avoid the corpus's exact wording where possible.

The scorer is the shipped decision (`decideScopeDecline`), so questions it never
judges (too few subject terms, or questions about the workspace's own files,
uploads or settings) count as answered. Reproduce with:

```sh
pnpm exec tsx scripts/retrieval-quality/scope-decline-calibrate.mts \
  --traces <retrieval-quality evidence root> \
  --queries docs/evals/retrieval-quality/scope-decline-queries-v1.json
```

The script makes no network or model calls.

## Results

"Unrelated" is the positive class (a decline). Precision is declines that were
off-topic; recall is off-topic questions declined.

| Threshold | Declined | Precision (unrelated) | Recall (unrelated) | False declines | On-topic traced | On-topic paraphrase | Off-topic | Off-topic near-domain |
|---|---|---|---|---|---|---|---|---|
| 0.1 | 10 | 1 | 0.256 | 0 | 0/19 declined | 0/16 declined | 10/31 declined | 0/8 declined |
| 0.15 | 10 | 1 | 0.256 | 0 | 0/19 declined | 0/16 declined | 10/31 declined | 0/8 declined |
| 0.2 | 10 | 1 | 0.256 | 0 | 0/19 declined | 0/16 declined | 10/31 declined | 0/8 declined |
| 0.25 | 11 | 1 | 0.282 | 0 | 0/19 declined | 0/16 declined | 11/31 declined | 0/8 declined |
| 0.3 | 14 | 1 | 0.359 | 0 | 0/19 declined | 0/16 declined | 14/31 declined | 0/8 declined |
| 0.34 | 23 | 1 | 0.59 | 0 | 0/19 declined | 0/16 declined | 21/31 declined | 2/8 declined |
| 0.4 | 23 | 1 | 0.59 | 0 | 0/19 declined | 0/16 declined | 21/31 declined | 2/8 declined |
| 0.45 | 24 | 1 | 0.615 | 0 | 0/19 declined | 0/16 declined | 22/31 declined | 2/8 declined |
| 0.5 | 24 | 1 | 0.615 | 0 | 0/19 declined | 0/16 declined | 22/31 declined | 2/8 declined |
| 0.6 | 41 | 0.854 | 0.897 | 6 | 4/19 declined | 2/16 declined | 30/31 declined | 5/8 declined |

## Decision

**0.34**: precision 1.00 (23 of 23 declines were off-topic), recall 0.59 (23
of 39 off-topic questions declined), no on-topic question declined (0 of 35).
On-topic questions bottom out at 0.50, so 0.34 leaves a margin: scores are
small fractions, and a question with one of two or two of five subject terms
present is still answered. 0.6 catches 90% of off-topic questions but declines
6 of 35 on-topic ones.

The misses are off-topic questions that share an incidental word with the
corpus ("capital", "life", "history"). The fixed core rule ("decline
out-of-scope or unrelated requests") still covers them at answer time, and the
default chat instructions template repeats the scope.

## Limits

- Small sample: 35 on-topic and 39 off-topic questions over two corpora, with
  the probes authored by the same person who chose the threshold. Treat the
  precision as "no false declines observed", not a measured rate.
- Lexical only: a paraphrase that shares no subject term with any passage is
  declined. None did in this sample.
- The agent path scores a bounded Postgres full-text probe of the workspace
  (top 12 chunks matching any subject term), close to the pooled method used
  here. The retrieval path scores the retrieved passages.
- Re-run with the Langfuse retrieval datasets, and with `[chat-scope-decline]`
  production logs (relevance and threshold per decline), before tightening it.
