# Bounded HTML table chunks

Both fallback chunking and canonical-document embedding now recognize block HTML tables before heading/paragraph splitting. Tables that fit are retained whole. Oversized supported tables become JSON-string cell records with one-based table/row/column identifiers, rowspan/colspan and continuation part numbers. Records are packed without slicing identity or payload. Chunk indices, canonical block/page provenance and locators remain attached; no character-sliced overlap is generated across table chunks.

This changes embedding representation, not the stored original Markdown. Minimum HTML-table chunk budget is 128 characters. Invalid budgets throw instead of looping. Huge individual values split into continuation records; empty cells remain explicit. Unsupported HTML (nested/active elements, unexpected attributes, out-of-order row groups, ambiguous spans) and inputs over parser limits are retained as escaped, labelled unparsed source. That fallback preserves source but does not claim cell geometry. Tables must start at a block line; inline/wrapped HTML tables are not covered.

Parser work is bounded by 262,144 source characters, 8,192 less-than characters, depth 32 and 100,000 geometry visits. Spans/columns cap at 2,048. Boundary scanning tracks quotes, comments, raw text and CDATA. The HTML parser is inert: no URLs, scripts or image loads are executed. This is post-extraction text handling and does not replace the required VM boundary for source-file parsers.

## Validation and tradeoffs

Seventy affected worker tests and 17 integrity tests pass. Worker typecheck and build passed before the upstream merge; the final build is also rerun after synchronization. Local synthetic tests cover plain text/code/headings, table overlap, empty cells, huge Unicode cells, entities, rowspan/colspan ownership, malformed/multiline/quoted/comment/CDATA boundaries, nested/active HTML and resource fallbacks. Retained outputs from three providers (four pages each) preserve complete small tables. The same twelve pages and a 300-row table pass the primary canonical-document replay. The large table retains all 600 cells in order with correct row/column identity; maximum emitted size is 1,790 characters under a budget of 1,800.

The oversized-table example grows from eight arbitrary HTML slices to 22 contextual chunks. This can increase embedding input size and requests; it is a correctness change, not a speedup. Six interleaved warm rounds per arm, 50 calls per round, Node 26.8.2 on the development host gave median milliseconds/call:

| Workload | Baseline | Candidate |
| --- | ---: | ---: |
| Prose | 0.1050 | 0.1228 |
| Small HTML page | 0.0238 | 0.0380 |
| 300-row HTML table | 0.0674 | 5.3410 |

These are local fallback-chunker microbenchmarks, not process-independent trials, end-to-end ingestion or a fleet SLO. Host noise and extra parsing/identity output limit timing interpretation. No paid provider jobs or customer data were used. No scorer weights or quality gold were modified.

## Integrity and independent reviews

Nested-repository integrity scans now traverse tracked Gitlinks, record coverage, scan dirty content and require pinned HEADs. Production classification uses each file's owning-repository-relative path, so a nested repository under a parent documentation folder cannot conceal production answers. Missing/uninitialized/escaping repositories fail closed. The authored-pilot core gate passed; the dedicated app gate still fails for an unmerged core pin and evaluation evidence classified as production. This is not an app integrity pass or production promotion.

Two independent initial reviewers (chunk_adversarial, chunk_fidelity) reproduced boundary, row-group and nested-classification problems plus the missing canonical integration; each has regression coverage. Two independent final reviewers (chunk_final_adversarial, chunk_final_fidelity) verified those mechanisms and found footer ordering and CDATA edge cases. Those last findings were fixed conservatively and tested locally, but the final small fixes have not received another independent review. No high-severity finding was established. Human merge approval and deployment remain separate.

Durable local replay, raw samples, integrity reports and test/build logs are in the app worktree's `performance/table-chunks-nested-integrity/`. The baseline comes from the pre-chunking feature commit; synthetic/provider inputs remain outside this public repository. The main branch was merged after measurements; unrelated VM changes did not touch the measured chunker. Focused checks are rerun after that merge.
