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

## Page router

With `DOCSLURP_DOPPLER_PAGE_FACTS=use` and the v2 page router in `shadow` or `active`, the router reads its page features
from these facts instead of probing the PDF (`createDopplerFactsProbeRunner`, `worker/src/routing/probe/doppler-facts-runner.ts`):

- extract-markdown stores the winning job's validated facts as canonical lines (`dopplerPageFactsJsonl`) at
  `<artifactRoot>/routing-page-facts/<documentId>.jsonl` (slot `routing-page-facts`). route-pages reads only that key,
  re-validates it with `parseDopplerPageFacts` bounded by the host's measured page count, and never opens the PDF.
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
