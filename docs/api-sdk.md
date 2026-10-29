# HTTP API

Use the HTTP API to upload documents from any language, follow their processing, and retrieve passages that cite the document and page they came from. Requests use HTTPS under `https://docslurp.io/v1`, authenticated with `Authorization: Bearer <key>`. Most requests use JSON; file uploads use multipart form data or signed storage PUTs.

Use search when you already have an LLM or a search UI. Use chat when you want DocSlurp to write a cited answer.

```bash
curl https://docslurp.io/v1/search \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"q": "How much parental leave do we get?", "limit": 5}'
```

Each result has `text`, a `score` and a `citation` with the `filename`, `pageNumber` and `documentId`. Without a `workspace`, the request searches your organization's default workspace. To upload documents first, run [the complete HTTP flow](#the-complete-http-flow) below.

| Prefer a client library? | Use it for |
| --- | --- |
| [Node.js / TypeScript SDK](https://docslurp.io/docs/sdk) | Application code, streams, deadlines and typed responses |
| [CLI](https://docslurp.io/docs/cli) | Exploring documents, shell scripts, CI and agent tooling |
| [Runnable Node examples](https://docslurp.io/docs/sdk#quickstart) | Upload, wait and search, progress with polling fallback, and LLM context |
| [Deferred indexing modes](deferred-indexing.md) | On-demand page map and page images, query spend policies, capability tokens for browser clients |
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
| `dslp_priv_` | Server key | Backend secrets, CI, agent configuration | The scopes you grant: `ingest`, `search`, `chat`, `artifacts`, and opt-in organization/workspace management |
| `dslp_pub_` | Browser key | Page HTML and browser bundles | `search`, plus `chat` for an answer widget. Nothing else, ever: only on your allowed websites, and only in the workspaces you name |

`search` returns passages. `chat` generates answers on your credits: `/v1/chat`, `/v1/chat/stream`, `/v1/chat/completions` (and its `/v1/models` list) and the MCP `chat` tool need it. Keys created before `chat` existed kept chat access wherever they had `search`.

Web tools (`/v1/web/*` and the MCP and chat-agent web tools) make paid calls to the open web. Server keys use them with `search` (`ingest` for website ingestion). Browser keys never get them, nor `ingest` or `artifacts`: anyone can copy a browser key from your page source. A browser key saved earlier with those scopes retains only the `search` or `chat` permissions it already held. If none remain, it has no permissions: saving or rotating it never adds `search`. Edit its scopes explicitly to enable search or chat; default scopes apply only when creating a key.

Controls per key type:

| | Browser key | Server key |
| --- | --- | --- |
| Scopes | `search`, `chat` | Any, including opt-in organization and workspace management |
| Workspaces | Required (`workspaceIds`) | Optional; empty means every workspace you can reach in the organization |
| Where it works | Allowed websites (`allowedDomains`) | Anywhere, or only from an IP allowlist (`ipAllowlist`: addresses or CIDR ranges, up to 50) |
| Chat output cap (`maxOutputTokens`) | 500, 1,000 (default) or 2,000 | 500, 1,000, 2,000, 4,000 or none (`null`, the default) |
| Expiry (`expiresAt`) | Optional | Optional, up to 365 days ahead |
| Limits | Per-key limits, plus per-visitor limits and concurrency | Per-key request, spend and `concurrent` rules; no default concurrency cap |

The chat output cap bounds the model's maximum output tokens for every chat answer the key gets (`/v1/chat`, `/v1/chat/completions`, the MCP `chat` tool). A request asking for more (`max_tokens`, `max_completion_tokens`) is lowered to the cap. An expired key stops authenticating, and so does a key used from outside its IP allowlist (403 `api_key_ip_not_allowed`; an address we can't determine is refused too). Each key reports `lastUsedAt` and `lastUsedIp`. MCP and first-party CLI OAuth access tokens also honor their linked server key’s current expiry, IP allowlist and chat output cap; an expired key or a disallowed/unknown address makes the token unauthorized.

Rotate a key with `POST /v1/api-keys/:id/rotate`. With no body the secret is replaced at once. With `{"overlapSeconds": 86400}` (up to 7 days) you get a new key with the same settings (`rotatedFromKeyId` names the old one), and the old key keeps working until the overlap ends (`previous.expiresAt` in the response). Deploy the new secret within that window.

A browser key must name the workspaces it may use (`workspaceIds`), because anyone can copy it from your page source. A browser key created before this rule, with no workspaces, is refused with `client_key_workspaces_required` until you edit it and choose its workspaces; it is never widened to every workspace in the organization. A request from a website the key doesn't allow is refused with `client_key_origin_not_allowed` (on `/v1/chat/completions`, a 403 `permission_error` with that code).

Allowed websites for a browser key are matched like this:

| Entry | Allows |
| --- | --- |
| `docs.example.com` | Exactly that host, over http or https, on any port. Subdomains are not included. |
| `*.example.com` | Any subdomain of example.com, but not example.com itself (add both if you need both). |
| `https://docs.example.com` | That host over https only. |
| `docs.example.com:8443`, `http://localhost:4321` | That port only. |

Entries saved before exact matching (which then covered every subdomain) were migrated to keep that meaning: `example.com` became `example.com` plus `*.example.com`. A shared public suffix from the [Public Suffix List](https://publicsuffix.org/) (private section included), such as `github.io`, `vercel.app`, `pages.dev`, `s3.us-east-1.amazonaws.com`, `co.uk` or `com`, is refused, because every site on it would be allowed: enter your own site, such as `yourname.github.io`. The check uses the browser's `Origin` (or `Referer` when there is no `Origin`), which only a browser enforces. A script outside a browser can send any `Origin`, so keep the key's scopes, workspaces and spend limits narrow.

A key's type is fixed when you create it; to switch, create a new key. Keys issued before typed prefixes (`dslp_<hex>`) keep working. Create and rotate keys on the [API keys](https://docslurp.io/app/api-keys) page.

### OAuth access tokens (CLI login)

`docslurp login` gets an OAuth access token instead of a key. The first-party CLI client (`docslurp-cli`) is the only client that may request the REST API audience (`resource=<origin>/v1`, RFC 8707): through the browser (authorization code with PKCE and a loopback redirect) or, on headless machines, the device authorization grant (RFC 8628, `POST /oauth/mcp/device_authorization`, verification page `/oauth/mcp/device`). Dynamically registered MCP clients stay bound to `<origin>/v1/mcp`, and their tokens are refused on the REST API.

Access tokens start with `dscli_` and last 15 minutes; refresh tokens (`dsclir_`) rotate on every use, last 30 days, and revoke the whole grant if one is replayed. Send an access token like a key, as `Authorization: Bearer`. It acts as a server key bound to the approving user and organization (removing the membership or revoking the grant stops it at once), and its scopes map onto key scopes:

| OAuth scope | Key scope it grants |
| --- | --- |
| `search` | `search` |
| `chat` | `chat` |
| `read` | `artifacts` |
| `ingest` | `ingest` |
| `web` | `web` |

A CLI token needs `web` for the paid web tools; `search` alone does not unlock them (MCP-audience grants keep the older rule, where a server identity with `search` may use them). No OAuth scope grants `workspaces:manage`, `organizations:read` or `organizations:manage`, so a token cannot change workspace settings or manage an organization. Device approvals grant only `search` and `read` unless the approving user ticks the other requested scopes, and the device flow has no `verification_uri_complete`: the user always types the code. OAuth tokens, MCP-audience ones included, are never platform admins. An expired or revoked OAuth token gets `401` with `WWW-Authenticate: Bearer error="invalid_token"`, on compat routes too. OAuth tokens are never a dashboard session, so they never reach the app-only settings tools, and they cannot mint API keys or `/v1/capabilities` tokens that would outlive them. `GET /v1/whoami` returns the token's user, organization, default workspace, granted scopes and expiry.

In the SDK, pass `accessToken` as a string or as a provider `({ forceRefresh }) => token`; the client calls it per request and once more with `forceRefresh: true` after a 401. Without `apiKey`, `DOCSLURP_API_KEY` or `accessToken`, the SDK reads `DOCSLURP_TOKEN`. Revoke a login with `docslurp logout` (RFC 7009 `POST /oauth/mcp/revoke`) or from the connected apps list in your account.

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

With no `workspace`, the upload, search and chat all use your organization's default workspace. To keep documents in their own workspace, add `-F 'workspace=Legal Contracts'` to the upload and `"workspace": "Legal Contracts"` to search and chat: the first upload creates a workspace with that name (slug `legal-contracts`), and every later request finds it by name, slug or ID. To create a new workspace that titles itself from the upload, add `-F 'newWorkspace=true'` instead (see [Workspaces](#workspaces)).

Keep server keys out of browser bundles. The base URL is the service **origin**; the routes below already include `/v1`.

### Add a grounded answer

Chat uses the same default workspace when `workspace` is omitted:

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

Workspaces are optional. Every organization has a **default workspace**, created on first use, and any request that omits `workspace` uses it. This section explains every way to refer to a workspace; other guides link here.

Every request that targets a workspace takes one field, `workspace`, whose value can be any of these:

| Value | Example | Notes |
| --- | --- | --- |
| Omitted, or `default` | `default` | Your organization's default workspace. Any organization member can read and upload to it; it cannot be archived or deleted. |
| Name | `Legal Contracts` | Matched by its slug, so `Legal Contracts`, `legal contracts` and `  Légal—Contracts! ` all name the workspace whose slug is `legal-contracts`. If no slug matches, a workspace whose name has that slug matches (oldest first). |
| Slug | `legal-contracts` | Every workspace has a globally unique, URL-safe slug: the slug of its name when it was created from an upload, otherwise three generated words (e.g. `amber-falcon-ridge`). Slugs are renamable. Prefer them in config and human-facing links. |
| Former slug | `amber-falcon-ridge` | Every slug a workspace has had keeps resolving to it, like a renamed GitHub repository, and cannot be claimed by another workspace. |
| UUID | `6f1c2a7e-…` | An absolute reference that never changes. |

Values are matched by slug: the value is lowercased, accents are stripped, every run of characters other than `a-z` and `0-9` becomes one hyphen, and leading and trailing hyphens are dropped (at most 63 characters). A value with no letters or digits left, such as `!!!`, is a `400 invalid_request`. Matching only ever looks at workspaces you can use: your organization's (the API key's organization, or `orgId` for dashboard sessions), and for a key restricted to specific workspaces, only those.

**When nothing matches:** uploads (`/v1/uploads/bulk`, `/v1/uploads/url`, direct upload sessions, the MCP `upload` tool) create a workspace whose display name is the value as you typed it and whose slug is its slug (with a short suffix if another organization already holds that slug). Every other request answers `404 workspace_not_found` with a message naming the slug it looked for, for example `No workspace matching "legal-contracts" was found` (also in `error.details.workspaceSlug`). A key restricted to specific workspaces cannot create one: such an upload answers `403`.

**Where `workspace` is accepted:** request bodies, query strings and form fields of uploads, URL ingest, direct upload sessions, upload estimates, search GET/POST and each batch query, chat and chat stream, suggest, document and notification listing filters, run previews, and the MCP tools. Aggregate search (`POST /v1/search/aggregate`) takes a `workspaces` array of the same values. REST paths `/v1/workspaces/:workspace/...` accept a UUID, slug, former slug or `default` (a name in a path is matched by its slug). [Compatible search](https://docslurp.io/docs/search-integrations) index/collection names (`/compat/meilisearch/indexes/default/search`) and `model: "workspace:default"` for [OpenAI-compatible chat](https://docslurp.io/docs/chat) (`GET /v1/models` lists `workspace:<uuid>` IDs; `workspace:<slug>` also works) use the same resolver. Responses keep reporting the resolved `workspaceId` (a UUID) and the workspace record with its `slug`.

**Which organization:** API keys use their own organization. Dashboard sessions use the personal organization for the default workspace unless the request passes `orgId` (body field, or `?orgId=` on query-string and `/v1/workspaces/default/...` requests); with `orgId`, names and slugs only match workspaces in that organization.

**Precedence (first match wins):**

- SDK: a per-call `workspace`, then `createDocSlurpClient({ workspace })`, then `DOCSLURP_WORKSPACE` (server runtimes only; browser builds never read environment variables), then `"default"` (exported as `DEFAULT_WORKSPACE`).
- CLI: `--workspace`, then `DOCSLURP_WORKSPACE`, then `default`.

So `client.search({ q: "question" })`, `client.getWorkspaceState()` and `docslurp search` work with no workspace configuration.

**New workspaces:** besides naming one that does not exist yet, an upload creates a workspace when it omits `workspace` and sends `newWorkspace: true` (multipart `newWorkspace=true`, CLI `--new-workspace`, SDK `newWorkspace`) or a `templateKey` (CLI `--template`); that workspace titles itself from the uploaded content. The SDK and CLI send no `workspace` in those cases, so a configured client workspace does not swallow the request. An explicit `workspace` (including `default`) wins over `newWorkspace`; a `templateKey` sent with a `workspace` applies only if the upload creates it. The upload response's `workspace` record includes `id` and `slug`.

**Automatic titles:** `POST /v1/workspaces` takes an optional `name`. Omit it, send an empty string or send `"Untitled workspace"` and the workspace is created as "Untitled workspace" and named for you. Titles only move forward through stronger signals: the first upload's filenames (later uploads re-derive the title from all of the workspace's files while it is still filename-based), then content (a stored document summary, else the first heading), then the subject of the first chat question, which is final. Renaming the workspace yourself stops automatic naming. Titles update when the workspace is read, uploaded to or first chatted with; there is no background job.

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
| Upload files | `POST /v1/uploads/direct/sessions`, storage PUTs, then poll the session; `POST /v1/uploads/bulk` is the size-limited HTTP fallback | `upload` (direct storage by default) | `upload` (uses the SDK) |
| Ingest URLs | `POST /v1/uploads/url` | `upload({ urls })` | Use SDK/HTTP |
| Extract (upload, auto-deleted after retention) | `POST /v1/extracts/{bulk,url,direct/sessions}`; `GET`/`DELETE /v1/extracts/:id`, `GET /v1/extracts/:id/download` ([extract.md](extract.md)) | `extract`, `getExtract`, `getExtractDownloadUrl` | `extract`, `extract-status`, `extract-download` |
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
| List document versions | `GET /v1/documents/:id/versions` | `listDocumentVersions` | Use SDK/HTTP |
| Export as a zip | `POST /v1/exports`, poll `GET /v1/exports/:id`, then `GET /v1/exports/:id/download` | Use HTTP | Use HTTP |
| Retention | `PATCH /v1/organizations/:orgId` or `/v1/workspaces/:workspace` with `retainDocumentVersions` | `setRetention` | Use SDK/HTTP |
| Estimate work before starting it | `POST …/estimate` twins of each work-creating route | `updateWorkspaceEstimate`, `reprocessEstimate`, `fullIndexEstimate`, `uploadEstimate`, … | `--estimate` on `upload`, `full-index`, `reprocess` |
| Follow a background job | `GET /v1/jobs/:id`, `GET /v1/jobs/:id/events` (SSE) | `getJob` / `streamJob` | `jobs get` / `jobs watch` |
| List / create organizations | `GET` / `POST /v1/organizations` | `listOrganizations` / `createOrganization` | Use SDK/HTTP |
| Read / update organization (name, slug, retention, `allowChinaProviders`) | `GET` / `PATCH /v1/organizations/:orgId` | `getOrganization` / `updateOrganization` | Use SDK/HTTP |
| Organization details / access | `GET /v1/organizations/:orgId/details` / `access` | `getOrganizationDetails` / `getOrganizationAccess` | Use SDK/HTTP |
| List members | `GET /v1/organizations/:orgId/members` | `listOrganizationMembers` | Use SDK/HTTP |
| Invite / list / revoke invites | `POST` / `GET /v1/organizations/:orgId/invites`, `DELETE …/invites/:inviteId` | `inviteOrganizationMember` / `listOrganizationInvites` / `revokeOrganizationInvite` | Use SDK/HTTP |
| Change / remove membership | `PATCH` / `DELETE /v1/organizations/:orgId/members/:memberUserId` | `updateOrganizationMemberRole` / `removeOrganizationMember` | Use SDK/HTTP |
| Leave organization | `POST /v1/organizations/:orgId/leave` | `leaveOrganization` | Use SDK/HTTP |
| List / revoke organization keys | `GET` / `DELETE /v1/organizations/:orgId/api-keys` | `listOrganizationApiKeys` / `revokeOrganizationApiKeys` | Use SDK/HTTP |

Guides: [document versions and retention](document-versions.md) and [config-change jobs and estimates](config-change-jobs.md).

## Upload completion

A successful storage PUT means the bytes reached storage. It does not mean the
document has been processed. Direct uploads have three milestones:

| Milestone | Evidence | Next step |
| --- | --- | --- |
| Bytes stored | Each storage PUT succeeds | Wait for the session result |
| Ingestion accepted | The session has a non-null `result` containing `run.id` | Follow that run |
| Processing finished | The run reaches `completed` | Read the extracted content or search it |

### Known-size files

1. Create a session with `POST /v1/uploads/direct/sessions`. For each file, send
   `filename`, `mimeType` and the exact `sizeBytes`. Save the returned `sessionId`.
2. Transfer each file using its returned `mode`. For `single`, PUT the bytes to
   `putUrl` with the supplied `headers`. For `multipart`, PUT each byte range to
   its `pendingParts[].url`; the range starts at
   `(partNumber - 1) * partSize` and contains that part's `sizeBytes`.
3. Poll `GET /v1/uploads/direct/sessions/:sessionId?statusOnly=true` until
   `result` is non-null, or the session becomes `failed` or `aborted`.
4. Follow `result.run.id` through the run status or progress endpoints.

The server uses a single PUT below 32 MiB and multipart at or above 32 MiB,
with 8 MiB parts. Use the returned descriptors rather than hard-coding those
values. The reconciler reads storage's part list, checks the part numbers and
sizes, assembles the object, and verifies the stored file. It starts ingestion
after all files in the session are ready. Clients do not need to call
`/files/complete` or `/confirm` for known-size files.

The API checks pending sessions every 15 seconds in bounded batches, with
backoff between attempts. This is not a completion-time guarantee. A Tigris
object notification makes a session eligible for the next check; polling still
works without notifications. A webhook does not replace multipart assembly or
prove that an unknown-size stream has ended.

### Streams without a known size

`client.upload(stream, { filename, mimeType })` handles multipart transfer and
completion. At EOF, it waits for every part PUT to succeed, sends the final byte
count and ordered part manifest, then waits for the accepted ingestion response.
You do not call a completion method yourself when using `upload()`.

For a custom HTTP client:

1. Omit `sizeBytes` when creating the file's session entry.
2. Request signed part URLs from
   `POST /v1/uploads/direct/sessions/:sessionId/files/:fileId/parts/sign` with
   `{ "partNumbers": [1, 2] }`. Upload parts using the returned `partSize` from
   session creation; only the final part may be shorter.
3. After EOF and successful PUTs, send
   `POST /v1/uploads/direct/sessions/:sessionId/files/complete` with
   `{ "fileId": "FILE_ID", "sizeBytes": 12345, "parts": [{ "partNumber": 1, "etag": "STORAGE_ETAG" }] }`.
   Use the actual final byte count and the ETag returned by each PUT.
4. Poll the session for `result`, then follow `result.run.id`.

The server verifies the stored parts. It cannot infer EOF from an idle stream
or from its current byte total. The `/confirm` endpoint remains available as an
explicit fallback, but automatic ingestion does not require it.

### Timeouts, retries and abandoned uploads

Keep the session ID when implementing your own transfer. A polling timeout is
not proof that ingestion failed: check the same session before creating another
upload. Repeated status reads and duplicate notifications reuse that session's
accepted result. A new session is a new upload, not a retry of the old one. Direct sessions do
not support `Idempotency-Key`; that key applies to HTTP bulk and URL ingestion.

Signed URLs expire after 15 minutes. A session GET without `statusOnly=true`
returns fresh transfer URLs for pending files; use `statusOnly=true` when you only
need status. Treat signed URLs as credentials. Send your DocSlurp bearer key to
the API, never to storage.

`failed` and `aborted` sessions are terminal. Read the session's `error` field;
a retry message on a pending session is not a terminal failure. To abandon a
session, POST to its `/abort` endpoint. Aborting after ingestion has started
returns 409; follow the run instead. Unfinished transfers expire after 24 hours
and are marked `aborted`; sessions already starting ingestion continue recovery.

The SDK attempts to abort its session on transfer or acceptance-wait errors.
That cleanup can lose a race with ingestion, so an SDK timeout alone does not
prove that no run was created. Use the low-level session methods when you need
to retain a session ID and control recovery yourself.

`POST /v1/uploads/bulk` remains available for multipart/form-data through the
API, with a default 25 MB limit (`MAX_MULTIPART_UPLOAD_BYTES`). This is a separate
transport from object-storage multipart. In the SDK, select it with
`directUpload: false`.

Self-hosters: see [automatic completion and Tigris setup](self-host/operations.md#automatic-upload-completion-and-tigris-notifications)
for the reconciler, Token authentication, bucket filter and deployment order.

## API changes

- **2026-10-21, breaking.** One `workspace` request field replaces `workspaceId` and `workspaceName` everywhere a request targets a workspace (bodies, query strings, multipart fields, MCP tool arguments; aggregate search takes `workspaces` instead of `workspaceIds`). It takes a UUID, slug, former slug or name, matched by slug. Uploads into a name that matches nothing create that workspace; other requests answer `404 workspace_not_found` naming the slug. The SDK option and inputs, embed and widget attribute (`workspace`), CLI `--workspace` (`--workspace-name` is removed) and the `DOCSLURP_WORKSPACE` environment variable follow. Responses still carry `workspaceId`. See [Workspaces](#workspaces).

- **2026-10-20.** New workspaces default to `summaries: true`. Create/update bodies and workspace responses expose this document-summary option. It adds a one-time processing cost to improve document search and workspace overviews. See [document summaries, costs and limits](document-summaries.md).
- **2026-10-14, non-breaking.** Responses of work-creating routes (workspace `PATCH`, search-settings `PATCH`, uploads, reprocess, full-index, graph rebuild) gain an optional `job`. New `POST …/estimate` routes, `GET /v1/jobs/:id` and `GET /v1/jobs/:id/events`. Workspaces gain `autoConfirmReindex` and `retainDocumentVersions`; organizations gain `retainDocumentVersions`. Uploads accept `path`. Config `PATCH` requests that succeeded before still succeed and never return `409`; a `reindex-required` change now queues a re-index. See [config-change jobs](config-change-jobs.md).

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

Omit the first argument (or pass `undefined` when you also pass options) to use the client's workspace: the `workspace` client option, then `DOCSLURP_WORKSPACE`, then `default`. For another workspace, pass a slug such as `"legal-contracts"` or a UUID. `recentWindowHours` is an integer from 1 to 720 and defaults to 24; HTTP enforces the same range. Bearer requests need a server key with the `ingest`, `search`, `artifacts` or `workspaces:manage` scope.

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
| `images` | Embedded images per page, pages with images, and `scannedLookingPages` (images and almost no text layer: scans and photos of text). Pages of failed files are excluded: a crash during extraction says nothing about page triage. |
| `extraction` | Pages read with vision versus the native text layer, and pages vision skipped: not selected by page triage, failed, or stopped by the run cost cap (reports on files processed before 2026-10-29 can also show pages past the former per-file vision page limit). |
| `searchability` | Searchable pages (a page with chunks), unsearchable pages grouped by reason, pages still processing, and up to 20 example pages. |
| `failures` | Files that failed: `total`, counts `byReason` and up to 20 `examples`, each with the failed `stage`, a classified `reason` (`ocr_unavailable`, `extractor_failed`, `unsupported_format`, `unreadable_file`, `timeout`, `provider_failed`, `policy_blocked`, `cancelled`, `unknown`), reviewed `message`, whether `retryable` and a short sanitized `detail` (first line of the recorded error with paths, URLs, e-mail addresses and credential-looking values removed). The raw error stays in the database and logs. |
| `stages`, `languages`, `media`, `tables` | Failed and skipped stages, detected languages, audio and video files (and minutes), and table-heavy pages. |
| `performance` | Cost (`costCents`, the same figure as the run records: billed spend plus the flagged unbilled compute estimate, `computeEstimated`), `billedCostCents` (billed spend only, what the run cost cap is enforced against), pages per minute, minutes per 100 pages and pages per $1, from run wall time including queueing. |
| `coverage` | Per-page text and image facts exist for files processed from 2026-10-14; older files report them as not recorded. |
| `config` | The pipeline settings that shaped what was observed (vision, processing quality, OCR language, tables, embeddings, chunking, video, cost cap, privacy mode), each with why it matters here. |
| `recommendations` | Deterministic rules with the evidence, the expected effect, `cost.centsPer100Pages` for future uploads, `cost.reprocessCents` for re-running the affected files, and the pipeline `patch` an editor can apply. |

Video frame reading defaults to enabled for new workspaces and configurations that omit `mediaVideo.enabled`. Explicit `false` disables frame reading even for silent video, and bills the file as audio (see below). Every organization gets the same video limits (up to 2 hours per file); only credits and budgets bound what a video costs. This workspace policy still requires the worker's `MEDIA_VIDEO_ENABLED=true`, remote-media support, privacy permission and available budget. The report shows workspace policy, not proof that frames were processed. Changing the default does not reprocess existing uploads; reprocessing remains explicit.

Recommendation rules: read every page with vision when scanned-looking pages have no searchable text or vision stopped at the former per-file page limit (`turn-on-vision` when vision is off, `vision-all-pages` otherwise; the patch sets `quality: "good"`); make pages that Fast kept as page images searchable (`fast-kept-as-image`, reason `kept-as-image`; the patch sets `quality: "auto"`, and the effect names Good as the other choice, or only a reprocess once the workspace has left Fast); retry pages where vision failed; raise the run cost cap when it stopped vision; keep tables when table-heavy pages were flattened (`preserveTables`); turn on embeddings; read video frames (`mediaVideo.enabled`); flag audio or video without a transcript (a platform setting); reprocess pages that have text but no chunks; retry failed files; and suggest a multilingual embedding profile for non-English files. A failed file never produces a vision recommendation; `retry-failed-files` names the cause and says when retrying will fail the same way (for example `ocr_unavailable`). Singular and plural wording follows the counts. Every recommendation id is classified in `INGEST_RECOMMENDATION_CATALOG`: those with a `patch` (`turn-on-vision`, `vision-all-pages`, `fast-kept-as-image`, `preserve-tables`, `turn-on-embeddings`, `turn-on-video`) can be prepared in the DocSlurp app's chat with `proposeWorkspaceSettings` as `{changes: {pipeline: <patch>}}` (app-only; API callers apply a patch with `POST /v1/workspaces/:id/ingest-report/apply`); the rest are reprocess-only, informational or outside the proposal allowlist, and a test enforces that. Vision cost uses this workspace's observed vision spend per page when at least three pages were read, otherwise the model's catalog price.

In the dashboard, ask "how did my files process?", "why can't it find page 4?" or type `/status` in chat, or use the Report button in the composer. Only the signed-in dashboard chat answers this way (`CHAT_INGEST_REPORT_NATURAL=false` keeps just `/status`); `/v1/chat`, MCP `chat` and `/v1/chat/completions` treat these as ordinary questions, so API clients read the endpoint above. Workspace editors can apply a recommendation (`POST /v1/workspaces/:workspace/ingest-report/apply` with `recommendationId` and the report's `runId`/`documentIds`; API keys need a server key with `workspaces:manage`) after a confirmation that shows the cost; the server recomputes the report and merges the recommendation's own patch onto the stored pipeline through the regular workspace update and audit log, so a request cannot carry arbitrary settings. `POST …/ingest-report/reprocess` re-runs up to 100 affected files with the workspace's current settings (server keys need `ingest`). The report's `permissions.canEdit` tells you whether the caller may do either.

## Keep workspace content current

A server key with the `ingest` scope can keep the documents it uploads current without a dashboard session. Use it from CI to reindex a docs site, drop pages you removed, or pick up extraction improvements.

| Operation | HTTP endpoint | SDK |
| --- | --- | --- |
| Reprocess a run's documents as new versions | `POST /v1/runs/:runId/reprocess` with optional `stageFrom` or `stages` | `reprocessRun` |
| Price it first | `POST /v1/runs/:runId/reprocess/estimate` | `reprocessEstimate` |
| Delete a document | `DELETE /v1/documents/:docId` | `deleteDocument` |
| Replace a document's tags | `PUT /v1/documents/:docId/tags` with `{ tags }` | `setDocumentTags` |
| Reprocess, retag or delete many documents | `POST /v1/documents/bulk` with `{ action, documentIds, tags? }` | `bulkDocuments` |
| Act on an ingest report recommendation | `POST /v1/workspaces/:workspace/ingest-report/reprocess` (`ingest`) or `…/apply` (`workspaces:manage`) | `reprocessIngestRecommendation` / `applyIngestRecommendation` |

- Browser keys never get these, whatever their scopes.
- A key never exceeds its user's role: the user must be able to edit the workspace. Keys restricted to specific workspaces reach only documents and runs in those workspaces. A request naming anything outside them answers 404 before any change, including bulk requests where only one document is out of scope.
- The bulk `export-artifacts` action is a read and needs `artifacts` instead.
- Reprocessing and recommendations spend credits; budgets and spend caps apply as for uploads. The audit log records the key that made each change.
- Uploading identical bytes again reuses the earlier extraction, so a re-upload doesn't pick up extraction improvements. Reprocess the run (`stageFrom: "extract-markdown"` re-extracts and reindexes) instead.

```ts
const client = createDocSlurpClient({ apiKey: process.env.DOCSLURP_API_KEY });
// Re-extract a docs ingestion with the current worker.
const { job } = await client.reprocessRun(runId, { stageFrom: "extract-markdown" });
// Drop documents for pages the site no longer has.
await client.bulkDocuments({ action: "delete", documentIds: removedIds });
```

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
  --data '{"name":"Organization automation","orgId":"org-123","keyType":"server","scopes":["organizations:read","organizations:manage"],"rateLimitPpd":10000}'
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
      "rateLimitRpm": null,
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
| Per key or signed-in user | `<table>-<category>` | The per-category limit of the organization's table (`free-…` for starter organizations, `paid-…` once it has bought credits), capped by the key's requests per minute if it has one. |
| Custom key windows | `key-requests-<window>` | All endpoints together, e.g. 1,000 requests per hour. |
| Spend windows | `key-spend-<window>` (`X-DocSlurp-Spend`) | Credits the key's work was charged (pages, storage, searches, chat answers) in a rolling window. Once reached, uploads, search and chat return 429; reads keep working. If the spend can't be read (a database problem), those requests get a 503 `unavailable` with `Retry-After` instead of going through unchecked. |
| Daily pages | — | Uploads stop with `daily_page_limit` once the key's pages-per-day cap is used. |
| Per visitor of a browser key | `client-visitor-<category>` | Browser (publishable) keys only: each visitor address gets a share of the key's budget per minute, by default 20 `chat-ai` and 120 `search`, so one visitor cannot use up a widget's whole allowance. A visitor is an IP address (an IPv6 /64), so people behind one office or NAT address share it; requests with no known address share one bucket. |
| Chat in progress | `chat-concurrency` | AI chat turns still running or streaming at once. Browser keys: 16 per key and 3 per visitor address. Server keys: no default cap, so backend batch jobs aren't throttled; set one with a `concurrent` rule. A turn frees its slot when its response ends, the client disconnects, or the turn deadline plus 15 seconds passes, whichever is first. An MCP `chat` tool call counts as `chat-ai` and takes a slot too. |

Custom request and spend windows are set per key on the API keys page (under "Permissions and limits", then "Advanced rate limits") or with `rateLimits` on `POST`/`PATCH /v1/api-keys`, e.g. `[{ "metric": "requests", "limit": 1000, "windowSeconds": 3600 }, { "metric": "spend", "limit": 500, "windowSeconds": 86400 }, { "metric": "concurrent", "limit": 32, "windowSeconds": 1 }]` (spend in US cents; `concurrent` caps chat turns in progress, per server process, and ignores `windowSeconds`; at most five rules, one per metric and window, windows up to 31 days). Spend is recorded when the work it pays for finishes and is refreshed every few seconds, so a request already running can carry a key slightly past its spend limit.

Every account gets the same table, whatever its billing state: buying credits does not change it. A key's `rateLimitRpm` is an optional cap: omitted or `null` (the default) means the table's limits apply, and a number lowers every category to at most that many requests a minute. It never raises the limits. Set it on create, change it with `PATCH /v1/api-keys/:id`, and send `"rateLimitRpm": null` to remove it. Default per-minute limits on docslurp.io:

| Category | Per account | Per client IP |
| --- | ---: | ---: |
| `upload` | 120 | 90 |
| `search` | 600 | 240 |
| `chat-ai` | 120 | 90 |
| `read` | 1,500 | 1,200 |
| `write` | 600 | 300 |
| `webhook` | 600 | 600 |

Per-IP limits count an IPv6 client as its /64. These are abuse protection, not a spending control: credits and budgets bound what you spend. No feature, model, media type, setting or rate limit depends on whether an organization has bought credits. Self-hosted deployments use their own, higher table, and operators can set `API_RATE_LIMIT_<TABLE>_<CATEGORY>_MAX` (for example `API_RATE_LIMIT_ACCOUNT_SEARCH_MAX`) or `API_RATE_LIMIT_<CATEGORY>_MAX`.

Every 429 has `Retry-After` and the [error envelope](https://docslurp.io/docs/search-reference#errors) with `error.code` set to `rate_limited` (with `details.category` and `details.policy`, which names the table: `account-*`, `ip-*` or `self-hosted-*`), `spend_limit_exceeded`, `daily_page_limit` or `ip_temporarily_blocked`. On docslurp.io the details also carry `links` and the response a `Link` header (`rel="payment"` for billing, `rel="help"` for these docs), and the message says where to go:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Please wait a moment before trying again. Rate limits: https://docslurp.io/docs/http#rate-limits-and-headers",
    "details": {
      "category": "chat-ai",
      "policy": "account-chat-ai",
      "retryAfterSeconds": 12,
      "links": {
        "billing": "https://docslurp.io/app/billing",
        "docs": "https://docslurp.io/docs/http#rate-limits-and-headers"
      }
    },
    "requestId": "req_123"
  }
}
```

`spend_limit_exceeded` and `daily_page_limit` are the key's own limits, so their `links.apiKeys` points at the API keys page. IP-level limits only link these docs. An IP is blocked for a while after an extreme burst or after repeatedly presenting invalid API keys, so stop and fix credentials rather than retrying 401s in a loop.

### Processing quality

`pipeline.quality` is the one extraction setting: set it on the workspace (`PATCH /v1/workspaces/:workspace` with `{ "pipeline": { "quality": "fast" } }`) or per upload in the request's `pipeline` overrides (SDK `quality`, CLI `--quality`, MCP `upload`/`extract` `quality`). Indexing mode (`pipeline.indexingMode`, full or on demand) is a separate, advanced setting.

| Quality | What it does | Price per 1,000 pages |
| --- | --- | --- |
| `fast` | Reads the text layer only, never OCR or a vision model. Request or workspace extraction settings that could read a page (OCR options, `forceOcr`, model or OCR extractors in `documentExtraction.order`, artifact-graph `enrich`) are removed for the run and logged; Kreuzberg runs with OCR disabled. A page without a usable text layer keeps its stored page image, and its Markdown is `![Page N: scanned page image, no text layer](images/page-NNNN.png)` (the export's page-image path; the extension follows the stored image, so a JPEG upload links `images/page-0001.jpg`). Markdown-only exports include these page images. Renders are capped at `WORKER_FAST_PAGE_IMAGE_MAX_PER_DOCUMENT` (default 1,000) per document and `WORKER_FAST_PAGE_IMAGE_MAX_PER_RUN` (default 10,000) per run; pages past a cap stay unread with no reference (previews still render them on demand). On-demand indexing (search-triggered, index-all, map mode) follows the same rule: text layer only. Such a page has no text, adds no chunks and is not searchable; the ingest report lists it as `kept-as-image`. | $0.05 (every page bills Fast) |
| `auto` (default) | Reads each page the cheapest faithful way: the text layer for born-digital pages, a vision model for scans and complex layouts. | $0.05 to $2.50, depending on the mix |
| `good` | A vision model reads every page, for the most faithful tables, figures and layout. Good turns `visionFallback` on. A run cost cap (`maxCostCents`) can still stop vision early; pages it did not read bill as in Auto. | $2.50 (every page a vision model reads bills Rich, plus the extra-output-token rule) |

`QUALITY_MODES` in `@docslurp/shared` holds these labels, descriptions and prices (from `PRICE_CARD`), and `estimateIngest` takes the same three ids as its `profile`. The internal parser playbooks are not a setting: requests and stored pipelines that still send the retired `parserPlaybook` or `vision.forceAllPages` are accepted and mapped (`fast` to fast, `forceAllPages: true` to good, and every other playbook, `review-grade` and `agentic` included, to auto: those playbooks never read every page). Run previews (`POST /v1/runs/preview`) return one option per quality.

### Credits and budgets

DocSlurp is prepaid: there are no plans or subscriptions. 1 credit = 1 US cent. Buy a credit pack ($25, $50 or $100) or any amount from $10 to $10,000 on the billing page; credits do not expire while the account exists. Every new account starts with 250 free credits, no card needed. You pay per unit:

| Unit | Credits |
| --- | --- |
| Fast page (text-layer PDF, Office, HTML, Markdown, EPUB, text) | 5 per 1,000 pages |
| Rich page (scanned page, image, or a page read by a vision model) | 250 per 1,000 pages; a page whose model output runs past 1,000 tokens counts once more per extra 1,000 tokens. In Fast quality nothing is read, so scans and images bill as Fast pages |
| Audio | 1 Rich page per minute |
| Video (frames read) | 3 Rich pages per minute |
| Storage (originals, page images, indexes) | 25 per GB-month, accrued daily |
| Search | 10 per 1,000 searches; a search that uses LLM query strategies (HyDE, rewrite, stepback, compression, self-query) counts as 10 |
| Chat answer | 1 (standard models), 7.5 (advanced) or 50 (premium) per answer; an answer above 100,000 total tokens counts once more per extra 100,000 |
| Document summary (`summarize`) | 0.5 per document |
| Structured fields (`outputSchema`) | 1 per started 10 pages per document |
| Knowledge graph (`graphRag`, community summaries included) | 1.5 per started 10 pages per document |
| Propositions (`propositionIndex`, provisional) | 1 per started 10 pages per document |

Optional features are charged once per document each time their stage actually runs (a reprocess that skips the stage pays nothing for it); an audio or video file counts its Rich pages (minutes) as pages: an audio minute is 1 Rich page, a video minute whose frames are read is 3, and a video read from its audio track alone (`mediaVideo.enabled: false`, which an upload can set for itself through its `pipeline` overrides) is billed as audio. `POST /v1/uploads/estimate` prices audio and video before any bytes are sent: pass each file's `durationSeconds` (and `type`), and read `media` for the credits, the cheaper audio-track-only option (`media.lighter.pipeline`) and whether durations were guessed from file sizes. Contextual chunk preambles are part of the page price. A file pays only for its pages and the features it uses: there is no per-file minimum. Reprocessing pays again only for the share of stages that run, and a re-index that only rebuilds indexes pays nothing per page. Searches inside a chat answer are part of the answer. An answer that never reaches you because of an error on our side is refunded. `GET /v1/billing/prices` returns the price card, packs, top-up limits and the tier of each chat model; it needs no authentication.

Organizations that have bought credits (funded) run up to 250 workers at once; starter organizations run up to 50. Rate limits are the same for both. Larger ceilings and dedicated (private) machines are sold by sales.

Auto top-up is off by default. Turn it on from the billing page with a threshold in credits, a refill amount (a pack or a custom amount of at least $10) and a required monthly cap; every charge emails a receipt and appears in the credit ledger, and it pauses after two failed charges. `GET /v1/billing/overview` returns the balance, funding, worker ceiling, auto top-up settings, this month's spend by category and a monthly forecast built from what you store and the last 30 days of searches, chat answers and pages.

Work that spends credits (uploads, runs and reprocessing, search, chat, chat completions and the MCP chat and upload tools) is refused with HTTP 402 when the organization can't pay for it; a run that has started finishes even if the balance goes slightly negative. Optional AI search strategies are skipped instead of failing the search.

| `error.code` | Meaning | `details.links` |
| --- | --- | --- |
| `credit_exhausted`, `minimum_credit_required`, `payment_required` | Out of credits. | `billing`, `buyCredits`, `autoTopUp` (only while auto top-up is off), `docs` |
| `workspace_budget_paused`, `org_budget_paused` | A monthly budget cap was reached and AI processing is paused. | `billing`, `docs` |
| `plan_not_entitled` | The workspace has no billing organization. | `billing`, `docs` |

On docslurp.io the message names the page to visit (for example "Your organization is out of credits. Buy credits at https://docslurp.io/app/billing#bl-topup, or turn on auto top-up at https://docslurp.io/app/billing#bl-auto-topup."), and the response has the same `Link` header as a 429. Protocol surfaces keep their shapes and add the links too: MCP tool errors and the flat `{error, code}` body carry a top-level `links`, and the OpenAI-compatible API puts them on `error.links` with `error.code` set to the DocSlurp code. In the SDK, `DocSlurpErrorLinks` holds `billing`, `buyCredits`, `autoTopUp`, `apiKeys` and `docs`. Self-hosted servers have no billing, so they send no links.

## Authentication and integration boundaries

- Create and revoke keys on the [API keys](https://docslurp.io/app/api-keys) page, or with the session key API above. `ingest` allows uploads and URL ingestion and, on server keys, [keeping that content current](#keep-workspace-content-current) (reprocess, retag, delete). `search` allows search, `chat` generated answers, and `artifacts` document reads. Run progress accepts any of these scopes. Workspace state also requires a server key.
- Organization scopes are opt-in. `organizations:manage` also allows organization reads, but doesn't bypass role, organization, personal-membership or last-owner checks.
- Send `Authorization: Bearer <key>`. Keep server keys on the server. Route frontend requests through your own authenticated backend and enforce your application's access rules there.
- Allowed websites restrict where a browser key works. They don't make a server key safe to use in a browser.
- Stored files never leave private storage directly. Every `url` in document, artifact and export responses is a DocSlurp file URL (`/v1/files/…`) that streams through an authenticated proxy. It works only with the same API key that received it (send the same `Authorization` header), expires within about 75 minutes, and stops working when the key is revoked or loses access to the document. To show page images to your own users, stream them through your backend. Byte ranges (`Range`) are supported.
- `formatSearchContext` formats search results as evidence for any LLM. Keep document text separate from your instructions, and keep the structured citations.
- The Node SDK and CLI need Node.js 20+ and are ESM. From other languages, use HTTP; there is no Python SDK.

## Document tags

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

Document listing and search accept comma-separated `tags`; matching any supplied tag is sufficient. Chat accepts an array in `filters.tags`. `PUT /v1/documents/{docId}/tags` and `POST /v1/documents/bulk` (`apply-tags`/`remove-tags`) edit labels with workspace edit access, from a session or a server key with `ingest`. Tag changes take effect without re-ingestion.

## Export documents as a zip

Export one document or a workspace's current documents as an organized zip. The worker builds the archive in the background and stages it in object storage; the API never holds it in memory.

```bash
curl -X POST "$DOCSLURP_URL/v1/exports" -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" -d '{"workspaceId":"default","content":"markdown"}'
# 202 { "export": { "id": "exp_…", "status": "queued", "notifyEmail": false, "expiresAt": "…" } }
curl "$DOCSLURP_URL/v1/exports/exp_…" -H "Authorization: Bearer $KEY"     # status: queued → running → ready
curl -L -o export.zip "$DOCSLURP_URL/v1/exports/exp_…/download" -H "Authorization: Bearer $KEY"
```

Pass `documentId` for one document, or `workspaceId` (UUID, slug or `default`) for a workspace; omit both to export the organization's default workspace. `content` is `markdown` (default) or `all`:

```text
Finance/                      one folder per document (a document export is just its folder)
  Q3 plan/
    Q3 plan.md                extracted Markdown for the whole document
    pages/page-0001.md        the same text page by page (documents with more than one page)
    structured.json           schema fields, when the workspace has a schema
    metadata.json             filename, type, status, page count, version, tags
    original/Q3 plan.pdf      "all" only: the uploaded file
    images/page-0001.png      "all": rendered page images; Markdown-only: pages Fast kept as images
    outputs/html.html         "all" only: readable pipeline outputs (HTML, canonical document, …)
  README.md                   the layout, a document table, and any file that could not be included
```

Workspace exports hold current versions only (no superseded, archived or purged documents), up to 5,000 documents; a document still processing contributes its `metadata.json`. Files the PII policy withholds are never exported, and the README lists them. Deleting or purging a document in an export withdraws the export. Limits:

- **Size:** exports estimated over **3 GB** are refused with `413 payload_too_large`; export Markdown only or one document at a time. The worker also stops adding files at that size and lists the rest in `README.md`.
- **Email:** exports estimated over **250 MB** are emailed to the requester when ready (`notifyEmail: true`), so nobody has to keep a tab open.
- **Lifetime:** every link works for **7 days** from when the export is ready (`expiresAt`). After that `download` answers `404` and the file is deleted. Each `download` call checks the export (requester, workspace access, expiry) and then redirects to a presigned storage link that lasts two minutes, so the zip downloads straight from storage. Call `download` again for a fresh link; resumable downloads (Range) work against the storage link.
- **Limits:** three unfinished exports per user, and 20 exports or 20 GB (estimated) per user per day (`429 rate_limited`). Asking for the same export again within an hour returns the one already in flight or finished. A single document must have finished processing (`409` otherwise).

Sessions and server keys with `artifacts` can export; keys stay within their organization and workspace restrictions. Objects live in the private bucket under `exports/<orgId>/<workspaceId>/<exportId>.zip` with an `Expires` header and `docslurp-expires-at` metadata; the API's maintenance sweep deletes them. A bucket lifecycle rule that expires `exports/` after 8 days is a useful backstop (see [operations](self-host/operations.md#export-cleanup)).

## Primary sponsor

[![17th Street Labs logo](https://docslurp.io/sponsors/17th-street-labs-readme.svg)](https://17thstreetlabs.com)

[17th Street Labs](https://17thstreetlabs.com) is DocSlurp's primary sponsor.
