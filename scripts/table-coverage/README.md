# Table coverage acceptance gate

Generate original CC0 source layouts, gold cells and PDFs outside the repository with `generate.py`. Source layouts and gold are saved before rasterization/extraction. Requires PyMuPDF. Preserve the generator revision and hashes with results. Do not tune production on these held-out outputs.

Run each case through the actual candidate pipeline and the chosen competitor tiers. Save unchanged outputs and sanitized receipts including endpoint/version, timing, retries and actual billing. Use Unstructured Transform **v2** (`POST https://transform.unstructured.io/api/v2/parse`), not the legacy partition endpoint. Do not treat quotas as throughput, or missing billing as zero cost. No provider calls are made by the offline scorer.

For each case in the generated manifest, populate `outputs` with paths to table-bearing HTML/Markdown for each named provider. Keep page boundaries and convert page-local table ordinals to the source's sequential document table order before scoring. GFM cannot represent spans; do not fabricate span metadata when adapting it. Mark unsupported outputs missing until a truthful adapter is available.

From core run:

```
pnpm --filter @docslurp/worker exec tsx src/benchmarks/table-coverage-cli.ts /external/manifest.json /external/report.json
```

The fixed gate profile requires at least two cases in each of nine categories (simple, colspan, rowspan, multi-header, multipage, scan, rotated, borderless and financial), plus any caller-added categories. Removing a category from a manifest cannot weaken it. The gate requires all categories and provider outputs, at least 99% cell-value/placement recall, exact-span recall and precision, and candidate parity or better for each case against every competitor. Wrong values and placements count as both missing and extra; duplicate cells reduce precision. Missing outputs fail, rather than silently shrinking the denominator. The scorer is separate from the production chunker and uses independently authored gold.

The initial eighteen-case corpus covers simple tables, horizontal spans, vertical spans, multilevel headers, multiple pages, image-only scans, rotated pages, borderless tables and financial numeric formats. It is a minimum diagnostic slice, not evidence of general market leadership. Multipage cases currently contain separate page tables; cross-page continuation/stitching, degraded scans and diverse real financial layouts remain required expansion categories before broad claims. Run the separate `scripts/evaluation-integrity-judge.mjs` gate with a supported provenance manifest before promoting any quality result.

Also require the application's end-to-end table-preservation test. A parser-only score is insufficient: test the canonical stored artifact, chunk identities and safe renderer. Large cells are split into numbered parts; headers repeat as explicit context only when they fit within one third of the budget. Oversized headers remain source records instead of displacing cell values. Chunk table ordinals are local to the document/page invocation; callers retain their existing document/page tenant scope.

Live competitive runs require an explicit total spending cap. Do not use prohibited Pro/Ultra models or any model at or above the repository's output-token price ceiling. Do not submit fixtures until provenance and sharing permission are established.
