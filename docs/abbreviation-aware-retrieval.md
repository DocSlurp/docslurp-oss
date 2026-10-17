# Abbreviation-aware hybrid retrieval

Workspace search settings `synonyms` and per-request `glossary` are explicit
alias groups. They now affect the text sent to the query embedding provider as
well as Postgres lexical retrieval. No additional model call is made: the
existing embedding call records usage for the expanded text.

For a technical workspace, an administrator might configure:

```json
{
  "API": ["application programming interface"],
  "SSO": ["single sign on"],
  "SLA": ["service level agreement"]
}
```

These are examples, not global defaults. Acronym meanings depend on the corpus.
Do not silently expand `MS`, course prefixes, legal abbreviations or product
codes using a general-purpose dictionary. Explicit translated aliases can be
added to the same groups; no automatic translation or acronym-definition
extraction is performed.

For `SSO setup`, vector retrieval embeds the original query plus
`Aliases: SSO = single sign on`. Lexical retrieval uses
`"SSO" "setup" OR "single sign on" "setup"`. Each OR branch keeps the surrounding
query terms. Parenthesized alternatives are not used because Postgres
`websearch_to_tsquery` does not implement grouped Boolean expressions.

Aliases also match in the reverse direction, case-insensitively, with phrase
and punctuation support. Longest overlapping matches win. The original query
is preserved in vector text and remains one lexical branch. An alias shared by
multiple groups is not expanded: this is ambiguity, not permission to choose a
meaning. Unconfigured abbreviations remain unchanged. Hyphenated identifiers
are not expanded by matching their prefixes.

Request keys override workspace keys case-insensitively. An empty alias list
can disable that key. Existing quoted phrases, OR and negated websearch syntax
are left untouched by lexical expansion. The vector embedding still receives
applicable explicit aliases. A caller-supplied `queryVector` is never recomputed.
Query rewriting and HyDE precede alias expansion for embedding; lexical
expansion continues to use the original query.

Work is bounded to 256 glossary groups, eight aliases per group, 128 characters
per alias, eight nonoverlapping matches and eight lexical variants. Queries
over 8,192 characters are not expanded. This avoids exponential cross-products;
not every combination is searched for a query with many aliases.

## Tuning and evaluation

This change repairs where configured terms enter the hybrid pipeline. It is
not evidence of improved recall on an actual corpus. Measure retrieval with a
fixed candidate corpus and held-out questions, comparing no glossary, the
workspace glossary, reranking, and parent-context reranking separately. Report
recall at the answer's evidence page, MRR, latency, token usage and cost. Do not
include evaluator answers in the glossary.

The current pipeline fuses lexical/vector candidates using reciprocal rank
fusion, applies the relevance floor and optionally reranks with local BM25.
Parent text is attached after final selection; consequently a child chunk
cannot benefit from its parent during that rerank. Parent-aware candidate
hydration is a promising separate experiment, but it adds database work before
selection and needs an explicit latency/quality evaluation. Do not label the
current BM25 reranker as a remote cross-encoder or disable it globally based on
three questions.

Validation includes helper tests for lexical syntax, bounds, scoped overrides,
ambiguity and identifiers, and planner tests that intercept the actual
`embedConfiguredText` boundary and check usage attribution. Provider inference
and a production Postgres query are not exercised by these offline tests.

## MMR and ordering corrections

Candidate chunks in the search-session pipeline currently carry no embedding
vectors. Requesting `useMmr` therefore preserves relevance selection and records
`diagnostics.mmr = { requested: true, applied: false,
reason: "candidate-vectors-unavailable", selection: "relevance" }`. It does not
claim semantic diversity. The former positional fallback could skip rank two
in favor of rank three, even at `mmrLambda: 1`; that behavior is removed.

The standalone MMR selector continues to balance relevance and cosine diversity
when all supplied vectors have equal nonzero dimensions and finite, nonzero
values. Missing, mixed-dimension, zero and nonfinite vectors fall back to
relevance. Lambda one always selects by relevance. Returning meaningful
semantic MMR from the search endpoint still requires candidate-vector hydration
and its cost/latency evaluation.

Lost-in-the-middle positioning now consumes the selected order rather than
sorting again by pre-rerank fused scores. Thus reranker relevance (or valid MMR
selection order) determines which result is first and which is placed last.
This fixes ordering semantics; it does not establish a held-out recall gain.
