# Doppler page facts (`doppler-page-facts/1`)

Doppler computes compact per-page facts during the text pass it already runs: geometry, the text layer (visible and
invisible words, coverage), fonts, images with their codec, resolution and scan class, vector drawing (rules, grid score,
figure clusters), form fields, annotations, optional content, parse warnings and unusual features. The contract (field
meanings, levels, families) is Doppler's: `docslurp/page-facts/README.md` and `doppler-page-facts-1.schema.json` in
[DocSlurp/doppler](https://github.com/DocSlurp/doppler).

A sandboxed PDF provider returns them as `SandboxedPdfResult.pageFacts` beside the Markdown of the same VM job (one file
of a batch carries them on its text event). This page describes how the worker treats them.

## Trust

The facts come from a VM that read a customer file, so the worker treats every byte as hostile. The reader
(`worker/src/lib/doppler-page-facts.ts`, `parseDopplerPageFacts`):

- refuses input over a byte budget before parsing it: 256 KiB plus 12 KiB per page, at most 64 MiB; a stream with more lines (blank ones included) than the page count needs; and a
  missing or malformed doc line. Without a page count the host measured, facts are dropped;
- drops a line that is over 64 KiB, not printable ASCII (the contract escapes everything else), not JSON, of another
  schema or type, out of order, outside the host's page count, or unterminated at the end of the stream; a page that
  appears twice is unknown;
- accepts finite numbers only, ratios in 0..1, non-negative integer counts, closed enums (an unknown enum value is
  dropped, as the contract asks) and bounded lists; a family that fails any check, or whose counts contradict each
  other, is absent (unknown) while the rest of the page stands;
- never reads `producer`, `creator` or `lang`, the document's own strings in the stream, nor any field it does not know; the run
  line's `version` and `commit` are kept only as a dotted version and a hex commit.

Facts that must be handed on (the first pass's stored batch result) go as canonical lines re-serialized from what the
reader kept (`dopplerPageFactsJsonl`), never as the guest's bytes.

Page counts for billing and limits stay the host's own (pdfpagecount). The facts' `pageCount` is kept only as
`reportedPageCount`. Missing or malformed facts never authorize a read or raise a charge.

## Modes

`DOCSLURP_DOPPLER_PAGE_FACTS`:

- `off`: facts a provider returns are dropped unread.
- `store` (default): parsed, and each known page's text layer and scan class recorded in `document_page_facts`
  (`text_layer`, `scan_class`; migration 0141) through `upsertPageFacts`. The walker's layout facts give the text layer
  when they have one; the facts give the scan class. The facts themselves are stored as
  `<artifact root>/doppler/<documentId>/images/page-facts.jsonl` (slot `doppler-page-facts`), beside the figure manifest
  ([Doppler figures](doppler-figures.md)), whatever the figure setting: canonical lines re-serialized from what the
  reader kept (`dopplerPageFactsJsonl`), never the guest's bytes, so without `producer`, `creator`, `lang` or any field
  the reader does not know. The file proxy serves it as text, behind the same artifact and PII checks as the folder's
  other files. Malformed or refused facts write no object.
- `use`: as `store`, and when the provider returned no layout facts the facts stand in for them: the mapped
  `PageLayoutFacts` are stored as `page-layout-facts` with `source: "vm-pdf-facts"`.

An unrecognised value is `off`, logged as an error.

In every mode the facts never size a charge: page-equivalent billing reads page sizes only from layout facts the VM's
walker measured. `use` does let valid facts steer routing where no walker facts exist, as layout facts do: a page the
facts show without words can be read by OCR or vision for the project that asked for it, billed by the host's page count.

## Mappings

`pageLayoutFactsFromDopplerFacts` (`worker/src/lib/doppler-page-facts-layout.ts`) fills `PageLayoutFacts` so
classify-route and page-image evidence read the facts unchanged:

| `PageLayoutFacts` | from the facts |
|---|---|
| `words` | `text.wordCount` (null without `text`) |
| `invisibleWords`, `textLayer` | `text.invisibleWordCount`, `text.textLayer` |
| `widthPt`, `heightPt` | `geometry.widthPt`, `heightPt` (the CropBox with rotation; the walker uses CropBox ∩ MediaBox) |
| `images` | `images.items`: box, coverage, pixel size, bits, colour space and codec in the walker's vocabulary, ppi; `repeated` from `obj` across pages. Null when not computed or truncated |
| `images[].bytesPerPixel`, `images[].wordsInside` | null: facts never read the stream or the word boxes |
| `grids` | `[]` when the `vectors` family proves no ruled grid (fewer than 2 horizontal or 3 vertical rules, no cap hit); otherwise null |
| `tables`, `tableCoverage` | null: tables come from the Markdown |

`probeRowsFromDopplerFacts` (`worker/src/routing/probe/doppler-facts.ts`) builds the v2 router's `ProbeRow` with
`probeEngine: "doppler-facts"` and no thumbnail; its header comment lists each field.

## Page router

With `DOCSLURP_DOPPLER_PAGE_FACTS=use` and the v2 page router in `shadow` or `active`, the router reads its page features
from these facts instead of probing the PDF (`createDopplerFactsProbeRunner`, `worker/src/routing/probe/doppler-facts-runner.ts`):

- route-pages reads the canonical facts extract-markdown already stored (`<artifactRoot>/doppler/<documentId>/images/page-facts.jsonl`,
  slot `doppler-page-facts`; written in `store` and `use` before the stage commits). It reads only the address recorded in the current run's
  `doppler-page-facts` slot, and only when that address is the key `dopplerFolderKey` gives for this run and document (a
  file left at the key by a failed attempt or an earlier run, without a current-run slot, is never read), re-validates it with `parseDopplerPageFacts` bounded by the document's page count and
  the reader's byte budget, and never opens the PDF.
- Facts that are missing, refused, oversized, for an unreadable document, for fewer pages than the host counted, or with
  every page failed are unavailable: no plan is written and the document keeps v3 routing (`page-route-fallback`). Missing
  or refused facts never authorize a model read or a charge. Valid facts (including a failed page, as the native probe's
  failed row) steer the plan like probe rows do, within the run's quality tier and cost cap. In `active` mode the facts must
  cover every host page, so a locked row on a multi-page document is unavailable there. A doc line that says a user
  password is required gives the locked row.
- On a sandboxed deployment (the checks extract-markdown uses for `sandboxed-pdf-deployment` and for a project whose PDF
  extractor order names vm-pdf, `sandboxed-pdf-route`, plus `NODE_ENV=production` or the service profile) every host-side PDF access in the router is refused before it happens: the native probe, its
  encrypted-file byte scan, thumbnails, inset renders and clips and the table gate. A refusal is logged as an error and
  recorded as `page-route-host-pdf-refused`. Without facts mode `use` a sandboxed deployment writes no plan.
- Facts carry no pixels, so image decision models are skipped (`decision-model-skipped:no-host-pixels:<ids>`) and their
  pages take the existing escalation path; text-only decision models still run.

Shadow telemetry compares the facts-driven plan with v3. Each `page-route-decision` row carries `probeSource` and
`shadowComparison` (`routerRoles`, `routerNeedsPixels`, `v3Route`, `v3OcrAuthorized`, `v3NeedsPixels`, `agreesWithV3`);
`page-route-chunk-estimate` carries the document totals (`pages`, `compared`, `agree`, `routerOnlyPixels`, `v3OnlyPixels`).
The router needs pixels for any role beyond `accept-text` or `skip`; v3 does for any route other than `straightforward-text`
or an authorized OCR decision.

## Chart and diagram candidates

Chart export (`worker/src/chart-export/facts-candidates.ts`) reads the facts again from the document's
`doppler-page-facts` slot (the canonical lines above), through the same strict reader, bounded by the host's page count
and byte budget. No slot, or facts the reader refuses, leaves chart export exactly as it was. Unlike the page router,
chart export also reads a slot a partial reprocess seeded from an earlier run of the same document (the same source
bytes); it never reads another document's facts.

**Candidates (`use` only, and only without a router plan, which owns chart labels when it exists: with the page router
in `shadow` or `active` on these facts, its plan's labels are used instead).** A page or region is
a candidate from its structure, not its words. Each candidate carries the cluster or image box as its crop, so the model
reads that crop; a facts candidate whose crop cannot be made is not read at all (never the whole page). A page whose
CropBox differs from its MediaBox, or whose size is outside 1–14,400 pt, gets no facts boxes (unknown):

| rule | stands alone | needs the keyword route on its page |
|---|---|---|
| figure cluster (curved or diagonal drawing) at least 48 pt on its short side, 6 paths, 2–90% of the page | the page's `uncoveredRatio` ≥ 0.6, or `coverage` × `uncoveredRatio` ≥ 0.15 (a large non-text vector area) | `uncoveredRatio` 0.3–0.6 |
| placed image, 4–85% of the page, at least 96 samples a side, not a stencil mask, on a page whose `scan` is `none` | never: photos are common | always |

Never candidates: a page with `uncoveredRatio` below 0.3 (underlines, boxes around text, ruled tables), thin rule-like
clusters, a scan page's images, and furniture: an image `obj` or a cluster box that recurs on at least 3 pages and 20% of
the pages with facts (logos, headers, borders). At most 4 candidates a page, largest first, and 500 a document. The keyword route
(`chart-or-figure`) stays a vote: alone it is still low confidence; a facts candidate on its page replaces its whole-page
read with crops. The thresholds are general structure limits (`FACTS_CANDIDATE_RULES`), set from the contract's field
meanings, not from any evaluation document.

Known gap: Doppler clusters only curved or diagonal drawing, so an axis-aligned bar chart drawn only with rectangles has no
cluster box to crop and is left to the other signals.

**One read per repeated picture (`store` and `use`; `off` turns it off).** Before a model reads a crop or an image,
candidates are grouped by the facts' image object number and the media map's content hash (sha256), transitively, within
the document only. An image-backed candidate (image routing, a router image inset) takes a facts `obj` only when its box
and the image's agree to IoU 0.9, and never from a stencil mask, the page's scan image, or two objects in one place; a
vector cluster or router region never takes one. Only a placement the facts show nothing drawn over shares a read: no
figure cluster crossing its box and no text over images on its page (one base image under different data points or
labels is different pictures). Without facts for its page a placement is never grouped, so a document without facts
reads as before. The first placement whose read the provider answers stands for the
group; the other placements reuse its visual with no call and no charge. A read that failed before an answer, or a
whole-page read (a crop that failed), stands for nothing; a placement waiting for it reads for itself, within the read
cap checked again after the wait. Visual candidate stats count a group
once (so measured estimates price the reads that will be made), and the stage stats record
`chartExport.dedupe: { groups, placements, readsAvoided }` and, with `use`, `chartExport.factsCandidates` per rule.

Charges are per read made, as before: a reused placement has no answered call, so it is never charged. Nothing about the
facts sizes a charge.

Known limits: clusters cover curved and diagonal drawing only, so an axis-aligned overlay (rectangles drawn over a base
image) is not seen; one image object drawn with different clips (sprites, crops of one large image) is treated as one picture;
a reused `none` answer leaves a later placement's middling deterministic spec unused; and the same chart image on many
pages counts as furniture for nomination (other signals still list it, and it is then read once). In `use`, standalone
vector candidates are a new source of reads that a first estimate built on the per-page prior does not see until stats
are recorded; the read cap per document still bounds them.
