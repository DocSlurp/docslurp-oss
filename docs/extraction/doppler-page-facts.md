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
  when they have one; the facts give the scan class. Doppler's raw `page-facts.jsonl` is kept beside the figure
  manifest when figures are on ([Doppler figures](doppler-figures.md)).
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

## Chart and diagram candidates

Chart export (`worker/src/chart-export/facts-candidates.ts`) reads the facts again from the document's
`doppler-page-facts-canonical` slot: the canonical lines extract-markdown re-serialized from what the reader kept, parsed
again by the same strict reader and bounded by the host's page count. No slot, or facts the reader refuses, leaves chart
export exactly as it was.

**Candidates (`use` only, and only without a router plan, which owns chart labels when it exists).** A page or region is
a candidate from its structure, not its words. Each candidate carries the cluster or image box as its crop, so the model
reads crops, never whole pages:

| rule | stands alone | needs the keyword route on its page |
|---|---|---|
| figure cluster (curved or diagonal drawing) at least 48 pt on its short side, 6 paths, 2–90% of the page | the page's `uncoveredRatio` ≥ 0.6, or `coverage` × `uncoveredRatio` ≥ 0.15 (a large non-text vector area) | `uncoveredRatio` 0.3–0.6 |
| placed image, 4–85% of the page, at least 96 samples a side, not a stencil mask, on a page whose `scan` is `none` | never: photos are common | always |

Never candidates: a page with `uncoveredRatio` below 0.3 (underlines, boxes around text, ruled tables), thin rule-like
clusters, a scan page's images, and furniture: an image `obj` or a cluster box that recurs on at least 3 pages and 20% of
the pages with facts (logos, headers, borders). At most 4 candidates a page, largest first. The keyword route
(`chart-or-figure`) stays a vote: alone it is still low confidence; a facts candidate on its page replaces its whole-page
read with crops. The thresholds are general structure limits (`FACTS_CANDIDATE_RULES`), set from the contract's field
meanings, not from any evaluation document.

Known gap: Doppler clusters only curved or diagonal drawing, so an axis-aligned bar chart drawn only with rectangles has no
cluster box to crop and is left to the other signals.

**One read per repeated picture (`store` and `use`).** Before a model reads a crop or an image, candidates are grouped by
the facts' image object number and the media map's content hash (sha256), transitively, within the document only. The first
placement whose read the provider answers stands for the group; the other placements reuse its visual with no call and no
charge. A read that failed before an answer, or a whole-page read, stands for nothing. Visual candidate stats count a group
once (so measured estimates price the reads that will be made), and the stage stats record
`chartExport.dedupe: { groups, placements, readsAvoided }` and, with `use`, `chartExport.factsCandidates` per rule.

Charges are per read made, as before: a reused placement has no answered call, so it is never charged. Nothing about the
facts sizes a charge.
