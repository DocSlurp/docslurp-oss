# Local extraction metadata allocation check

Node 24.22.2, synthetic 10 MiB text, three serial fresh processes per arm.
Rerun: `node performance/text-counts-2026-11-14/verify.mjs` from the core root.
Raw observations are in `counts.jsonl`; max RSS includes the Node process and input.
This isolates the two replaced array-producing expressions. It does not measure
full ingestion, parser CPU, quality, tenant scheduling, or production throughput.
No provider/model/VM calls; incremental provider cost $0.

Correctness: all 196,608 cases (each UTF-16 code unit alone, between words, and
around one word) match the previous whitespace and word-run counts. Empty,
dense, multilingual, malformed-surrogate and form-feed examples are also covered.
Script-aware `pageWordCount` and the plausibility formula remain unchanged.

Heatmaps are requested lazily by critique after its existing budget/quality/page
boundary guards, then reused for publication if text is unchanged. Corrections
and normalization invalidate the cache; the final map uses final text and strategy.
Critique disabled builds only the final map, including when normalization changes
text. Critique enabled may need an original map plus a final corrected map.

Threat model: hostile extracted text can drive allocations in worker metadata
calculation. Counting uses constant auxiliary storage, preserves ECMAScript
whitespace semantics and never opens a new parser path. Existing tenant scoping,
credentials, output caps and VM isolation remain in force. This is not removal of
all document-sized allocations: sanitization and page splitting still hold text.
Independent council review is required before merge; not performed by the author.
