# Ingest versions and unavailable states

Every document and run records the **ingest version** of the pipeline that
produced it. The serving API answers data it cannot show with a typed
**unavailable state**, not an error. The contract lives in
`packages/shared/src/ingest-version.ts`, the columns come from migration
`0160_ingest_version.sql`, and the worker stamps them in
`worker/src/db/ingest-version.ts`.

## Ingest version

- `GET /v1/ingest-version` returns the version this deployment produces and its
  capabilities, for example `{ "ingestVersion": 1, "capabilities":
  ["parseSourceDecision", "pageFacts", "figureLedger"] }`. Every organization
  gets the same value. Sessions and API keys can read it.
- Document records carry `ingestVersion` and `ingestCapabilities`.
  `GET /v1/documents/:id` also returns `ingest`: `{ version, capabilities,
  currentVersion, updateAvailable, missingCapabilities, updateRecommended,
  canReprocess }`.
  - `updateAvailable` (version below current) is informational; show it in
    document details.
  - `missingCapabilities` lists what a serving path needs and the document
    lacks, measured from its row rather than its version. Today that is
    `parseSourceDecision` for a PDF or a deferred-indexed document without a
    decision from the current scan.
  - `updateRecommended` is true when that list is non-empty, and it is the only
    case to badge "Update available". Version-0 documents that serve fine are
    not badged.
  - `canReprocess` says whether this caller may start the reprocess.
- Runs carry `ingestVersion` and `ingestCapabilities`. A run's capabilities are
  what its pipeline build supports. A document's capabilities are measured from
  what its run actually stored:
  - `parseSourceDecision`: a parse decision from the current quarantine scan;
  - `pageFacts`: per-page facts written by that run;
  - `figureLedger`: a figure ledger written by that run.
- Version `0` means unknown. Every row that existed before tagging was backfilled
  to `0` with no capabilities, and nothing about those rows is inferred.
- The worker stamps a document when its last stage completes, and stamps the run
  with all of its finished documents when the run completes. Both stamps ride on
  statements the run already makes. A failed, cancelled or superseded document
  keeps the version that last produced it. A deferred page materialization
  (`materialize` run) does not reproduce its document and stamps nothing.
- Only a run that ran extraction stamps the current version. A run that reused
  extraction is a partial reprocess or reindex whose `reusedStages` reach into
  intake, prep or extraction (quarantine always re-runs, so it does not count).
  Its documents inherit their source's version and capabilities
  (`reused_from_document_id`, same organization only), plus
  `parseSourceDecision` when the re-run quarantine recorded one for the new row.
  Such a run stays at version 0. A deduplicated copy
  (`deduped_from_document_id`) always inherits its source's version and
  capabilities.
- Migration 0160 waits at most 5 s for each lock. It adds the CHECKs `NOT
  VALID` and validates them separately.
- When `updateAvailable` is true, a reprocess brings the document to the current
  version. Clients should send it through the reprocess estimate
  (`POST /v1/projects/:project/documents/bulk/estimate`) so credits are shown
  before it runs.

### Bump policy

- Bump `CURRENT_INGEST_VERSION` when a change alters extraction output, or adds
  metadata that serving relies on, so that documents produced before the change
  lack something a reprocess would add. Examples are a new parse decision, a new
  figure format, or page facts the reader needs.
- Do not bump it for refactors, speedups, cost changes or anything a reprocess
  would not change for the customer.
- The version only increases. Capability names are append-only: never rename,
  reuse or remove one. Add a capability when its data can be measured from stored
  rows, and teach `stampDocumentIngestVersion` to measure it.
- A bump marks every earlier document `updateAvailable`. Clients show a quiet
  "Update available" badge; nothing reprocesses automatically.

## Unavailable states

A page image, figure or structured result the caller may see, but that cannot be
shown, answers HTTP 200 with this body:

```json
{
  "status": "unavailable",
  "reason": "needs-reprocess",
  "message": "This needs a quick reprocess to display.",
  "canReprocess": true,
  "ingestVersion": 0,
  "currentIngestVersion": 1
}
```

`canReprocess` is true only when a reprocess resolves the reason *and* the
caller may start one: a session that can edit the project, or a server key with
`ingest` that can use it. `message` is reviewed copy. Raw errors, scanner output
and worker reasons stay in logs and traces.

| Reason | When | `canReprocess` |
| --- | --- | --- |
| `needs-reprocess` | Produced before the current scan or by an older pipeline: a page of a document without a current parse decision (`source-unscanned`), or a figure resume blocked `unscanned`. | If the caller may reprocess |
| `withheld` | A PII policy withholds it: a PII-blocked document's pages and structured result (even when a result was recorded), a structured result its policy withheld, a withheld figure file, a page materialization blocked by PII, or a page whose source file is withheld. | No |
| `not-extracted` | The pipeline produced nothing: a failed or cancelled document, an image Doppler did not extract (its `reason` says why, for example `min_side`, `repeat` or `budget`), no structured result while the project has a schema, a figure resume that ran out of attempts, a page that failed to materialize, or a figure upload still pending 15 minutes after its level was written (the next attempt adopts it). | Document-level states and stalled uploads, if the caller may reprocess. Images Doppler skipped: no |
| `processing` | Still being produced: a document mid-run, a figure upload in flight, or a figure resume whose document moved to a newer run. Clients refresh these with backoff. | No |
| `not-supported` | The data does not exist for this file type (page images of a non-PDF). | No |
| `disabled` | A project setting turns the feature off: figure resume blocked `figures-off` or `resume-off`, or no structured result in a project without an `outputSchema`. | No |
| `temporarily-unavailable` | Storage did not answer (an unreadable structured result). Retry later. | No |

Where the states appear:

- `GET|POST /v1/documents/:id/pages/:n/image`: the body itself. This replaces
  the earlier `409 quarantine_rescan_required` and `409 Page image
  unavailable`. The refusal is unchanged: no render is queued for a document
  without a current parse decision.
- `GET /v1/documents/:id/structured`: `{ structured: null, uri: null,
  availability }`. This replaces the earlier 404 and 500.
- `GET /v1/documents/:id/assets`: `assets[].availability` (null when the file is
  served or the image is left to the page image) and `level.resumeBlocked`.
- `GET /v1/searches/:sessionId/materialization`: `pages[].availability` on
  failed and PII-blocked pages, with `canReprocess` decided by each document's
  own project, not the session's. The older `reason:
  "quarantine-rescan-required"` field stays.

A document outside the caller's scope is still the same 404 as a missing
document, with no reason, version or other hint.
