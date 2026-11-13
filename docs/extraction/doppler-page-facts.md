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
  `minSignificantImageCoverage`, and the repeated-furniture rule over significant placements in the probe's listing scope).
  No text-layer verdict: the probe judges the PDF's own layer, which facts do not carry, and judging the extracted Markdown or
  OCR text instead would call math, tables or OCR output garbled. `embeddedImageBytes` and `drawnBytesPerPage` are null:
  facts never read a stream, so the drawn-content hint stays off;
- per-page rows in `document_page_facts` (`facts_source = 'doppler-facts'`): `word_count`, `image_count` (image rows, as
  `pdfimages -list` counts them) and `text_bytes`, which is 0 for a page with no text layer and otherwise the extracted page's
  whitespace-collapsed bytes, or null for a page a model read (its text is OCR output, not the layer).

Only facts that cover the document count: a complete stream (a run line last), no dropped line, no failed page, no document
error or lock, every page of the host's own count present with the `text` and `geometry` families and a complete
`images.items` list. Any
less, in any mode but `use`, or when another extractor won, nothing is built and the route goes without, as before; the
stage records `dopplerFactsEvidence: { status: "skipped", reason }`.

No page count, size or charge comes from the facts: the page count stays the host's, page-equivalent sizes stay the
walker's, extract-markdown's Rich reads stay the provider's `ocrPages`, and the per-page rows are not written for a run
without a page billing pin, which still bills pages with no text bytes and an image as scans at completion
(`runBillsScansAtCompletion`). The evidence is routing evidence, though: like the probe's, it can make classify-route send a
sparse scan page to a vision read, and that read bills Rich when it happens, for a project with vision fallback on. To keep a
counting gap or hostile facts from turning text pages into reads, the facts must agree with the extraction: a page the facts
call sparse while the winning extraction read `sparsePageWords` or more words from it without a model (the provider's OCR,
host scan-fill and accepted critique pages are exempt) refuses the whole
document's evidence (`words-disagree`), and an image never counts for more of the page than its own box covers.

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
