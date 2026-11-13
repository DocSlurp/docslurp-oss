# PII withholding is page-scoped

One page with PII no longer blocks a whole document. Under the project PII policy `block_indexing`, a match withholds
the page it is on. The rest of the document completes and stays searchable, chattable, previewable and exportable.

## Policy actions

| Action | A match does |
| --- | --- |
| `flag_for_review` | Records the detection and flags the document. Nothing is withheld. |
| `redact_artifacts` | Replaces each matched value. Artifacts the scan did not rewrite are withheld, except the page images and figures of pages with no match. |
| `block_indexing` | Withholds the page with the match (its text, chunks, vectors, search hits, citations, page images, renders, figures, tables and structured-extraction evidence). The document completes. |
| `block_document` | Withholds the whole document (status `pii_blocked`). This is the explicit choice for whole-document blocking. |

Under `block_indexing`, the document is still `pii_blocked` when:

- every page is withheld, or
- a match cannot be placed on a page (the fail-closed fallback).

## Behaviour change for existing projects

Projects that already use `block_indexing` become page-scoped too, and no policy is migrated to `block_document`.
Their documents start serving their clean pages from the next scan on. Projects that want the old whole-document
behaviour set `block_document`.

Documents already `pii_blocked` are **not** rescanned automatically. They keep their state until they are rescanned or
reprocessed. Operators can count what a rescan would change, read-only, with:

```sh
psql "$DATABASE_URL" -f scripts/pii-page-scope-dry-run.sql
```

It groups the blocked documents by verdict, using the detections recorded for each:

- `partly-available:pages`, with the pages that would be served and the pages that stay withheld;
- `partly-available:sections`;
- `stays-blocked:every-page`, `stays-blocked:match-without-page` or `stays-blocked:block_document`;
- `policy-disabled-now`, `policy-action-changed` or `unknown:no-detections-recorded`.

## Granularity

- **Paged documents** (more than one page): the unit is the page.
  - Canonical blocks carry their page number.
  - Markdown and source text are `\f`-separated, so a match's page is the page its offsets fall in. A match that crosses a page break withholds both pages.
  - HTML and extraction-contract hits with no page are placed through the same value's fingerprint on a paged source.
- **Unpaged documents** (one page: plain text, HTML, a transcript, a one-page PDF): the unit is the Markdown section that holds the match. That is the heading-delimited section, or the paragraph when the text has no headings, plus the canonical block that holds the match.
  - For a transcript, the section is the time range it covers.
  - Everything written before the scan stays withheld.

## Fail closed

- A match that cannot be placed on a page withholds the whole document. The worker logs `[pii] document-withheld reason=unattributed:<why>` and records the reason. Causes:
  - a block with no page;
  - Markdown whose page breaks don't match the page count;
  - an HTML or contract hit with no paged twin.
- Malformed `metadata.pii`, an unknown scope or a page list that isn't valid withholds the whole document on every reader.
- A hit without a page on a document with withheld pages is dropped.
- A per-page artifact is served only when its page is known to be clean. Every other artifact written before the scan (parser output, raw vision output, the HTML rendering, the figure index, the source file) stays withheld whenever anything is withheld.

## Where it is enforced

The worker writes the outcome to `documents.metadata.pii` and the pii-detect checkpoint stats:

- `scope` (`none` | `pages` | `sections` | `document`)
- `withheldPages`, `withheldPageCount` and `withheldSectionCount`
- `withheldArtifactUris`

Every reader asks `piiWithholding()` and `isPageWithheld()` from `@docslurp/shared`.

**At write time** (`pii-detect`, before summary, structured extraction, embedding, graph and indexing):

- The withheld pages' text becomes `[Page N withheld by the project's privacy policy]` in the Markdown, canonical document, extraction contract and summary evidence.
- Chunks, vectors, propositions, page index and summaries are built from that text, so they never hold it.

**At serve time:**

- **Search and chat** (`hybridSearch` and the whole-corpus chat context) drop hits on withheld pages, whichever index served them. MCP, the SDK and the compat search APIs all use these paths.
- **The file proxy** (`userCanAccessArtifactUri`) refuses:
  - URIs on the withheld list;
  - any per-page artifact of a withheld page, by slot (`<doc>:page-N`, raster renders, `<doc>:doppler-figure:pN.M`) or by figure storage key. This covers renders and figures written after the scan.
- **Page renders**:
  - The server refuses a withheld page before queueing.
  - The worker refuses it before rasterizing and again under the write lock.
  - Page-image readiness reports a withheld page as `unavailable`.
- **Exports** leave out withheld pages' images and replace page text with the placeholder.
- **Deferred materialization** refuses pages the ingest scan withheld.
- **First-pass figures** are stored after the scan, so pii-detect never saw them:
  - Under page scope, figure slots (`<doc>:doppler-figure:pN.M`) join `withheldArtifactUris` only for withheld pages.
  - Non-page slots (`doppler-markdown`, `doppler-figures`, `doppler-manifest*`) stay all-or-nothing.
  - `document.md` is the scanned Markdown slot (withheld pages already replaced). It is stored only when every withheld page is verified to be the placeholder; otherwise it is not stored.
- **Doppler's folder** (`<root>/doppler/<doc>/images/page-NNNN/(image|figure)-MMM.<ext>`): the file proxy reads the page from the key. Under `images/`, a key it cannot parse is refused while the document withholds pages. The assets route refuses an image on a withheld page, or one that shows a file from a withheld page.
- **Later stages and resumes** (figure resume, chart export, reindex, the first-pass reprocess) consult the worker's `documentPiiWithholding()` and `isPageWithheldInRun()` in a run, or `loadDocumentPiiWithholding()` outside one.

## Rescans

- A rescan replaces the outcome.
- A page whose text is already the placeholder stays withheld under any policy, so a weaker rescan of rewritten text cannot re-expose its images.
- New hits extend the set.
- A document re-extracted from its source with no PII lifts the withholding.

## Reporting

- The ingest report has `piiWithheld`: files, pages, page numbers and a message such as "2 pages withheld for privacy (pages 3, 7)".
- The document detail response has `piiWithheld`.
- Neither shows the withheld content.
