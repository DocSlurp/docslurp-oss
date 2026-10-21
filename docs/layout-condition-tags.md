# Condition tags for the layout corpus

Condition metadata is additive to content/layout labels and annotation confidence. It does not change pixels, source layouts, ground truth or experiment admission. A picture of a page is a capture condition; a photograph inside a digital page is content. Keep those separate.

The first version is grounded in known rendering/capture recipes and reviewed source receipts. It is a small project taxonomy informed by public datasets, not an imported annotation standard. No dataset files or licenses are copied by this work.

## Facets and scopes

| Facet | Friendly tags | Scope and meaning |
| --- | --- | --- |
| Acquisition | `digital`, `scanned`, `picture` | Page; mutually exclusive at the same scope. A synthetic photo composite is `picture` plus `synthetic`, with the composite basis explicit. Actual acquisition unknown means no assertion. |
| Source origin / synthesis | `born-digital`, `synthetic` | Page; independently records authored source versus generated/composited content. |
| Alignment/projection | `aligned`, `skewed`, `perspective`, `rotated`, `warped` | Page; native upright rendering is aligned. These tags do not mean that every table row or cell aligns. Camera homography is evidence for projection, not a measured OCR quality score. |
| Quality | `low-res`, `blurry`, `low-lighting`, `shadow`, `glare`, `uneven-lighting`, `noise`, `low-contrast` | Page or region, with resolution/sharpness also usable at row/cell scope. Require a stated measurement/threshold, verified recipe, or explicit visual review; no classification from paper color or historical age. |
| Page/region extent | `cropped`, `occluded` | Page, region, table, row or cell; preserve specific extent and visibility evidence. |
| Table rules | `borderless`, `bordered`, `mixed-rules` | Table; exclusive within that table. `border=False` in our renderer still draws row rules, so it does not establish borderlessness. Inspect commands or visual evidence. |
| Table structure | `header-repeated`, `continues` | Table; requires explicit continuation/header metadata. |
| Row state | `partial-row`, `row-aligned`, `row-misaligned` | Row; partial follows explicit truncated-cell crop evidence. Page alignment never overwrites row alignment. |
| Cell state | `truncated-cell`, `empty-cell`, `missing-cell` | Cell. Empty requires an authored empty string. Null, absent metadata and clipped/untranscribed text are not evidence of an empty or missing source cell. |

`conditions.schema.json` defines records and tag vocabulary. `condition_tags.validate` adds facet/scope contradiction checks. Tags are additive across independent facets; exclusive values cannot coexist at the same exact scope. An upright native page and a differently scoped skewed inset are not a contradiction. `inherit_page` returns parent page conditions as `pageContext`, retaining original page scope, alongside independent child assertions. It does not rewrite a page's `aligned` into a row's `row-aligned` or replace row/cell state.

Each assertion records `tag`, `facet`, `scope` (`kind` and stable ID), evidence paths and SHA-256, `basis`, actor and confidence. Flat `tags` is a convenient union for filtering, not a substitute for scoped assertions; a page listed with `truncated-cell` may contain only one affected cell. File absence or tag absence means unknown/not asserted, never false. Unknown facets carry reasons.

The canonical confidence anchors are ordinal evidence strength: **0** unknown/unvalidated; **0.25** tentative weak evidence; **0.5** source/recipe-derived; **0.75** independently checked relevant evidence; **1** adjudicated against explicit matching evidence. These are not probabilities, accuracy percentages or hidden thresholds. Version one source-derived condition assertions use 0.5; no automatic 0.75/1 promotion. Existing annotation confidence is retained separately.

## Metadata-only backfill

```sh
python scripts/layout-eval/corpus_v2/condition_tags.py \
  /home/dan/data/docslurp-evals/layout-synthetic-v2 \
  --historical /home/dan/data/docslurp-evals/reference-inspiration-v2/historical
```

The command writes only `tags/*.conditions.json` plus `tags/index.json`. It hashes the current source, image/reference or capture-row bytes and never rerenders or edits originals. Refresh after the final master freeze; hashes expose stale evidence if source or image changes. Historical references remain references, including rights-unverified inspiration; a tag sidecar does not admit or license them.

Native pages get source-backed digital/born-digital/synthetic/aligned assertions. Table rules and continuation come from actual table regions and rendering commands. Capture composites get synthetic/picture, recorded projection, manual foreground occlusion and directional/mixed illumination where recorded. The deterministic rainfall crop is digital/cropped/aligned; its recipe name “scan” does not turn it into a documented physical scanner acquisition. Cropped cells and partial rows use explicit crop metadata. Do not score full-source photo prose as visible-only transcript; hand masks are area approximations, not character-level transcriptions.

The initial historical receipt records archive originals and observed page features, but does not establish actual scanner/camera acquisition or quality thresholds. Those sidecars therefore state unknown rather than guessing scanned, blurry or low-lighting. Small dimensions alone do not automatically establish low resolution: retain dimensions and define a task-specific threshold before asserting `low-res`.

## Vocabulary references

[DocLayNet](https://github.com/DS4SD/DocLayNet) distinguishes 11 layout classes and six document categories. We retain condition tags as an orthogonal axis instead of expanding paragraph/table classes with image defects.

[Doc3D](https://github.com/cvlab-stonybrook/doc3D-dataset) and [UVDoc](https://github.com/tanguymagne/UVDoc) motivate keeping capture/deformation geometry separate from content. UVDoc explicitly stores grid/UV/geometry information; our planar composites retain their actual homographies, not invented dense geometry.

[PubTables-1M](https://github.com/microsoft/table-transformer) includes row, column and cell locations, blank cells and header structures. This motivates stable row/cell scopes and the distinction between an empty cell, absent annotation and clipped text.

[DocRes](https://github.com/ZZZHANG-jx/DocRes) treats dewarping, deshadowing, appearance, deblurring and binarization as distinct restoration tasks. We likewise separate geometry, illumination and sharpness; a generic “bad scan” tag would hide those differences.
