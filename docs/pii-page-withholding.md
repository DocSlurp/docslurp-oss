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
- **A label and its value in two blocks**: the Markdown is scanned as one string and the canonical document block by block, so a context-validated detector (passport, licence, bank account, phone) can match the Markdown ("Passport number", a blank line, the value) while no single block matches. Each Markdown match's value is located in the canonical blocks (exactly, then ignoring spacing and punctuation) and every block holding it is replaced, or redacted under `redact_artifacts`; on a paged document its page is withheld. A value no block holds fails closed to the whole document (`unattributed:text-match-not-in-canonical`).
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

**At serve time** an API serving these documents applies the same shared helpers. The contract it must keep:

- **Search and chat** drop hits on withheld pages, whichever index served them, including streamed provisional hits.
- **The file proxy** refuses URIs on the withheld list and any per-page artifact of a withheld page, by slot (`<doc>:page-N`, raster renders, `<doc>:doppler-figure:pN.M`) or by figure storage key. This covers renders and figures written after the scan.
- **Pixels follow `isPageImageWithheld()`**: a page's image, render and figures are refused when the page is withheld, when the outcome redacted a value on it (`redactedPages`), or on every page when an outcome redacted without recording its pages. Text readers use `isPageWithheld()`: redacted text is servable, its image is not.
- **Page renders** are refused for such a page before queueing; the worker refuses again before rasterizing and under the write lock. Page-image readiness reports the page as `unavailable`.
- **Exports** leave out withheld pages' images and replace page text with the placeholder.
- **Before the scan**: while a document's run has a PII policy and its scan has not completed, its source file and run artifacts are not served. The scan has completed when pii-detect completed for the document's run, or when an outcome is recorded on `metadata.pii` (deferred modes record theirs page by page, below). Every other state waits: `failed` or `cancelled` before the scan, or a document stuck in `processing`. A failed or cancelled copy does not decide for a live document that shares its source file. The document map completing is not a scan: it reads only some pages.
- **Unscanned pages (deferred modes)**: under a withholding or redaction policy (`block_indexing`, `block_document`, `redact_artifacts`), a page's pixels and text are served only once that page has been scanned, and the source file and every artifact without a page only once every page has been. See [Map indexing mode](#map-indexing-mode).
- **Deferred materialization** refuses pages the ingest scan withheld.
- **First-pass figures** are stored after the scan, so pii-detect never saw them:
  - Under page scope, figure slots (`<doc>:doppler-figure:pN.M`) join `withheldArtifactUris` only for withheld pages.
  - Non-page slots (`doppler-markdown`, `doppler-figures`, `doppler-manifest*`) stay all-or-nothing.
  - `document.md` is the scanned Markdown slot (withheld pages already replaced). It is stored only when every withheld page is verified to be the placeholder; otherwise it is not stored.
- **Doppler's folder** (`<root>/doppler/<doc>/images/page-NNNN/(image|figure)-MMM.<ext>`): the file proxy reads the page from the key. Under `images/`, a key it cannot parse is refused while the document withholds pages. The assets route refuses an image on a withheld page, or one that shows a file from a withheld page.
- **Later stages and resumes**: the figure resume and the first-pass reprocess read the stored outcome (`loadDocumentPiiWithholding()`, `Store.documentPiiWithholding()`). Stages that run after pii-detect in the same run read only the rewritten text, so they need no per-page check; a document withheld whole is left out by `indexableDocuments()`. Chart export runs inside vision-extract, before the scan, so its output is scanned like any other text.
- **Rows written before the scan**: a page-scoped outcome deletes the withheld pages' rough-text rows (`document_pages`, written by the document map from the text layer it scanned itself), clears kept model reads and marks those page states `blocked-pii`. An existing summary tree is withdrawn, as for blocking and redaction.
- **Dedup and backfill**: a document with a PII outcome is never a dedup source. A temporary backfill version (a map/visual mode switch) whose outcome withheld or redacted something is retired, never adopted. One whose outcome is scan progress only is adopted: when the source already tracks a deferred scan, the temp's scanned pages are added to the source's (a source `scanComplete` stays); the source's withheld pages, redaction and block are never changed, and a source with no outcome stays without one. The temp's outcome is re-read under its row lock before adoption, and the adopted titles and map are scrubbed against the source's own withheld pages.
- **Deferred indexing** (modes that skip pii-detect): a page whose deferred read matches (the document map's rough text, or materialization) is recorded on the document exactly as the ingest scan records a withheld page: `metadata.pii` gets the page, its categories and the withheld source and non-page artifacts, merged with any earlier outcome under the document's row lock, and findings rows are written. Every reader above answers from it. Every page withheld, or `block_document`, blocks the document (`pii_blocked`). Under `redact_artifacts` the page is redacted and recorded in `redactedPages`.
- **Titles and the document map** are built before the scan. After it (and on a deferred match), `metadata.title`, `metadata.mapTitle`, the map's node titles and index terms are dropped when they match or come from a withheld page, and the map's `search_text` is rebuilt.
- **Summary trees**: a page- or section-scoped document gets a tree built from its rewritten text; whole-document, redaction and other withheld outcomes still get none.
- **Chunks of placeholders only** are not indexed; a chunk spanning a clean and a withheld page keeps its clean text and drops the withheld page.
- **`block_document`**: the document map drops matched rough-text pages, and a match found by deferred materialization blocks the whole document (`pii_blocked`).

## Map indexing mode

Map mode runs no pii-detect. Pages are read later, when a query needs them, and each read is scanned on its own. So
the outcome records the scan in progress: `metadata.pii.scanPending: true` with `scannedPages`, the pages scanned so
far. Readers (`isPageWithheld`, `isPageImageWithheld`, `piiScanIncomplete`) treat every other page as withheld, and
withhold the source and every artifact without a page while the scan is incomplete. The fields go once every page has
been scanned.

- **The document map** starts the scan with the pages whose rough text it read and scanned (the coarse pages of a
  born-digital PDF). A scanned PDF or a non-PDF starts with none.
- **Materialization** reads a page a query needs (text layer, OCR or a model read), scans it, and adds it to the scan
  in the same locked update that records a match. A page that matched is withheld; one that did not becomes servable.
- **The coarse visual layer** (`visualPages.coarseFallback`) embeds no page images under such a policy.
- **Visual mode** embeds page images without reading their text, so it is refused with every withholding or redaction
  policy, `redact_artifacts` included (`visual_mode_privacy`).

What a map-mode project with such a policy sees:

- No source download, and no whole-document artifacts or export, until every page has been read. A document whose
  pages are never all read never serves its source.
- Page images, renders and figures only for pages a query (or the map) has read and scanned; other pages show as
  pending (`piiWithheld.scanPending`), not as withheld for PII.
- Search and chat are unchanged: they only ever return pages that were read, and every read is scanned first.

Documents processed in map mode before this change keep their recorded outcome and read as before. A map-mode document
with no recorded outcome (it matched nothing) and no pii-detect run now waits for the scan like any other.

## Known limitations

- Under `redact_artifacts`, a clean document whose text literally contains a redaction marker (`[REDACTED:ssn]`) reads
  as a carried redaction on rescan: its page images and unrewritten artifacts are withheld. This fails closed and
  affects only that document.
- Under a withholding or redaction policy in map or visual mode, a non-PDF document is not scanned until a query reads
  it. A document that no query reads never serves its source.

## Rollout

- An action this worker does not know (a newer API configured it) blocks the document.
- The findings table must exist before this worker runs: a missing table fails the stage as retryable infrastructure, never the document.
- The stage writes its outcome, findings, page rows and summary-tree withdrawal in one transaction, and a rescan that
  finds only redaction markers records a carried redaction (pages unknown), never a clean document.

### Rolling back the worker

A worker-only rollback is not safe once page-scoped or `block_document` outcomes exist:

- an older worker does not know `block_document` and indexes in-flight `block_document` runs in full;
- an older worker rescanning a page-scoped document reads the rewritten text, finds no PII and records it clean;
- an older worker does not record deferred scan progress.

Roll forward. If a rollback cannot be avoided, first cancel the `block_document` runs and pause reprocessing of
projects with a PII policy, then roll back.
- Deploy order: the migration, then workers, then the API and UI. An older worker does not know `block_document` and would index such documents in full, so an API offers `block_document` only once the fleet runs a worker that handles it.

## Rescans

- A rescan replaces the outcome.
- A section an earlier scan replaced (the section placeholder in the text, or a canonical block marked withheld) is carried too: a rescan of an unpaged document's rewritten text stays `sections` and keeps its pre-scan artifacts withheld.
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

The pii-detect stage artifact, which the document's users can fetch, lists the categories and text sources per page
only, with no count of matches (the stage stats and `metadata.pii` carry none either). Match fingerprints, offsets and lengths stay in `pii_detections`, which no tenant route reads: an unsalted hash
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
only. The API database role holds no privilege on it (revoked after the schema-wide grant in `server/db/roles.mjs`; the
predeploy check flags any other grant); the worker role may select, insert and delete. Operators read it as the owner.
There is no admin UI for it yet.

## Reporting

- The ingest report has `piiWithheld`: files, pages, page numbers, `types`, per-page reasons and a message.
- The document detail and viewer responses have `piiWithheld` (SDK `DocumentPiiWithheld`, with `types` and `pages`).
- SDK `DocumentPreviewPage` has `withheld` and `withheldReason`.
- None shows the withheld content.

## Cost

- Ingest: the category per page is gathered in the same pass that places matches on pages (no extra scan). The stage
  makes one more statement per scanned document (a primary-key-prefix delete of earlier findings) and one insert when
  something was withheld. Locating Markdown matches in the canonical blocks is one pass building a per-page string
  index plus one `indexOf` per match, only when the Markdown has matches. A document with a match (or carried
  withholding) adds one primary-key read of its titles and map, and a write only when something changed; a rescan of
  text holding a placeholder adds one primary-key read of the previous categories. A deferred match adds one locked
  read and one update of the document row, and one findings insert, per batch with a match.
- Deferred scan progress: the document map adds no statement (its outcome write already runs); each materialized
  batch under a withholding policy adds one locked read and, when it scans a new page, one update of the document row.
  `scannedPages` is one integer per scanned page in `metadata.pii` until the scan completes.
- Read: no new query. Summaries parse a few more fields of the `metadata.pii` object the readers already load.
  `isPageWithheld` adds one set lookup per page while a scan is pending. The artifact export reads scan stages only for
  documents whose run has an enabled policy.
- Locating short values counts their occurrences in the whole text once per document with such a match (one pass).
