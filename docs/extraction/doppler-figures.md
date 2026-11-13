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
and `<!-- doppler:paragraph-continued -->`, see the Doppler README). They stay in the stored Markdown and are removed,
like the image markers, from canonical blocks, chunks, embeddings, summaries and search text. Exports keep the raw
Markdown.

Stage stats record `dopplerFigures.imagesConfined`: whether Doppler's renderer (`pdfregions`) confined itself inside the
VM, from Doppler's report (`null` when it did not say). Figures run with `--images-confine auto` for now. The index
keeps Doppler's `skipped` reason (`repeat`, `fate`, ...) for figures without a file; repeats are requested in `link`
mode, so a repeat resolves to its first figure's file.

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
are reduced to an allowlist inside the VM before they leave it, but that is a correctness filter, not the security
boundary: code running in the VM (a decoder compromise) could rewrite a file after it ran. The boundary is how figures
are served: a fixed `image/svg+xml` type, `nosniff`, and `default-src 'none'; style-src 'unsafe-inline'; sandbox`, so an
SVG carrying script or remote references stays inert (pinned by a server test).

A refused folder stores no figure and keeps the Markdown; the stage stats say `dopplerFigures.status: "rejected"` with the
rule that refused it, and the worker logs `[doppler-figures] ... status=rejected rule=<rule>`.

When Doppler writes the Markdown but cannot extract the figures (manifest version 1's exit status 5, or exit 6: it
removes the folder), the document completes with its Markdown and no figures. The raw reason is logged
(`[doppler-figures] ... status=extraction-failed reason=...`) and never reaches an API response; stage stats carry only
`dopplerFigures.status: "extraction-failed"`.

### Manifest version 2

Doppler's manifest version 2 (its `pdftomarkdown --images-dir` from the image-paths release) is accepted beside version 1
until the provider's Doppler pin moves. The provider hands over Doppler's own `manifest.json` (`"version": 2`) with the
folder Doppler wrote, and reports the outcome: `extracted` (exit 0), `partial` (exit 5: the Markdown and some images were
written, the folder is kept, and the manifest says per image why the rest are missing) or `failed` (exit 6). A partial
run is not a failure: its files are validated and stored like a complete run's, and its missing images are recorded as
resumable when Doppler says a resume would retry them. The worker checks the outcome against the manifest (a partial
outcome needs `complete: false`, a complete one `complete: true`) and refuses the folder (`outcome-mismatch`) otherwise.

A version 2 folder holds only `manifest.json` and `page-NNNN` real directories, each holding only
`(image|figure)-NNN.<format>` regular files. The schema (`dopplerManifestV2Schema`, `packages/shared/src/doppler-assets.ts`)
is strict: unknown fields, values outside each closed enum (`status`, `reason`, `fate`, `source`, batch `status`, `fallback`),
non-finite or out-of-range numbers, over-long strings, more than 16,384 images or batches, or a manifest over 8 MiB refuse
it. Each linked image's `path` must be exactly the one derived from its id (or, for a repeat, the id it repeats) and
format, with no extra leading zeros; `link` must be the validated `link_prefix` (relative, no `..`, at most 128 bytes)
followed by that path; at most one image may own a file; `resumable` and `complete` must agree with the images, and the
totals with the entries. The files present must be exactly the paths of the `extracted` images, with sizes, hashes and
signatures checked as for version 1. Files are stored under keys derived from the id that owns them
(`<artifact root>/doppler-figures/<document id>/<id>.<format>`), never from the folder's path, so the file proxy and its
fixed content types are unchanged.

Doppler's `error` detail and `obj` are checked but never stored. Version 2 Markdown links are real paths
(`images/page-0003/image-001.webp`); resolving them for display is a follow-up, as is moving the provider to version 2.

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
| Manifest entries per document | 4,096 (version 2: 16,384, unlinked images included) |
| Files per document | 2,048 |
| One file | 8 MiB |
| All files of a document | 64 MiB |
| Manifest | 4 MiB (version 2: 8 MiB) |
| Version 2 batches | 16,384 |
| Figure side | 16,384 px (or pt) |

Doppler applies its own limits inside the VM (crop pixels, `pdfregions` memory and time; see its protocol). A document
over any of these bounds keeps its Markdown and stores no figure.

## Asset ledger

Every image Doppler reports for a document, whether or not it has a file, is a row of `document_assets` (migration
0140), and the document's extraction level is a row of `document_extraction_levels`. The figure step writes both in one
transaction (`worker/src/db/document-asset-ledger.ts`), scoped to the run's organization and project. It never fails the
document: a refused or failed write is logged (`[asset-ledger] document=... status=refused rule=...`) and noted in stage
stats (`dopplerFigures.ledger`).

**Scope.** Both tables carry `org_id` and `project_id` (NOT NULL) and reference the document's own
`(id, project_id, org_id)` with a composite foreign key, so a row cannot name another organization's or project's
document, and a document without an organization has no rows. The writer re-checks the document's organization and
project inside the transaction and refuses (`scope-mismatch`, nothing written) when they differ; an upsert never
overwrites a row of another scope. Every read filters by organization. Values are only validated manifest fields from
closed vocabularies and bounded numbers, re-validated before the write; no text from the document is stored.

**Idempotent.** A row is keyed by `(document_id, asset_id)`. A re-run or a resume updates rows in place; images the
new manifest no longer lists are removed, so the table is always the full map of the latest manifest. A step that stored
nothing (the provider failed, or the folder was refused) removes the rows and records `images_status: failed`.

| `status` | Meaning |
| --- | --- |
| `extracted` | The image owns a stored file: `format`, `bytes`, `sha256`, `width`, `height`, `source` and `storage_key` are set. |
| `not-extracted` | The Markdown links it (or, for version 1, marks it) but it has no file of its own; `reason` says why. |
| `unlinked` | Doppler placed it without a link (`fate` furniture, watermark, background, small, fragment, grouped, ...). |

| `reason` | Meaning |
| --- | --- |
| `repeat` | Same image as `repeat_of`; `file_of` names the image whose file shows it. |
| `min_side`, `bbox`, `id`, `pages` | Too small, an unusable box or id, or outside `--images-pages`. |
| `file_bytes`, `encode`, `error` | Over the per-file cap, the encoder failed, or the renderer reported an error for this image. |
| `scan-pages`, `copy` | Page scans skipped (`--scan-pages skip`), or a scan copy failed its checks. |
| `budget`, `doc_budget`, `timeout`, `deadline`, `aborted` | The batch or document stopped; `resumable` is true when Doppler says a resume retries it. |
| `renderer` | The batch's renderer failed; not resumable. |
| `other` | A version 1 skip reason outside this vocabulary. |

| `source` | Meaning |
| --- | --- |
| `render` | Rendered from the page (every version 1 file except a JPEG scan). |
| `copy` | A page scan's JPEG stream copied unchanged, metadata stripped. |
| `decode` | A page scan's samples decoded once (bilevel scans become 1-bit PNG). |

Version 1 maps with what it has: a file is `extracted` (`copy` for a `.jpg` scan, else `render`); `repeat_of` is
`not-extracted`/`repeat`; `error` is `error`; `skipped: fate` is `unlinked`; any other skip is `other`; there is no link.

`document_extraction_levels` holds, per document: `markdown_complete`; `facts_level` (`none`, `basic`, `full`: the
`doppler-page-facts/1` level, `none` until the provider returns page facts); `images_status` (`complete` exit 0,
`partial` exit 5 with nothing a resume retries, `resumable` exit 5 with images a resume retries, `failed`, and `none` /
`disabled` for writers that record a skipped step); `images_exit_code` and `doppler_build` when the provider reports them;
`manifest_version`; for version 2 the manifest's `source_sha256` and `settings_sha256` (which a resume must repeat),
`resumes`, the last batch's `cut_page` and `deadline_ms`; and counts per status and source with the stored bytes.
`document_page_facts` gains `text_layer` (`none`, `invisible`, `visible`, `mixed`, from the layout facts today) and
`scan_class` (`none`, `single`, `tiled`, `layered`, from page facts once the provider returns them).

**Reading it.** `GET /v1/documents/:id/assets` returns the level and every image (status, reason, resumable, source,
format, size, hash, link, `fileOf` and the artifact `slot` of the file that shows it). It is gated like the document
detail: the caller must reach the document's project, and an API key also needs the `artifacts` scope and a project it
may use; anything else is the same 404 as a missing document. Storage keys are never returned; a slot resolves to a file
URL through the document detail, under the file proxy's own checks.

**Finding resumable work.** `listResumableDocuments(sql, { orgId, projectId?, limit, after })` lists one organization's
live documents whose `images_status` is `resumable`, oldest first with a keyset cursor, with the hashes a resume must
present (`--images-resume` refuses a different PDF or settings) and the count of resumable images. Nothing resumes yet;
a resume worker would run `--images-resume` in the PDF VM and write the ledger again through the same transaction.

## Not yet

- Figures are not merged into search results, chat citations or exports; they are artifacts and markers only.
- A deduplicated copy of a document (same content hash in a run) does not inherit the original's figures.
- No local-mode support: figures are cropped only inside the VM.
