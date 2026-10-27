# Mixed PDF corpus: measured clean-room contract, attempt 4

Mode: **synthetic**. Format: ten-page US-letter PDFs, PDF 1.4 or 1.7 after declared storage rewrites. Content is newly authored, unbranded technical, operational and analytical writing. This clean file and `spec-a4.json` are the complete Builder handoff. They contain geometry and abstract requirements, not source sentences, source paths, images, transcripts or prior build code.

This is a design deliverable, not a build, audit score or judge acceptance. Only local measurement was performed. The requested full target is **90 families, 540 PDFs, 5,400 pages**, with **54 / 18 / 18 families** assigned to train / tune / heldout. First build only the three training prototypes **0, 6, 12**. A balanced 18-family pilot precedes full generation and requires separate coordinator authorization.

## Measured basis and intentional separation

All 30 authorized source pages were measured for font resources, native spans/lines, drawing paths, image placements, page rotation and paint order. Body text has **38 + 35 = 73 words**, with normalized paragraph character ranges **262–267** and **249–250**. Native spans cover 24 body pages; six outlined body pages were measured through rendered-page OCR, with a rotated-page OCR discrepancy resolved by an upright crop. The discussion has **5 title words + 33 excerpt words + 25 commentary words**. Its text is native on 21 pages and bitmap-only on nine. Measurement details and original wording stay outside this handoff.

**P** denotes a measured source prototype. It preserves short prose, the compact matrix, quotient rule, constraint, panel geometry and encoding features. **E1–E5** are deliberately enriched derivatives with their own complete geometry/budgets in JSON. Their reference is their own specification plus the parent difficulty checklist. Increased prose length, charts, merged cells and richer equations must never be presented as measured source features.

## Global look and coordinate rules

Use white paper, black-blue text, a pale gray-blue discussion frame and restrained blue-gray decoration. Embed Liberation Sans and Liberation Mono; record exact font hashes. Heading pair: 13 pt with 19.2017 pt leading. Body: 10 pt with 14.7705 pt leading. Technical mono: 10 pt / 11.6407 pt in A/C, 9 pt / 10.4766 pt in B. Footer: 9 pt / 13.2935 pt. Preserve intentional whitespace; do not stretch prose to fill the page.

All table boxes below are **occupied typographic support in unrotated top-left points**, not a convenient oversized container. JSON also supplies distinct placement containers, normalized boxes `[x0/612,y0/792,x1/612,y1/792]`, typography, line counts, reading ranks, z-order and tolerances. Every visible block and semantic parent group must achieve **IoU ≥ 0.70** independently. An acceptable average cannot hide a misplaced block. Anchor tolerance is 2 pt, font-size tolerance 0.3 pt, leading tolerance 0.5 pt; overflow and clipped glyphs have zero tolerance. Decorations/backgrounds have no textual reading rank.

## Prototype A: single-column technical report

| Stable block suffix | Role | Occupied bbox, pt | Words | Characters | Lines | Rank / z |
|---|---|---|---:|---:|---:|---|
| `heading` | heading | [39, 31, 231.192, 48.862] | 4–6 | 30–39 | 1–1 | 0 / 20 |
| `subheading` | subheading | [39, 50.202, 184.236, 68.064] | 4–6 | 22–28 | 1–1 | 1 / 20 |
| `body.1` | body | [39, 119, 567.58, 162.281] | 34–42 | 242–286 | 3–3 | 2 / 20 |
| `body.2` | body | [39, 178.082, 554.81, 221.363] | 31–39 | 229–270 | 3–3 | 3 / 20 |
| `matrix.title` | technical-caption | [39, 297, 189, 309.49] | 3–4 | 23–27 | 1–1 | 4 / 20 |
| `matrix.table` | table | [39, 308.641, 243, 367.693] | 20–22 | 125–145 | 5–5 | 5 / 20 |
| `math.rule` | formula | [39, 378.485, 267, 390.975] | 5–9 | 34–42 | 1–1 | 6 / 20 |
| `math.constraint` | constraint | [39, 390.125, 327, 402.615] | 6–10 | 44–52 | 1–1 | 7 / 20 |
| `discussion.frame` | panel-background | [32, 469, 580, 701] | 0–0 | 0–0 | 0–0 | none / 10 |
| `discussion.title` | inset-heading | [39, 476, 263.53, 489.74] | 4–6 | 41–49 | 1–1 | 8 / 20 |
| `discussion.excerpt` | quoted-excerpt | [39, 490.771, 567.04, 519.281] | 30–36 | 196–237 | 2–2 | 9 / 20 |
| `discussion.commentary` | commentary | [39, 535.082, 538.09, 563.593] | 22–28 | 157–192 | 2–2 | 10 / 20 |
| `footer` | footer | [39, 721, 249.105, 746.659] | 13–17 | 87–105 | 2–2 | 11 / 20 |
| `footer.ornament` | decoration | [60, 766, 450, 775] | 0–0 | 0–0 | 0–0 | none / 5 |

Reading order: `heading` → `subheading` → `body.1` → `body.2` → `matrix.title` → `matrix.table` → `math.rule` → `math.constraint` → `discussion.title` → `discussion.excerpt` → `discussion.commentary` → `footer`.

## Prototype B: prose left / matrix and rule right

| Stable block suffix | Role | Occupied bbox, pt | Words | Characters | Lines | Rank / z |
|---|---|---|---:|---:|---:|---|
| `heading` | heading | [39, 31, 270.907, 48.862] | 4–6 | 35–43 | 1–1 | 0 / 20 |
| `subheading` | subheading | [39, 50.202, 184.236, 68.064] | 4–6 | 22–28 | 1–1 | 1 / 20 |
| `body.1` | body | [39, 119, 285.23, 191.822] | 34–42 | 242–286 | 5–5 | 2 / 20 |
| `body.2` | body | [39, 207.623, 291.34, 280.445] | 31–39 | 229–270 | 5–5 | 3 / 20 |
| `matrix.title` | technical-caption | [320, 119, 455, 130.241] | 3–4 | 23–27 | 1–1 | 4 / 20 |
| `matrix.table` | table | [320, 129.477, 503.6, 182.624] | 20–22 | 125–145 | 5–5 | 5 / 20 |
| `math.rule` | formula | [320, 192.336, 525.2, 203.577] | 5–9 | 34–42 | 1–1 | 6 / 20 |
| `math.constraint` | constraint | [320, 202.813, 552.2, 224.53] | 6–10 | 44–52 | 2–2 | 7 / 20 |
| `discussion.frame` | panel-background | [32, 447, 580, 701] | 0–0 | 0–0 | 0–0 | none / 10 |
| `discussion.title` | inset-heading | [39, 454, 263.53, 467.74] | 4–6 | 41–49 | 1–1 | 8 / 20 |
| `discussion.excerpt` | quoted-excerpt | [39, 468.771, 545.37, 497.281] | 30–36 | 196–237 | 2–2 | 9 / 20 |
| `discussion.commentary` | commentary | [39, 513.082, 534.76, 541.593] | 22–28 | 157–192 | 2–2 | 10 / 20 |
| `footer` | footer | [39, 721, 249.105, 746.659] | 13–17 | 87–105 | 2–2 | 11 / 20 |
| `footer.ornament` | decoration | [60, 766, 450, 775] | 0–0 | 0–0 | 0–0 | none / 5 |

Reading order: `heading` → `subheading` → `body.1` → `body.2` → `matrix.title` → `matrix.table` → `math.rule` → `math.constraint` → `discussion.title` → `discussion.excerpt` → `discussion.commentary` → `footer`.

Both body paragraphs are stacked **in the left column**. The matrix caption, table, rule and wrapped constraint occupy **the right column beside them**. A pair of prose columns followed by a technical block underneath is a substantive failure.

## Prototype C: single-column report / left discussion and right text-free image

| Stable block suffix | Role | Occupied bbox, pt | Words | Characters | Lines | Rank / z |
|---|---|---|---:|---:|---:|---|
| `heading` | heading | [39, 31, 243.106, 48.862] | 4–6 | 31–40 | 1–1 | 0 / 20 |
| `subheading` | subheading | [39, 50.202, 184.236, 68.064] | 4–6 | 22–28 | 1–1 | 1 / 20 |
| `body.1` | body | [39, 119, 567.58, 162.281] | 34–42 | 242–286 | 3–3 | 2 / 20 |
| `body.2` | body | [39, 178.082, 554.81, 221.363] | 31–39 | 229–270 | 3–3 | 3 / 20 |
| `matrix.title` | technical-caption | [39, 297, 189, 309.49] | 3–4 | 23–27 | 1–1 | 4 / 20 |
| `matrix.table` | table | [39, 308.641, 243, 367.693] | 20–22 | 125–145 | 5–5 | 5 / 20 |
| `math.rule` | formula | [39, 378.485, 267, 390.975] | 5–9 | 34–42 | 1–1 | 6 / 20 |
| `math.constraint` | constraint | [39, 390.125, 327, 402.615] | 6–10 | 44–52 | 1–1 | 7 / 20 |
| `discussion.frame` | panel-background | [32, 469, 400, 701] | 0–0 | 0–0 | 0–0 | none / 10 |
| `discussion.title` | inset-heading | [39, 476, 263.53, 489.74] | 4–6 | 41–49 | 1–1 | 8 / 20 |
| `discussion.excerpt` | quoted-excerpt | [39, 490.771, 389.19, 534.052] | 30–36 | 196–237 | 3–3 | 9 / 20 |
| `discussion.commentary` | commentary | [39, 549.853, 389.14, 593.134] | 22–28 | 157–192 | 3–3 | 10 / 20 |
| `side.image` | text-free-image | [410, 516.25, 580, 643.75] | 0–0 | 0–0 | 0–0 | none / 15 |
| `footer` | footer | [39, 721, 249.105, 746.659] | 13–17 | 87–105 | 2–2 | 11 / 20 |
| `footer.ornament` | decoration | [60, 766, 450, 775] | 0–0 | 0–0 | 0–0 | none / 5 |

Reading order: `heading` → `subheading` → `body.1` → `body.2` → `matrix.title` → `matrix.table` → `math.rule` → `math.constraint` → `discussion.title` → `discussion.excerpt` → `discussion.commentary` → `footer`.

The discussion title, excerpt and commentary are all stacked **in the left panel**. The image to their right contains no text. It is not a relocated excerpt. If a future derivative intentionally puts commentary left and a text inset right on one row, its explicit visual order is left commentary before right inset.

Block IDs expand to `fNNNN.pNN.<suffix>` and remain stable across all six hard cases and every build revision. Word counting excludes punctuation-only tokens such as table separators. Character budgets count NFC text with whitespace folded to one space. The two body blocks additionally obey a combined **68–78 word** budget, target 73, so simultaneous per-block maxima cannot inflate the page.

## Table, formula and evidence shape

Every prototype page contains a genuine **5-row × 4-column native table**, with one header row, four observations, no merged cells and 20 semantic cells. Its caption is separate. Render it as a compact unruled mono matrix with literal pipe separators; preserve the 15 visible separators in display text, separately from cell values. Header cell lengths are approximately 6–8, 4–6, 7–9 and 4–6 characters; data cells are 5, 3, 3 and 4 characters. The last column has one fractional digit. All cells are authored before typesetting and have individual boxes. Use ReportLab Table or actual Writer table cells; no tab-only or bitmap stand-in at the native stage.

Every prototype page also contains a compact labeled equality with a quotient, plus a separate interval and positive tolerance. The narrow layout wraps the end of its constraint onto a second line. Store the exact printed expression, LaTeX representation, recursive AST, variable values and units, computed result and rounding rule. The parent quotient shape is `equal(symbol, divide(symbol, symbol))`; it does not authorize reuse of any source expression. Denominators must be nonzero. The visible ASCII plus/minus sequence in prototypes is preserved literally in gold. Do not replace matrix/rule content with a chart or leave formula arrays empty.

The discussion is independently authored quoted evidence followed by fresh analytical commentary, linked to the page’s own table/units/observation window. Its panel remains whole when rendered as a screenshot. Footer lines are normal administrative text with the measured length/line shape; they must carry no generation, evaluation or benchmark notice.

## Explicit enriched classes and content diversity

| Class | Deliberate change | Its own geometric/semantic contract |
|---|---|---|
| E1 | Longer causal prose | Two 70–90 word paragraphs, total 140–180. Wider layouts use 5–6 lines per paragraph; B uses 9–10 lines. Resolved body/table positions are in JSON; these budgets never apply to P. |
| E2 | Merged numeric table and weighted formula | Eight rows, four columns, two header tiers, one span across header columns 1–2, 31 semantic cells; six observations. Weighted aggregate with subscripts and a real fraction. |
| E3 | Plotted vector chart | Two series × eight points, title, axes/units, eight x ticks, 4–6 y ticks, two legend entries and a caption. Matrix and rule remain present. Labels have child boxes at chart position. |
| E4 | Semantically dense document screenshot | Whole discussion frame rasterized on all ten pages; contains its own 4×3 table and signed-difference rule as additional visible gold, below commentary. |
| E5 | Bounded partial occlusion | Five-row auxiliary card: rows 0, 1 and 4 visible; rows 2 and 3 wholly masked. Parent prose/table/math/panel stays visible. Explicit new card, row and occluder boxes/z-order in JSON. |

The JSON contains **15 resolved enriched layout contracts**, one per class/layout pair, rather than informal labels. A Builder must additionally freeze its final page instances before rendering. Derivative formula shapes cycle among quotient, signed normalized difference, affine conversion, weighted aggregate and bounded power law unless E2/E4 fixes the named block; the explicit five-recipe AST library defines each distinct shape, unit constraints and display budget. Rich formulas have reserved 24 pt frames at 9 pt. Each final instance explicitly specifies the chosen recipe, literal display, budgets and glyph geometry. Do not use a class label as a substitute for authoring those structures.

Use a separate immutable world per family. Change genre, reasoning, paragraph organization, concrete observations and equation structure across families; swapping a heading, station and numbers is insufficient. All ten body pairs, excerpts and commentaries in a family are distinct after digit/case/punctuation folding. Include at least four narrative purposes per family. Flag pairwise word-5-gram Jaccard above 0.35 for review and forbid a shared 8-token run across non-furniture paragraphs. Avoid invented claims attributed to real persons/organizations; anonymous roles and unbranded components suffice. Every numeric relation must be plausible and recalculable.

## Complete producer paths, before transformations

**ReportLab path:** author all ten pages through ReportLab, including all headings, body, footer, native Table objects, formula placement and full figure placement. Preserve complete native sources, data, native PDF and block-map. **LibreOffice path:** author one complete ten-page editable Writer FODT/ODT with every heading, paragraph, footer, native table, formula and embedded figure; export the entire document through Writer PDF export. FODT may be written as XML using the Python standard library, so this path does not depend on an unavailable python-docx or UNO module. Preserve the editable document, full native PDF, export profile and command.

A LibreOffice-exported subtitle pasted into a ReportLab document **fails** the independent producer-path requirement. Prove ownership of the complete document through per-block producer attribution and the untouched native exports. Prototype 0 uses ReportLab, prototype 6 uses LibreOffice, prototype 12 uses ReportLab. The 18-family pilot has nine of each complete path and three of each within every layout.

Verified planning versions are ReportLab **5.1.0**, LibreOffice **26.8.1.1 680(Build:1)** and PyMuPDF **1.27.1**. Pin actual executable/font/package versions at build time and disclose any change. Native PDF Producer must identify its actual authoring software/version. Final Producer must truthfully identify any final rewriting writer; retain original Producer/Creator and all subsequent writers in immutable external history, optionally truthful XMP history. Honest software metadata is intentional here and overrides the generic skill prohibition on library-default tells. Do not replace it with a fictional department exporter or restore an old value that conceals a rewrite.

## Frozen transforms, visibility and hard-share controls

Save complete native documents and exact authoring gold **before** applying any transforms. The base prototype schedule is: whole discussion-panel screenshots on pages **2, 5, 8**; outlined body glyphs on **4, 9**; fully occluded authored decoys on **3, 8**. Prototype family 0 page 9 has 90° display rotation; other prototype pages are upright. Non-P families rotate page 3 by 90° and page 7 by 270° in every hard case. Quarter-turn rotation happens after raster composition, with unrotated authoring coordinates and explicit final display coordinates both retained.

A decoy is authored in `[35,85.32,212.01,97.69]`, before an opacity-1 local cover `[31,81,217,102]`. Bound every decoy glyph, content hash and cover operation in the exclusion record. The cover must completely hide anti-aliased glyph overhang and avoid meaningful content. A full-page white cover hiding the original native page is forbidden. Native non-hard output retains the decoy operators; a blank-page hard scan does not. Visible gold never contains the hidden decoy.

Each family has six documents with exactly **0, 2, 4, 6, 8, 10 hard pages**, labeled 0/20/40/60/80/100 percent. Rank pages once by seeded SHA256 and take nested prefixes; never select pages after seeing extractor performance. Non-hard pages have an independent section-raster factor: choose exactly **k of five semantic groups**, k = 0…5. The groups are body paragraph 1, body paragraph 2, matrix caption+table, rule, constraint. A cyclic deterministic selection schedule is specified in JSON. Mandatory discussion screenshots and text-free images are excluded from this denominator, avoiding a falsely nonzero base share at factor zero. Report realized section share and image-area union separately. Hard pages supersede all section encodings and report that override explicitly.

Discussion and selected-section rasterization use **150 DPI lossless** pixels, zero skew/blur/noise and unchanged contrast. Remove the underlying native text/paths for each replaced region; painting over it fails. Keep neighboring glyphs and decoys intact. Render only the selected group’s objects, not neighboring text captured by a broad crop; overlapping font line boxes do not justify erasing or duplicating a neighbor. Body outlines become raster only when their group is selected; record that intended supersession.

Hard scans use declared cycles of **85/95/105/115/125 DPI**, skew **−0.6/−0.3/0/+0.3/+0.6°**, blur sigma **0.2/0.35/0.5/0.65/0.8 pixels**, JPEG quality **54/62/70/78/86**, contrast **0.84…1.00**, and noise sigma **0…2/255**. The index depends on family and page, not hard percentage. Expand the intermediate canvas for skew and uniformly scale to fit with a ≥4 pt safety border, keeping every meaningful glyph. Record actual dimensions and affine. Start every hard output page blank: **one opaque page image, zero native text operators, zero inherited page Form XObjects, zero OCR layer and zero annotations**. All formula signs and data must remain legible; an unreadable scan is a rendering miss, not an excuse to edit gold.

For a clockwise quarter-turn, `[a,b,c,d,e,f]=[0,1,−1,0,792,0]`, giving displayed size 792×612 pt. Store glyph polygons and axis-aligned envelopes after every affine; normalize display boxes by actual display dimensions. No silent coordinate overwrite, clipping or out-of-page meaningful content is allowed.

## Gold, immutable schemas and independent checks

`spec-a4.json` embeds strict JSON Schemas for **authoring**, **transform_plan**, **transform execution**, **exclusion_plan**, and **exclusions execution**. Unknown keys are rejected. A recursive formula AST schema, per-glyph visibility and offsets, native table cell spans/values/units, chart data/ticks/legend boxes, font hashes and exact block IDs are included. JSON Schema validates shapes; the listed cross-record invariants validate reference resolution, geometry, numeric semantics and visibility. Implement both before sealing any corpus.

Freeze world → authoring → whole native document → transform plan/exclusion bindings → execution results → validated final labels. Hash UTF-8 canonical JSON with sorted keys, compact separators and NFC strings; omit only the record’s own hash field. The frozen transform and exclusion plans have no result-evidence hashes. Record measured output/stage hashes in a separate execution record that references it. Hash actual delivered files as raw bytes. A later text/geometry/exclusion/parameter change creates a new revision and invalidates downstream checks; preserve rejected evidence.

Gold requires **100% meaningful visible glyph precision and recall**, zero missing or extra tokens, zero duplicate tokens and zero unresolved glyphs. Use one canonical visible reading-order list to generate sections, paragraphs, expected Markdown and typed references, with block-ID mappings. Gold includes all heading/footer text, screenshot content, table separators/cells, numeric signs, units and chart title/axes/ticks/legend. Plotted but unprinted numbers live in chart data, not invented visible prose. Hidden decoys are exclusions bound to preexisting authoring glyph IDs, never arbitrary text an extractor missed.

Independently compare actual native/raster renders, cell/formula close-ups and glyph support, not two versions of the authoring JSON. Recalculate values using decimal/rational arithmetic and the declared rounding rule. Match formulas’ literal symbols to ASTs, denominators, intervals and units. Check every replaced region for native leakage, including nested XObjects. Nonsemantic storage/section rewrites must keep changed pixels ≤2% at the same DPI and preserve every semantic glyph. Intended scan degradation is checked against its own transform plan, not a no-change pixel metric.

Each run reports native/outlined/raster glyph counts, selected-group share, raster union area, mandatory-image area, encoded/decoded image bytes, font/content/xref bytes, object/path counts, PPI, bytes/page and actual hard-page counts. Area uses unions after clipping/alpha/occlusion, never overlapping-paint sums. These are corpus measurements for later routing heuristics; no extraction evaluation or production heuristic changes belong to this task.

## File profile

Native authoring PDF is 1.7. Final storage variants span honest PDF 1.4/1.7, classic/stream xref, object streams enabled only at 1.5+, and linearized/unlinearized files. Six profiles and a family-rotated assignment are explicit in JSON. This nuisance factor is rotated across families; it is not an independently fully crossed factor within a single six-case family. Preserve the same visible content, measure exact sizes and record qpdf version/commands. Embed fonts, forbid encryption and unannounced OCR layers, avoid false archival/accessibility claims, and keep Info/XMP consistent. Titles/authors/dates are fresh genre-appropriate administrative metadata. Exact compressed lengths are measured, not forced to match the source.

## Dataset plan and gates

The fixed mapping is layout = floor((family mod 18)/6), section share = (family mod 6)/5. Producer parity depends on batch + layout + share index. P applies only to 0, 6, 12; other families rotate E1–E5 with fixed independent family/world seeds. JSON enumerates all 90 assignments. The first 18 families cover all 18 layout/share cells, with nine ReportLab and nine LibreOffice documents; their six hard cases produce 108 PDFs and 1,080 pages. Five such factorial blocks make the full corpus: three train blocks, one tune, one heldout. The three existing prototypes are included, not added again.

Full split counts are **train 54 families / 324 PDFs / 3,240 pages**, **tune 18 / 108 / 1,080**, **heldout 18 / 108 / 1,080**. All variants, world facts, native sources and seeds of a family remain in that split. Initial prototype native documents are 30 semantic pages; their six hard variants are 180 delivered pages. Native intermediates do not count toward the 540 final PDFs. Heldout inputs are never consulted for development; later sealed generation gets deterministic checks without discretionary manual inspection or answer-driven tuning.

Promotion requires **both audit and independent final judge ≥95**, **zero fatal/high misses**, **zero unresolved medium or other substantive misses**, and at most five low cosmetic misses in total. Models list misses; the skill `score.py` calculates scores. Its default 85 threshold is insufficient: apply this additional promotion gate. Report structural fidelity and difficulty parity separately for prototypes and enriched classes. No build/judge score has been earned by this design.

The authorized ceiling is **20 total spec attempts**, including completed prior attempts; this is **attempt 4**. Maximum **four build rounds per attempt**. A capacity failure before work is logged separately, not counted as a completed round. Spec-caused serious misses, any leak, a recurring serious build miss or an exhausted fourth round cause a fresh spec and fresh Builder. Local prehandoff overlap rewrites remain in this attempt. Keep historical logs intact and do not silently use old round labels to bypass the cap.

## Handoff boundary and lessons

Start a fresh source-blind Builder with **only `spec-a4.md`, `spec-a4.json` and overlap-checked abstract notes**. Do not grant it directory-wide access to audit storage. Never forward measurement reports, source paths, screenshots, transcripts, previous code, raw overlap reports or quoted audit evidence. The coordinator retains raw heuristic entity hits for adjudication; ordinary capitalized technical words are not silently discarded or converted into an automatic pass.

Recurring lessons: specify technical position by column and bbox; budget every visible block from measurement; put all figure text at its visible position in every gold projection; require actual whole-document producer paths and truthful version history; separate matched prototypes from deliberate enrichment. These requirements are encoded above rather than left as aspirational labels.

The source file profile uses unembedded Helvetica/Courier and repeated paints. The new profile intentionally embeds metric-compatible fonts, uses genuine native table cells, draws visible elements once and replaces generation-notice furniture with ordinary administrative text. These explicit changes are reported separately from measured layout fidelity; no fake source producer identity or inaccessible source metadata is required.
