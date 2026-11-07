# Embedded images

Born-digital PDFs draw raster images: figures, photos, scans, logos, masks. DocSlurp can keep them as artifacts,
describe them in a media map, reference them from the Markdown and export them beside it.

## Producers

| Producer | Assets | Placement | Markdown references |
| --- | --- | --- | --- |
| Sandboxed PDF provider ([plugin](extractor-plugins.md)) | Lossless WebP from its VM | As the provider measured it, or `unknown` | At the provider's reading-order position; page end when it has none |
| Local artifact graph (default) | PNG from `pdfimages` | Always `unknown` (`placementSource: "none"`) | None: the local graph has no position to put one at |

The local default reads `pdfimages -list` for what the PDF stores (type, size, colour space, encoding, object id,
resolution). It does not report where an image is drawn, so nothing is guessed.

## Contracts (`packages/shared`)

- `media-map.ts`: the facts a producer reports per drawn occurrence (`EmbeddedImageFacts`) and the published
  `document/media-map` (`docslurp-media-map@2`). Every field is validated strictly before it reaches an artifact.
- `image-routing.ts`: one threshold table that classifies each occurrence (blank, decorative, text-scan,
  chart-diagram, photo, figure, mask) and routes it (`skip`, `ocr`, `vision`, `label`, `keep`).
- `image-anchors.ts`: Markdown references, `![alt](docslurp-artifact:<artifactId>#p<page>o<occurrence>)`, each its
  own block. A later OCR, vision or caption result merges back as a labelled blockquote after its reference.
  `markdownBlocks` is the block-counting rule a producer must share, pinned by `test-vectors/markdown-blocks.json`.

## Exports

A document export lays embedded images out so the Markdown can be stitched back together:

```text
Report/
  Report.md                              ![Revenue](images/page-0001/image-001.webp)
  pages/page-0001.md                     ![Revenue](../images/page-0001/image-001.webp)
  images/page-0001.png                   rendered page image (when kept)
  images/page-0001/image-001.webp        occurrence 0 on page 1
  images/page-0001/image-001.smask.webp  its soft mask
  images/page-0003/image-002.webp
  images/index.json                      media map entries with export paths
  README.md
```

- Names come from (page, occurrence): collision-free, ordered and stable across re-exports. Masks sit beside the
  image they mask, suffixed with their role. An asset drawn on several pages is stored once, at its first
  occurrence; later references link to that file.
- `docslurp-artifact:` references become relative links only to files the zip holds. A withheld (PII policy),
  missing or capped image keeps its alt text only and is listed in the README.
- Markdown-only exports ship the images the Markdown references and their masks; full exports ship every image.
- Images are read only through the document's own artifact slots. A URI the artifact-graph manifest names but the
  document's run does not record is never opened.
