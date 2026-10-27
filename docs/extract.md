# Extract mode

Extract is an upload that deletes itself. It takes the same inputs as upload (multipart files, public URLs, direct storage sessions and, over MCP, inline files), runs the same pipeline and returns the same outputs: page-by-page Markdown, page images, chunks and search. When the retention window ends, the source files and every derived asset are deleted: stored objects under the extract's prefix, Postgres rows (documents, pages, chunks, graph links) and the extract's rows in the workspace's LanceDB vector tables, which are compacted at once so no older table version keeps the text.

Use it for one-off conversions, like turning a PDF into Markdown, when you don't want the documents kept in a workspace.

| | Upload | Extract |
| --- | --- | --- |
| Endpoints | `/v1/uploads/{bulk,url,direct/sessions}` | `/v1/extracts/{bulk,url,direct/sessions}` |
| Kept | until you delete them | `retentionDays`, or the free window (48 hours by default) |
| Storage | `<user>/<run>/…` | `extracts/<org>/<extract>/…` |
| Daily storage meter | yes | no (free window, or prepaid extended retention) |
| Versions, dedup, reprocess | yes | no: extract documents never supersede, deduplicate against or get reprocessed into kept documents |
| Completion email | no | a sign-in download link, unless `notifyEmail: false` |

## Requests

Every upload field works the same way (`workspace`, `newWorkspace`, `templateKey`, `pipeline`, `tags`, `indexingMode`, `Idempotency-Key`), and partial success works the same way: good files are accepted, bad ones are listed in `rejected`, and the request fails only when nothing was created. Extract adds three fields:

- `retentionDays` (integer): how long to keep everything. Omit it for the free window. Anything longer than the free window is charged as storage (see [Pricing](#pricing)), and a request above the deployment's cap is refused with `400 retention_exceeds_cap` (`details.maxRetentionDays`).
- `notifyEmail` (boolean, default `true`): email the requester when the extract finishes.
- `download` (`markdown`, the default, or `all`): what the download zip holds. `all` adds originals, page images and readable outputs.

```bash
curl -X POST "$DOCSLURP_URL/v1/extracts/url" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com/report.pdf"],"retentionDays":7}'
```

```json
{
  "workspace": { "id": "…", "name": "Default" },
  "run": { "id": "5f0c…", "status": "queued" },
  "documents": [{ "id": "…", "filename": "report.pdf" }],
  "warnings": [],
  "extract": {
    "id": "ext_3b7c…",
    "status": "processing",
    "workspaceId": "…",
    "runId": "5f0c…",
    "retentionHours": 168,
    "paidRetention": true,
    "expiresAt": "2026-11-03T18:00:00.000Z",
    "retentionCredits": null,
    "notifyEmail": true,
    "download": { "content": "markdown", "status": "pending", "url": null },
    "pages": null,
    "storedBytes": null,
    "createdAt": "2026-10-27T18:00:00.000Z",
    "completedAt": null,
    "deletedAt": null
  }
}
```

Multipart (`POST /v1/extracts/bulk`) sends the same fields as form strings (`retentionDays=7`, `notifyEmail=false`). A direct session starts at `POST /v1/extracts/direct/sessions` and then continues on the usual `/v1/uploads/direct/sessions/{sessionId}/…` routes: PUT to the returned URLs, and the server confirms and starts ingestion. Its sources are stored under the extract prefix from the start. Aborting the session expires the extract immediately.

Follow progress with the run (`GET /v1/runs/{runId}/progress`) or the extract:

| Route | Scope (API keys) | |
| --- | --- | --- |
| `GET /v1/extracts` | `ingest` or `artifacts` | Recent extracts you can see |
| `GET /v1/extracts/{id}` | `ingest` or `artifacts` | Status, retention and download state; `410 extract_expired` after expiry |
| `GET /v1/extracts/{id}/download` | `artifacts`, server keys | `302` to a two-minute signed URL for the zip. The requester, or an owner or admin of the organization (as for exports); other workspace readers get `403` |
| `DELETE /v1/extracts/{id}` | `ingest` | Expire now (the requester only); the next sweep deletes everything |

`status` moves from `pending` (no run yet) to `processing`, then `completed` or `failed`, then `expired`. `download.status` moves from `pending` to `preparing`, then `ready` (`download.url` set) or `failed`, then `expired`.

Creating an extract is rate-limited as an upload. An extract's status is visible to anyone who can read its workspace; its download and early deletion are not. API keys see it only when they belong to the extract's organization and are allowed its workspace. Anyone else gets `404 extract_not_found`, whether or not the ID exists.

## The completion email

When the run finishes, the sweep measures what was stored, charges any extended retention, and builds the download: a zip export scoped to the extract's run, written under the extract prefix. Once the zip is ready (or can't be built), the requester gets one email from the deployment's `EMAIL_FROM` (`noreply@docslurp.io` on the hosted service). The email respects their run notification settings: *run completed* for a ready download, *run failed* otherwise. It goes out only while they can still read the workspace.

The emailed link is not a credential. It opens the app's download page (`/app?export=<exportId>`), which makes the reader sign in first. Then `GET /v1/exports/{exportId}/download` checks that they are the requester and can still read the workspace, and only then redirects to a signed storage URL that is valid for two minutes and covers that one zip. A forwarded or replayed link does nothing for anyone else, and the signed URL is never emailed or logged. The zip link never outlives the extract.

## Retention and deletion

Retention counts from `createdAt`, so an extract that is still processing when its window ends is cancelled and deleted. The maintenance sweep (`MAINTENANCE_SWEEP_INTERVAL_MS`, one minute by default, on every API instance; rows are claimed with `for update skip locked` and a ten-minute lease) handles each expired extract in this order:

1. If a run is still in flight, cancels it (and any zip still being built) and stops. Nothing is deleted until 15 minutes later, so late writes of the cancelled run are not orphaned.
2. Charges an unsettled paid window on what is stored (a run that never finished still pays).
3. Withdraws every zip that holds its documents (its own download, and workspace exports that included them) and stops workspace exports still being built.
4. Deletes its documents, every copy made from them (versions, re-indexes, reused or deduplicated copies, and anything whose source is under the prefix), and its runs. The delete triggers (migration 0035) queue LanceDB rows, graph nodes, stage artifacts and sources for the worker's cleanup drain, which deletes the vector rows and compacts the table with `cleanupOlderThan: now`. Media receipts (`remote_media_jobs`, `media_video_admissions`) stay as accounting records with their run and document links set to null.
5. Deletes every object under `extracts/<org>/<extract>/`, 1,000 keys per page and 20 pages per pass, and aborts unfinished multipart uploads there. An extract with direct upload sessions waits 30 minutes first, longer than a presigned PUT stays valid (15 minutes). A failure in step 4 doesn't stop this step.
6. Marks the extract `deleted` with `deleted_objects`, `deleted_bytes`, `failed_objects` and `deleted_at`, then lists the prefix once more six hours later and deletes anything that arrived after the purge.

Each step can be repeated safely. A failure records `last_error` (internal only; public responses never show it) and backs off 2^attempts minutes, up to six hours. Claims go least-failed first, so one failing extract never holds up the others. The `extract-deletion-stuck` alert (critical) fires while any expired extract has `last_error`, or one is more than an hour past expiry. The row remains as a tombstone, so `GET` keeps answering `410` and the extract's usage stays reportable.

What remains after deletion:

- **LanceDB:** deleted rows leave the table when the worker's cleanup drain runs (every sweep, normally within a minute, after a 15-minute grace for documents that were in flight). Until then they are already invisible to search (deletion vectors).
- **Chat history:** conversations that cited an extract's documents keep their messages; their citations stop resolving. Chat history is the user's own record of a conversation, and scrubbing quoted text out of answers would rewrite it. Delete the conversation to remove it.
- **Audit and usage:** audit entries and usage events keep IDs, counts and costs, but no document content.

Logs: `[extract-retention] deleted extract=… objects=… bytes=… lag_s=…` per extract, and one `settled= charged= exports= emailed= deleted= deleted_objects= deleted_bytes= max_lag_s= failed=` line per sweep that did anything. `lag_s` is the time from expiry to the last object deleted. Each sweep runs in a `maintenance.extracts` span.

### Bucket lifecycle backstop (optional)

The sweeper is the primary deletion path. As a backstop for a sweeper that is down for days, add a lifecycle rule that expires objects under `extracts/` one day after the longest retention you allow. With the default 30-day cap, that is 31 days:

```json
{ "Rules": [{ "ID": "extract-backstop", "Status": "Enabled", "Filter": { "Prefix": "extracts/" },
  "Expiration": { "Days": 31 }, "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 2 } }] }
```

If you raise `DOCSLURP_EXTRACT_MAX_RETENTION_DAYS`, raise this too, or extended extracts lose their files early.

## Pricing

- The free window (`DOCSLURP_EXTRACT_FREE_RETENTION_HOURS`, default 48) costs nothing beyond ingestion, which is billed exactly as for uploads (Fast and Rich pages, media minutes and features).
- Extended retention (up to `DOCSLURP_EXTRACT_MAX_RETENTION_DAYS`, default 30) bills **the whole window, free hours included** (7 days is 7 days of storage, not 5), as storage at `EXTRACT_RETENTION_STORAGE_MULTIPLIER` (2) times the storage price (`PRICE_CARD.storageGbMonth`, 25 credits per GB-month), prorated over the whole window in 30-day months: `credits = stored GB × 25 × 2 × retentionDays / 30`. The stored size uses the daily meter's model: source bytes plus an estimated 96 KB of artifacts and 28 KB of index per page.
- A paid window is checked before anything is stored: the organization must be allowed to spend (`assertCanSpend`) and, when billing is enforced, must hold the estimated charge for the declared size. Otherwise the request fails with `402 credit_exhausted`.
- It is charged as soon as intake has created the run and the sizes are known (`extract-retention:<extract>`), so parallel extracts can't all pass the pre-check and then overdraw. When the run finishes, any rise in the measured size is charged (`extract-retention:<extract>:settle`). An extract whose run never finished is charged at expiry (`…:expiry`). There are no refunds when the stored size turns out smaller. Each charge is a billable unit event (`storage-extract-retention`, provider `docslurp`) recorded through the usage ledger with the extract's org, workspace, run and API key, plus the matching credit debit. It counts as storage spend.

For example, 1,000 pages with 75 KB sources kept for 30 days store about 0.19 GB and cost about 9.5 credits ($0.095) of retention, about 10,500 pages per $1 for retention alone. Storage for those pages costs us about $0.013 a month (Tigris objects at $0.02 per GB-month and Neon index storage at $0.35 per GB-month).

## Measuring extract on its own

Extract runs are `workspace_runs` with `extract_id` set. Their `stats` carry `product: "extract"`, and the retention charge's metadata does too. `GET /v1/billing/usage/extracts?window=month|all` (organization billing readers) reports `extracts`, `pages`, `costCents` (every credit charged on extract runs, retention included), `retentionCents`, `computeCostCents` (the rate-card estimate of unbilled worker compute) and `pagesPerDollar`. All of it is read through `usage_attribution`, so the figures survive the runs' deletion.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `DOCSLURP_EXTRACT_FREE_RETENTION_HOURS` | `48` | Free window. Invalid values fall back to the default. |
| `DOCSLURP_EXTRACT_MAX_RETENTION_DAYS` | `30` | Longest `retentionDays` a request may ask for (never below the free window). |
| `EMAIL_FROM` | `DocSlurp <noreply@docslurp.local>` | Sender of the completion email; `noreply@docslurp.io` on the hosted service. |
| `APP_URL` | `http://localhost:4321` | Base of the emailed download link. |

## SDK, CLI and MCP

```ts
const { extract } = await client.extract([file], { retentionDays: 7 });
const record = await client.getExtract(extract.id);          // throws DocSlurpApiError 410 once expired
const url = await client.getExtractDownloadUrl(extract.id);  // two-minute signed URL (server key, artifacts)
```

```bash
docslurp extract report.pdf --retention-days 7
docslurp extract https://example.com/report.pdf --no-email
docslurp extract-status ext_3b7c…
docslurp extract-download ext_3b7c…
```

The MCP `extract` tool takes the `upload` tool's inputs (`urls`, `files` or `inlineFiles`) plus `retentionDays`, `notifyEmail` and `download`.
