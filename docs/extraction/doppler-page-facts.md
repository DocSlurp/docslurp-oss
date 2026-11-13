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
  `PageLayoutFacts` are stored as `page-layout-facts` with `source: "vm-pdf-facts"`. The facts also stand in for the host
  probes the sandboxed route never runs (see [Routing evidence](#routing-evidence)).

An unrecognised value is `off`, logged as an error.

In every mode the facts never size a charge: page-equivalent billing reads page sizes only from layout facts the VM's
walker measured. `use` does let valid facts steer routing where no walker facts exist, as layout facts do: a page the
facts show without words can be read by OCR or vision for the project that asked for it, billed by the host's page count.

## Routing evidence

The sandboxed PDF route runs none of the host's Poppler probes: page facts' `pdfimages -list` and `pdftotext`, page triage's
`pdfimages -list` and `pdfinfo` page sizes, the layout walker's `pdftotext -bbox-layout` run, and the OCR ledger's
`pdftotext`. Without them it had no page-image evidence (classify-route saw a sparse scan page as `unknown`) and no per-page
source rows in the ingest report. In `use` mode, `lib/doppler-page-facts-evidence.ts` builds both from the winning VM job's
facts, with no command:

- page-image evidence (`page-image-evidence`, `source: "doppler-facts"`, vision fallback on): the probe's sparse pages
  (fewer than `sparsePageWords` words in the text layer, invisible OCR words included, as `pdftotext` reads them), each
  with its significant, non-repeated image count and coverage under the probe's own rules (`minSignificantImagePixels`,
  `minSignificantImageCoverage`, the repeated-furniture rule), plus any page whose extracted text reads as garbled or suspect.
  `embeddedImageBytes` and `drawnBytesPerPage` are null: facts never read a stream;
- per-page rows in `document_page_facts` (`facts_source = 'doppler-facts'`): `word_count`, `image_count` (image rows, as
  `pdfimages -list` counts them) and `text_bytes`, which is 0 for a page with no text layer and otherwise null: facts count
  characters, never bytes.

Only facts that cover the document count: a complete stream (a run line last), no dropped line, no failed page, no document
error or lock, every page of the host's own count present with the `text` family and a complete `images.items` list. Any
less, in any mode but `use`, or when another extractor won, nothing is built and the route goes without, as before; the
stage records `dopplerFactsEvidence: { status: "skipped", reason }`.

Billing does not move: no size or read comes from the facts, Rich reads stay the provider's `ocrPages`, page-equivalent
sizes stay the walker's, and the per-page rows are not written for a run without a page billing pin, which still bills
pages with no text bytes and an image as scans at completion (`runBillsScansAtCompletion`).

Commands the facts cannot retire, and why:

| Command | Feeds | Kept because |
|---|---|---|
| `pdfpagecount`, `pdftotext -f 1 -l 1` | page count, Poppler acceptance | billing and limits use the host's own count |
| layout walker (`pdfimages -list`, `pdftotext -bbox-layout`, `pdf_layout_facts.py`) | layout facts | page-equivalent billing reads the walker's page sizes; facts have no `wordsInside`, `bytesPerPixel`, table or grid boxes |
| OCR ledger `pdftotext` | Rich reads of an extractor that OCRs without saying so | billing evidence; never on the sandboxed route |
| `pdfinfo` before `pdftoppm` | render bounds, rendered page areas | bounds an untrusted render and sizes a charge |

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
