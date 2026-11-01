# Compact faithful table records — 2026-10-30

Implemented Architect / Ruthless Minimalist follow-on; Performance Wizard raster batching remains separate. Baseline 760589aa (PR240 bounded representation), source captured before edits. Acceptance frozen in ACCEPTANCE.md before candidate measurement. Historical sibling and engine reports were read, not modified.

Every compact chunk repeats table identity, version, coordinate schema, span/part defaults and JSON designation. Nondefault spans and continuations remain explicit; unsupported source and small tables retain existing representation. Whole-value JSON encoding skips per-codepoint scanning when the value fits. Parser/work caps unchanged. No opaque compression, provider calls or rate-card changes.

Both canonical and fallback results agree. Cached Xenova/all-MiniLM-L6-v2 tokenizer is a named proxy, not verified configured-provider billing. Large 300-row table: 12,644→6,098 tokens (51.77% reduction), 22→8 chunks. Wide table: 16,686→9,024 tokens (45.92%), 28→11 chunks. Long-cell case REGRESSES 6,968→7,158 tokens (+2.73%), 7→7 chunks; repeated schema overhead is not universally cheaper. Small table with images and prose are byte-identical to baseline.

Independent fidelity reviewer authored nine case/budget combinations: exact reconstructed captions/cells, combined spans, Unicode/hostile values, empties, ordering, multiple table IDs, both paths and adjacent image references pass. This is NOT digital image extraction validation or full pipeline optimization. Retrieval quality and deployed VM behavior remain unverified.

Adversarial reviewer found medium minimum-budget continuation failure. Legend shortened and budgets below 256 retain legacy labels to preserve baseline continuation capacity; regression covers combined rowspan=2/colspan=2048, 10,000 characters and table IDs 1/10/1000. No tenant/auth/network behavior changes. Review does not establish live isolation.

Six interleaved rounds ×100 calls, ten warmups/arm, process user+system CPU and wall ms/call. Final replay is sequenced after build completion; build-completed-at.txt and replay startedAt retain the timing boundary. Medians with min/max follow. No general speedup claim; local host noise and unchanged-path variation limit inference.

| Case/path | Baseline median [min,max] | Candidate median [min,max] |
|---|---|---|
| large/canonical | cpuMs 2.993 [2.812, 3.182]; wallMs 2.549 [2.354, 2.646] | cpuMs 2.566 [2.476, 3.211]; wallMs 2.405 [2.349, 2.548] |
| large/fallback | cpuMs 2.904 [2.730, 3.134]; wallMs 2.375 [2.280, 2.564] | cpuMs 2.494 [2.446, 2.938]; wallMs 2.339 [2.316, 2.559] |
| wide/canonical | cpuMs 3.182 [3.101, 3.523]; wallMs 2.698 [2.637, 2.814] | cpuMs 2.839 [2.803, 3.416]; wallMs 2.663 [2.575, 2.788] |
| wide/fallback | cpuMs 3.259 [3.084, 5.139]; wallMs 2.803 [2.687, 4.154] | cpuMs 2.954 [2.683, 4.184]; wallMs 2.790 [2.558, 4.086] |
| long/canonical | cpuMs 1.268 [1.195, 1.452]; wallMs 1.236 [1.190, 1.430] | cpuMs 1.184 [1.172, 1.193]; wallMs 1.178 [1.168, 1.182] |
| long/fallback | cpuMs 1.417 [1.332, 1.622]; wallMs 1.366 [1.231, 1.619] | cpuMs 1.285 [1.232, 1.560]; wallMs 1.273 [1.190, 1.311] |
| small/canonical | cpuMs 0.054 [0.033, 0.077]; wallMs 0.018 [0.014, 0.026] | cpuMs 0.050 [0.034, 0.066]; wallMs 0.017 [0.014, 0.025] |
| small/fallback | cpuMs 0.010 [0.006, 0.031]; wallMs 0.007 [0.005, 0.011] | cpuMs 0.007 [0.005, 0.008]; wallMs 0.006 [0.005, 0.007] |
| prose/canonical | cpuMs 0.023 [0.015, 0.055]; wallMs 0.017 [0.015, 0.023] | cpuMs 0.024 [0.014, 0.040]; wallMs 0.015 [0.014, 0.021] |
| prose/fallback | cpuMs 0.056 [0.048, 0.148]; wallMs 0.054 [0.048, 0.055] | cpuMs 0.053 [0.048, 0.102]; wallMs 0.051 [0.048, 0.055] |

## Validation and review record

23 focused table/canonical tests pass; worker typecheck and build pass. Independent reviewer `/root/resource_review` performed adversarial escaping/resource review, found the medium continuation-budget issue above; fixed with regression and conservative minimum-budget legacy mode, tested locally. Independent `/root/fidelity_review` authored confirmation and reviewed measured costs: no medium/high fidelity issue, long-cell regression retained; low timestamp/hash provenance limitation addressed by final sequential build/replay and tokenizer SHA256. Final small safeguards were not independently re-reviewed. Human approval remains required before merge.

Separate core integrity screening uses a truthfully attributed synthetic authored manifest, not a quality score. Initial sandbox execution returned unreadable-or-invalid-input and is retained; elevated metadata-access run passes without judge changes. Final committed-head result is retained locally. No app integrity pass claimed; app pin intentionally remains unchanged.

Full raw evidence remains in the prepared app worktree performance/table-chunk-cost; this core document aggregates it. No customer inputs, paid inference, competitors, guest transport changes, merge or deployment.

Final replay started 2026-10-30T18:57:14.942Z, finished 2026-10-30T18:57:32.019Z. Tokenizer artifact SHA256 `da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0`.
