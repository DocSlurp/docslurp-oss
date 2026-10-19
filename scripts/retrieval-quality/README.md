# Offline retrieval development evidence

`eval.mjs` builds a versioned private development dataset from explicit manifest,
query and completed-run directories. It verifies PDF hashes and every labeled
quote against its 1-based PDF page in `pdftotext -layout` output. A missing label
fails the build. Existing output is never overwritten. Keep third-party source
text, queries and raw traces outside the repository; this directory contains only
generic tooling and synthetic tests.

```
node scripts/retrieval-quality/eval.mjs build MANIFEST QUERIES OUTPUT RUN...
node scripts/retrieval-quality/eval.mjs score DATASET TRACES
node --test scripts/retrieval-quality/eval.test.mjs
```

TRACES is a JSON array of `{id, results}` records using the search API result
shape. Capture the complete request, flags, timestamp, raw response, session ID,
usage and document/index identity alongside it; never include authentication
headers. Original summary-only observations remain explicitly missing raw traces.
Replays are new observations, not reconstructed originals.

Scoring requires each premise's quotes, document and support page together in a
result within k. Multi-premise retrieval succeeds only when every premise is
found. Report joint reciprocal rank and individual ranks. Text with invalid
citations is distinct from a missing passage. A miss alone cannot distinguish
OCR, chunking and ranking: inspect extracted artifacts or diagnostic searches.
Unanswerable questions require separate answer/abstention review; empty search
results are not proof. Exact quote scoring is a diagnostic, not semantic answer
correctness. Record reviewed label corrections as new case versions, retaining
original failures and explaining why the original oracle was too strict.

Hard negatives must be scoped to a frozen document set with an absence rationale.
Inferred questions require separately labeled premises and a stated derivation.
Author confirmation questions independently, seal them before tuning, and do not
load them through the development builder. Failed runs and unsupported questions
must remain visible; never silently drop them from denominators.
