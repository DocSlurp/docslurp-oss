# JSONL offline profiler council — 2026-11-15

## Range-reader continuation (supersedes the initial scope limits below)

The continuation removes the 64 MiB whole-input constraint from the public JSONL APIs. The new cooperative range reader accepts up to 2 GiB, uses pinned public `otf-pdf-syntax` low-level grammar, and reuses the existing evidence engine on bounded per-page graphs. Browser, Node, Python and native adapters share the protocol. Schema v3 adds compact summary vectors, rich geometric candidates, exclusive text-byte composition and bounded rankings. No private engine source or internals were used.

Three independent council proposals (Architect, Ruthless Minimalist, Performance Wizard) were synthesized before implementation. Architect/Performance supplied the sparse grammar/resolver design; Minimalist supplied the retained accumulator and bounded candidate module. A second native engine build, eager high-level loaders and simply raising memory limits were rejected. Raw proposals are preserved in the private application repository; this public record describes only the generic seam.

Independent new boundary reviewers `range_security_review` (adversarial) and `range_semantics_review` (correctness) received the diff, threat model and mandatory boundary rules. Source-only findings and author-verified resolutions:

- **High: unbounded dependency queue/materialization.** Deduplicate on enqueue, cap unique dependencies at 512 and traversed reference slots at 10,000, and charge/cap materialized metadata before conversion. A 30,000-reference resource fixture refuses deep work without exhausting memory.
- **High: inherited resource cloning on inventory pages bypassed work accounting.** Inventory never resolves/materializes Resources. Copy/conversion/traversal is charged, independently of parser I/O. The same resource fixture inventories successfully with deep inspection disabled.
- **P1: hybrid xref precedence.** Merge a revision's hybrid stream over its classic placeholders before merging older revisions. Synthetic compressed-page hybrid fixture passes; truncated rows refuse.
- **P2: payload replay thrashing.** Retain bounded page payload progress across range suspension, separately from the raw cache; a two-near-8-MiB-form fixture completes with bounded reads. Clear retained payloads after each page.
- **Medium: repeated Contents lost execution semantics.** Preserve ordered duplicate stream references for execution, deduplicate only stored-byte accounting and graph loading. The regression doubles glyph counts while retaining stored bytes.
- **Medium: prefix-only stream terminators.** Parse exact endstream/endobj tokens and reject overlap with another indexed object. Truncated xrefs and terminator-prefix attacks refuse.
- **P2: rotated/anisotropic text boxes.** Transform all estimated box corners through text and page matrices. Unit tests cover rotation and unequal axis scaling.

Additional author checks: reject stale range epochs after close/reopen; bound compressed-member syntax before parsing; strictly validate xref widths/row counts/generations; verify large content streams without collecting all operations; avoid classifying plot ticks as table cells; and stop metadata coalescing before large indexed stream bodies. A distributed-image regression catches read-ahead that would otherwise copy scan payloads.

The new reviewers did not independently execute tests or approve the final fixes. The author ran targeted negatives and package checks. No known high-severity finding remains open in this bounded implementation; this is a draft pending human merge approval, not a deployment approval.

Validation now includes 80 Rust tests, 53 JS tests, 3 synthetic production-routing parity tests and 7 Python tests, plus declaration checks and package builds. Scale observations and exact WASM hashes are retained under `docs/performance/offline-profile-jsonl-2026-11-15/`: 20,000-page shared-image and 10,000-page separate-image ~1 GiB inputs, and 10,000 variable-size local snapshots. These do not establish real-corpus semantic accuracy. Pixel OCR, calibrated semantic classification, confidence-aware population estimates and budgeted damaged-xref recovery remain explicit follow-ups.

## Initial bounded implementation review

Scope: new local page-feature sessions in `packages/estimate`, host bindings and bounded interpretation changes. Threat model: malicious PDFs, decompression amplification, partial evidence misrepresented as complete, memory/work exhaustion and session lifetime confusion. No server routes, tenant authorization, credentials, pricing rules or storage permissions change. Existing local WASM isolation remains; server use still requires a credential-free VM boundary. Cross-tenant/wrong-key tests are not applicable to this local-only API.

Two independent source reviewers received the diff, threat model and boundary rules without the author's conclusion:

- `jsonl_adversarial` — adversarial parser/budget/lifecycle review.
- `jsonl_correctness` — independent feature-accounting/stream-contract and isolation review.

## Findings and resolutions

- **P1 failed-decompression work bypass (adversarial):** charge the attempted stream allowance on errors; document the conservative work counter. A shared 9 MiB decompression bomb referenced by 100 pages now exhausts the cumulative work budget before every page is attempted, while inventory still covers all pages. Also cap cumulative interpreted operations at 2,000,000 and selected pages per batch at eight.
- **P1 incomplete-as-complete interpretation (both):** mark malformed decode errors, missing/depth-limited forms and image-list overflow partial. Because the dependency iterator tolerates trailing malformed input, detailed inspection strictly verifies bounded streams; streams above 256 KiB are explicitly partial rather than using an unbounded collected strict parse. Tests cover malformed suffixes, 65 significant image draws and existing recursive form amplification.
- **P1/P2 Python header-close leak (both):** set session ownership before yielding the header, then close in `finally`. Header-only close/reopen and cancellation are regression-tested.
- **P2 duplicate terminal after cancellation (correctness):** return immediately after yielding the terminal record in JS and Python. Both hosts test aborting after the terminal record.
- **P2 native/WASM sample drift (correctness):** modulo the PRNG in `u64` before casting to a platform index. Selection no longer depends on host pointer width.
- **P2 missing rotation (correctness):** inventory reports displayed dimensions and explicit rotation. Test covers a rotated page.
- **P2 tiny-text table numerator mismatch (correctness):** table-text bytes become unavailable when tiny glyphs were dropped; method caveats also explain punctuation/continued-run undercounting. Byte estimates are never represented as exact UTF-8 extraction.

The reviewers performed source review, not independent test execution. The author implemented these fixes and ran the regression checks; this record is not a claim that reviewers approved the final revision. No known high-severity finding remains open in the bounded implementation. Human approval is still required before merge; nothing was deployed.

## Validation and outstanding scope

- Rust: 54 tests pass (22 unit, 8 JSONL, 1 layout cross-check, 23 fixture tests).
- New JS stream/lifecycle tests: 4 pass. Existing estimator, progress, rules, page-equivalent, cost-route and layout-snapshot suites pass; the snapshot test requires subprocess access to local fixture tools.
- Python: 7 tests pass against the final WASM.
- Public JS declaration type check passes; shared package builds.
- Final WASM: 1,109,843 bytes, below the 1,500,000-byte budget.
- Generated 1,200-page document: 1,200 inventory rows, 1,000 deep measurements, 200 explicit unknowns. Batch boundaries preserve summaries.
- Actual synthetic table output is saved at `packages/estimate/examples/ruled-table.sample.jsonl`; its source is the existing repository-owned `routing-table-clean-financial.pdf` fixture.

The 64 MiB whole-input path, large-file scale benchmarks, semantic caption/chart/unruled-table detection, feature rankings and confidence-aware population estimates remain unfinished and tracked in `TODO.md`. This is a draft first slice, not completion of those capabilities.
