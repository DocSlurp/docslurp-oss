# Table preservation and competitive coverage — 2026-11-01

**Warning: native-parser coverage does not meet the overall competition gate.**

Eighteen original CC0 synthetic PDFs, twenty pages, nine categories and 354 authored cells were submitted once to each service. Gold layouts preceded rendering/extraction. The separate integrity gate passed (18 cases; zero findings/candidates). These are diagnostic synthetic examples, not representative market evidence. No fixture labels or document-specific rules were added to production.

| Route | Correct value + cell placement | Exact value + placement + spans | Extra/wrong-position cells |
|---|---:|---:|---:|
| DocSlurp native guest, HTML tables | 246/354 (69.49%) | 246/354 (69.49%) | 0 |
| LlamaParse v2, cost_effective, latest | 354/354 (100%) | 352/354 (99.44%) | 2 |
| Unstructured Transform v2, balanced | 324/354 (91.53%) | 324/354 (91.53%) | 30 |

The native parser is exact on simple ruled tables, colspan, rowspan, multilevel headers, separate page tables and financial numeric formats (12 cases, 246 cells). It emits no text for image-only scans, and emits plain text without table structure for rotated and borderless cases (6 cases, 108 cells). Plain text is **not** counted as a correctly owned table cell. LlamaParse lost a rowspan and introduced an extra cell in each rowspan case; Unstructured retained only 3/18 correct placements in each rotated case.

The acceptance gate remains **failed**: each required category needs at least two cases, >=99% value/placement recall, exact-span recall and precision, and candidate parity with every competitor per case. Missing/error outputs fail explicitly. All final outputs were present; the three failed categories are quality failures, not missing jobs.

## Scope and latency

This run compares the **native guest** against complete hosted parser services. DocSlurp's OCR/vision fallback, canonical database/object storage, retrieval and production throughput were not exercised. Guest artifacts were replayed through the app chunker and actual chat renderer, comparing cell identities before/after rendering. This does not prove storage/retrieval parity or real VM deployment. Guest smoke tests used a network-disabled local container with original synthetic documents; no security-isolation claim is made for that container.

Observed one-document wall time, seconds (min / median / max):

- Local guest including container startup: 0.233 / 0.250 / 0.389.
- LlamaParse service including upload, queue and polling: 4.707 / 10.716 / 33.110.
- Unstructured service including upload, queue and polling: 6.818 / 7.019 / 28.880.

These scopes are different; no pipeline speedup or pages/$ superiority is inferred. No repeated load or concurrent throughput measurement was performed.

## Spend and exact endpoints

User ceiling: **$20 total**. No resubmissions/retries. Conservative reservations totaled $4 (not billed spend).

- LlamaParse: `POST https://api.cloud.llamaindex.ai/api/v2/parse/upload`; `cost_effective`, `latest`. 60 reported credits × $0.00125 = **$0.075**. [Official pricing](https://developers.llamaindex.ai/llamaparse/general/pricing/).
- Unstructured: `POST https://transform.unstructured.io/api/v2/parse`; `profile=balanced`, `output=markdown`, multipart `input`. Twenty pages × $0.015 = **$0.300 estimated**, not a billing receipt. No free allowance assumed. [Official Transform overview](https://docs.unstructured.io/transform/overview).
- Combined provider cost: **$0.375**, with the Unstructured component estimated. Local compute and reporting overhead are unpriced and excluded.

## Changes and remaining work

Implemented: guest `--html` tables; compact bounded chunks preserving row/cell/span/part identities; whole-row grouping where it fits; explicit bounded header context; inert table rendering in chat, search embed and clipboard; visible fallback for unsupported HTML; blank-line, comment, blockquote and currency regressions; fixed nine-category offline coverage gate.

Follow-up warnings:

1. Evaluate the existing OCR/vision route on image-only and rotated pages through full storage/retrieval before claiming parity. The native route alone cannot cover scans.
2. Evaluate general orientation normalization and borderless table reconstruction using independent held-out material. Preserve ambiguous text; do not infer table structure from benchmark answers.
3. Expand beyond two synthetic cases/category: degraded scans, genuinely varied financial layouts, and cross-page table continuation. Current multipage fixtures contain separate tables, not continued ones.

Evidence lives outside the repository at `/home/dan/data/docslurp-evals/table-coverage-2026-11-01-v2`: source PDFs/layouts/gold and hashes, manifest, unchanged outputs, sanitized submission/results, per-job ledger, current guest SHA/timing receipts, `report.json`, and `integrity-core.json`. The earlier v1 corpus was superseded before scoring; it is not evidence for this report.
