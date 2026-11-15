# Complete native measurement confirmation — 2026-11-15

Supersedes the partial-coverage throughput calibration in `../offline-profile-real-2026-11-15/`. The same four publisher PDF hashes and default feature groups were used. Independent pdfinfo page counts agree. **All 168 pages return complete declared evidence, zero partial/unreadable/budget rows and zero unknown requested feature sections, in each of three repetitions (504 page observations).** Full-deep cost is now populated, rather than inferred from attempted work.

| PDF | Pages | Median full-deep pages/sec | Pages/min | Estimated USD / 1,000 fully measured pages |
| --- | ---: | ---: | ---: | ---: |
| irs-tax-tables | 28 | 37.50 | 2,250 | 0.001407 |
| census-population | 62 | 106.23 | 6,374 | 0.000497 |
| ti-tps54302 | 32 | 142.48 | 8,549 | 0.000370 |
| ti-bq25570 | 46 | 173.94 | 10,436 | 0.000303 |

The complete records, every repetition and observed timing ranges are retained in `measurements.jsonl`, each source-specific `.jsonl`, and `calibration.json`. Node 24.22.2, AMD EPYC 9655P, requested/limited 1 physical CPU core and 2 GiB RAM, credential-free network-blocked Modal VM. Runtime identity and harness SHA256 are in the runtime record. WASM SHA256 `5f988e12dc2fac4213b238f7f43b3dcd1ae7e318dad9ca599e8df63a78cd9e2b`, 1,407,099 bytes;256MiB ceiling unchanged. Three sequential repetitions alternate input order and reuse the module. First pass is not disk-cold: hashing and independent page-count validation precede timing. Process RSS includes harness allocations; WASM stayed at16 MiB. VM startup/staging/rendering are excluded from marginal page timing.

## Repair and meaning of complete

- Apply the existing thin/long eligibility predicate and exact deduplication before detailed rule retention. Discard unusable short path fragments before path storage and flag actual relevant-path truncation. Legacy quote/parity behavior remains separate.
- Replace all-pairs grid preflight with a conservative orthogonal event sweep and exact original contact test. Charge actual candidates under the existing65,536 allowance. Reuse grids once per page. Dense hostile graphs still refuse, and every requested grid/support/derived-stage failure remains partial.
- Off-crop word centres are not missing evidence; keep their glyph estimates in the unattributed composition remainder. Real invalid geometry, truncation and budgets remain partial.
- One form combined small Group4 inline masks with a PNG-predicted Flate image using a resource color space. Bounded adapters verify exact row/sample dimensions, full fax EOFB/padding or zlib endpoint/checksum, aliases, separators, colors and predictors. Original encoded lengths survive normalization. Unverified original raw-inline recovery never grants completeness.
- Header-described diagnostics and work vectors explain refusals. `charts.shortEligibleRules` now explicitly counts retained unique eligible rules below20 pt, rather than pretending discarded5pt ticks are counted.

Complete means the declared native numeric methods finished, **not verified semantic extraction**. Text remains encoded-string glyph/word estimates with half-em geometry, not Unicode-aware extraction; font/CMap fidelity and candidate calibration remain separate follow-ups. Table/caption/chart labels remain uncalibrated geometric candidates. No OCR or model API was called and no extraction-quality score is promoted.

## Cost, safety and evidence

The cost model uses the same dated verified Modal Sandbox rates and alternative AWS OCR/table scenarios in rates.json. Compute is requested allocation × measured wall time, not an invoice. Native text-extraction execution baseline and modeled downstream API scenarios remain separate in calibration.json; table API already includes OCR. Chart interpretation is uncalibrated/null. No controlled speedup/SLO claim is made across different VM allocations.

This completion phase used 15 short owned VMs while diagnosing and repairing the boundary cases. Every termination was verified; estimated requested-allocation total$0.014168909, plus prior-phase$0.002228900 = **$0.016397809** against the approved$20 cap. No new persistent volumes/endpoints or image builds. Invoice, possible transfer/storage charges and model/tool reporting costs are unmeasured. All intermediate failed/partial iterations, cleanup receipts, raw council proposals and actual source-page captures are preserved in the private companion PR; original PDFs remain outside Git.

Three independent council proposals were read and synthesized. Final independent adversarial/correctness reviews found no unresolved high issue after strict boundary and completion fixes. The final P2 explicit-BPC default finding was fixed with negative tests. Source-only review scope and every finding/resolution are recorded in docs/reviews/offline-profile-jsonl.md. Validation:91 Rust,58 JS,7 Python tests; separate evaluation-integrity gate passes. Publisher source paths/hashes remain runtime inputs, never production recognition branches.

Reproduce inside the mandatory credential-free VM using `packages/estimate/scripts/benchmark-real.mjs`; stage the same immutable inputs and manifest as described in the preceding report. Regenerate costs with `packages/estimate/scripts/calibrate-cost.mjs measurements.jsonl rates.json`. These measurements do not authorize parsing external files in a secret-bearing host process.
