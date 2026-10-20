# HTTP API

Use the HTTP API to upload documents from any language, follow their processing, and retrieve passages that cite the document and page they came from. Requests use HTTPS under `https://docslurp.io/v1`, authenticated with `Authorization: Bearer <key>`. Most requests use JSON; file uploads use multipart form data or signed storage PUTs.

Use search when you already have an LLM or a search UI. Use chat when you want DocSlurp to write a cited answer.

```bash
curl https://docslurp.io/v1/search \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"q": "How much parental leave do we get?", "limit": 5}'
```

Each result has `text`, a `score` and a `citation` with the `filename`, `pageNumber` and `documentId`. Without a `workspaceId`, the request searches your organization's default workspace. To upload documents first, run [the complete HTTP flow](#the-complete-http-flow) below.

| Prefer a client library? | Use it for |
| --- | --- |
| [Node.js / TypeScript SDK](https://docslurp.io/docs/sdk) | Application code, streams, deadlines and typed responses |
| [CLI](https://docslurp.io/docs/cli) | Exploring documents, shell scripts, CI and agent tooling |
| [Runnable Node examples](https://docslurp.io/docs/sdk#quickstart) | Upload, wait and search, progress with polling fallback, and LLM context |
| [20-second demo](https://docslurp.io/demos/integration.mp4) | Seeing the workflow before you build it |

> **Versions:** SDK examples target `@docslurp/sdk` 0.3.0 or newer. This includes URL uploads through `upload`, batch search, workspace discovery and upload-session methods. Self-hosted deployments must run an API version with these routes.

## The contract in one minute

- **Workspace:** the set of documents you search, and where pipeline settings live. Optional: requests without one use your organization's default workspace. See [Workspaces](#workspaces).
- **Run:** one ingestion job, processed in the background. Save its ID before you wait on it. Client timeouts don't cancel it.
- **Document:** an uploaded file, with an ID that citations point to.
- **Search:** passages with scores, citations, availability, usage and a session ID. Retrieval scores are not confidence percentages.
- **Chat:** a generated answer with citations, availability, session IDs, usage and runtime.

A completed run doesn't mean every document in the workspace is ready, because other runs can still be indexing. Check the response's `availability` as well as run completion.

## API keys

There are two kinds of API key. The prefix tells you, and secret scanners, where a key may safely live:

| Prefix | Type | Where it may live | Can do |
| --- | --- | --- | --- |
| `dslp_priv_` | Server key | Backend secrets, CI, agent configuration | The scopes you grant: `ingest`, `search`, `artifacts`, and opt-in organization/workspace management |
| `dslp_pub_` | Browser key | Page HTML and browser bundles | `search` only, and only from your allowed websites |

A key's type is fixed when you create it; to switch, create a new key. Keys issued before typed prefixes (`dslp_<hex>`) keep working. Create and rotate keys on the [API keys](https://docslurp.io/app/api-keys) page.

The SDK, search adapters and search widget refuse to send a `dslp_priv_` key from a browser. This check is in SDK builds after 0.2.0; the published 0.2.0 does not include it.

## The complete HTTP flow

This script uploads a file, waits for processing, and searches it. You need Bash, `curl`, `jq`, a `handbook.pdf` and a [server key](https://docslurp.io/app/api-keys) with the `ingest` and `search` scopes. The script stops on HTTP errors, on runs that fail or stop, and after a 10-minute polling deadline. It saves the returned IDs before polling and never repeats the upload on timeout.

```bash
export DOCSLURP_API_KEY='dslp_priv_…'  # Your server key.
# Only for a self-hosted or local deployment:
# export DOCSLURP_URL='http://localhost:4321'
```

Save as `ingest-and-search.sh`, then run `bash ingest-and-search.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${DOCSLURP_API_KEY:?Set DOCSLURP_API_KEY}"
api_url="${DOCSLURP_URL:-https://docslurp.io}"
api_url="${api_url%/}"

curl --fail-with-body --silent --show-error --max-time 120 \
  "$api_url/v1/uploads/bulk" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -F 'files=@handbook.pdf' > accepted.json

workspace_id="$(jq -er '.workspace.id' accepted.json)"
run_id="$(jq -er '.run.id' accepted.json)"
printf 'Workspace: %s\nRun: %s\n' "$workspace_id" "$run_id"
# Keep accepted.json: use these IDs to resume after a timeout.
deadline=$((SECONDS + 600))
while true; do
  remaining=$((deadline - SECONDS))
  if (( remaining <= 0 )); then
    printf 'Wait expired; run %s may still be processing.\n' "$run_id" >&2
    exit 1
  fi
  request_seconds=$((remaining < 30 ? remaining : 30))
  progress="$(curl --fail-with-body --silent --show-error --max-time "$request_seconds" \
    "$api_url/v1/runs/$run_id/progress" \
    -H "Authorization: Bearer $DOCSLURP_API_KEY")"
  state="$(jq -r '.run.controlState // .run.status' <<< "$progress")"
  if [[ "$(jq -r '.run.status' <<< "$progress")" == 'failed' ]]; then printf '%s\n' "$progress" >&2; exit 1; fi
  case "$state" in
    paused|cancelled|dead-letter|failed) printf '%s\n' "$progress" >&2; exit 1 ;;
  esac
  if [[ "$(jq -r '.run.status' <<< "$progress")" == 'completed' ]]; then break; fi
  sleep 2
done

jq -n --arg q 'What is the parental leave policy?' '{q: $q, limit: 5}' |
  curl --fail-with-body --silent --show-error --max-time 30 \
    "$api_url/v1/search" \
    -H "Authorization: Bearer $DOCSLURP_API_KEY" \
    -H 'Content-Type: application/json' --data-binary @- > evidence.json

jq '{availability, sessionId, usage, results: [.results[] | {text, score, citation}]}' evidence.json
```

Check `availability.status` before you treat the result as complete evidence.

With no `workspaceId`, the upload, search and chat all use your organization's default workspace. To use a named workspace, add `-F 'workspaceId=legal-contracts'` to the upload and `workspaceId: "legal-contracts"` to search and chat. To create a new workspace that titles itself from the upload, add `-F 'newWorkspace=true'` (see [Workspaces](#workspaces)).

Keep server keys out of browser bundles. The base URL is the service **origin**; the routes below already include `/v1`.

### Add a grounded answer

Chat uses the same default workspace when `workspaceId` is omitted:

```bash
jq -n --arg q 'Summarize the parental leave policy and cite your sources.' '{q: $q}' |
  curl --fail-with-body --silent --show-error --max-time 120 \
    "${DOCSLURP_URL:-https://docslurp.io}/v1/chat" \
    -H "Authorization: Bearer $DOCSLURP_API_KEY" \
    -H 'Content-Type: application/json' --data-binary @- > answer.json

jq '{answer, citations, availability, sessionId, usage, runtime}' answer.json
```

To follow up, pass the returned `sessionId` in the next chat request. Search doesn't write an answer; chat does. Search can still incur embedding and AI costs without writing an answer.

## Workspaces

Workspaces are optional. Every organization has a **default workspace**, created on first use, and any request that omits `workspaceId` uses it. This section explains every way to refer to a workspace; other guides link here.

| Reference | Example | Notes |
| --- | --- | --- |
| Omitted, or `default` | `default` | Your organization's default workspace. Any organization member can read and upload to it; it cannot be archived or deleted. |
| Slug | `legal-contracts` | Every workspace has a globally unique, URL-safe slug, generated as three words (e.g. `amber-falcon-ridge`) and renamable. Prefer slugs in config and human-facing links. |
| Former slug | `amber-falcon-ridge` | Every slug a workspace has had keeps resolving to it, like a renamed GitHub repository, and cannot be claimed by another workspace. |
| UUID | `6f1c2a7e-…` | Also accepted; an absolute reference that never changes. |

**Where references are accepted:** `workspaceId` in request bodies and query strings (uploads, URL ingest, direct upload sessions, search GET/POST/batch, chat and chat stream, suggest, MCP `workspace.*` tools); REST paths `/v1/workspaces/:workspace/...`; [compatible search](https://docslurp.io/docs/search-integrations) index/collection names (`/compat/meilisearch/indexes/default/search`); and `model: "workspace:default"` for [OpenAI-compatible chat](https://docslurp.io/docs/chat) (other workspaces use the `workspace:<uuid>` model IDs from `GET /v1/models`).

**Which organization:** API keys use their own organization's default workspace. Dashboard sessions use the personal organization unless the request passes `orgId` (body field, or `?orgId=` on query-string and `/v1/workspaces/default/...` requests).

**Precedence (first match wins):**

- SDK: a per-call `workspaceId`, then `createDocSlurpClient({ workspaceId })`, then `DOCSLURP_WORKSPACE_ID` (server runtimes only; browser builds never read environment variables), then `"default"` (exported as `DEFAULT_WORKSPACE_ID`).
- CLI: `--workspace`, then `DOCSLURP_WORKSPACE_ID`, then `default`.

So `client.search({ q: "question" })`, `client.getWorkspaceState()` and `docslurp search` work with no workspace configuration.

**New workspaces:** uploads only create a workspace when asked: `newWorkspace: true` (multipart `newWorkspace=true`, CLI `--new-workspace`, SDK `newWorkspace`), a `workspaceName` (CLI `--workspace-name`), or a `templateKey` (CLI `--template`). The SDK and CLI send no `workspaceId` in those cases, so a configured default workspace does not swallow the request. Without a name the new workspace titles itself from the uploaded content. An explicit `workspaceId` (including `default`) wins over these. The upload response's `workspace` record includes `id` and `slug`.

**Rename a slug** in the dashboard (the gear next to the workspace name, then Workspace) or over HTTP:

- Slugs are 3 to 63 lowercase letters, digits and single hyphens.
- Reserved words such as `default`, `board`, `templates` and `invites` return 400.
- A slug that another workspace uses, or used before, returns 409.
- API keys need the opt-in `workspaces:manage` scope, which only server keys can have. The key owner's workspace role still decides what may change. The same scope covers the other workspace settings (name, prompt, pipeline, budget).

```bash
curl -X PATCH "$api_url/v1/workspaces/amber-falcon-ridge" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" -H 'Content-Type: application/json' \
  --data '{"slug":"legal-contracts"}'
```

**Path responses:** when a `/v1/workspaces/:workspace/...` path uses a slug, former slug or `default`, the response carries `X-DocSlurp-Workspace-Id` (UUID) and `X-DocSlurp-Workspace-Slug` (current slug), plus `X-DocSlurp-Workspace-Renamed-From` when a former slug was used, so clients can update stored links. Dashboard URLs are canonical at `/app/workspaces/<slug>`; UUIDs, former slugs and legacy `/app?workspaceId=` links redirect there.

## Route map

| Operation | HTTP endpoint | SDK | CLI |
| --- | --- | --- | --- |
| Upload files | `POST /v1/uploads/bulk` (multipart `files`, up to `MAX_MULTIPART_UPLOAD_BYTES`, 25 MB by default) or a direct upload session (`POST /v1/uploads/direct/sessions`, presigned PUTs, `.../confirm`) for larger files | `upload` (direct session above 20 MB) | `upload` (direct session above 20 MB) |
| Ingest URLs | `POST /v1/uploads/url` | `upload({ urls })` | Use SDK/HTTP |
| Full run progress | `GET /v1/runs/:runId/progress` | `getRunProgress`; `getRun` returns only `run` | `status`, `status --watch` |
| Live progress snapshots | `GET /v1/runs/:runId/progress/stream` | `streamProgress` | Watch uses polling |
| Raw run/stage/document events | `GET /v1/runs/:runId/events/stream` | `streamRun` | Use SDK/HTTP |
| Wait for successful run | Poll `GET /v1/runs/:runId/progress` | `waitForRun` | `status --watch` |
| List runs | `GET /v1/runs` | Use HTTP | `runs` |
| Workspace state | `GET /v1/workspaces/:workspace/state` | `getWorkspaceState` | Use SDK/HTTP |
| Ingest report | `GET /v1/workspaces/:workspace/ingest-report` (also MCP `getUploadStatus`, chat `/status`) | `getIngestReport` | Use SDK/HTTP |
| List workspaces | `GET /v1/workspaces` | `listWorkspaces()` | Use HTTP |
| Read workspace | `GET /v1/workspaces/:workspace` | `getWorkspace(id)` | Use HTTP |
| Rename workspace | `PATCH /v1/workspaces/:workspace` (session or `workspaces:manage` key) | Use HTTP | Use HTTP |
| Retrieve passages | `POST /v1/search` or `GET /v1/search` | `search` | `search` |
| Batch retrieval | `POST /v1/search` with `{ queries }` | `search({ queries })` | `search --queries-file` |
| Grounded chat | `POST /v1/chat` | `chat` | `chat` |
| Read a document | `GET /v1/documents/:id` | `getDocument` | Use SDK/HTTP |
| List / create organizations | `GET` / `POST /v1/organizations` | `listOrganizations` / `createOrganization` | Use SDK/HTTP |
| Read / update organization | `GET` / `PATCH /v1/organizations/:orgId` | `getOrganization` / `updateOrganization` | Use SDK/HTTP |
| Organization details / access | `GET /v1/organizations/:orgId/details` / `access` | `getOrganizationDetails` / `getOrganizationAccess` | Use SDK/HTTP |
| List members | `GET /v1/organizations/:orgId/members` | `listOrganizationMembers` | Use SDK/HTTP |
| Invite / list / revoke invites | `POST` / `GET /v1/organizations/:orgId/invites`, `DELETE …/invites/:inviteId` | `inviteOrganizationMember` / `listOrganizationInvites` / `revokeOrganizationInvite` | Use SDK/HTTP |
| Change / remove membership | `PATCH` / `DELETE /v1/organizations/:orgId/members/:memberUserId` | `updateOrganizationMemberRole` / `removeOrganizationMember` | Use SDK/HTTP |
| Leave organization | `POST /v1/organizations/:orgId/leave` | `leaveOrganization` | Use SDK/HTTP |
| List / revoke organization keys | `GET` / `DELETE /v1/organizations/:orgId/api-keys` | `listOrganizationApiKeys` / `revokeOrganizationApiKeys` | Use SDK/HTTP |

The SDK and CLI use `/v1/chat`. For streamed answers, use the separate [OpenAI-compatible chat API](https://docslurp.io/docs/chat). See [search contracts](https://docslurp.io/docs/search-reference) for retrieval controls and [OpenAPI](https://docslurp.io/openapi.json) for machine-readable request and response schemas. Each deployment's OpenAPI describes that deployment.

## Live ingestion progress

`waitForRun()` tells you whether a run succeeded. For live counts, read the full progress snapshot or iterate over snapshots as they change. These examples use a configured `client` and the `run` returned by an upload:

```ts
const snapshot = await client.getRunProgress(run.id);
console.log(snapshot.run.processedDocuments, snapshot.run.totalDocuments);
console.log(snapshot.progress?.pageRollup, snapshot.progress?.stageRollups);

for await (const snapshot of client.streamProgress(run.id, {
  transport: "auto",
  timeoutMs: 600_000, // Stop watching after 10 minutes in total.
  idleTimeoutMs: 60_000, // Stop if no snapshot changes for a minute.
  pollIntervalMs: 1_000, // Poll every second if SSE is unavailable.
  heartbeatMs: 6_000, // Re-yield the latest snapshot at least this often.
})) {
  console.log(snapshot.run.status, snapshot.run.controlState);
  console.log(snapshot.progress?.pageRollup, snapshot.progress?.usageTotals);
  console.log(snapshot.progress?.resourceTotals);
}
```

The iterator yields a final snapshot for completed, failed, cancelled or dead-letter runs, then finishes. Check that final state: the loop ending doesn't mean the run succeeded. Paused runs stay observable until they resume, are cancelled, or the deadline expires.

`waitForRun()` throws for failed, paused, cancelled and dead-letter runs. Both methods default to a five-minute overall deadline, and a client deadline doesn't cancel ingestion. Breaking out of the loop or aborting closes the connection.

### Read one snapshot over HTTP

```bash
curl --fail-with-body --silent --show-error --max-time 30 \
  "$api_url/v1/runs/$run_id/progress" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" > progress.json

jq '{run: (.run | {id, status, controlState, stage, totalDocuments, processedDocuments, pagesTotal, pagesProcessed}),
     pages: .progress.pageRollup, usage: .progress.usageTotals}' progress.json
```

The HTTP response is the full `{ run, stages, recentEvents, temporal, progress?, stats, artifacts }` snapshot. `getRunProgress()` returns that envelope; `getRun()` returns its `run` record. The following is **illustrative output of the `jq` projection**, not a complete wire response:

```json
{
  "run": {
    "id": "run-123",
    "status": "processing",
    "controlState": null,
    "stage": "extract-markdown",
    "totalDocuments": 2,
    "processedDocuments": 0,
    "pagesTotal": 20,
    "pagesProcessed": 7
  },
  "pages": {
    "completed": 7,
    "total": 20,
    "byStage": {
      "extract-markdown": 7
    },
    "byDocument": {
      "doc-123": {
        "extract-markdown": 7
      }
    }
  },
  "usage": {
    "inputTokens": 1000,
    "outputTokens": 300,
    "costCents": 0
  }
}
```

`progress` may be absent, and `temporal` may be `null`. Stage rollups report completed pages, document status counts, duration and usage. Resource totals report elapsed time, CPU time and memory. Run and stage progress can infer completion from lifecycle state, so use [workspace state](#current-workspace-state) for current searchable page coverage. A recorded cost of zero doesn't prove there was no API or infrastructure cost.

### Subscribe over HTTP

```bash
curl --fail-with-body --no-buffer --max-time 600 \
  "$api_url/v1/runs/$run_id/progress/stream" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -H 'Accept: text/event-stream'
```

| SSE event | `data` | Meaning |
| --- | --- | --- |
| `snapshot` | Complete run-progress snapshot JSON | Initial current state, then progress changes and periodic reconciliation |
| `heartbeat` | `{}` | Connection is alive; no progress change implied |
| `error` | `{"code":"access_revoked","error":"Run access is no longer available"}` | Access ended; server closes the stream |

On this stream, snapshots always have `recentEvents: []`. When you need event history, read REST progress or use raw `streamRun()`.

- Bursts of changes are combined into at most one snapshot per second.
- The server re-reads state about every ten seconds to catch missed notifications.
- Heartbeats arrive about every four seconds.
- Access, including key revocation and membership, is rechecked before each snapshot.
- A failed run arrives as a final snapshot, not as an `error` event.

In the SDK, `transport: "auto"` switches to REST polling when SSE is unsupported, ends before a final snapshot, or fails with a network error or a transient status (such as 429, 502, 503 or 504). Polling uses the remaining overall deadline and doesn't replay missed events. `"sse"` requires SSE and throws if the stream ends early; `"poll"` polls from the start. Polling defaults to once a second. 401, 403 and 404 responses and malformed snapshots throw instead of falling back. Snapshots describe current state; there is no replay or `Last-Event-ID` support.

`streamRun()` is a separate, raw stream of run, stage and document events. It has no polling fallback and no replay. The [runnable watch example](https://docslurp.io/docs/examples/watch-run.mjs) uses the typed progress iterator and its automatic fallback.

## Current workspace state

```ts
const state = await client.getWorkspaceState(undefined, {
  recentWindowHours: 24,
  timeoutMs: 30_000,
});
console.log(state.pages.indexed, state.pages.notIndexed);
console.log(state.storage.sourceMb, state.storage.documentsWithUnknownSize);
console.log(state.searches.latencyMs.p95, state.performance.pagesPerMinute);
```

Omit the first argument (or pass `undefined` when you also pass options) to use the client's workspace: the `workspaceId` client option, then `DOCSLURP_WORKSPACE_ID`, then `default`. For another workspace, pass a slug such as `"legal-contracts"` or a UUID. `recentWindowHours` is an integer from 1 to 720 and defaults to 24; HTTP enforces the same range. Bearer requests need a server key with the `ingest`, `search`, `artifacts` or `workspaces:manage` scope.

```bash
curl --fail-with-body --silent --show-error --max-time 30 \
  "$api_url/v1/workspaces/default/state?recentWindowHours=24" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
```

The response is a `WorkspaceState` object, not wrapped in `{ state: ... }`. This **illustrative full response** shows one completed document with two searchable pages, one queued document with an unknown page count, and one unknown source size:

```json
{
  "workspaceId": "workspace-123",
  "orgId": "org-123",
  "observedAt": "2026-10-06T12:00:00Z",
  "recentWindow": {
    "from": "2026-10-05T12:00:00Z",
    "to": "2026-10-06T12:00:00Z",
    "hours": 24
  },
  "documents": {
    "total": 2,
    "queued": 1,
    "processing": 0,
    "completed": 1,
    "failed": 0,
    "unknownPageCount": 1
  },
  "pages": {
    "total": 3,
    "indexed": 2,
    "notIndexed": 1,
    "basis": "text-searchable-unique-pages"
  },
  "storage": {
    "sourceBytes": 2000000,
    "sourceMb": 2,
    "textBytes": 1500,
    "textMb": 0.0015,
    "documentsWithUnknownSize": 1,
    "vectorBytes": null,
    "artifactBytes": null,
    "mbDivisor": 1000000
  },
  "runs": {
    "total": 2,
    "queued": 1,
    "processing": 0,
    "completed": 1,
    "failed": 0
  },
  "searches": {
    "total": 0,
    "recentCount": 0,
    "recentZeroResultCount": 0,
    "latencyMs": {
      "sampleCount": 0,
      "p50": null,
      "p95": null,
      "max": null
    }
  },
  "performance": {
    "completedRuns": 1,
    "failedRuns": 0,
    "completedPages": 3,
    "durationMs": {
      "sampleCount": 1,
      "p50": 60000,
      "p95": 60000,
      "max": 60000
    },
    "pagesPerMinute": 3,
    "minutesPer100Pages": 33.333333333333336,
    "basis": "run-wall-time-including-queue"
  },
  "usage": {
    "inputTokens": 100,
    "outputTokens": 20,
    "costCents": 0.005
  }
}
```

| Metric | Basis and limits |
| --- | --- |
| `documents`, `runs` | Current persisted workspace records, grouped by status; counts are not limited to the recent window. |
| `pages.total` | Sum of known current document page counts. `documents.unknownPageCount` counts documents whose total is not yet known. |
| `pages.indexed` | Distinct valid document/page numbers with nonempty page/chunk text in completed documents' current runs. Several chunks on a page count once. This is text-searchable coverage, not vector coverage or extraction progress. |
| `pages.notIndexed` | Known total minus indexed; documents with unknown page totals are not assigned invented missing-page counts. |
| `storage.sourceBytes` / `sourceMb` | Logical source sizes measured while accepting bytes/streams. Unknown legacy/already-stored sizes are counted by `documentsWithUnknownSize`; the sum can be a lower bound. Declared content length is not a measurement. |
| `storage.textBytes` / `textMb` | Current persisted page and chunk text representations, including both when content is represented twice; not physical database/object-store footprint. |
| MB and unknown storage | Decimal MB = bytes / 1,000,000. Vector and artifact physical byte totals are unknown (`null`), never implied to be zero. |
| `searches.total` | All-time sessions scoped to this workspace, including multi-workspace sessions. One such session can appear in each involved workspace's count. |
| Recent searches | `recentCount`, `recentZeroResultCount`, and latency distributions cover the selected window. Invalid/missing latency observations do not become zero samples. |
| Recent ingestion performance | Completed/failed run counts use the selected window. Duration is persisted run wall time from creation to update, including queue time. Throughput uses completed pages and positive completed-run durations; reprocessing contributes work. It is not parser-only runtime. |
| Efficiency | `pagesPerMinute = completedPages × 60,000 / summed durationMs`; `minutesPer100Pages = 100 / pagesPerMinute`. These are observed recent run-efficiency measures, not an ETA for queued work. |
| Distribution fields | `sampleCount` describes available measurements; `p50`, `p95`, and `max` are `null` without samples. A measured zero search latency remains zero. Throughput is `null` when there is no positive page/runtime evidence. |
| `usage` | All-time recorded usage attributed to this workspace. Cross-workspace usage is proportionally attributed. Fractional costs/tokens are preserved; this is not a complete bill or an estimate of unrecorded costs. |

Workspace state is a one-time REST read; there is no workspace-state stream. Read it again when you need fresh numbers, and use the run progress iterator for live ingestion counts. After one run completes, concurrent runs and unknown page counts can still leave a workspace partly searchable.

## Ingest report

The ingest report explains how a workspace's files processed and why a page can or cannot be found. It is built from recorded facts, with no model call, so reading it costs nothing.

```ts
const report = await client.getIngestReport(); // default workspace
console.log(report.pages.total, report.text.avgBytesPerPage, report.images.avgPerPage);
console.log(report.searchability.byReason); // e.g. [{ reason: "scanned-no-vision", pages: 12 }]
for (const rec of report.recommendations) console.log(rec.severity, rec.title, rec.cost.centsPer100Pages);

// One run, or up to 100 documents:
await client.getIngestReport("legal-contracts", { runId: run.id });
```

```bash
curl --fail-with-body --silent --show-error \
  "$api_url/v1/workspaces/default/ingest-report?runId=$RUN_ID" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
```

Bearer requests need a server key with the `ingest`, `search`, `artifacts` or `workspaces:manage` scope. Without `runId` or `documentIds` the report covers the current corpus (documents not superseded by a newer version), newest first, capped at 500 files and 20,000 pages read page by page; `scope.truncated` says when the cap applied.

| Field | Meaning |
| --- | --- |
| `files`, `pages`, `bytes` | Files by type and status, page totals, bytes per file and per page, and a file-size histogram. |
| `text.perPage` | Plain-text bytes of each page's native text layer (whitespace collapsed), as a histogram with p50/p95. `zeroTextPages` and `nearZeroTextPages` (under 64 bytes) count pages with no usable text layer. |
| `text.indexedPerPage` | Bytes of indexed chunk text per page, after vision and chunking. |
| `images` | Embedded images per page, pages with images, and `scannedLookingPages` (images and almost no text layer: scans and photos of text). |
| `extraction` | Pages read with vision versus the native text layer, and pages vision skipped: not selected by page triage, past the per-file vision page limit, failed, or stopped by the run cost cap. |
| `searchability` | Searchable pages (a page with chunks), unsearchable pages grouped by reason, pages still processing, and up to 20 example pages. |
| `stages`, `languages`, `media`, `tables` | Failed and skipped stages, detected languages, audio and video files (and minutes), and table-heavy pages. |
| `performance` | Cost (`costCents`, the same figure as the run records: billed spend plus the flagged unbilled compute estimate, `computeEstimated`), `billedCostCents` (billed spend only, what the run cost cap is enforced against), pages per minute, minutes per 100 pages and pages per $1, from run wall time including queueing. |
| `coverage` | Per-page text and image facts exist for files processed from 2026-10-14; older files report them as not recorded. |
| `config` | The pipeline settings that shaped what was observed (vision, vision page limit, playbook, OCR language, tables, embeddings, chunking, video, cost cap, privacy mode), each with why it matters here. |
| `recommendations` | Deterministic rules with the evidence, the expected effect, `cost.centsPer100Pages` for future uploads, `cost.reprocessCents` for re-running the affected files, and the pipeline `patch` an editor can apply. |

Recommendation rules: read every page with vision when scanned-looking pages have no searchable text or vision stopped at the per-file page limit (`turn-on-vision` when vision is off, `vision-all-pages` otherwise; the patch sets `vision.forceAllPages` and a page limit of up to 32); retry pages where vision failed; raise the run cost cap when it stopped vision; keep tables when table-heavy pages were flattened (`preserveTables`); turn on embeddings; read video frames (`mediaVideo.enabled`); flag audio or video without a transcript (a platform setting); reprocess pages that have text but no chunks; retry failed files; and suggest a multilingual embedding profile for non-English files. Vision cost uses this workspace's observed vision spend per page when at least three pages were read, otherwise the model's catalog price.

In the dashboard, ask "how did my files process?", "why can't it find page 4?" or type `/status` in chat, or use the Report button in the composer. Only the signed-in dashboard chat answers this way (`CHAT_INGEST_REPORT_NATURAL=false` keeps just `/status`); `/v1/chat`, MCP `chat` and `/v1/chat/completions` treat these as ordinary questions, so API clients read the endpoint above. Workspace editors can apply a recommendation (`POST /v1/workspaces/:workspace/ingest-report/apply` with `recommendationId` and the report's `runId`/`documentIds`, session only) after a confirmation that shows the cost; the server recomputes the report and merges the recommendation's own patch onto the stored pipeline through the regular workspace update and audit log, so a request cannot carry arbitrary settings. `POST …/ingest-report/reprocess` re-runs up to 100 affected files with the workspace's current settings.

## Organization access and management

Use these endpoints to read and manage an organization, its members and its API keys. You need current membership in the organization; being shared on a workspace isn't enough.

- Server keys need an explicit `organizations:read` or `organizations:manage` scope. The ordinary `ingest`, `search` and `artifacts` scopes don't cover organization endpoints.
- A key only works for its own organization and never exceeds its user's current role.
- Browser keys can't have organization scopes.

| Operation | Required key scope | Required organization role / behavior |
| --- | --- | --- |
| List, read, details, access, members | `organizations:read` or `organizations:manage` | Any current member. A key's organization list contains only its own organization. |
| Create organization | Session only | Creates the organization and makes you its first owner in one step. |
| Update name or slug | `organizations:manage` | Owner or admin. Returns the updated details, not just the organization record. |
| Add, change or remove other members | `organizations:manage` | Owners manage all roles. Admins manage member and billing roles only, and can't change owners or admins. |
| Leave, or remove yourself | `organizations:manage` for keys | Any member, except in a personal organization or as the last owner. |
| List organization keys | `organizations:read` or `organizations:manage` | Owner or admin. Returns metadata only. |
| Revoke all organization keys | `organizations:manage` | Owner or admin. Also revokes the key making the request. |

Signed-in sessions don't need key scopes. Demoting, removing or leaving as the last owner returns 409, and this check is safe against concurrent membership changes. Personal organization memberships can't be added, changed or removed. Removing a member revokes their keys for that organization; workspaces shared with them directly stay shared.

### Grant organization scopes explicitly

Create the key while signed in, on the [API keys](https://docslurp.io/app/api-keys) page or over HTTP with your session cookie. Below, `DOCSLURP_COOKIE_JAR` is a cookie jar file from a signed-in session. Granting `organizations:manage` needs an owner or admin; any member can grant read access. Pass the real organization ID: without `orgId`, the key is created in your personal organization.

```bash
curl --fail-with-body --silent --show-error --max-time 30 \
  "$api_url/v1/api-keys" \
  -b "$DOCSLURP_COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Organization automation","orgId":"org-123","keyType":"server","scopes":["organizations:read","organizations:manage"],"rateLimitRpm":60,"rateLimitPpd":10000}'
```

The response is `{ "key": <key metadata>, "rawKey": <the new key> }` with status 201. Store `rawKey` securely; key listings never return it. Existing keys don't gain the new scopes. To change an existing key's `scopes`, send `PATCH /v1/api-keys/:keyId` from a signed-in session; the same role and server-key rules apply. Because creating and updating keys requires a session, a key can't grant itself organization access.

The examples below use these IDs and a server key with the scope each operation needs:

```bash
org_id='org-123'
member_user_id='user-456'
```

All output examples in this section are **illustrative**, with synthetic IDs and timestamps.

### List, read, inspect details and capabilities

```bash
curl --fail-with-body --silent --show-error "$api_url/v1/organizations" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
curl --fail-with-body --silent --show-error "$api_url/v1/organizations/$org_id" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
curl --fail-with-body --silent --show-error "$api_url/v1/organizations/$org_id/details" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
curl --fail-with-body --silent --show-error "$api_url/v1/organizations/$org_id/access" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
```

`GET /v1/organizations/:orgId` (and create) returns the organization record directly, in this complete shape:

```json
{
  "id": "org-123",
  "name": "Research",
  "slug": "research",
  "isPersonal": false,
  "personalOwnerUserId": null,
  "createdByUserId": "user-123",
  "creditBalanceCents": 0,
  "memberRole": "owner",
  "createdAt": "2026-10-06T12:00:00Z",
  "updatedAt": "2026-10-06T12:00:00Z"
}
```

The list endpoint wraps records in `{ "organizations": [<organization record>] }`, and SDK `listOrganizations()` returns the array. A session sees all of its organizations; a key sees only its own.

Details returns `{ "organization": <organization record>, "access": <access object>, "counts": { "members": 2, "workspaces": 3 } }`. The member count covers the whole organization. The workspace count does too for owners and admins, but for member and billing roles it counts only workspaces they own or that are shared with them.

The direct access object for this owner is:

```json
{
  "orgId": "org-123",
  "userId": "user-123",
  "role": "owner",
  "capabilities": {
    "read": true,
    "update": true,
    "manageMembers": true,
    "manageOwners": true,
    "manageApiKeys": true,
    "leave": false
  }
}
```

Here `leave: false` means this user is the only remaining owner. Personal memberships also limit capabilities. A key with only `organizations:read` gets `false` for every write capability, even if its user is an owner. Capabilities describe what the current user or key can do; the server still checks every write.

```ts
const organizations = await client.listOrganizations(); // OrganizationRecord[]
const organization = await client.getOrganization(org_id);
const details = await client.getOrganizationDetails(org_id);
const access = await client.getOrganizationAccess(org_id);
console.log(details.counts, access.capabilities);
```

### Create or update metadata

Creating an organization needs a signed-in session, so the first request uses the cookie jar instead of a key:

```bash
curl --fail-with-body --silent --show-error "$api_url/v1/organizations" \
  -b "$DOCSLURP_COOKIE_JAR" -H 'Content-Type: application/json' \
  --data '{"name":"Research","slug":"research"}'
curl --fail-with-body --silent --show-error -X PATCH "$api_url/v1/organizations/$org_id" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" -H 'Content-Type: application/json' \
  --data '{"name":"Research library","slug":null}'
```

Create returns the organization record with 201. Update returns the full `{ organization, access, counts }` details with 200.

- `name` is trimmed and 1 to 120 characters.
- `slug` is 2 to 120 lowercase letters, digits and hyphens; `null` clears it.
- PATCH needs `name`, `slug` or both, and rejects other fields. Owners, credits and personal status can't be changed this way.
- A slug that's already taken returns 409.

```ts
const updated = await client.updateOrganization(org_id, { name: "Research library", slug: null });
console.log(updated.organization.name, updated.access.capabilities);
// With session-capable authentication:
// const created = await sessionClient.createOrganization({ name: "Research", slug: "research" });
```

`createOrganization()` needs a browser cookie session or a custom `fetch` that sends session cookies; a Node client with only an API key can't create organizations. This API doesn't delete organizations or send email invitations.

### List, add, change and remove members

```bash
curl --fail-with-body --silent --show-error "$api_url/v1/organizations/$org_id/members" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
jq -n --arg memberUserId "$member_user_id" '{memberUserId:$memberUserId,role:"member"}' |
  curl --fail-with-body --silent --show-error "$api_url/v1/organizations/$org_id/members" \
    -H "Authorization: Bearer $DOCSLURP_API_KEY" -H 'Content-Type: application/json' --data-binary @-
curl --fail-with-body --silent --show-error -X PATCH "$api_url/v1/organizations/$org_id/members/$member_user_id" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" -H 'Content-Type: application/json' --data '{"role":"billing"}'
curl --fail-with-body --silent --show-error -X DELETE "$api_url/v1/organizations/$org_id/members/$member_user_id" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
```

Listing members returns names, emails and roles in this exact shape:

```json
{
  "memberships": [
    {
      "orgId": "org-123",
      "userId": "user-456",
      "role": "member",
      "createdAt": "2026-10-06T12:00:00Z",
      "email": "member@example.com",
      "name": "Research Member"
    }
  ]
}
```

New members join through an email invite (`POST /v1/organizations/:orgId/invites` with `{ "email", "role" }`). It returns `{ invite, inviteUrl }` with 201 and emails the link; the person joins by opening it while signed in with that verified email. There is no way to add a user by ID. Changing a role returns the membership record with 200:

```json
{
  "orgId": "org-123",
  "userId": "user-456",
  "role": "billing",
  "createdAt": "2026-10-06T12:00:00Z"
}
```

Roles are `owner`, `admin`, `member` and `billing`. An omitted invite role defaults to `member`. Inviting someone who is already a member returns 409 instead of changing their role. PATCH changes only the role. DELETE returns `{ "ok": true }` with 200, not 204.

```ts
const members = await client.listOrganizationMembers(org_id); // OrganizationMember[]
const { invite, inviteUrl } = await client.inviteOrganizationMember(org_id, { email: "teammate@example.com", role: "member" });
const changed = await client.updateOrganizationMemberRole(org_id, member_user_id, "billing");
await client.removeOrganizationMember(org_id, member_user_id); // Resolves to undefined.
```

### Leave an organization

```bash
curl --fail-with-body --silent --show-error -X POST "$api_url/v1/organizations/$org_id/leave" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
```

No request body is needed. Success returns `{ "ok": true }` with 200, and the SDK's `leaveOrganization(org_id)` resolves to `undefined`. A key needs `organizations:manage` to leave; any member can leave from a signed-in session. You can't leave a personal organization, or leave as the last owner. Leaving revokes your keys for that organization, so later calls with the same key fail.

### List and revoke organization keys

```bash
curl --fail-with-body --silent --show-error "$api_url/v1/organizations/$org_id/api-keys" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
```

Owners and admins get `{ "keys": [...] }`, with metadata for active and revoked keys. This illustrative record shows every field:

```json
{
  "keys": [
    {
      "id": "key-123",
      "userId": "user-123",
      "orgId": "org-123",
      "name": "Organization automation",
      "keyType": "server",
      "allowedDomains": [],
      "scopes": [
        "organizations:manage"
      ],
      "rateLimitRpm": 60,
      "rateLimitPpd": 10000,
      "lastUsedAt": null,
      "createdAt": "2026-10-06T12:00:00Z",
      "revokedAt": null,
      "requestsLastMinute": 0,
      "pagesToday": 0
    }
  ]
}
```

To revoke **every active key in the organization**, including the key making the request:

```bash
curl --fail-with-body --silent --show-error -X DELETE "$api_url/v1/organizations/$org_id/api-keys" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
```

The response is `{ "keys": [<revoked key metadata>], "revokedCount": 1 }`, with `revokedAt` set on each record. Keys that were already revoked aren't included. The response never contains raw keys.

```ts
const keys = await client.listOrganizationApiKeys(org_id); // OrganizationApiKey[]
const result = await client.revokeOrganizationApiKeys(org_id); // {keys, revokedCount}
```

### Organization errors

| Status | Contract |
| --- | --- |
| 400 | Invalid fields, role or key scope. Validation errors can contain Zod `success`/`error` details, so don't assume every error has the same shape. |
| 401 | No valid authentication. |
| 403 | Missing organization scope, a browser key, creating without a session, or a role that isn't high enough. |
| 404 | The organization or membership doesn't exist or you can't access it, or the target user is unknown. A key asking about another organization gets 404, so it can't tell whether that organization exists. |
| 409 | Duplicate membership or slug, a personal membership, or removing, demoting or leaving as the last owner. |
| 429 | Rate limit reached. Wait for `Retry-After`, and cap your retries. |

Organization errors use the [error envelope](https://docslurp.io/docs/search-reference#errors). For example, removing the last owner returns:

```json
{
  "error": {
    "code": "last_owner",
    "message": "An organization must keep at least one owner.",
    "requestId": "req_123"
  }
}
```

Other codes include `personal_organization`, `membership_exists`, `membership_forbidden`, `membership_not_found`, `organization_not_found`, `organization_forbidden`, `organization_conflict`, `session_required` and `user_not_found`. In the SDK, HTTP failures throw `DocSlurpApiError` with `status`, `code`, `requestId` and the response in `body`; branch on `code`. The SDK never retries organization writes, so keep earlier successful responses when a later call fails.

## Make failures recoverable

| What happened | What your application should do |
| --- | --- |
| Upload accepted with warnings | Store the IDs and warnings, and follow the run. |
| Wait deadline passed | Check the stored run later. Don't repeat an upload that may have been accepted. |
| Run failed or stopped | Check the final snapshot and control state. The loop ending doesn't mean success. |
| Progress stream drops or ends | `streamProgress(..., { transport: "auto" })` polls for the rest of its deadline. |
| Raw event stream drops or ends | Fall back to REST polling yourself, within the same overall deadline. |
| Workspace empty, pending or partly indexed | Wait, show partial results, or decline to answer, as your application requires. |
| Batch contains `ok: false` | Handle each result. Successful queries are still usable. |
| Chat has `finishReason: "length"` | The answer was cut off. Decide whether to ask again. |
| HTTP 401 or 403 | Check the key's validity, type and scopes, your membership, and organization and workspace access. |
| HTTP 409 | Fix the membership, ownership or uniqueness conflict it names. Retrying won't help. |
| HTTP 429 or a transient server error | Retry a limited number of times where the operation allows it. Avoid repeating billable writes. |

SDK reads (run progress, workspace state, organization reads and document reads) retry at most twice on HTTP 429, 502, 503 or 504. Retries honor `Retry-After`, wait at most five seconds each, and stay within the request deadline. Uploads of files or blobs with an `idempotencyKey` use the same policy. Network errors aren't retried.

The progress iterator's `auto` transport is separate: it switches to polling instead of retrying the SSE connection. Raw streams, organization writes, URL ingestion, search, batches and chat are never retried automatically, and the CLI doesn't retry failed requests. See [SDK timeouts, cancellation and errors](https://docslurp.io/docs/sdk-reference#timeouts-cancellation-and-errors).

Progress, workspace state and organization GETs count against the read rate limit, and organization writes against the write limit. Opening a stream counts as one read; heartbeats and server-side refreshes don't add requests. Every poll is another read against the key's allowance, so choose `pollIntervalMs` for your limits and the number of runs you watch. Polling once a second uses about 60 requests a minute per run. Limits vary by deployment, account and key settings, so read the `X-RateLimit-*` and `Retry-After` headers instead of assuming a fixed allowance.

### Rate limits and headers

Limits depend on deployment, account profile and each key's settings, so read them from responses instead of hard-coding them. Every limit that applied to a request is listed in the IETF [`RateLimit-Policy` and `RateLimit`](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) fields (`q` = quota, `w` = window seconds, `r` = remaining, `t` = seconds until reset), and `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` (Unix seconds) describe the tightest one:

```http
RateLimit-Policy: "ip-search";q=240;w=60, "ip-burst";q=200;w=10, "free-search";q=60;w=60, "key-requests-1h";q=1000;w=3600
RateLimit: "ip-search";r=231;t=42, "ip-burst";r=197;t=7, "free-search";r=52;t=42, "key-requests-1h";r=12;t=1630
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 12
X-RateLimit-Reset: 1791504000
X-DocSlurp-Spend: "key-spend-1d";q=500;r=212;w=86400;u=usd-cents
```

| Layer | Policy names | Applies to |
| --- | --- | --- |
| Per client IP | `ip-<category>`, `ip-burst` | Every request. Categories: `upload`, `search`, `chat-ai`, `read`, `write`, `webhook`. |
| Per key or signed-in user | `<plan>-<category>` | The plan's per-category limit, capped by the key's requests per minute. |
| Custom key windows | `key-requests-<window>` | All endpoints together, e.g. 1,000 requests per hour. |
| Spend windows | `key-spend-<window>` (`X-DocSlurp-Spend`) | Attributed AI, embedding and processing cost in a rolling window. Once reached, uploads, search and chat return 429; reads keep working. |
| Daily pages | — | Uploads stop with `daily_page_limit` once the key's pages-per-day cap is used. |

Custom request and spend windows are set per key on the API keys page (under "Permissions and limits", then "Advanced rate limits") or with `rateLimits` on `POST`/`PATCH /v1/api-keys`, e.g. `[{ "metric": "requests", "limit": 1000, "windowSeconds": 3600 }, { "metric": "spend", "limit": 500, "windowSeconds": 86400 }]` (spend in US cents; at most five rules, one per metric and window, windows up to 31 days). Spend is recorded when the work it pays for finishes and is refreshed every few seconds, so a request already running can carry a key slightly past its spend limit.

Every 429 has `Retry-After` and the [error envelope](https://docslurp.io/docs/search-reference#errors) with `error.code` set to `rate_limited` (with `details.category` and `details.policy`), `spend_limit_exceeded`, `daily_page_limit` or `ip_temporarily_blocked`. An IP is blocked for a while after an extreme burst or after repeatedly presenting invalid API keys, so stop and fix credentials rather than retrying 401s in a loop.

## Authentication and integration boundaries

- Create and revoke keys on the [API keys](https://docslurp.io/app/api-keys) page, or with the session key API above. `ingest` allows uploads and URL ingestion, `search` allows search and chat, and `artifacts` allows document reads. Run progress accepts any of these scopes. Workspace state also requires a server key.
- Organization scopes are opt-in. `organizations:manage` also allows organization reads, but doesn't bypass role, organization, personal-membership or last-owner checks.
- Send `Authorization: Bearer <key>`. Keep server keys on the server. Route frontend requests through your own authenticated backend and enforce your application's access rules there.
- Allowed websites restrict where a browser key works. They don't make a server key safe to use in a browser.
- Stored files never leave private storage directly. Every `url` in document, artifact and export responses is a DocSlurp file URL (`/v1/files/…`) that streams through an authenticated proxy. It works only with the same API key that received it (send the same `Authorization` header), expires within about 75 minutes, and stops working when the key is revoked or loses access to the document. To show page images to your own users, stream them through your backend. Byte ranges (`Range`) are supported.
- `formatSearchContext` formats search results as evidence for any LLM. Keep document text separate from your instructions, and keep the structured citations.
- The Node SDK and CLI need Node.js 20+ and are ESM. From other languages, use HTTP; there is no Python SDK.

## Primary sponsor

[![17th Street Labs logo](https://docslurp.io/sponsors/17th-street-labs-readme.svg)](https://17thstreetlabs.com)

[17th Street Labs](https://17thstreetlabs.com) is DocSlurp's primary sponsor.

### Document tags

Apply tags to every accepted document in an upload, including streamed, URL, and direct-to-storage uploads:

```ts
await client.upload({ files: [file], tags: ["finance", "FY26"] });
await client.upload({ urls: ["https://example.com/report.pdf"], tags: ["finance"] });
const tags = await client.listWorkspaceTags();
// [{ tag: "finance", documentCount: 2 }, ...]
await client.search({ q: "revenue outlook", tags: "finance,FY26" });
```

JSON upload and direct-session requests accept `tags: string[]`. Multipart `/v1/uploads/bulk` accepts a `tags` field containing a JSON array. Tags are case-sensitive, trimmed, and deduplicated: up to 24 labels per request, each 1–100 characters, with no commas or NUL characters. Tags are saved with the document before processing starts, returned in the upload response, and preserved when reprocessing documents.

`GET /v1/workspaces/{workspaceId}/tags` returns `{ "tags": [{ "tag": "finance", "documentCount": 2 }] }`, sorted by tag. Counts cover current, non-superseded documents, including pending uploads. The workspace accepts a UUID, slug, former slug, or `default`. Session callers need workspace access; API keys additionally need one of `search`, `ingest`, `artifacts`, or `workspaces:manage`, and stay within their organization and workspace restrictions. An empty workspace returns `{"tags":[]}`.

Document listing and search accept comma-separated `tags`; matching any supplied tag is sufficient. Chat accepts an array in `filters.tags`. Existing dashboard-session endpoints `PUT /v1/documents/{docId}/tags` and `POST /v1/documents/bulk` (`apply-tags`/`remove-tags`) edit labels with workspace edit access. Tag changes take effect without re-ingestion.
