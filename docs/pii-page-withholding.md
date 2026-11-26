# PII withholding is page-scoped

One page with PII no longer blocks a whole document. Under the project PII policy `block_indexing`, a match withholds
the page it is on. The rest of the document completes and stays searchable, chattable, previewable and exportable.
Every place that says a page was withheld also says why, in terms of the kinds of PII detected on it: "Page 3
withheld: contains a payment card number and an email address."

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
- `patternTypes` (categories found in the document) and `withheldPageTypes` (`{ "3": ["credit-card", "email"] }`, page scope)

Every reader asks `piiWithholding()` and `isPageWithheld()` from `@docslurp/shared`.

**At write time** (`pii-detect`, before summary, structured extraction, embedding, graph and indexing):

- The withheld pages' text becomes `[Page N withheld by the project's privacy policy: contains <categories>]` in the Markdown, canonical document, extraction contract and summary evidence (`[Page N withheld by the project's privacy policy]` when no category is known).
- Chunks, vectors, propositions, page index and summaries are built from that text, so they never hold it.

**At serve time** (the API, through the same shared helpers; the hosted API is not part of this repository):

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
- **Later stages and resumes**: the figure resume and the first-pass reprocess read the stored outcome (`loadDocumentPiiWithholding()`, `Store.documentPiiWithholding()`); in a run, `documentPiiWithholding()` and `isPageWithheldInRun()` are available to stages that run after pii-detect. Chart export runs inside vision-extract, before the scan, so its output is scanned like any other text.
- **Streamed search** (`/v1/search/stream`) drops provisional hits on withheld pages with the final path's filter before it sends them; if the outcomes cannot be read, the leg sends no hit bodies.
- **Rows written before the scan**: a page-scoped outcome deletes the withheld pages' rough-text rows (`document_pages`, written by the document map from the text layer it scanned itself), clears kept model reads and marks those page states `blocked-pii`. An existing summary tree is withdrawn, as for blocking and redaction.
- **Dedup and backfill**: a document with a PII outcome is never a dedup source, and a temporary backfill version with one is never adopted (neither copy would carry the outcome).
- **`block_document`**: the document map drops matched rough-text pages, and a match found by deferred materialization blocks the whole document (`pii_blocked`).

## Rescans

- A rescan replaces the outcome.
- A page whose text is already the placeholder stays withheld under any policy, so a weaker rescan of rewritten text cannot re-expose its images. The rescan reads the page's categories back from the placeholder; a placeholder written before categories were recorded keeps the page withheld with a generic reason.
- New hits extend the set.
- A document re-extracted from its source with no PII lifts the withholding.

## Why a page was withheld

Each withheld page records the kinds of PII detected on it. The categories are the detectors' stable ids
(`PiiPatternType` in `packages/shared/src/pii.ts`), each with a plain label (`PII_CATEGORY_LABELS`):

| Id | Label |
| --- | --- |
| `ssn` | a Social Security number |
| `credit-card` | a payment card number |
| `phone` / `email` / `ip-address` | a phone number / an email address / an IP address |
| `bank-account`, `iban` | a bank account number |
| `passport` / `drivers-license` | a passport number / a driver's license number |
| `generic-api-key` and the provider key formats | an API key |
| `github-token`, `slack-token`, `jwt` | an access token |
| `private-key` | a private key |

Credential formats share a label, so a reason never names a vendor.

`piiWithheldSummary()` turns the recorded outcome into what responses show:

- `types`: `[{ id, label }]` for what was withheld;
- `pages`: per withheld page, `{ page, types, message }`, for example "Page 3 withheld: contains a payment card number and an email address.";
- `message`: "2 pages withheld for privacy (pages 3, 7): contains a payment card number and an email address".

The summary never carries the matched text, a fragment of it, where on the page it was, or how many matches there were.
Type data is descriptive only: missing, malformed or unknown categories never change what is withheld. A document
processed before categories were recorded reads exactly as before, with "Page N withheld for privacy." and no
backfill. Whole-document and section outcomes show their document-level categories (`patternTypes`).

The pii-detect stage artifact, which the document's users can fetch, lists each match's category, page and source
only. Match fingerprints, offsets and lengths stay in `pii_detections`, which no tenant route reads: an unsalted hash
of a short value such as an SSN can be brute-forced.

## Confidence (operator-only)

`pii_page_findings` (migration `20261126T0225_pii_page_findings`) has one row per withheld page and category (page 0
when the categories have no page: an unpaged section, or a block whose matches could not be placed):

- `detector`: `rule` or `model`;
- `confidence`: the detector's score in [0, 1], or null;
- `validation`: how a rule proves a candidate (`checksum`, `structure`, `context`, `format`), or `score` for a model.

Every current detector is rule-based and produces no score, so `confidence` is null and `validation` records the rule
(`PII_DETECTOR_VALIDATION`) instead of an invented number. The pii-detect stage replaces the document's rows on every
scan. `org_id` and `project_id` are tied to the document's own by a composite foreign key.

Confidence is never written to `documents.metadata` and no tenant response reads the table: document detail, the
ingest report, the viewer payload, search hits, exports, MCP tools and the SDK types carry categories and page numbers
only. Operators read it from the database. There is no admin UI for it yet.

## Reporting

- The ingest report has `piiWithheld`: files, pages, page numbers, `types`, per-page reasons and a message.
- The document detail and viewer responses have `piiWithheld` (SDK `DocumentPiiWithheld`, with `types` and `pages`).
- SDK `DocumentPreviewPage` has `withheld` and `withheldReason`.
- None shows the withheld content.

## Cost

- Ingest: the category per page is gathered in the same pass that places matches on pages (no extra scan). The stage
  makes one more statement per scanned document (a primary-key-prefix delete of earlier findings) and one insert when
  something was withheld.
- Read: no new query. Summaries parse a few more fields of the `metadata.pii` object the readers already load.
