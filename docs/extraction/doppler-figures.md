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
- **One file per extracted figure**: `images/page-0003/image-001.webp`, `images/page-0003/figure-002.svg`, or `.png` when
  Doppler fell back to a lossless raster (version 1 folders name them `p3.1.webp`; they are stored at the same page paths).
  A figure drawn again (the same image on a later page) points at the first one's file instead of storing it twice.
- **An index**, `doppler/<document>/index.json` (`docslurp-doppler-figures@1`): for every figure Doppler reported,
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
the Markdown. Nothing in the folder is trusted. The worker (`worker/src/extractors/doppler-figures.ts`) accepts a version 1 folder only if:

- it is a real directory holding only `manifest.json` and `<id>.<format>` regular files: no links, subdirectories or other
  names;
- the manifest (`doppler-figures@1`, `packages/shared/src/doppler-figures.ts`) parses strictly: unknown fields, ids that
  are not `p<page>.<n>` or `p<page>.g<n>`, an id whose page or kind disagrees with its fields, a file name that is not
  exactly `<id>.<format>`, formats other than `webp`, `svg` and `png`, a dangling `repeat_of`, or a page outside the
  document all refuse it;
- the files present are exactly the ones the manifest names;
- each file's size equals its `bytes` and its SHA-256 its `sha256` (checked while it uploads, see Storage);
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

### Manifest versions 2 and 3

Doppler's images manifest comes in two newer shapes, accepted beside version 1 until the provider's Doppler pin moves:

- **Version 3, `manifest.jsonl`** (`doppler-images/3`, Doppler's current `pdftomarkdown --images-dir`): JSON Lines, one
  ASCII object per line, each at most 64 KiB with its `\n`, keys in a fixed order. A header line
  (`"type":"header"`: the PDF's `source_sha256`, the `settings_sha256` a resume must repeat, `link_prefix`, `pages`
  (the `--images-pages` range `[A,B]`, or null), `dpi`, `min_side_pt`, `repeats`, `scan_pages`, `scan_dpi`, `scan_max_dpi`,
  `batch_pages`, `deadline_ms`, `resumes`); one `"type":"image"` line per image, in id order (page, pictures before
  figures, index), with the version 2 entry fields; one `"type":"batch"` line per batch (`pages`, `status`, `cut_page`,
  null when the batch finished); and the end line (`complete`, `resumable`, `totals`, the `images` and `batches` line
  counts, and `sha256`, the SHA-256 of every byte before the end line).
- **Version 2, `manifest.json`**: the same fields as one JSON object (`"version": 2`).

The worker reads version 3 **one line at a time in fixed memory** (`DopplerManifestV3Validator`,
`packages/shared/src/doppler-assets.ts`): each line is parsed and validated as it arrives and becomes one ledger row,
spilled to a private temporary file, so memory does not grow with the number of images. It refuses the folder when a line
is not ASCII, is longer than 64 KiB or has no `\n`, is not a JSON object, has an unknown `type`, or comes out of order
(header, images, batches, end, nothing after); when the end line is missing (a truncated manifest), its counts or totals
disagree with the lines, or its hash does not match; and when there are more lines than the document's entry cap. These
are Doppler's own reader's rules (`docslurp/doppler-md/src/extract/manifest.rs`) plus the checks below. A real Doppler
run is a test fixture (`worker/src/__tests__/fixtures/doppler-golden/v3-repeats`).

The provider reports the outcome: `extracted` (exit 0), `partial` (exit 5: the Markdown and some images were written, the
folder is kept, and the manifest says per image why the rest are missing) or `failed` (exit 6). A partial run is not a
failure: its files are validated and stored like a complete run's, and its missing images are recorded as resumable when
Doppler says a resume would retry them. The worker checks the outcome against the manifest (`complete`) and refuses the
folder (`outcome-mismatch`) otherwise.

Either way the folder holds only the manifest, optionally `page-facts.jsonl`, and `page-NNNN` real directories holding
only `(image|figure)-NNN.<format>` regular files. Every entry is checked strictly: unknown fields, values outside each
closed enum (`status`, `reason`, `fate`, `source`, batch `status`, `fallback`), non-finite or out-of-range numbers and
over-long strings refuse it. A linked image's `path` must be exactly the one derived from its own id and format, with no
extra leading zeros; only an image without a file of its own may share the path of the image it repeats, which must be an
earlier linked image that is not itself a repeat (no chains, no cycles). `link` must be the manifest's `link_prefix`
followed by that path, and the prefix must be `images/`, the one the host asks for (so the stored Markdown resolves with
no rewriting). Only page scans are copied or decoded, and a decoded scan is never a JPEG. `complete` with a stopped batch
or an image a stopped batch left is refused, as is `resumable` disagreeing with the images. Every total (`images`,
`linked`, `extracted`, `not_extracted`, `unlinked`, `bytes`, `repeats`, `fallbacks`, `scans`, `scan_bytes`, `batches`,
`batches_cut`: the batches whose status is not `ok`) must match the entries. The manifest must name this document's PDF
(`source_sha256`, when the host knows it). The files present must be exactly the paths of the `extracted` images, each of
its stated size.

**Sharded documents.** A provider that converts a long document in page ranges (one VM per shard, each running Doppler
with its own `-f/-l` and `--images-pages`) cannot merge the shards into one valid manifest: each shard's settings digest
differs, and a resume must use the shard's own manifest and range. Such a folder has the page folders at the top, as
always (page paths are global, so shards never collide), and `shards/<first>-<last>/manifest.jsonl` per shard (page
numbers zero-padded to 4 digits) instead of one `manifest.jsonl`; never both. Each shard manifest gets every version 3
check; its header's `pages` must be exactly its folder's range, and its image and batch lines must fall inside it. Across
shards: the ranges must not overlap, every shard must name the same PDF (`source_sha256`), every other header setting
must be equal (all fields but `pages`, `resumes`, `deadline_ms` and `settings_sha256`), and every file in the page folders
must be owned by exactly one shard's image line. Any violation refuses the whole folder. The shard manifests are stored at
`images/shards/<first>-<last>/manifest.jsonl` beside the page folders, each with its own artifact slot
(`<document>:doppler-manifest:<first>-<last>`).

**Gaps.** A provider may report page ranges it did not extract images for: `figures.gaps`, at most 128
`{first, last, reason}` entries of whole pages within the document, sorted and not overlapping, with `reason` from
`plugin:doc-pass-budget`, `plugin:shard-over-share`, `converter:timeout`, `converter:budget`, `converter:renderer`
(anything else is recorded as `other`, never as text). Malformed gaps make the whole figure answer a failure. They are
recorded on the document's extraction level; a page inside a gap with no ledger rows was not extracted. The plugin host
exposes `figureOutcomes: ["extracted", "partial", "failed"]` so a provider can tell that this core accepts `partial`.

The folder must be quiescent when it is read (the VM has exited). The reader still opens it defensively: directories are
read entry by entry with a cap (a huge directory is refused without being listed whole), page folders are opened with
`O_DIRECTORY | O_NOFOLLOW` and must be the device and inode the listing saw, every file is opened with `O_NOFOLLOW`, must be
a regular file with one link (a hard link could alias a file elsewhere) on the folder's device, and must resolve
(`realpath`) to exactly its path in the folder.

Doppler's `error` detail is telemetry only and never stored.

## Storage and serving

A document's Doppler output is stored in **Doppler's own folder layout** under one tenant-scoped prefix, so a plain
download of the folder is the conversion exactly as Doppler wrote it:

```text
<artifact root>/doppler/<document id>/
  document.md                         the Markdown as Doppler wrote it (its links are images/page-NNNN/...)
  source.json                         {sourceKey, sha256, pageCount, mimeType}: a pointer to the source, never served
  index.json                          DocSlurp's figure index (docslurp-doppler-figures@1)
  images/manifest.jsonl               the manifest bytes, unchanged (manifest.json for versions 1 and 2)
  images/page-facts.jsonl             doppler-page-facts/1 lines, when the provider returns them
  images/page-0003/image-001.webp     pictures and page scans
  images/page-0003/figure-002.svg     vector figures
```

`images/` is the `--images-link-prefix` the host passes, so every link of `document.md` resolves inside the folder with no
rewriting, and `images/` minus `page-facts.jsonl` is exactly the DIR `pdftomarkdown --images-resume` takes. The ledger's
`link_path` and a file's storage key share one relative path. Version 1 files are stored at the page path a version 2 run
would use. Sources are stored under upload-session keys and deduplicated across documents, so `source.json` points at the
source rather than copying it.

The artifact root is the run's tenant-scoped prefix (`<user>/<run>`, or an extract's own prefix). Each served object is a
document artifact slot: `<document>:doppler-figure:<id>` per file, `<document>:doppler-figures` (the index),
`<document>:doppler-manifest`, `<document>:doppler-page-facts` and `<document>:doppler-markdown`. `source.json` has no slot
and the file proxy refuses it by name. The slots are what authorize the objects: the file proxy (`/v1/files/<token>/<name>`)
serves an artifact only when its exact URI is one of the caller's documents' recorded slots, within the caller's projects and
organization, with the API key's `artifacts` scope, and not withheld by the project's PII policy (every slot of the document
written before the PII stage is withheld under `redact_artifacts` and `block_indexing`, these included). Revoking access, a
key from another organization or a key without the scope all get the same 404.

Image files are served with a content type fixed by their name, never by storage metadata or the bytes: `image/webp`,
`image/svg+xml`, `image/png` or `image/jpeg`, with `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`
and `Content-Disposition: inline`. SVG figures get `Content-Security-Policy: default-src 'none'; style-src
'unsafe-inline'; sandbox`, so opening one directly loads and runs nothing. The manifest and index are served as JSON or
plain text, the page facts as plain text and the Markdown as `text/markdown`, all under the sandbox CSP. Any other SVG is
still served as an `application/octet-stream` attachment.

**Memory and speed.** Storing streams every file: it is read in 1 MiB chunks, hashed and signature-checked as it goes, and
sent with one streaming PUT of its exact size (`ArtifactStore.putStream`); files of 256 KiB or less are read whole. Each
file is verified before its upload may complete (the last chunk is held back until the size, hash and signature check out);
a mismatch fails that upload, deletes what landed and refuses the folder. Uploads run concurrently
(`DOCSLURP_DOPPLER_FIGURE_UPLOAD_CONCURRENCY`, default 8), and the bytes they hold are reserved from a fixed per-job budget
(`DOCSLURP_DOPPLER_FIGURE_BUFFER_BYTES`, default 64 MiB) and a per-process ceiling shared by every document a worker runs
(`DOCSLURP_DOPPLER_FIGURE_WORKER_BUFFER_BYTES`, default 256 MiB), whatever the page count. The manifest, page facts,
Markdown and `source.json` are written only after every file has landed and checked out, and the index last.

Measured with an fs-backed store double (no local object store was used), Node 24:

| Folder | Previous (read all, then upload) | Streamed (budget 64 MiB) |
| --- | --- | --- |
| 500-page JPEG scan book, 470 MB in 500 files | 6.8 to 7.9 s, RSS +468 MiB | 6.2 to 7.1 s, RSS +56 to 78 MiB |
| Born-digital book, 300 pages, 2,400 WebP figures, 131 MB | 4.9 to 9.3 s, RSS +165 MiB | 4.0 to 5.4 s, RSS +89 to 94 MiB |

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

The host's caps grow with the document's page count `p`, within absolute bounds (`dopplerAssetCaps`), and are passed to
Doppler as its own limits (`SandboxedPdfJob.figures.limits`: `--images-max`, `--images-max-bytes`,
`--images-max-file-bytes`, `--scan-max`, `--scan-max-bytes`, `--images-doc-max-bytes`, `--images-batch-pages`,
`--images-link-prefix images/`), so Doppler's budgets stop it first, resumably (`budget`, `doc_budget`). The host refuses a
folder only when Doppler went past what it was told.

| Bound | Value |
| --- | --- |
| Files per document | `min(2048 + 2p, 32768)` |
| Page folders | `min(p, files cap)` |
| All files of a document | `min(64 MiB + 1.25 MiB x p, 4 GiB)` |
| Manifest entries (version 3: lines) | `min(16384 + 16p, 131072)` |
| One picture or figure | 8 MiB |
| One page scan copied or decoded from the PDF | 64 MiB |
| Version 3 manifest line | 64 KiB |
| Version 2 manifest (parsed whole) | `min(8 MiB + 128 B x entries, 16 MiB)`, at most 65,536 entries |
| Version 1 manifest | 4 MiB, 4,096 entries, 2,048 files, 64 MiB of files |
| `page-facts.jsonl` | `min(1 MiB + 16 KiB x p, 64 MiB)` |
| Batches | 16,384 |
| Image side | 16,384 px (or pt) |

A 500-page scanned book of about 1 MiB per page fits (the old fixed 64 MiB total refused anything past about 74 pages and
lost the whole ledger). Parsing a version 2 manifest at its 16 MiB cap peaks near 160 MB and 2 s (measured), which is why
version 2 is held to fewer entries; version 3 needs no such cap. Doppler applies its own limits inside the VM (crop pixels,
`pdfregions` memory and time; see its protocol). A document over any of these bounds keeps its Markdown and stores no image.

## Asset ledger

Every image Doppler reports for a document, whether or not it has a file, is a row of `document_assets` (migration
0141), and the document's extraction level is a row of `document_extraction_levels`. The figure step **queues** the write
on the run's state; the store writes it in one transaction after the stage checkpoint that records the Markdown and the
image slots commits, never before (`worker/src/db/document-asset-ledger.ts`, `Store.writeProgress`). `markdown_complete`
is whether that committed checkpoint holds the document's Markdown. An attempt that fails or is escalated drops its queued
write. The write never fails the document: a refused, stale or failed write is logged
(`[asset-ledger] document=... status=refused rule=...`, `status=stale-write`) and the stage stats say `ledger: "queued"`.

**Scope.** Both tables carry `org_id` and `project_id` (NOT NULL) and reference the document's own
`(id, project_id, org_id)` with a composite foreign key, so a row cannot name another organization's or project's
document, and a document without an organization has no rows. `run_id` references the run's own
`(id, project_id, org_id)` the same way (`ON DELETE SET NULL (run_id)`), so a row cannot name another tenant's run. Inside
the transaction the writer re-checks the document's organization and project (`scope-mismatch`), refuses a run that is not
the document's current run (`documents.run_id`) or is older than the run that wrote the current level (`stale-write`: a
superseded run, or one finishing late), and compares every storage key and the manifest key exactly to the keys derived
from the document's artifact root (`key-mismatch`); the database also checks that each key ends in the document's own
folder and the path derived from the image's id, compared as plain text. Values are only validated manifest fields from
closed vocabularies and bounded numbers, re-validated row by row; no text from the document is stored.

**Idempotent and bounded.** A row is keyed by `(document_id, asset_id)`. Rows stream into the write in id order and are
upserted in batches of 1,000, skipping rows that did not change; the rows of each finished page range that the new
manifest no longer lists are removed by an anti-join, so the table is always the full map of the latest manifest. Measured
on PostgreSQL 17 (local container): 131,072 rows (the cap) in about 10 s the first time, 4 s unchanged; about 16,000 rows
(a typical 1,000-page document) in about 1 s. The write stays one transaction so readers never see half a map; it holds
only that document's advisory lock. A step that stored nothing (the provider failed, or the folder was refused) removes the
rows and records `images_status: failed`.

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
| `render` | Rendered from the page (every version 1 file except a page scan's JPEG). |
| `copy` | A page scan's JPEG stream copied unchanged, metadata stripped. |
| `decode` | A page scan's samples decoded once and re-encoded (bilevel scans become 1-bit PNG); never a JPEG. |

Each row also keeps the image object (`obj_num`, `obj_gen`) and its `bbox`. Version 1 maps with what it has: a file is
`extracted` (`copy` only for a page scan's `.jpg`, else `render`); `repeat_of` is `not-extracted`/`repeat`; `error` is
`error`; `skipped: fate` is `unlinked`; any other skip is `other`; there is no link.

`document_extraction_levels` holds, per document: `markdown_complete`; `images_status`: `complete` (exit 0), `partial`
(exit 5, nothing a resume retries), `resumable` (exit 5, images a resume retries), `failed` (exit 6, a refused folder or a
failed store), and, written by extract-markdown whenever it commits a document's Markdown and no figure step ran, `none`
(another extractor won, not a PDF, no VM, a deduplicated copy) or `disabled` (figures off for the run), which takes a stale
resumable state out of the queue; `images_exit_code` and `doppler_build` when the provider reports them;
`manifest_version`; the stored manifest's key and SHA-256; for versions 2 and 3 the manifest's `source_sha256` and
`settings_sha256` (which a resume must repeat), `last_cut_page` (the `cut_page` of the last batch that has one: the first
page with an image that batch did not get to) and `deadline_ms`; `resumes`; and counts per status and source with the
stored bytes.

`document_page_facts` gains `text_layer` (`none`, `invisible`, `visible`, `mixed`) and `scan_class` (`none`, `single`,
`tiled`, `layered`). They are written through the ordinary page-facts write whatever the figure setting: `text_layer` from
the VM's layout facts today, `scan_class` once the provider returns `doppler-page-facts/1`.

A sharded document also has one `document_extraction_shards` row per shard (scoped like the other tables, with the same
composite foreign keys): its range, its stored manifest's key and SHA-256, its `source_sha256` and `settings_sha256`, its
own status (`complete`, `partial`, `resumable`), resumable count and host-side `resumes`. Its asset rows are the union of
the shards'. The document's level is the aggregate: `complete` only if every shard is, `resumable` while any image a
resume would retry remains, else `partial`; its `shards` column counts the shards and its manifest key is null. A write
for a single manifest (or a failed, `none` or `disabled` level) removes the shard rows. The level's `gaps` keeps the
provider's gaps, capped at 128.

**Reading it.** `GET /v1/documents/:id/assets` returns the level and the images, a page at a time: `limit` (1 to 1,000,
default 500), `after` (the previous page's `nextCursor`) and an optional `pageFrom`/`pageTo` range. It answers only for a
document the viewer is shown (status `completed`, in the caller's organization and a project it may use, and for an API key
the `artifacts` scope); anything else is the same 404 as a missing document. An image whose file the project's PII policy
withholds keeps its `sha256`, `bytes`, `width` and `height`, has no `slot`, and carries `refusal: "pii-policy"`; the
refusal is a fixed value, never error text or content. Storage keys, the manifest key and `source.json` are never
returned; a slot resolves to a file URL through the document detail, under the file proxy's own checks.

**Resuming.** `listResumableDocuments(sql, { orgId, projectId?, limit, after })` lists one organization's live documents
whose `images_status` is `resumable` and that have a stored manifest, and, for a sharded document, each resumable shard
as its own entry (`shard: { first, last }`), oldest first with a keyset cursor, with the hashes a resume must present and
the manifest's SHA-256. A shard's resume writes with `resume: { first, last }` and that shard alone: only its pages' rows
are upserted and pruned, its record's `resumes` goes up by one (capped at 3 like a whole document's), and the level is
recomputed from all rows and shard records. The host counts resumes itself (previous + 1 on each resume write; the
manifest's own `resumes` is telemetry only) and leaves a document out of the queue at 3, so a manifest that never finishes
cannot keep it there. A resume worker rebuilds Doppler's DIR from stored state with `downloadDopplerImagesDir`: it
downloads `images/manifest.jsonl`, checks its SHA-256 against the level's `manifest_sha256`, validates it line by line,
and downloads each `extracted` file from the key derived from its id (never a listing) into `DIR/page-NNNN/...`, checking
its size and SHA-256; `page-facts.jsonl` stays out. It then runs `pdftomarkdown --images-resume DIR` in the PDF VM with the
same PDF and settings, validates the returned folder like any other, stores it, and writes the ledger with
`resume: true`. Nothing runs resumes yet.

## Pending and stored files

Migration 0143 makes the asset ledger keep extracted figures on every failure path:

- **Pending, then stored.** Before each upload step (64 files), the figure step records the files as `pending` rows
  under their exact keys. After the step's uploads land and check out, it flips them to `stored`, in the same order for
  the first pass and `extract-markdown`. It does this as soon as the VM job returns, before the Markdown is stored, so a
  later failure keeps them. Such failures include the Markdown or text pass, a later stage, a cancelled or failed run, or
  a worker killed mid-upload. The level stays honest: `markdown_complete = false` until the checkpoint commits the
  Markdown, and `partial` or `resumable` from the rows.
- **Only stored rows count.** Only stored rows are served (slots, the assets route) or billed (`asset_bytes`). A crash
  can leave unbilled orphans, never billed ghosts.
- **Adopt, no VM.** The next attempt checks each pending row of the document's current run by streaming its object and
  hashing it (`adoptPendingAssets`). An object of exactly the row's size and SHA-256 becomes `stored`. A missing object,
  or one with other bytes, turns the image back into a resumable `aborted` one.
- **Never overwritten.** Keys stay exactly Doppler's layout, so the stored `images/` folder is a plain `--images-resume`
  DIR and `document.md`'s relative links resolve. Each figure is created with `If-None-Match: *`; Tigris returns 412
  for a taken key, for both buffered and streamed bodies (probed 2026-11-13). An object already at the key is accepted
  only when its SHA-256 is the manifest's, else the folder is refused (`object-conflict`) and the object is left as it
  is. A store without conditional creates still writes under the run's own artifact root, and a stale run's ledger writes
  are refused (`stale-write`).
- **Never deleted on failure.** No failure path deletes a figure object or row:
  - a failed upload reports `cleanup: "kept"`;
  - the failed-figures and no-figures ledger writes are level-only.
  A re-run that skips the figure step still takes the document off the resume queue: the level becomes that run's
  (`none` or `disabled`, with no rows of that run).
- **Only the level's run is current.** Rows an earlier run left are never served, counted or billed as current. The
  assets route reads only rows of the level's run, and slots come from the document's current run.
- **Who deletes.** Deleting the document or tenant purges its folder, as before. Run artifact retention purges a run's
  prefix. Otherwise, the orphan GC sweep (`figure-orphan-gc` in the maintenance sweeper, resume runner PR) is the only
  deleter: it removes objects under a document's `images/` folder that no ledger row vouches for, 24 hours after their
  last write. Objects of a failed run that still have rows are kept until that run's purge or the document's deletion.
- **A resume only adds.** It never rewrites or prunes a stored file (`resume-rewrite`). Its input is the shard's
  `manifest.jsonl` alone: `downloadDopplerImagesDir` defaults to `manifestOnly`, so finished figures never travel back
  into the VM.

## Resuming partial figures

A figure pass can leave images resumable: a batch or document budget, a deadline, or a shard that timed out. The resume
runner (`worker/src/figures/resume-runner.ts`) finishes them in the background.

**Queueing.** A document is queued in the same transaction that commits its resumable level
(`document_extraction_levels.resume_after`, migration 0144), when its project's `pipeline.figureResume` is `auto` (the
default). A backstop sweep in the API's maintenance sweeper (`figure-resume-enqueue`) re-queues any the commit missed.
`manual` projects queue only on request, and `off` projects (or projects whose figures are off) never do. Requests:

- `POST /v1/documents/{id}/assets/resume`, or the SDK's `resumeDocumentFigures(id)`;
- `POST /v1/projects/{id}/figures/resume?limit=N` (at most 100 per request), or `resumeProjectFigures(id, { limit })`;
- in the app's chat, the `proposeFigureResume` tool, which offers to "finish extracting the missing figures" for one
  document or the project. The user applies the card (`POST /v1/projects/{id}/figure-resume-proposals/apply`).

All three only queue. They need a server API key with `ingest`, or a session that may edit the project; anything outside
the caller's organization or project is a 404. `getProjectSettings` reports `figures.resumableDocuments`.

**Setting scope.** `figureResume` is a project setting. DocSlurp has no organization-level pipeline settings, so there is
no organization default above it.

**Running.**

- *When it runs.* The runner runs only while all of these hold:
  - `DOCSLURP_FIGURE_RESUME` is on (default off; queued documents wait and nothing is lost);
  - `DOCSLURP_DOPPLER_IMAGE_EXTRACT` is on;
  - the PDF provider implements `figures.resume`.

  Every worker runs it, with at most `DOCSLURP_FIGURE_RESUME_CONCURRENCY` resumes at once (default 2).
- *Claiming.* Each claim takes the oldest due document of each organization that holds no live lease (`distinct on`),
  re-locks it `for update skip locked`, and checks it again. The rules:
  - at most one resume per organization;
  - at most `DOCSLURP_FIGURE_RESUME_GLOBAL_MAX` resumes across the fleet (default 8);
  - only `completed` documents whose Markdown committed, on their current run.

  Failed, cancelled, `pii_blocked` and processing documents are never claimed.
- *Blocking and deferring.*
  - A project whose figures are off is blocked `figures-off`.
  - A project whose resumes are off is blocked `resume-off`.
  - An organization that may not spend is re-queued an hour later.
  - An organization past its daily resume VM budget (`DOCSLURP_FIGURE_RESUME_ORG_DAILY_VM_MINUTES`, default 120 minutes
    per UTC day, `figure_resume_org_days`) is re-queued for the next day.
- *The lease.* The lease is fenced. Every runner write after the claim matches the lease owner and the claimed run, so a
  runner that lost its lease, or a document that moved to a new run, is never overwritten.

**One unit per claim.** A unit is the unsharded document, one resumable shard, or one gap. A gap is a range with no
manifest, resumed by a fresh pass over its pages that becomes its shard. A unit is runnable only below #355's caps: 3 per
unit, and `min(3 × shards, 12)` per document. For the claimed unit:

1. Pending uploads a crashed attempt left are adopted (streamed SHA-256, no VM).
2. The lease is extended to cover the unit's VM budget (heartbeat).
3. The launch is counted against two caps:
   - the document's lifetime cap of 6 (`resume_vm_launches`), which no request resets and only a new run does;
   - the organization's daily count.
4. Only the unit's stored `manifest.jsonl` is downloaded; there is none for a gap. The provider runs `--images-resume` in
   a fresh VM, and no figure file goes back into the VM.
5. The folder is validated whole. Images already stored must keep their digest and are never uploaded again.
6. Figures on a page the document's PII stage withheld are added to the document's withheld list before upload. The rule
   is page-scoped: it uses `pii_detections.page_number` once the document withholds anything, and a withholding with no
   page number withholds every resumed figure. One PII page never blocks or fails the document; clean pages resume
   normally.
7. New figure files only (`folderFiles: false`) are stored pending, then stored, with conditional creates.
8. The new manifests are staged by content.
9. The ledger is written as a resume. It only adds, refuses `resume-rewrite`, keeps the pass's `markdown_complete`, and
   counts against the caps.
10. After the commit, the manifests are published at their places. An unsharded document's `index.json` is rebuilt with
    markers from the stored `document.md`. A resume never rewrites page facts or the Markdown.
11. The new files' slots join the document's run.

The document then goes back to the queue at once for its next unit. When no runnable unit is left, it is blocked
`attempts`, never re-queued.

**Cost, backoff and overtaking.**

- *Cost.* VM time, including failed and timed-out runs, is a cost-only usage event (`doppler-figures-resume-vm`) at its
  real allocated cost, `billable: false`. It is never a customer charge.
- *Backoff.* Failed attempts back off 2 minutes, 15 minutes, then 2 hours. The document is blocked `attempts` after
  three failures, or after its lifetime launch cap.
- *Requests.* A request clears only the backoff and any block other than `attempts`, never a counter.
- *Overtaking.* A reprocess or newer run that overtakes a resume makes its writes `stale-write`, so the resume is a no-op.
  A new run's level starts with a clean resume state (`resumeRunChangeSql`).
- *Binding.* The source and settings digests bind a resume to the same PDF and settings.

**Salvaged figures.** A failed VM job can hand back the shards that finished (`error.figures`, only when the host
declares `partial` in `figureOutcomes`). The stage stores them idempotently, with conditional creates and pending then
stored, before the failure stands, so a retry or resume starts from them.

**Orphan GC, retention and audit.** Every 30 minutes the leader walks up to 50 documents with figure rows or objects,
oldest audited first (`audited_at`).

- Pending rows older than 24 hours are adopted (no VM).
- Each folder is listed whole. A truncated listing skips the document: no deletes, and no "missing" verdict.
- Page files that no ledger row vouches for are collected 24 hours after their last write.
- Retention collects every object, and the rows, of:
  - a failed or cancelled document, 7 days after it ended;
  - a level that is no longer current (`assets_current = false`), after 24 hours.
- Each delete is re-checked under the document's ledger lock (`document-assets:<id>`) right before it happens.
- Each current stored row is HEAD-checked. Only a confirmed 404 or another size makes it a resumable `aborted` image. The
  document is then queued, without clearing an `attempts` block.
- Kill switches: the ledger writes need `DOCSLURP_FIGURE_AUDIT=1` and the deletes need `DOCSLURP_FIGURE_GC_DELETE=1`.
  Both default to a dry run that logs and measures only.

These are the only figure deleters besides document, run and tenant purges.

**Telemetry.**
- Log lines: `[doppler-figures] resume claim|unit|done|failed|stale|capped|deferred|requested|backstop|salvaged` and
  `[figure-audit]`.
- Spans: `figure-resume`, `figure-resume-backlog` and `figure-audit`.
- Metrics are on the OTel meter `docslurp.figures` (`recordFigureTelemetry`), so they reach SigNoz from background
  timers:
  - `resume.claimed`, `resume.attempts{outcome}`, `resume.capped{reason}`, `resume.deferred{reason}`, `resume.vm_ms`,
    `resume.added_files`, `resume.pii_withheld_files` and `adopted_files`;
  - the gauges `resumable_backlog` and `resume_oldest_age_s` (live documents only);
  - `gc.orphan_files`, `gc.orphan_bytes`, `gc.expired_files`, `audit.ledger_storage_drift`, `audit.adopted_files` and
    `audit.skipped_truncated`.

## Storage billing

Stored figures are billed as storage, measured rather than estimated. The daily storage meter
(`server/src/services/billing/storage-meter.ts`) reads `getOrgStorage`, which adds the sum of
`document_extraction_levels.asset_bytes` to `objectBytes`. The figure bytes follow the same rules as source bytes:

- Live documents (completed, not superseded) count. The daily meter leaves out extracts, which pay for their own
  retention window.
- Archived versions that are not yet purged also count.
- Superseded, purged and failed documents add nothing.
- Every sum is filtered by the organization, and the ledger's composite foreign key ties each row to its document's own
  organization.

The per-page artifact estimate (96 KiB per page) never included figures, so nothing is counted twice. The figure bytes
are charged through the existing daily storage event and credit debit, once per organization per day. The event's
metadata records `measuredArtifactBytes`, and so does `storage_meter_days.measured_artifact_bytes`. Pending uploads and
orphaned objects that no committed ledger row vouches for are never billed. A failed document's figures are not billed
while it is failed, exactly like its source file (the meter counts completed, non-superseded documents plus archived,
not purged ones); they are billed once a retry completes it.

## Not yet

- Figures are not merged into search results, chat citations or exports; they are artifacts and markers only.
- A deduplicated copy of a document (same content hash in a run) does not inherit the original's figures.
- No local-mode support: figures are cropped only inside the VM.
