# Layout corpus V3: new review candidates and honest coverage

Snapshot: 2026-10-21. V3 adds independently composed and real pages aimed at the gaps listed in [the V2 coverage plan](layout-corpus-v2-coverage.md). Everything here is a **silver review candidate**: pages were inspected by the authoring agent (not independent, not human-adjudicated). No detector, model or holdout run touched any V3 split.

Data (outside the repository): `/home/dan/data/docslurp-evals/layout-corpus-v3/`. Contact sheets: `v3-contact-sheet.jpg` (26 authored pages) and `v3-capture-contact-sheet.jpg` (20 capture variants).

## Inventory

| Bucket | Count | Notes |
| --- | ---: | --- |
| Authored base pages | 26 | 24 source clusters; two 2-page documents (cargo manifest, water-quality annex). Each page is a distinct brief, not a reskin. |
| Real rights-cleared pages | 6 | 6 clusters. 3 handwriting manuscripts (Library of Congress, public-domain *By the People* transcripts) labelled at all visible regions; 2 historic newspaper fronts with figure-scope labels only; 1 unlabeled reference. |
| Capture variants | 20 | 14 procedural captures + 6 chained degradations from 14 parents. Counted separately; never new layouts. |
| Source groups | 30 | Clusters joined by shared asset hash and capture parentage (no shared assets occurred). |
| Integrity cases | 51 | 26 authored + 5 labelled real + 20 variants. The unlabeled reference is excluded from the candidate lock. |

Combined with V2's 44 cases in 32 clusters, the campaign now has 96 review candidates (68 base page units, 28 variants/derivatives) across 62 clusters. That is still well short of the ~200 ceiling, and deliberately so: the remaining gaps below need real material rather than more authored pages.

### Splits (assigned before any evaluation)

`split_v3.py` groups by cluster, shared inserted asset and capture parentage, then fills toward 50/25/25 base pages with seed 20261021.

| Split | Base pages (real) | Variants | Groups | Region support on base pages |
| --- | ---: | ---: | ---: | --- |
| development | 16 (2) | 9 | 15 | 84 paragraph, 14 table, 9 photo, 1 chart, 5 formula, 6 form, 1 seal |
| validation | 8 (2) | 6 | 8 | 57 paragraph, 7 table, 6 chart, 6 illustration, 5 formula, **0 photo** |
| test | 8 (2) | 5 | 7 | 13 paragraph, 5 table, 4 photo, 2 chart, **0 formula** |

Validation has no photo regions and test has no formula regions. A slice that needs them must reassign whole groups before anything is run; it must not move individual pages.

## Feature coverage (author-declared, then visually checked)

| Gap from the V2 plan | V3 evidence | Still missing |
| --- | --- | --- |
| Genuine handwriting + printed metadata | Military Telegraph form (printed heading, handwritten lines, signature, LoC stamp as `seal`, folio `number`); diary page (3 paragraphs); printed cash-book spread with handwritten entries | Only 3 items, all 19th/early-20th-century US; ledger cells not annotated; no modern handwriting |
| Truly borderless multi-level tables | Segment results (2 header levels, subtotals); household tenure (3 header levels, indented stub, empty cells); receipts; gazette market table. Condition tags: 6 `borderless` | No real scanned borderless table |
| Multi-page continued tables | Cargo manifest (carried/brought forward totals), water annex (repeated 2-level header, "(continued)") | No continuation across a page with a different layout |
| Non-Latin / RTL | Hebrew (RTL two columns, RTL table), Arabic Naskh (RTL booktabs table), Hindi/English (Devanagari conjuncts), Japanese, Simplified Chinese (CJK wrap with kinsoku) | No mixed-script runs inside one block (fonts lack fallback); no Korean, Thai or vertical CJK |
| Dense advertisements | Grocery flyer: 5 real photos, 3 logos, coupons, price badges, barcodes, text over photo | One page only |
| Historic print, column rules, engravings | Authored 1889-style gazette with 3 real engravings; 3 real 1898/1900/1915 fronts | Real fronts have figure-scope labels only (text unlabeled) |
| Charts | line, stacked bar, grouped bar, horizontal bar, scatter, pie; axis/legend text is native | All authored; no real scanned charts |
| Photos with captions | 12 real PD/CC0 photos, each used once, credits checked against receipts | Validation split has none |
| Forms, receipts, slides | Filled and unfilled forms, 2 receipts, 2 slides (one dark) | Receipts are clean renders |
| Display math | Numbered displays with `formula_number`, inline math, KaTeX matrices/cases | Test split has none |
| Newspaper multi-column | 5-column broadsheet; gazette; real fronts | — |
| Real-world captures | Perspective, cast shadow, light falloff, pen/phone/mug occlusion, blur, digital underexposure, low-res | Procedural plates, not camera photos; no warping or glare |

## Builder contract (what is persisted before rasterization)

Authored pages use the unchanged V2 `Page` contract through `page_v3.PageV3`: source commands, glyph-line boxes, region labels in the product ontology, prose presence per region, expected Markdown, table cells with row/column/span and coordinates, formula source with display/inline placement, explicit non-applicability, font hashes and confidence defaults. The V3 helpers add:

- a glyph-coverage guard that fails text the chosen face cannot render (Noto script faces carry no Latin digits, so bilingual blocks are kept separate);
- tables with an explicit rule style (`none` draws no lines or fills) and spanning headers, whose Markdown places the spanning cell in its first column;
- RTL logical column order and CJK character wrapping;
- KaTeX via headless Chromium for matrices and cases, with KaTeX, Chromium and Node versions and the KaTeX CSS hash in each raster's provenance;
- real assets that must match a rights receipt by SHA-256, with imported transcripts given explicit lower confidence.

`page.py` changed only by a TTC face index, the spanning-header Markdown rule and registered extra evidence. All 22 reproducible V2 pages re-render byte-identically under a fixed hash seed. (`font_provenance` key order depends on the hash seed, so `render_v3.py` re-executes with `PYTHONHASHSEED=0`.)

Handwriting region text is **transcript-derived and agent-corrected**: the Library of Congress *By the People* crowd transcripts contained clear misreadings (for example "11 dozen" for "1/2 Doz." and "sargne"/"Lasque" for "Sacque" in the cash book, "[Canton Junc.]" for "Cabin John" and "heads" for "back" in the diary). Every handwritten line was re-read at close-up. Corrections are listed old → new in `real-pages/manifest.jsonl` (`metadata.transcript_corrections`, 21 entries). Readings the agent could not confirm stay marked `[?]`, and those regions carry 0.25 transcription evidence instead of 0.5.

Real pages are labelled by the agent against a coordinate grid on the exact work raster (`real_pages_v3.py`). Geometry and semantics are 0.5 evidence. Handwriting text is the archive transcript split by region (0.5, imported crowd-reviewed). Archive OCR for newspapers is kept as unreviewed evidence only.

## Reproduce

```sh
cd scripts/layout-eval/corpus_v2   # Python with Pillow+raqm, numpy, matplotlib 3.10.7, fontTools
V=/home/dan/data/docslurp-evals/layout-corpus-v3
python render_v3.py --output $V --manifest
python real_pages_v3.py --root $V
python capture_v3.py --root $V --plan $V/captures/capture-plan.json
python condition_tags.py $V
python split_v3.py --root $V
python integrity.py --root $V --repo ../../.. --frozen-directory frozen-v3
node ../../evaluation-integrity-judge.mjs --dataset $V --base e15996da --output $V/integrity-result.json
python coverage.py $V
```

Tests: `python -m unittest discover -s scripts/layout-eval/corpus_v2 -p "test_*v3.py"`.

## Results of this snapshot

- `coverage.py`: 26 authored sources, 26 manifest rows, 26 unique rasters, no exact duplicates, no missing sources and no structural issues (exit 0). Declared regions: 143 paragraph, 99 title, 46 header, 39 caption, 36 footer, 24 table, 16 list, 12 photo, 11 logo, 10 formula, 9 formula_number, 9 chart, 9 figure, 8 illustration, 7 form, 6 footnote.
- Integrity judge (`base e15996da`, head `abb969a2`): passed, 51 cases, 1,759 files scanned (1,084 production), zero findings. The receipt is at `$V/integrity-result.json`.
- Spend: USD 0. All generation was local, assets were free public downloads, and no model or image-generation API was called.

## Known weaknesses

- Rights caveats: the Barton diary's public-domain status rests on the author's death (Clara Barton, 1912), not on an explicit Library of Congress public-domain statement. The railroad-journal engraving carries only a "No restrictions" rights label. The other real assets have explicit public-domain or CC0 statements in their receipts.

- All review is by the authoring agent. Same-author inspection is not independent validation, and reading order is unannotated everywhere.
- Authored pages are clean digital renders; acquisition difficulty comes only from the 20 procedural variants.
- On the flyer, the hero photo is partly covered by a text panel, but its visibility stays at the layer estimate of 1.0.
- Barcodes and QR codes are non-decodable patterns labelled `figure`.
- Condition-tag basis text for occlusion mentions a "hand"; the actual occluders (pen, phone, mug) are recorded in `calibration.occluder_kind`.
- Historic fronts support figure recall only. Their text is unlabeled, so precision on those pages is not computable.
