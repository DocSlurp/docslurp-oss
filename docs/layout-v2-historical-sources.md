# Historical source references for layout corpus v2

Observed on 2026-10-20. These four real document images provide visual inspiration and review evidence; they are not synthetic pages or evaluation gold. Downloaded image bytes remain outside Git in `/home/dan/data/docslurp-evals/reference-inspiration-v2/historical/`.

`source-manifest.json` in that directory records exact download URLs, SHA-256 hashes, byte counts, image dimensions, source pages, rights status and visually observed features. `downloads.json` preserves download timestamps. HTML snapshots preserve the source statements checked during curation.

| Image | Dimensions | Visually observed layout | Campaign permission |
| --- | --- | --- | --- |
| `constitution-page-1.jpg` | 630 × 762 | Ornate large opening, centered article heading, single wide cursive flow, indented sections, folds and faded ink | Reuse allowed; credit National Archives |
| `declaration-parchment.jpg` | 630 × 766 | Spaced top heading, large title, severely faded handwritten body, signature clusters, creases and uneven contrast | Reuse allowed; credit National Archives |
| `bill-of-rights.jpg` | 1128 × 1200 | Multiple centered heading scales, hanging article labels, indented continuations, lower attestations, foxing and folds | Reuse allowed; credit National Archives |
| `magna-carta-1297.jpg` | 1852 × 3143 | Dense medieval Latin script block, decorated initial, folded bottom, hanging tab and wax seal | Inspiration only; image rights unconfirmed |

The [National Archives founding-document downloads page](https://www.archives.gov/founding-docs/downloads) explicitly declares its images public domain and requests source credit. The files here are the smaller official website derivatives of those historical images; their precise derivative URLs are in the manifest. They support layout review but the 630-pixel images should not support fine transcription claims.

The [1297 Magna Carta press-kit image](https://www.archives.gov/press/press-kits/magna-carta/images.html) is presented courtesy of its private owner. The [NARA use policy](https://www.archives.gov/global-pages/privacy.html) cautions that not all hosted holdings are unrestricted. The manuscript's age alone does not establish rights in the downloaded photograph, so this asset remains inspiration only and must not enter a redistributable fixture bundle without a separate rights determination.

## Evidence and labeling boundaries

These are four distinct source documents, not feature-count multipliers. They add historical handwriting, legal layout, physical aging, signatures and a seal to a larger mixed corpus. Two near-identical copies of a page should never be counted as two layout designs.

No source transcription, bounding boxes, or reading-order labels were authored in this curation. All assets have `label_tier: unlabeled-reference` and `ground_truth: null`. Any later real-page annotations must be marked reviewed silver with source/hash/region provenance before capture transformations. Synthetic pages inspired by these sources must carry authored text and explicit structure before rendering; do not infer their gold from OCR of these images.


## First manual silver review artifact

The Bill of Rights has a separate manual annotation pilot under `/home/dan/data/docslurp-evals/layout-synthetic-v2/historical-silver/`. Its `manualmanifest.jsonl` points to the unchanged source image, 18 coarse manual regions, official transcript provenance and a review overlay. Regions cover the title, opening date, introductory prose, twelve proposed articles and a combined attestation/signature group. The last group uses `illustration` with original semantics retained as attributes; no new production label is introduced.

This pilot is `manual-silver-awaiting-independent-review`, with no benchmark admission. Pixel and normalized boxes are estimates drawn after viewing the real raster, not native construction geometry. The five confidence axes use the campaign ordinal evidence rubric (0, .25, .5, .75, 1), not probabilities: geometry .5, semantic label .75, text transcription .25, visibility/occlusion .75, reading order 0. Each axis records its basis and provenance. Fading is observed; no occluded-area fraction is claimed.

The official [NARA transcription](https://www.archives.gov/founding-docs/bill-of-rights-transcript) is preserved as HTML plus normalized text, with hashes. Text is associated at semantic-block level only; image spelling, punctuation and physical line alignment are not independently verified. Line boundaries remain unknown and transcription evaluation is explicitly disabled. The original four-reference manifest remains unlabeled; manual annotations live in their separate pilot and do not silently upgrade any reference to gold.
