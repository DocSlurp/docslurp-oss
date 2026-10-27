# Layout corpus V2: evidence and curation plan

Snapshot: 2026-10-21 01:50 UTC. The V3 expansion against this plan (26 authored pages, 6 real pages, 20 capture variants) is inventoried in [layout-corpus-v3-coverage.md](layout-corpus-v3-coverage.md). This is a moving development workspace. Counts below are an inspected snapshot, not benchmark admission or a claim that 200 candidates exist. No model calls, jobs, holdout runs or scoring were performed for this inventory.

## What exists

| Evidence bucket | Observed count | Meaning and evidence |
| --- | ---: | --- |
| Authored root source pages | 14 | `/home/dan/data/docslurp-evals/layout-synthetic-v2/sources`; 14 exact-unique PNG rasters, 12 document groups. Source contracts/hashes checked. |
| Root manifest rows | 12 at latest structural check | `south-room-wind-and-colour` and `water-cycle-field-notebook` exist outside the current manifest (the earlier contact-sheet manifest had 13 rows). Inventory exposes unindexed sources; rebuild/merge manifest before corpus use. |
| Separate scientific authored pages | 2 | `/home/dan/data/docslurp-evals/layout-editorial-pilots-v2-scientific/images`; both full-page inspected, not included in root counts. |
| Real historical reference originals | 4 | `/home/dan/data/docslurp-evals/reference-inspiration-v2/historical/source-manifest.json`; 3 explicit PD, 1 rights-unconfirmed inspiration-only. All unlabeled, zero evaluable pages. |
| Real academic inspiration page captures | 3 | OpenStax PDF pages 756/759 and NASA PDF page 3; separate source/rights receipt. These inspired original scientific layouts; they are not authored corpus pages. |
| Capture variants | 1 full-page inspected | `captures/water-cycle-kitchen-window.png`, same water-cycle parent source; AI photographic scene composite, not actual camera photo. Capture author owns further output/QA. |
| Human-curated layout families | Not yet adjudicated | Source IDs and document IDs are not family counts. Invoice continuation and estuary continuation share document groups. |
| Near-exact duplicate groups | Not reviewed | Exact SHA-256 equality only checks byte duplicates. Different bytes or lighting never establish independent layout diversity. |
| Benchmark-admitted pages | 0 | Every current authored page remains review/silver. Historical references have no reviewed labels. |

Visual evidence inspected for this snapshot:

- Root 13-page contact sheet: `/home/dan/data/docslurp-evals/layout-synthetic-v2/pilot-contact-sheet.jpg`. Shows full-photo advertisement, six-column classifieds, newspaper chart/table, two-page field report, diner menu, repair diagram, two-page invoice, timetable, food feature and illustrated lesson.
- New culture page full size: `/home/dan/data/docslurp-evals/layout-synthetic-v2/images/south-room-wind-and-colour.png`. Large real painting reproduction, source credit, caption, two lower prose/aside columns and folio; declared CC0 receipt owned by culture author.
- Scientific full pages: `scientific-phase-and-oscillation.png` and `scientific-heat-flux-technical-note.png` in the scientific directory above. Observed inline mathematical typography; aligned equations, fractions, derivatives, summation, Greek symbols, diagram, graph, table, citations, footnotes, aside and folio. The technical-note table has horizontal rules and zebra shading; do not call it a completely borderless table.
- Full-size Magna Carta reference: `/home/dan/data/docslurp-evals/reference-inspiration-v2/historical/magna-carta-1297.jpg`. Dense manuscript lines, decorated initial, folded lower edge, parchment tab and seal. Latin identification follows the archive source receipt, not OCR inference. Rights remain unconfirmed; inspiration only.

- Capture full page: `/home/dan/data/docslurp-evals/layout-synthetic-v2/captures/water-cycle-kitchen-window.png`; `.row.json` records parent source/image/reference hashes, homography, manual hand-occlusion mask and scene-generation provenance. Observed angled page, warm directional light, textured paper and lower-left hand obscuring part of the prose. Full-source expected prose must not be scored as fully visible capture prose without occlusion handling. This is a synthetic photographic composite, not an actual phone photograph.

Academic source receipt: `/home/dan/data/docslurp-evals/reference-inspiration-v2/scientific/REFERENCE-RECEIPT.json`. It pins PDF SHA-256, actual PDF page versus printed page, saved page captures and rights evidence. OpenStax historical PDF declares CC BY 4.0; NASA metadata records public-use permission. Preserve those exact receipts instead of assuming current website terms.

## Feature combinations, rather than repeated templates

The next selection round should fill the critical gaps with 1–2 convincing examples per feature, mixed into coherent documents. These are curation slots, not twelve parameterized templates. Existing authors retain ownership; this plan does not request duplicate authoring.

| Mix | Visible pilot coverage | Remaining requirement / owner |
| --- | --- | --- |
| Textbook derivation + inline math + display math + sidebar + diagram/graph + citation | Scientific oscillator inspected | Check baseline joins, superscript extents and exact expression provenance; scientific author. |
| Two-column technical article + complex fractions/sums + figure + table + footnotes | Scientific heat-flux note inspected | More difficult matrices/cases/integrals only if a distinct real reference justifies them; scientific author. |
| Printed line art + figure caption + explanatory prose + small table | Repair manual inspected | Add one archive-inspired engraving/technical plate, distinct from a modern vector exploded diagram; source/corpus author. |
| Genuine handwriting + printed/typed metadata + marginal notes | Historical manuscript references only | Need rights-cleared original or genuine handwriting asset with reviewed source transcript and regions. No procedural handwriting font substitute; source/corpus author. |
| Multilingual running text + translated labels + footer/credits | No inspected authored example | Culture author is preparing bilingual leaflet. Accented Latin is not RTL/non-Latin coverage; preserve that remaining gap explicitly. |
| Borderless numeric table + notes + multi-level headers | Horizontal-rule tables inspected | A truly borderless example with authored row/column/cell geometry remains missing; corpus author. |
| Two-page continued table + repeated headers + carry-forward total + prose | Estuary/invoice pairs inspected | Verify stable continuation ID and logical row offsets, no double-counting repeated header; corpus author. |
| Full-page photograph + readable overlapping typography + logo + fine print | ROVE advertisement inspected | One independent composition only. Distinguish photo extent, visible extent and text occlusion; editorial author. |
| Half-page picture + two-column text + caption + list/aside | Food feature and culture page inspected | Add cultural/concert arrangement only if independently composed; culture author. |
| Dense mixed advertisements + several logos + coupons/overlays + tiny copy | Classifieds inspected, but mostly text | Missing dense visual advert composition with multiple embedded logos/pictures; editorial author. |
| Historic print + irregular ink + column rules + engraving + footer | Manuscript originals do not cover this | Select rights-cleared actual print reference and retain original page/item identity; historical/source author. |
| Believable phone capture + shadows/light falloff + material edges + small text | Kitchen-window composite inspected | Warm directional sunlight, real-looking hand occlusion, perspective and paper texture; AI scene provenance explicit. Capture author owns calibration/visibility QA and further scene diversity. Count variants separately. |

Do not convert missing cells to absence. Do not claim symbols/formulas from a filename or an author's description alone. Distinguish a source-declared feature, a visually inspected feature, a reviewed label and a scored feature in every report.

## Bounded route to a couple hundred review candidates

A candidate pool of 200 images is a proposed review budget, not a completion quota: up to 96 independently composed authored pages, up to 24 rights-cleared real original pages and up to 80 selected capture variants of those sources. This yields at most 120 base page-content units and 80 variants, not 200 independent layouts. It is a ceiling and accounting example; do not bulk-generate to fill it. Stop earlier if quality, source diversity or provenance does not justify another page, and report any shortfall plainly.

Select sources in small visible batches, starting with the current 16 authored pages and 8–12 distinct missing combinations above. Require new composition, provenance and a clear feature reason before expanding a family. Reusing the same 16 layouts with new colors/photos/lighting is variant generation, not new diversity. Keep exact duplicates out of the selection sheet; retain near duplicates as a linked review group and include at most one in a small evaluation slice unless the evaluation explicitly measures capture robustness.

Before any eval, assign the entire document/source group, its adjacent pages, crops, re-encodings, reused composition derivatives and captures to one development/validation/test split. Group by original publication/item and underlying authored composition, not just output filename. Explicitly group repeated photo assets as a leakage risk when the target task uses photo content. Inspiration-only material is tagged separately and never silently admitted as a labeled original.

After curation, choose a small 24–32-image development slice with documented feature coverage, including 1–2 accepted examples of each critical feature. Final slice size depends on what passes review. Keep a separate capture-robustness slice so variants do not dominate content coverage. No held-out slice is opened or run by this plan.

## Builder integration and acceptance contract

`python scripts/layout-eval/corpus_v2/coverage.py <corpus-root>` reports root authored sources, manifest reconciliation, exact duplicates, document groups and declared labels. It checks expected-Markdown/contract hashes and explicit table-cell fields/math expressions; a successful exit only means these structural checks passed. It deliberately returns no inferred layout-family count. Capture manifests and archive source manifests remain separate inputs until a coordinator merges their reviewed records.

Persist these before rasterization for every authored source: immutable source/layout reference and hash, paragraph/line boundaries, explicit prose present/absent per region, expected Markdown, mathematical expression source with inline/display placement, table cells with row/column and source-page coordinates, and explicit non-applicability for absent math/tables. Missing labels fail generation; absence must be declared. Retain font and inserted-asset hashes and their rights/generation receipts. Reference-only regions must never acquire invented source text.

Before a candidate becomes evaluation silver/gold, review source versus image at full page and readable close-up, including overflow, unsupported glyphs, math baselines, cell extents, caption grouping, column order, photo text scope, edge clipping and capture visibility. Preserve reviewer, timestamp, source hashes and unresolved issues. Export an acceptance manifest only after this step. Run evaluation integrity separately from quality scoring; no production prompt or code receives fixture-specific content.
