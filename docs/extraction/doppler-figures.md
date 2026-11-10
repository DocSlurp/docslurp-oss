# Doppler figures

Doppler, the PDF extractor, can crop every picture and vector drawing it keeps on a page and save it as an image file
beside the Markdown. A chart drawn with paths comes back as SVG; a photo or scanned figure as WebP. The Markdown marks
where each figure sits, and DocSlurp stores the files as document artifacts that the API serves like any other.

This is off by default and runs only where PDFs run in the sandboxed PDF VM.

Doppler's side of it (what is cropped, how figures are grouped, the manifest it writes) is documented in the Doppler
repository: [`docslurp/doppler-md/README.md`](https://github.com/DocSlurp/doppler/blob/main/docslurp/doppler-md/README.md)
(restitching markers) and
[`docslurp/extraction/PROTOCOL.md`](https://github.com/DocSlurp/doppler/blob/main/docslurp/extraction/PROTOCOL.md)
(`pdfregions` and `pdftomarkdown --images-dir`).

## What you get

For each PDF the worker extracts with Doppler in the VM:

- **Markdown with markers.** `![image](doppler-image:p3.1)` is picture 1 of page 3; `![image](doppler-image:p3.g2)` is
  vector drawing 2. A figure between paragraphs is a paragraph of its own; a small picture inside a line of text stays in
  that line. The stored Markdown is Doppler's, byte for byte.
- **One file per extracted figure**: `p3.1.webp`, `p3.g2.svg`, or `.png` when Doppler fell back to a lossless raster.
  A figure drawn again (the same image on a later page) points at the first one's file instead of storing it twice.
- **An index**, `doppler-figures/<document>/index.json` (`docslurp-doppler-figures@1`): for every figure Doppler reported,
  its page, `bbox` (PDF points, page rotation applied, y down: the frame of Doppler's word boxes), `kind` (`picture`,
  `mask`, `vector`), Doppler's `fate`, `format`, content type, `bytes`, `sha256`, `width` and `height` (pixels, or points
  for SVG), `fileOf` (the figure whose file shows it) and `slot` (the document artifact slot of that file). `markers` lists
  the marker ids in the Markdown that resolve to a file.

Markers carry no words, so search, chunking, embeddings and summaries never see them; a marker line becomes an empty
image block in the canonical document, with the figure id in its metadata.

## Turning it on

Set `DOCSLURP_DOPPLER_IMAGE_EXTRACT=1` on the worker. It needs:

- `DOCSLURP_PDF_MODE=vm` (or another VM selection) and a sandboxed PDF provider that declares `figures`
  ([extractor plugins](extractor-plugins.md)). Otherwise the worker refuses to start: figures are never cropped on the
  worker host, and local mode (`DOCSLURP_PDF_MODE=local`) does not support them.
- A provider image whose Doppler build has `--images-dir` (and `pdfregions`). Turning the flag on against an older image
  fails every PDF job loudly rather than silently omitting figures.

Unset, `0`, `false` or `off` leaves extraction exactly as before: no `--markers`, no figure work, no new artifacts. Any
other value stops the worker at startup.

With the flag on, Doppler also writes its other restitching markers into the Markdown (`<!-- doppler:table-continued ... -->`
and `<!-- doppler:paragraph-continued -->`, see the Doppler README).

## How the worker handles the folder

The provider runs `pdftomarkdown --markers --images-dir <job folder> --report` inside the VM and returns the folder with
the Markdown. Nothing in the folder is trusted. The worker (`worker/src/extractors/doppler-figures.ts`) accepts it only if:

- it is a real directory holding only `manifest.json` and `<id>.<format>` regular files: no links, subdirectories or other
  names;
- the manifest (`doppler-figures@1`, `packages/shared/src/doppler-figures.ts`) parses strictly: unknown fields, ids that
  are not `p<page>.<n>` or `p<page>.g<n>`, an id whose page or kind disagrees with its fields, a file name that is not
  exactly `<id>.<format>`, formats other than `webp`, `svg` and `png`, a dangling `repeat_of`, or a page outside the
  document all refuse it;
- the files present are exactly the ones the manifest names;
- each file's size equals its `bytes` and its SHA-256 its `sha256`;
- each file starts with its format's signature: `RIFF....WEBP` with a matching RIFF size, the PNG signature, or for SVG
  `<?xml ` or `<svg` (after an optional BOM and whitespace).

The worker never decodes a figure. It reads each file to hash it and store it, and looks only at its leading bytes. SVGs
are reduced to an allowlist inside the VM before they leave it.

A refused folder stores no figure and keeps the Markdown; the stage stats say `dopplerFigures.status: "rejected"` with the
rule that refused it, and the worker logs `[doppler-figures] ... status=rejected rule=<rule>`.

When Doppler writes the Markdown but cannot extract the figures (its exit status 5; it removes the folder), the document
completes with its Markdown and no figures. The raw reason is logged (`[doppler-figures] ... status=extraction-failed
reason=...`) and never reaches an API response; stage stats carry only `dopplerFigures.status: "extraction-failed"`.

## Storage and serving

Files are stored under the document's artifact root with names built from database ids and the validated figure id:

```text
<artifact root>/doppler-figures/<document id>/p3.1.webp
<artifact root>/doppler-figures/<document id>/p3.g2.svg
<artifact root>/doppler-figures/<document id>/index.json
```

The artifact root is the run's tenant-scoped prefix (`<user>/<run>`, or an extract's own prefix). Each file is recorded
as a document artifact slot, `<document>:doppler-figure:<id>`, and the index as `<document>:doppler-figures`. That is
what authorizes them: the file proxy (`/v1/files/<token>/<name>`) serves an artifact only when its exact URI is one of
the caller's documents' recorded slots, within the caller's projects and organization, with the API key's `artifacts`
scope, and not withheld by the project's PII policy. Revoking access, a key from another organization or a key without
the scope all get the same 404.

Figure files are served with a content type fixed by their name, never by storage metadata or the bytes:
`image/webp`, `image/svg+xml` or `image/png`, with `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`
and `Content-Disposition: inline`. SVG figures get `Content-Security-Policy: default-src 'none'; style-src
'unsafe-inline'; sandbox`, so opening one directly loads and runs nothing. They are the only SVG the proxy renders: any
other SVG is still served as an `application/octet-stream` attachment.

SVG is stored uncompressed: the artifact store and file proxy do not set or forward `Content-Encoding`. Doppler compacts
SVG before writing it, and each file is capped (below).

## Resolving markers

Markers resolve at read time, the same way page images and other artifacts get URLs: the document detail
(`GET /v1/documents/:id`) lists each artifact slot with a file URL minted for that request, bound to the caller's
session or API key and short-lived. A stored Markdown cannot hold such a URL, so it keeps Doppler's markers and a reader
maps them:

```ts
import { dopplerFigureUrls, resolveDopplerImageMarkers } from "@docslurp/shared";

// artifacts: the document detail's `artifacts` ([{ slot, url }]); index: the parsed index.json (optional)
const urls = dopplerFigureUrls(documentId, artifacts, index?.figures);
const html = resolveDopplerImageMarkers(markdown, (id) => urls.get(id));
```

A marker whose id is not in the stored index (page text can imitate a marker) is removed, never turned into a URL.
Passing the index resolves repeats to the file they reuse.

## Limits

| Bound | Value |
| --- | --- |
| Manifest entries per document | 4,096 |
| Files per document | 2,048 |
| One file | 8 MiB |
| All files of a document | 64 MiB |
| Manifest | 4 MiB |
| Figure side | 16,384 px (or pt) |

Doppler applies its own limits inside the VM (crop pixels, `pdfregions` memory and time; see its protocol). A document
over any of these bounds keeps its Markdown and stores no figure.

## Not yet

- Figures are not merged into search results, chat citations or exports; they are artifacts and markers only.
- A deduplicated copy of a document (same content hash in a run) does not inherit the original's figures.
- No local-mode support: figures are cropped only inside the VM.
