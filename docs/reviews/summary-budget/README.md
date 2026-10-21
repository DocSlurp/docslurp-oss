# Summary budget pilot

This pilot informed the document-summary defaults described in
[document summaries](../../document-summaries.md). It is a small experiment, not
a comprehensive summary-quality benchmark or a production latency guarantee.

- `results.json`: aggregate findings, examples, confounds, and limitations.
- `measurements.json`: fixture hashes, page counts, and offline sample sizes.
- `hosted-analysis.json`: non-reasoning output lengths and generation timings.
- `receipts.jsonl`: provider usage receipts; generated source text is excluded.

The corpus contains two related CU Boulder catalogs (2,648 and 2,721 pages) and
three synthetic short PDFs. The 179 completed generations cost $0.028343705 in
reported provider charges. One interrupted request has no receipt; the additional
$0.02 allowance is an estimate, not a charge. The authorized total was $6.

The first ten default-model outputs were truncated. Explicitly disabling reasoning
produced 169 complete outputs. In the 150-call main comparison, the longest output
was 212 tokens; all 50 calls with a 256-token cap completed. The opening-page
refinement retained catalog identity in 16/16 outputs, versus 0/24 for the two
naive 10,000-byte evenly spaced variants. It changed several inputs together,
so these results cannot isolate the effect of page selection alone.

The production follow-up uses extraction-time evidence instead of an additional
page-offset index. A local check on the already-extracted catalogs produced
10,000-byte inputs and 10,668/10,695-byte JSON artifacts in approximately 11/13 ms,
with verified page positions and retained catalog identity. This timing excludes
PDF extraction, storage, model calls and embedding. The production implementation
also bounds retained page prefixes and removes exact duplicate dense rows; it is
not byte-for-byte identical to the experimental sampler.

## Reproduction

Scripts live in `scripts/summary-eval/`. `compare.mjs` uses a frozen copy of the
pre-change selector, so later production changes cannot silently change the
baseline. Fetch the pinned fixtures with `pnpm fixtures:fetch`, generate the local
synthetic PDF fixtures if absent, then run:

```sh
node --import tsx scripts/summary-eval/compare.mjs
```

`refine.mjs` additionally expects `pdftotext -layout` output at
`.cache/summary-eval/catalog-2023.txt` and `catalog-2024.txt`.
Raw PDFs, source text, screenshots and generated model output remain in the
gitignored cache; they are not redistributed with this report.

`hosted.mjs` is an opt-in paid runner. It requires an environment-provided
`OPENROUTER_API_KEY` and explicit `--budget-usd`, looks up current pricing,
reserves conservative exposure before each request, persists usage, and refuses
to overwrite an existing named run. Each invocation has its own cap: repeated
runs require a shared external budget decision. `SUMMARY_EVAL_NO_REASONING=1`
selects the non-reasoning comparison. Do not rerun paid experiments merely to
validate the production code; worker regression tests use mocks.

The original report's recommendation for a page-offset index was superseded by
the bounded extraction-time artifact. Other limitations remain: no demonstrated
search relevance gain, exhaustive factuality score, rare-change recall, or
end-to-end timeout calibration.
