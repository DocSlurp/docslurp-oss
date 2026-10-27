# Mixed PDF extraction-yield experiment

## Decision

Test whether page-local evidence can select native text, cheap OCR and stronger local OCR while preserving visible content and reducing measured processing time. Compare the existing 20% character-yield idea against image coverage, drawing/glyph evidence, compressed/decoded stream sizes, and actual OCR confidence. No production threshold promotion or deployment is part of this experiment.

## Corpus and splits

External artifact root: `/home/dan/data/docslurp-evals/mixed-pdf-yield-v2`.
Target: 90 authored source families, six matched hard-page percentages (0,20,40,60,80,100), ten pages per document: 540 PDFs / 5,400 pages. Families 0–53 are training, 54–71 tuning, 72–89 held out. All encodings, pages, screenshots and degraded derivatives remain with their source family. The held-out content and labels are not read by the optimizer; its evaluation requires a frozen policy receipt.

The synthetic authoring source preserves paragraph lists, visible Markdown, numeric table rows, bounding boxes, document-screenshot provenance and explicitly excluded hidden text before rasterization. There are three layout geometries and nine document genres. Image-region share varies independently of full-page hard-scan share. Text outlines, optional-content/occluded text, rotated pages and text-free textured illustrations are included. Hard scans vary DPI, blur, contrast, skew and JPEG quality. Difficulty percentages describe applied transformations, not a claim that exactly that fraction will defeat OCR.

Limitations: synthetic English templates, no handwriting or multilingual evidence, modest layout diversity, shared templates across family splits, no claim that these represent real customer frequencies. This is a routing-training corpus, not sufficient evidence for language-model fine-tuning or production generalization. Pilot v1 is exploratory and separate; its scores are invalid because the scorer was edited during that pilot run. Pilot images remain valid generator observations. No held-out content was exposed.

## Measurements and scorer

Native: Poppler `pdftotext -layout`. Cheap: Tesseract English at 150 DPI/PSM 6. Stronger local comparator: Tesseract at 300 DPI/PSM 3; this is a configuration name, not a claim that it always wins. Both OCR settings record confidence, raw text, wall time, rasterization time and cache reuse. No hosted model calls or uploads are planned in this local phase; hosted dollar savings cannot be inferred as measured outcomes.

`mixed-page-preservation@v2` measures visible token precision/recall, minimum section recall, atomic numeric recall, complete ordered table-row recall and hidden-text leakage. The minimum content dimension is the main diagnostic score. Acceptance: precision/recall at least .95, every section at least .90, numeric/row recall at least .95, global token-order similarity at least .90, no excluded hidden text. Non-applicable numeric/table dimensions are null and excluded from gates. Exact references plus deletion, cell-swap, padding, whitespace and hidden-text mutations validate the deterministic scorer before tuning. The local Mastra scorer executes this same scoring function.

Latest located reusable preservation scorers: `tolerant-markdown@v1`, `tolerant-table@v3`, and `markdown-math-preservation@v2`, recovered from the archived repository and snapshotted with hashes externally. Table structure, wrapping and math diagnostics remain separate; this corpus currently has no typeset-math applicability labels. No LLM judge substitutes for authored source content.

Metadata features include glyph count/yield, invisible glyphs, image placement coverage, image resource stream bytes, compressed and decoded content-stream bytes, vector-drawing and font counts, rotation, and object count. Image-resource bytes and actually placed image bytes are distinct. Residual PDF storage is not expected text bytes. Compare original documents with QPDF one-page and four-page outputs: total size, image/nonimage residuals, split overhead, extraction latency and token equivalence.

## Search and integrity

Freeze scorer and measurement code before collecting accepted results. Search only training/tuning scores; keep family-level paired results and uncertainty. Select the fastest policy within one percentage point of the stronger-local baseline's mean content score and two percentage points of its acceptance rate, without hiding hard-share slice regressions. Include native-only, always-cheap, always-stronger and the 20% proxy as baselines. If no policy meets the constraints, report no accepted improvement. Confirm the selected policy once against untouched held-out families.

Run `scripts/evaluation-integrity-judge.mjs` independently of quality scoring and check family/source/derivative split disjointness. No production code, prompts or model defaults may contain corpus identifiers, expected values or benchmark-specific branches. Keep raw predictions, failure records, source/scorer/software hashes, resource concurrency and timestamps. Cache entries must identify the input pixels, tool/configuration and scorer version; cached timing is historical service-time evidence, not fresh wall throughput.

## Fool’s Gold rebuild

The v2 corpus is exploratory. Following the newly available Fool’s Gold skill, a fresh-context builder receives only `fools-gold-spec.md` and writes three training prototypes before full expansion. Native tables, proper plotted figures, realistic metadata, producer diversity, source profiles, tell checks, independent audits and the skill's deterministic pass/revise gate are required. Candidate/source provenance is retained externally in `mixed-pdf-fools-gold-audit`; no existing corpus has been relabeled as skill-approved.

The builder uses GPT-6 Luna; new final judges use an allowed model below the project's price cap. Earlier code review records are retained, but no new Astra evaluation delegates are permitted after its live output price was verified at the exclusion threshold. Direct model API calls remain out of scope; orchestration usage is reported as unavailable unless the host supplies actual tokens/cost.

## Frozen execution design

Measure the first 18 training families (one complete 3-layout × 6-region-share block), all 18 tuning families and all 18 held-out families: 3,240 measured pages from the 5,400-page corpus. Training selects a finite shortlist; tuning selects the policy including all fixed baselines and the exact 20% proxy. Heldout confirms once only. The completed inventory must match the predeclared panel and immutable manifest exactly. Sealed labels retain original authoring references and ordered page IDs; cross-split source/content reuse is rejected.

Cached serial-equivalent work comparisons are exploratory, even with family bootstrap intervals. A savings claim requires a separate fresh, randomized, three-repeat timing experiment on balanced training documents, recording host, concurrency, timestamp and attempt identity. Report heldout paired family confidence intervals for quality and acceptance as well as work. No claim of optimality outside the finite candidate grid.

The original v1 full corpus and measurements are excluded because layout and raster share were confounded and the reviewed scoring/provenance contract was incomplete. The corrected v2 corpus independently crosses those factors. Generated data remains synthetic routing evidence, not customer-distribution evidence.

## Sources

- Existing PDF preservation workflow: archived `.agents/skills/pdf-preservation-evals/SKILL.md` and `docs/raster-corpus-evals.md`; Fool's Gold skill is now available at the app's `.agents/skills/fools-gold-datasets/SKILL.md` and governs the new prototype/build/audit loop.
- [QPDF page splitting](https://qpdf.readthedocs.io/en/stable/cli.html): split outputs differ in document-level data and shared-resource allocation.
- [QPDF JSON object map](https://qpdf.readthedocs.io/en/11.8/json.html): page resources, stream dictionaries and indirect-object identities can support accounting, but do not imply readable text quantity.
- [Mastra scorers](https://mastra.ai/reference/evals/create-scorer): local function-based scoring through the installed Mastra package.
