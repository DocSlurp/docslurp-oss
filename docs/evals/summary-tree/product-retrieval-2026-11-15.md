# Product retrieval replay, 2026-11-15

**Activation gate not passed.** Current product retrieval was exercised over the
existing frozen development trees without model calls. Broad-question strict
support did not improve over the zero-build arms. Guide missed its provisional
deadline in 3 of 33 requests. This small, local development replay is not a
sealed quality gate or a production-storage latency calibration.

## What ran

- 33 development cases: 11 fact, 11 multi-section, 11 whole-document; the
  same 11 public documents, 2,304 pages and 7,086 chunks as the phase-0 report.
- Five arms: current search, summarySeed, document order, actual product
  Guide, actual product Include. The old `tree-*` simulation arms were not run.
- The product summary-row writer, separate Lance summaries table, Postgres node
  registry/readiness checks, actual `hybridSearch`, fusion, context cap and
  provisional deadline all ran. Query vectors and summary vectors/text were cached.
- Fresh local PostgreSQL 17, migrated with the product migrator, and a fresh
  local Lance directory. The temporary database and its dedicated container were
  removed after completion. No production storage was touched.
- Provider spend cap: **USD 0**. Answer generation off, all query vectors cached,
  no provider ledger created. Local machine compute cost was not measured.
- Evaluation-integrity gate: **PASS**, 33 cases. Confirmation files were not read.

## Frozen-tree compatibility

The cached trees were built with the earlier product library: target 150 words,
4–16 leaves per group, fan-in 3–10. Today's build defaults differ, so this does
not validate the final builder's output. Ten cached trees pass today's row
contract. The RFC 9293 tree has 119 nodes and one level-9 node, above today's
maximum of eight. Its entire tree was marked partial and withheld, not trimmed
or silently accepted. All its queries remain in the denominator.

This also explains why regenerating trees under final build constants is still
required before confirmation. Frozen-tree hashes and validation results are in
[the provenance](results/product-retrieval-2026-11-15/provenance.json) and
[validation record](results/product-retrieval-2026-11-15/frozen-validation.json).

## Retrieval components

All numbers below are percentages. The existing retrieval scorer supplies
support@10, premise coverage, joint reciprocal rank and primary-page correctness.
The composite is the mean of support, coverage and reciprocal rank; answers
were not scored. Nothing here measures extraction text/table/math fidelity.

### Fact lookup (n = 11)

| Arm | Strict support@10 | Coverage | Reciprocal rank | Primary page | Composite |
| --- | ---: | ---: | ---: | ---: | ---: |
| current | 100.0 | 100.0 | 69.7 | 81.8 | 89.9 |
| summary-seed | 100.0 | 100.0 | 72.7 | 81.8 | 90.9 |
| document-order | 100.0 | 100.0 | 52.1 | 81.8 | 84.0 |
| product-guide | 100.0 | 100.0 | 69.7 | 81.8 | 89.9 |
| product-include | 100.0 | 100.0 | 69.7 | 81.8 | 89.9 |

### Broad questions (n = 22)

| Arm | Strict support@10 | Coverage | Reciprocal rank | Primary page | Composite |
| --- | ---: | ---: | ---: | ---: | ---: |
| current | 27.3 | 47.7 | 9.4 | 18.2 | 28.1 |
| summary-seed | 27.3 | 49.2 | 9.4 | 18.2 | 28.6 |
| document-order | 27.3 | 47.7 | 4.0 | 18.2 | 26.3 |
| product-guide | 27.3 | 51.5 | 9.4 | 18.2 | 29.4 |
| product-include | 27.3 | 50.0 | 9.4 | 18.2 | 28.9 |

Guide gains 2.3 points in broad premise coverage over summarySeed, but no
strict support or reciprocal-rank gain; its composite gain is only 0.8 points.
Fact support is unchanged. Under the plan's diagnostic that counts a deadline
miss as empty, Guide broad support is **22.7%**, versus **27.3%** when scoring
the actual response's chunk fallback.

Include returns summaries separately from its ten cited chunks. Its additional
mapped diagnostic counts **all returned evidence**, mapping each summary to its
source leaves: broad support **68.2%**, coverage **82.6%**, reciprocal rank
**12.6%**, primary-page correctness **18.2%**, composite **54.5%**. That has a larger evidence budget and is not a
like-for-like top-ten comparison or evidence that an answer is correct. Strict
Include broad support remains 27.3%. Every class/slice and component is retained
in [the aggregate](results/product-retrieval-2026-11-15/summary.json).

## Local timing and outcomes

Serial arm order, cached query vectors, one API database connection, first-use
cold work and concurrent local development load affect these observations.
These are 33-query distributions, not paired production calibration.

| Arm | Search p50 (ms) | Search p95 (ms) | Applied / requests | Deadline skips |
| --- | ---: | ---: | ---: | ---: |
| current | 95 | 201 | n/a | n/a |
| summary-seed | 122 | 191 | n/a | n/a |
| product-guide | 151 | 294 | 30/33 | 3/33 |
| product-include | 156 | 253 | 32/33 | 1/33 |

Guide's 9.1% and Include's 3.0% deadline skip rates exceed the planned 1% target
in this local run. Constants stay provisional (`deadlineCalibrated: false`);
no timing constant was tuned against these cases.

## Evidence and remaining gate

Raw responses, returned summaries, per-search outcomes and timings remain in
external eval storage at `runs/2026-11-15-product-retrieval-v5/`. The committed
[provenance](results/product-retrieval-2026-11-15/provenance.json) records source
revision/diff hash and each frozen-tree hash. Earlier setup attempts are marked
`INVALID.json`: one failed frozen-tree validation, one omitted registry rows,
one encountered PGlite wire-protocol errors, and one found no local admin service.
Their scores are not used here. The successful replay log has no query failures.

The [integrity result](results/product-retrieval-2026-11-15/integrity.json) is
separate from quality. This run does not clear phase 0: rebuild under frozen final
constants, use a larger independently authored confirmation set and a suitable
answer scorer, then measure warm/cold and quiet/ingest-loaded object-store timing.
The existing confirmation manifest has only two whole-document cases; do not
claim a 2–3-point acceptance threshold from it. Build and serve activation remain
a separate decision; this evidence supports keeping both off.
