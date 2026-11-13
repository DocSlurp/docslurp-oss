# HTTP API

Use the HTTP API to upload documents from any language, follow their processing, and retrieve passages that cite the document and page they came from. Requests use HTTPS under `https://docslurp.io/v1`, authenticated with `Authorization: Bearer <key>`. Most requests use JSON; file uploads use multipart form data or signed storage PUTs.

Use search when you already have an LLM or a search UI. Use chat when you want DocSlurp to write a cited answer.

```bash
curl https://docslurp.io/v1/search \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"q": "How much parental leave do we get?", "limit": 5}'
```

Each result has `text`, a `score` and a `citation` with the `filename`, `pageNumber` and `documentId`. Without a `project`, the request searches your organization's default project. To upload documents first, run [the complete HTTP flow](#the-complete-http-flow) below.

| Prefer a client library? | Use it for |
| --- | --- |
| [Node.js / TypeScript SDK](https://docslurp.io/docs/sdk) | Application code, streams, deadlines and typed responses |
| [CLI](https://docslurp.io/docs/cli) | Exploring documents, shell scripts, CI and agent tooling |
| [Runnable Node examples](https://docslurp.io/docs/sdk#quickstart) | Upload, wait and search, progress with polling fallback, and LLM context |
| [Deferred indexing modes](deferred-indexing.md) | On-demand page map and page images, query spend policies, capability tokens for browser clients |
| [20-second demo](https://docslurp.io/demos/integration.mp4) | Seeing the workflow before you build it |

> **Versions:** SDK examples target `@docslurp/sdk` 0.4.0 or newer. This includes URL uploads through `upload`, batch search, project discovery and upload-session methods. Self-hosted deployments must run an API version with these routes.

## The contract in one minute

- **Project:** the set of documents you search, and where pipeline settings live. Optional: requests without one use your organization's default project. See [Projects](#projects).
- **Run:** one ingestion job, processed in the background. Save its ID before you wait on it. Client timeouts don't cancel it.
- **Document:** an uploaded file, with an ID that citations point to.
- **Search:** passages with scores, citations, availability, usage and a session ID. Retrieval scores are not confidence percentages.
- **Chat:** a generated answer with citations, availability, session IDs, usage and runtime.

A completed run doesn't mean every document in the project is ready, because other runs can still be indexing. Check the response's `availability` as well as run completion.

## API keys

There are two kinds of API key. The prefix tells you, and secret scanners, where a key may safely live:

| Prefix | Type | Where it may live | Can do |
| --- | --- | --- | --- |
| `dslp_priv_` | Server key | Backend secrets, CI, agent configuration | The scopes you grant: `ingest`, one search mode (`search:keyword`, `search:hybrid` or `search:deep`), `chat`, `artifacts`, and opt-in organization/project management |
| `dslp_pub_` | Browser key | Page HTML and browser bundles | One search mode, plus `chat` for an answer widget. Nothing else, ever: only on your allowed websites, and only in the projects you name |

#### Search modes

A key holds one search scope, the most it may search. Modes nest: a `search:deep` key may also search in hybrid or keyword mode.

| Scope | Mode | What a search runs |
| --- | --- | --- |
| `search:keyword` | `keyword` | Keyword matching and the free BM25 rerank. Never embeds the query or calls a model. |
| `search:hybrid` | `hybrid` | Keyword plus the query embedding and vector search, fused. No graph expansion, hosted reranker or LLM step. |
| `search:deep` | `deep` | Everything the project and request turn on: graph and community expansion, the hosted reranker, deferred (on-demand) pages, and LLM query strategies (HyDE, rewriting, decomposition, stepback, self-query, compression, multi-hop). |

Pass `mode` (`keyword`, `hybrid` or `deep`) on a search to run a cheaper mode; omitted, a search runs in the key's mode. A mode above the key's scope runs at the key's mode, and the response's `mode` says which mode ran. Project search settings never lift a search above its mode. Every passage-search endpoint takes any search scope: `/v1/search`, batches, `/v1/search/aggregate`, the Algolia, Meilisearch, Typesense and Pagefind compatible routes, and the MCP `search`, `listProjects`, `suggestQueries` and `getMediaEvidence` tools. Paid web tools and `/v1/capabilities` need `search:deep`. Keys created with the retired `search` scope became `search:deep`.

A search is billed for the mode that ran, and the charge records it. On docslurp.io keyword search is the cheapest and deep the dearest; see [the price list](https://docslurp.io/pricing#rates) and [`GET /v1/billing/prices`](#credits-and-budgets). To cap what a key spends on each mode, give it [per-mode search limits](#rate-limits-and-headers).

Keyword and hybrid searches run with an API key are logged lean, so the cheap tiers stay cheap to run. Their search history expires: keyword searches after 7 days, keeping the query, result count and timing but not each result; hybrid searches after 30 days, results included. Their charges and embedding usage are written in batches every few seconds, one usage record per key and mode, so usage views show a count of searches per record and a key's spend limit sees a search up to a few seconds late. Dashboard searches, chat answers and deep searches keep full history and a record per search. Self-hosters can change this with `SEARCH_API_LEAN_LOGGING`, `SEARCH_API_KEYWORD_HISTORY_RETENTION_DAYS`, `SEARCH_API_HISTORY_RETENTION_DAYS` and `SEARCH_CHARGE_BATCH_MS` (see `.env.example`).

`chat` generates answers on your credits: `/v1/chat`, `/v1/chat/stream`, `/v1/chat/completions` (and its `/v1/models` list) and the MCP `chat` tool need it. A chat answer retrieves as chat always does (including any retrieval overrides it is sent), whatever the key's search mode, and per-mode search limits don't count it: a keyword key with `chat` can still make model calls through chat. Give a key `chat` only where answers are wanted; `/v1/search/aggregate` with `generateAnswer` needs a server key with `chat` and retrieves in the key's mode.

### Never embed a server key

**Page HTML, JavaScript bundles and browser requests expose their credentials.**
Use only a placeholder such as `dslp_pub_YOUR_BROWSER_KEY` in browser/embed setup,
restricted to the intended projects, websites and search/`chat` scopes.
Keep `dslp_priv_` server keys behind a trusted backend. Minification does not
hide them. Origin restrictions are browser controls; arbitrary HTTP clients can
spoof `Origin`.

If a private key reaches a public page, revoke it immediately, remove it from
client assets, and issue and deploy a replacement on the backend. Do not use
overlapping rotation for a leaked key: it remains usable during the overlap.

Web tools (`/v1/web/*` and the MCP and chat-agent web tools) make paid calls to the open web. Server keys use them with `search:deep` (`ingest` for website ingestion). Browser keys never get them, nor `ingest` or `artifacts`: anyone can copy a browser key from your page source. A browser key saved earlier with those scopes retains only the search and `chat` permissions it already held. If none remain, it has no permissions: saving or rotating it never adds a search scope. Edit its scopes explicitly to enable search or chat; default scopes apply only when creating a key.

Controls per key type:

| | Browser key | Server key |
| --- | --- | --- |
| Scopes | One search mode, `chat` | Any, including opt-in organization and project management |
| Projects | Required (`projectIds`) | Optional; empty means every project you can reach in the organization |
| Where it works | Allowed websites (`allowedDomains`) | Anywhere, or only from an IP allowlist (`ipAllowlist`: addresses or CIDR ranges, up to 50) |
| Chat output cap (`maxOutputTokens`) | 500, 1,000 (default) or 2,000 | 500, 1,000, 2,000, 4,000 or none (`null`, the default) |
| Expiry (`expiresAt`) | Optional | Optional, up to 365 days ahead |
| Limits | Per-key limits, plus per-visitor limits and concurrency | Per-key request, spend and `concurrent` rules; no default concurrency cap |

The chat output cap bounds the model's maximum output tokens for every chat answer the key gets (`/v1/chat`, `/v1/chat/completions`, the MCP `chat` tool). A request asking for more (`max_tokens`, `max_completion_tokens`) is lowered to the cap. An expired key stops authenticating, and so does a key used from outside its IP allowlist (403 `api_key_ip_not_allowed`; an address we can't determine is refused too). Each key reports `lastUsedAt` and `lastUsedIp`. MCP and first-party CLI OAuth access tokens also honor their linked server key’s current expiry, IP allowlist and chat output cap; an expired key or a disallowed/unknown address makes the token unauthorized.

Rotate a key with `POST /v1/api-keys/:id/rotate`. With no body the secret is replaced at once. With `{"overlapSeconds": 86400}` (up to 7 days) you get a new key with the same settings (`rotatedFromKeyId` names the old one), and the old key keeps working until the overlap ends (`previous.expiresAt` in the response). Deploy the new secret within that window.

A browser key must name the projects it may use (`projectIds`), because anyone can copy it from your page source. A browser key created before this rule, with no projects, is refused with `client_key_projects_required` until you edit it and choose its projects; it is never widened to every project in the organization. A request from a website the key doesn't allow is refused with `client_key_origin_not_allowed` (on `/v1/chat/completions`, a 403 `permission_error` with that code).

Allowed websites for a browser key are matched like this:

| Entry | Allows |
| --- | --- |
| `docs.example.com` | Exactly that host, over http or https, on any port. Subdomains are not included. |
| `*.example.com` | Any subdomain of example.com, but not example.com itself (add both if you need both). |
| `https://docs.example.com` | That host over https only. |
| `docs.example.com:8443`, `http://localhost:4321` | That port only. |

Entries saved before exact matching (which then covered every subdomain) were migrated to keep that meaning: `example.com` became `example.com` plus `*.example.com`. A shared public suffix from the [Public Suffix List](https://publicsuffix.org/) (private section included), such as `github.io`, `vercel.app`, `pages.dev`, `s3.us-east-1.amazonaws.com`, `co.uk` or `com`, is refused, because every site on it would be allowed: enter your own site, such as `yourname.github.io`. The check uses the browser's `Origin` (or `Referer` when there is no `Origin`), which only a browser enforces. A script outside a browser can send any `Origin`, so keep the key's scopes, projects and spend limits narrow.

A key's type is fixed when you create it; to switch, create a new key. Keys issued before typed prefixes (`dslp_<hex>`) keep working. Create and rotate keys on the [API keys](https://docslurp.io/app/api-keys) page.

### OAuth access tokens (CLI login)

`docslurp login` gets an OAuth access token instead of a key. The first-party CLI client (`docslurp-cli`) is the only client that may request the REST API audience (`resource=<origin>/v1`, RFC 8707): through the browser (authorization code with PKCE and a loopback redirect) or, on headless machines, the device authorization grant (RFC 8628, `POST /oauth/mcp/device_authorization`, verification page `/oauth/mcp/device`). Dynamically registered MCP clients stay bound to `<origin>/v1/mcp`, and their tokens are refused on the REST API.

Access tokens start with `dscli_` and last 15 minutes; refresh tokens (`dsclir_`) rotate on every use, last 30 days, and revoke the whole grant if one is replayed. Send an access token like a key, as `Authorization: Bearer`. It acts as a server key bound to the approving user and organization (removing the membership or revoking the grant stops it at once), and its scopes map onto key scopes:

| OAuth scope | Key scope it grants |
| --- | --- |
| `search:keyword`, `search:hybrid`, `search:deep` | The same scope |
| `chat` | `chat` |
| `read` | `artifacts` |
| `ingest` | `ingest` |
| `web` | `web` |

OAuth requests take one search mode; asking for several grants the widest, which the consent page shows. An authorization without `scope` asks for `search:deep chat read ingest`. Clients that saved the retired `search` scope keep working: it is read as `search:deep`, including when refreshing a grant. A CLI token needs `web` for the paid web tools; `search:deep` alone does not unlock them (MCP-audience grants keep the older rule, where a server identity with `search:deep` may use them). No OAuth scope grants `projects:manage`, `organizations:read` or `organizations:manage`, so a token cannot change project settings or manage an organization. Device approvals grant only the requested search mode and `read` unless the approving user ticks the other requested scopes, and the device flow has no `verification_uri_complete`: the user always types the code. OAuth tokens, MCP-audience ones included, are never platform admins. An expired or revoked OAuth token gets `401` with `WWW-Authenticate: Bearer error="invalid_token"`, on compat routes too. OAuth tokens are never a dashboard session, so they never reach the app-only settings tools, and they cannot mint API keys or `/v1/capabilities` tokens that would outlive them. `GET /v1/whoami` returns the token's user, organization, default project, granted scopes and expiry.

In the SDK, pass `accessToken` as a string or as a provider `({ forceRefresh }) => token`; the client calls it per request and once more with `forceRefresh: true` after a 401. Without `apiKey`, `DOCSLURP_API_KEY` or `accessToken`, the SDK reads `DOCSLURP_TOKEN`. Revoke a login with `docslurp logout` (RFC 7009 `POST /oauth/mcp/revoke`) or from the connected apps list in your account.

The SDK, search adapters and search widget refuse to send a `dslp_priv_` key from a browser. This check is in SDK builds after 0.2.0; the published 0.2.0 does not include it.

## The complete HTTP flow

This script uploads a file, waits for processing, and searches it. You need Bash, `curl`, `jq`, a `handbook.pdf` and a [server key](https://docslurp.io/app/api-keys) with the `ingest` and `search:deep` scopes. The script stops on HTTP errors, on runs that fail or stop, and after a 10-minute polling deadline. It saves the returned IDs before polling and never repeats the upload on timeout.

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

project_id="$(jq -er '.project.id' accepted.json)"
run_id="$(jq -er '.run.id' accepted.json)"
printf 'Project: %s\nRun: %s\n' "$project_id" "$run_id"
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

With no `project`, the upload, search and chat all use your organization's default project. To keep documents in their own project, add `-F 'project=Legal Contracts'` to the upload and `"project": "Legal Contracts"` to search and chat: the first upload creates a project with that name (slug `legal-contracts`), and every later request finds it by name, slug or ID. To create a new project that titles itself from the upload, add `-F 'newProject=true'` instead (see [Projects](#projects)).

Keep server keys out of browser bundles. The base URL is the service **origin**; the routes below already include `/v1`.

### Add a grounded answer

Chat uses the same default project when `project` is omitted:

```bash
jq -n --arg q 'Summarize the parental leave policy and cite your sources.' '{q: $q}' |
  curl --fail-with-body --silent --show-error --max-time 120 \
    "${DOCSLURP_URL:-https://docslurp.io}/v1/chat" \
    -H "Authorization: Bearer $DOCSLURP_API_KEY" \
    -H 'Content-Type: application/json' --data-binary @- > answer.json

jq '{answer, citations, availability, sessionId, usage, runtime}' answer.json
```

To follow up, pass the returned `sessionId` in the next chat request. Search doesn't write an answer; chat does. Search can still incur embedding and AI costs without writing an answer.

## Projects

Projects are optional. Every organization has a **default project**, created on first use, and any request that omits `project` uses it. This section explains every way to refer to a project; other guides link here.

Every request that targets a project takes one field, `project`, whose value can be any of these:

| Value | Example | Notes |
| --- | --- | --- |
| Omitted, or `default` | `default` | Your organization's default project. Any organization member can read and upload to it; it cannot be archived or deleted. |
| Name | `Legal Contracts` | Matched by its slug, so `Legal Contracts`, `legal contracts` and `  Légal—Contracts! ` all name the project whose slug is `legal-contracts`. If no slug matches, a project whose name has that slug matches (oldest first). |
| Slug | `legal-contracts` | Every project has a globally unique, URL-safe slug: the slug of its name when it was created from an upload, otherwise three generated words (e.g. `amber-falcon-ridge`). Slugs are renamable. Prefer them in config and human-facing links. |
| Former slug | `amber-falcon-ridge` | Every slug a project has had keeps resolving to it, like a renamed GitHub repository, and cannot be claimed by another project. |
| UUID | `6f1c2a7e-…` | An absolute reference that never changes. |

Values are matched by slug: the value is lowercased, accents are stripped, every run of characters other than `a-z` and `0-9` becomes one hyphen, and leading and trailing hyphens are dropped (at most 63 characters). A value with no letters or digits left, such as `!!!`, is a `400 invalid_request`. Matching only ever looks at projects you can use: your organization's (the API key's organization, or `orgId` for dashboard sessions), and for a key restricted to specific projects, only those.

**When nothing matches:** uploads (`/v1/uploads/bulk`, `/v1/uploads/url`, direct upload sessions, the MCP `upload` tool) create a project whose display name is the value as you typed it and whose slug is its slug (with a short suffix if another organization already holds that slug). Every other request answers `404 project_not_found` with a message naming the slug it looked for, for example `No project matching "legal-contracts" was found` (also in `error.details.projectSlug`). A key restricted to specific projects cannot create one: such an upload answers `403`.

**Where `project` is accepted:** request bodies, query strings and form fields of uploads, URL ingest, direct upload sessions, upload estimates, search GET/POST and each batch query, chat and chat stream, suggest, document and notification listing filters, run previews, and the MCP tools. Aggregate search (`POST /v1/search/aggregate`) takes a `projects` array of the same values. REST paths `/v1/projects/:project/...` accept a UUID, slug, former slug or `default` (a name in a path is matched by its slug). [Compatible search](https://docslurp.io/docs/search-integrations) index/collection names (`/compat/meilisearch/indexes/default/search`) and `model: "project:default"` for [OpenAI-compatible chat](https://docslurp.io/docs/chat) (`GET /v1/models` lists `project:<uuid>` IDs; `project:<slug>` also works) use the same resolver. Responses keep reporting the resolved `projectId` (a UUID) and the project record with its `slug`.

**Model URIs:** every field that names a model takes an `llm://<provider>/<model>` URI: `model` on `/v1/chat` and `/v1/chat/stream` (`llm://openrouter/anthropic/claude-haiku-5.5`), `docslurp.model` on `/v1/chat/completions` (its `model` stays the project), and the project `pipeline` model fields (`textGeneration`, `structuredExtraction`, `vision.modelUri`, `embedding.modelUri`). Hosted chat and text models also accept the bare OpenRouter id as shorthand. See [Model URIs](https://docslurp.io/docs/models) and [model configuration](model-configuration.md#model-uris-llm).

**Which organization:** API keys use their own organization. Dashboard sessions use the personal organization for the default project unless the request passes `orgId` (body field, or `?orgId=` on query-string and `/v1/projects/default/...` requests); with `orgId`, names and slugs only match projects in that organization.

**Precedence (first match wins):**

- SDK: a per-call `project`, then `createDocSlurpClient({ project })`, then `DOCSLURP_PROJECT` (server runtimes only; browser builds never read environment variables), then `"default"` (exported as `DEFAULT_PROJECT`).
- CLI: `--project`, then `DOCSLURP_PROJECT`, then `default`.

So `client.search({ q: "question" })`, `client.getProjectState()` and `docslurp search` work with no project configuration.

**New projects:** besides naming one that does not exist yet, an upload creates a project when it omits `project` and sends `newProject: true` (multipart `newProject=true`, CLI `--new-project`, SDK `newProject`) or a `templateKey` (CLI `--template`); that project titles itself from the uploaded content. The SDK and CLI send no `project` in those cases, so a configured client project does not swallow the request. An explicit `project` (including `default`) wins over `newProject`; a `templateKey` sent with a `project` applies only if the upload creates it. The upload response's `project` record includes `id` and `slug`.

**Automatic titles:** `POST /v1/projects` takes an optional `name`. Omit it, send an empty string or send `"Untitled project"` and the project is created as "Untitled project" and named for you. Titles only move forward through stronger signals: the first upload's filenames (later uploads re-derive the title from all of the project's files while it is still filename-based), then content (a stored document summary, else the first heading), then the subject of the first chat question, which is final. Renaming the project yourself stops automatic naming. Titles update when the project is read, uploaded to or first chatted with; there is no background job.

**Rename a slug** in the dashboard (the gear next to the project name, then Project) or over HTTP:

- Slugs are 3 to 63 lowercase letters, digits and single hyphens.
- Reserved words such as `default`, `board`, `templates` and `invites` return 400.
- A slug that another project uses, or used before, returns 409.
- API keys need the opt-in `projects:manage` scope, which only server keys can have. The key owner's project role still decides what may change. The same scope covers the other project settings (name, prompt, pipeline, budget).

```bash
curl -X PATCH "$api_url/v1/projects/amber-falcon-ridge" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY" -H 'Content-Type: application/json' \
  --data '{"slug":"legal-contracts"}'
```

**Path responses:** when a `/v1/projects/:project/...` path uses a slug, former slug or `default`, the response carries `X-DocSlurp-Project-Id` (UUID) and `X-DocSlurp-Project-Slug` (current slug), plus `X-DocSlurp-Project-Renamed-From` when a former slug was used, so clients can update stored links. Dashboard URLs are canonical at `/app/projects/<slug>`; UUIDs, former slugs and legacy `/app?projectId=` links redirect there.

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
| List runs (paged: `limit` 1-100, `cursor`; returns `hasMore`, `nextCursor`) | `GET /v1/runs` | `listRunsPage`, `iterateRuns`, `listRuns` (all pages) | `runs` |
| Account activity (SSE) | `GET /v1/runs/activity/stream` | `streamActivity` | Use SDK/HTTP |
| Project state | `GET /v1/projects/:project/state` | `getProjectState` | Use SDK/HTTP |
| Ingest report | `GET /v1/projects/:project/ingest-report` (also MCP `getUploadStatus`, chat `/status`) | `getIngestReport` | Use SDK/HTTP |
| List projects | `GET /v1/projects` | `listProjects()` | Use HTTP |
| Read project | `GET /v1/projects/:project` | `getProject(id)` | Use HTTP |
| Update or rename project | `PATCH /v1/projects/:project` (session or `projects:manage` key) | `updateProject(id, { slug })` | Use HTTP |
| Retrieve passages | `POST /v1/search` or `GET /v1/search` | `search` | `search` |
| Batch retrieval | `POST /v1/search` with `{ queries }` | `search({ queries })` | `search --queries-file` |
| Grounded chat | `POST /v1/chat` | `chat` | `chat` |
| Grounded chat over SSE | `GET /v1/chat/stream` | `chatStream` | Use SDK/HTTP |
| OpenAI-compatible chat | `POST /v1/chat/completions`, `GET /v1/models` ([chat](https://docslurp.io/docs/chat)) | Use an OpenAI SDK | Use HTTP |
| List documents (paged: `limit` 1-250, default 250, `cursor`; always returns `hasMore` and `nextCursor`, so a client that reads only `documents` sees one page and must follow `nextCursor` while `hasMore` is true; a malformed `cursor` is a 400) | `GET /v1/documents` | `listDocumentsPage`, `iterateDocuments`, `listDocuments` (all pages) | Use SDK/HTTP |
| Read a document | `GET /v1/documents/:id` | `getDocument` | Use SDK/HTTP |
| Read structured fields | `GET /v1/documents/:id/structured` | Use HTTP | Use HTTP |
| List document versions | `GET /v1/documents/:id/versions` | `listDocumentVersions` | Use SDK/HTTP |
| Export as a zip | `POST /v1/exports`, poll `GET /v1/exports/:id`, then `GET /v1/exports/:id/download`; `GET /v1/exports` lists yours | Use HTTP | Use HTTP |
| Who am I | `GET /v1/whoami` | Use HTTP | `whoami` |
| Retention | `PATCH /v1/organizations/:orgId` or `/v1/projects/:project` with `retainDocumentVersions` | `setRetention` | Use SDK/HTTP |
| Estimate work before starting it | `POST …/estimate` twins of each work-creating route | `updateProjectEstimate`, `reprocessEstimate`, `fullIndexEstimate`, `uploadEstimate`, … | `--estimate` on `upload`, `full-index`, `reprocess` |
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

### Matching files, partial acceptance and idempotency

`POST /v1/uploads/direct/sessions` takes `files[]`, each with an optional
`clientId` (up to 128 characters) that the server echoes back. The server
sanitizes filenames (`What is RAG?.pdf` is stored as `What is RAG-.pdf`), so
**match the response to your files by `index` (the position in your request) or
`clientId`, never by filename.** Each entry of the response's `files[]` carries
`index` and `clientId`.

One bad file never fails the request. Accepted files get session entries; the
others come back in a top-level `rejected[]` with the same `index` and
`clientId`, plus `filename`, `statusCode` (`415` unsupported type, `413` too
large), `code` and `message`. The request fails (with every file named) only
when nothing can be accepted. A file whose bytes contradict its declared type
(text declared as a PDF, a plain ZIP declared as a DOCX) is refused for that
file when its session is confirmed, under `rejected[]` with `unreadable_source`.

Send an `Idempotency-Key` header (1-255 printable ASCII characters) with the
create request. A repeated create with the same key and body returns the first
session (`200` with `Idempotency-Replayed: true`, fresh signed URLs and the
original `rejected[]`) instead of making a second session. The same key with a
different body is `409`; a second request while the first is still being
processed is `409` too (retry shortly). Keys are scoped to your organization
and user, so another tenant's identical key never matches yours. The SDK and CLI
always send one, and send it again after a timeout or dropped connection.

### Timeouts, retries and abandoned uploads

Keep the session ID when implementing your own transfer. A polling timeout is
not proof that ingestion failed: check the same session before creating another
upload. Repeated status reads and duplicate notifications reuse that session's
accepted result. A new session without the original `Idempotency-Key` is a new
upload, not a retry of the old one.

A part or file that fails mid-transfer resumes: read the session without
`statusOnly=true`. For a multipart file, `pendingParts` lists only the parts
storage does not yet hold at their expected size, with fresh signed URLs, and
`completedParts` the ones it does.

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
`directUpload: false`. A larger request gets `413 payload_too_large` whose
`details` carry `maxBytes` and `directUpload.maxFileBytes`, the per-file limit
for direct sessions (`MAX_UPLOAD_BYTES`, default 500 MB).

Self-hosters: see [automatic completion and Tigris setup](self-host/operations.md#automatic-upload-completion-and-tigris-notifications)
for the reconciler, Token authentication, bucket filter and deployment order.

## API changes

- **2026-11-05, non-breaking.** New projects, including each organization's default project and projects created by uploads, default to `summaries: false`, so ingestion no longer adds a per-document summary charge unless you turn it on. Existing projects keep their saved setting; templates that enable summaries still do. See [document summaries](document-summaries.md).
- **2026-11-03, breaking.** `POST /v1/search/aggregate` defaults `generateAnswer`, `queryRewrite` and `selfQuery` to `false`, like `POST /v1/search`; send them to turn them on. `generateAnswer: true` with an API key now needs a server key with `chat` as well as `search` (403 `forbidden` otherwise; browser keys are refused), counts against chat rate limits and the key's output cap, answers 400 when the projects span more than one organization, and answers `answer: null` with a warning when chat is off in an answered project or no project is accessible. `PATCH /v1/projects/:project/search-settings` and its estimate accept a server key with `projects:manage` (previously signed-in sessions only); browser keys and OAuth tokens are refused. `rankingRules`, `synonyms` and `pinnedResults` updates are limited to 500 entries and 64 KB each. A key's mutation of `/v1/projects/default/...` means the organization default project and answers 404 when the key's project allowlist excludes it. The SDK's `updateSearchSettings` now types its result as the stored settings (`ProjectSearchSettingsResponse`), which is what the route returns. See [aggregate search](search-api.md#aggregate-search).
- **2026-10-29, non-breaking.** Projects gain `allowChinaProviders` (default `true`; `PATCH /v1/projects/:project`), which narrows the organization's setting. With either off, OpenRouter requests carry a `provider.only` allowlist of providers with a known non-China headquarters, unknown-region providers are excluded and unknown scope is restricted. See [provider regions](provider-regions.md).
- **2026-10-21, breaking.** One `project` request field replaces `projectId` and `projectName` everywhere a request targets a project (bodies, query strings, multipart fields, MCP tool arguments; aggregate search takes `projects` instead of `projectIds`). It takes a UUID, slug, former slug or name, matched by slug. Uploads into a name that matches nothing create that project; other requests answer `404 project_not_found` naming the slug. The SDK option and inputs, embed and widget attribute (`project`), CLI `--project` (`--project-name` is removed) and the `DOCSLURP_PROJECT` environment variable follow. Responses still carry `projectId`. See [Projects](#projects).

- **2026-10-20.** New projects default to `summaries: true`. Create/update bodies and project responses expose this document-summary option. It adds a one-time processing cost to improve document search and project overviews. See [document summaries, costs and limits](document-summaries.md).
- **2026-10-14, non-breaking.** Responses of work-creating routes (project `PATCH`, search-settings `PATCH`, uploads, reprocess, full-index, graph rebuild) gain an optional `job`. New `POST …/estimate` routes, `GET /v1/jobs/:id` and `GET /v1/jobs/:id/events`. Projects gain `autoConfirmReindex` and `retainDocumentVersions`; organizations gain `retainDocumentVersions`. Uploads accept `path`. Config `PATCH` requests that succeeded before still succeed and never return `409`; a `reindex-required` change now queues a re-index. See [config-change jobs](config-change-jobs.md).

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

`progress` may be absent, and `temporal` may be `null`. Stage rollups report completed pages, document status counts, duration and usage. Resource totals report elapsed time, CPU time and memory. Run and stage progress can infer completion from lifecycle state, so use [project state](#current-project-state) for current searchable page coverage. A recorded cost of zero doesn't prove there was no API or infrastructure cost.

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

## Current project state

```ts
const state = await client.getProjectState(undefined, {
  recentWindowHours: 24,
  timeoutMs: 30_000,
});
console.log(state.pages.indexed, state.pages.notIndexed);
console.log(state.storage.sourceMb, state.storage.documentsWithUnknownSize);
console.log(state.searches.latencyMs.p95, state.performance.pagesPerMinute);
```

Omit the first argument (or pass `undefined` when you also pass options) to use the client's project: the `project` client option, then `DOCSLURP_PROJECT`, then `default`. For another project, pass a slug such as `"legal-contracts"` or a UUID. `recentWindowHours` is an integer from 1 to 720 and defaults to 24; HTTP enforces the same range. Bearer requests need a server key with the `ingest`, `artifacts` or `projects:manage` scope or any search scope.

```bash
curl --fail-with-body --silent --show-error --max-time 30 \
  "$api_url/v1/projects/default/state?recentWindowHours=24" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
```

The response is a `ProjectState` object, not wrapped in `{ state: ... }`. This **illustrative full response** shows one completed document with two searchable pages, one queued document with an unknown page count, and one unknown source size:

```json
{
  "projectId": "project-123",
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
| `documents`, `runs` | Current persisted project records, grouped by status; counts are not limited to the recent window. |
| `pages.total` | Sum of known current document page counts. `documents.unknownPageCount` counts documents whose total is not yet known. |
| `pages.indexed` | Distinct valid document/page numbers with nonempty page/chunk text in completed documents' current runs. Several chunks on a page count once. This is text-searchable coverage, not vector coverage or extraction progress. |
| `pages.notIndexed` | Known total minus indexed; documents with unknown page totals are not assigned invented missing-page counts. |
| `storage.sourceBytes` / `sourceMb` | Logical source sizes measured while accepting bytes/streams. Unknown legacy/already-stored sizes are counted by `documentsWithUnknownSize`; the sum can be a lower bound. Declared content length is not a measurement. |
| `storage.textBytes` / `textMb` | Current persisted page and chunk text representations, including both when content is represented twice; not physical database/object-store footprint. |
| MB and unknown storage | Decimal MB = bytes / 1,000,000. Vector and artifact physical byte totals are unknown (`null`), never implied to be zero. |
| `searches.total` | All-time sessions scoped to this project, including multi-project sessions. One such session can appear in each involved project's count. |
| Recent searches | `recentCount`, `recentZeroResultCount`, and latency distributions cover the selected window. Invalid/missing latency observations do not become zero samples. |
| Recent ingestion performance | Completed/failed run counts use the selected window. Duration is persisted run wall time from creation to update, including queue time. Throughput uses completed pages and positive completed-run durations; reprocessing contributes work. It is not parser-only runtime. |
| Efficiency | `pagesPerMinute = completedPages × 60,000 / summed durationMs`; `minutesPer100Pages = 100 / pagesPerMinute`. These are observed recent run-efficiency measures, not an ETA for queued work. |
| Distribution fields | `sampleCount` describes available measurements; `p50`, `p95`, and `max` are `null` without samples. A measured zero search latency remains zero. Throughput is `null` when there is no positive page/runtime evidence. |
| `usage` | All-time recorded usage attributed to this project. Cross-project usage is proportionally attributed. Fractional costs/tokens are preserved; this is not a complete bill or an estimate of unrecorded costs. |

Project state is a one-time REST read; there is no project-state stream. Read it again when you need fresh numbers, and use the run progress iterator for live ingestion counts. After one run completes, concurrent runs and unknown page counts can still leave a project partly searchable.

## Ingest report

The ingest report explains how a project's files processed and why a page can or cannot be found. It is built from recorded facts, with no model call, so reading it costs nothing.

```ts
const report = await client.getIngestReport(); // default project
console.log(report.pages.total, report.text.avgBytesPerPage, report.images.avgPerPage);
console.log(report.searchability.byReason); // e.g. [{ reason: "scanned-no-vision", pages: 12 }]
for (const rec of report.recommendations) console.log(rec.severity, rec.title, rec.cost.centsPer100Pages);

// One run, or up to 100 documents:
await client.getIngestReport("legal-contracts", { runId: run.id });
```

```bash
curl --fail-with-body --silent --show-error \
  "$api_url/v1/projects/default/ingest-report?runId=$RUN_ID" \
  -H "Authorization: Bearer $DOCSLURP_API_KEY"
```

Bearer requests need a server key with the `ingest`, `artifacts` or `projects:manage` scope or any search scope. Without `runId` or `documentIds` the report covers the current corpus (documents not superseded by a newer version), newest first, capped at 500 files and 20,000 pages read page by page; `scope.truncated` says when the cap applied.

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

Video frame reading defaults to enabled for new projects and configurations that omit `mediaVideo.enabled`. Explicit `false` disables frame reading even for silent video, and bills the file as audio (see below). Every organization gets the same video limits (up to 2 hours per file); only credits and budgets bound what a video costs. This project policy still requires the worker's `MEDIA_VIDEO_ENABLED=true`, remote-media support, privacy permission and available budget. The report shows project policy, not proof that frames were processed. Changing the default does not reprocess existing uploads; reprocessing remains explicit.

Recommendation rules: read every page with vision when scanned-looking pages have no searchable text or vision stopped at the former per-file page limit (`turn-on-vision` when vision is off, `vision-all-pages` otherwise; the patch sets `quality: "good"`); make pages that Fast kept as page images searchable (`fast-kept-as-image`, reason `kept-as-image`; the patch sets `quality: "auto"`, and the effect names Good as the other choice, or only a reprocess once the project has left Fast); retry pages where vision failed; raise the run cost cap when it stopped vision; keep tables when table-heavy pages were flattened (`preserveTables`); turn on embeddings; read video frames (`mediaVideo.enabled`); export charts and diagrams as data when ingest recorded ones that were not exported (`export-charts`, patch `chartExport: { enabled: true }`); flag audio or video without a transcript (a platform setting); reprocess pages that have text but no chunks; retry failed files; and suggest a multilingual embedding profile for non-English files. A failed file never produces a vision recommendation; `retry-failed-files` names the cause and says when retrying will fail the same way (for example `ocr_unavailable`). Singular and plural wording follows the counts. Every recommendation id is classified in `INGEST_RECOMMENDATION_CATALOG`: those with a `patch` (`turn-on-vision`, `vision-all-pages`, `fast-kept-as-image`, `preserve-tables`, `turn-on-embeddings`, `turn-on-video`, `export-charts`) can be prepared in the DocSlurp app's chat with `proposeProjectSettings` as `{changes: {pipeline: <patch>}}` (app-only; API callers apply a patch with `POST /v1/projects/:id/ingest-report/apply`); the rest are reprocess-only, informational or outside the proposal allowlist, and a test enforces that. Vision cost uses this project's observed vision spend per page when at least three pages were read, otherwise the model's catalog price.

In the dashboard, ask "how did my files process?", "why can't it find page 4?" or type `/status` in chat, or use the Report button in the composer. Only the signed-in dashboard chat answers this way (`CHAT_INGEST_REPORT_NATURAL=false` keeps just `/status`); `/v1/chat`, MCP `chat` and `/v1/chat/completions` treat these as ordinary questions, so API clients read the endpoint above. Project editors can apply a recommendation (`POST /v1/projects/:project/ingest-report/apply` with `recommendationId` and the report's `runId`/`documentIds`; API keys need a server key with `projects:manage`) after a confirmation that shows the cost; the server recomputes the report and merges the recommendation's own patch onto the stored pipeline through the regular project update and audit log, so a request cannot carry arbitrary settings. `POST …/ingest-report/reprocess` re-runs up to 100 affected files with the project's current settings (server keys need `ingest`). The report's `permissions.canEdit` tells you whether the caller may do either.

## Keep project content current

A server key with the `ingest` scope can keep the documents it uploads current without a dashboard session. Use it from CI to reindex a docs site, drop pages you removed, or pick up extraction improvements.

| Operation | HTTP endpoint | SDK |
| --- | --- | --- |
| Reprocess a run's documents as new versions | `POST /v1/runs/:runId/reprocess` with optional `stageFrom` or `stages` | `reprocessRun` |
| Price it first | `POST /v1/runs/:runId/reprocess/estimate` | `reprocessEstimate` |
| Delete a document | `DELETE /v1/documents/:docId` | `deleteDocument` |
| Replace a document's tags | `PUT /v1/documents/:docId/tags` with `{ tags }` | `setDocumentTags` |
| Reprocess, retag or delete many documents | `POST /v1/documents/bulk` with `{ action, documentIds, tags? }` | `bulkDocuments` |
| Act on an ingest report recommendation | `POST /v1/projects/:project/ingest-report/reprocess` (`ingest`) or `…/apply` (`projects:manage`) | `reprocessIngestRecommendation` / `applyIngestRecommendation` |

- Browser keys never get these, whatever their scopes.
- A key never exceeds its user's role: the user must be able to edit the project. Keys restricted to specific projects reach only documents and runs in those projects. A request naming anything outside them answers 404 before any change, including bulk requests where only one document is out of scope.
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

Use these endpoints to read and manage an organization, its members and its API keys. You need current membership in the organization; being shared on a project isn't enough.

- Server keys need an explicit `organizations:read` or `organizations:manage` scope. The ordinary `ingest`, search and `artifacts` scopes don't cover organization endpoints.
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

Signed-in sessions don't need key scopes. Demoting, removing or leaving as the last owner returns 409, and this check is safe against concurrent membership changes. Personal organization memberships can't be added, changed or removed. Removing a member revokes their keys for that organization; projects shared with them directly stay shared.

### One organization per user

For now a user belongs to exactly one organization. Everything tenant-scoped (runs, documents, API keys, webhooks, search) still names its organization explicitly, and organization IDs stay in every API, so several organizations per user can be enabled later without API changes.

- Sign-up creates your personal organization.
- Accepting an organization or project invite into another organization, or creating an organization, works only while your current organization is a personal one with no data (no documents, runs, unrevoked API keys or webhooks, never paid). That personal organization is then deleted and replaced. Otherwise the request returns 409 `user_already_in_org`: leave your current organization first.
- Leaving an organization, or being removed from one, gives you your personal organization back, so you always have exactly one. Access to the organization you left ends at once.
- While the limit is 1, `orgId` on requests made with a session can only name your own organization, and `project_ambiguous` cannot occur.

Self-hosters: the limit is `DOCSLURP_MAX_ORGS_PER_USER` (default and current maximum `1`) and the unique index `org_memberships_one_org_per_user` (migration 0127). Lifting it means dropping that index in a new migration and raising the variable; nothing else in the server assumes one organization per user. Raising the variable while the index exists has no effect, and the API logs `[org-limit]` at startup.

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

Details returns `{ "organization": <organization record>, "access": <access object>, "counts": { "members": 2, "projects": 3 } }`. The member count covers the whole organization. The project count does too for owners and admins, but for member and billing roles it counts only projects they own or that are shared with them.

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

No request body is needed. Success returns `{ "ok": true }` with 200, and the SDK's `leaveOrganization(org_id)` resolves to `undefined`. A key needs `organizations:manage` to leave; any member can leave from a signed-in session. You can't leave a personal organization, or leave as the last owner. Leaving revokes your keys for that organization, so later calls with the same key fail, and makes your personal organization your organization again ([one organization per user](#one-organization-per-user)).

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
| 409 | Duplicate membership or slug, a personal membership, removing, demoting or leaving as the last owner, or `user_already_in_org` (joining or creating a second organization). |
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

Other codes include `user_already_in_org`, `personal_organization`, `membership_exists`, `membership_forbidden`, `membership_not_found`, `organization_not_found`, `organization_forbidden`, `organization_conflict`, `session_required` and `user_not_found`. In the SDK, HTTP failures throw `DocSlurpApiError` with `status`, `code`, `requestId` and the response in `body`; branch on `code`. The SDK never retries organization writes, so keep earlier successful responses when a later call fails.

## Webhooks

A webhook belongs to one organization and receives that organization's run events (`run.completed`, `run.failed`, `document.replaced`; `GET /v1/webhooks/catalog` lists them), whoever started the run. There is no per-project webhook; a project can switch its own events off in its pipeline settings. Webhook routes take a signed-in session, not an API key.

| Operation | Route | Who |
| --- | --- | --- |
| List | `GET /v1/webhooks?orgId=` | Owners and admins of the organization. |
| Create | `POST /v1/webhooks` with `{ url, secret, events?, orgId? }` | Owners and admins. Any other field (such as `projectId`) is a 400. |
| Update, delete, rotate secret, send a test event | `PATCH`, `DELETE /v1/webhooks/:id`, `POST /v1/webhooks/:id/rotate-secret`, `POST /v1/webhooks/:id/test` | Owners and admins of the webhook's organization. |
| Delivery log and replay | `GET /v1/webhooks/deliveries?orgId=&webhookId=`, `POST /v1/webhooks/deliveries/:deliveryId/replay` | Owners and admins of the webhook's organization. |

An omitted `orgId` means your [organization](#one-organization-per-user) (your personal one when you have it). Not a member answers 404, a member who is not an owner or admin 403; a webhook of an organization you do not administer answers 404. A webhook delivers only while the user who created it is still an owner or admin of its organization: demoting or removing that user stops it (another admin can recreate it). Each delivery is signed with `X-DocSlurp-Signature: t=<unix>,id=<delivery id>,v1=<hex HMAC-SHA256 of "<t>.<id>.<body>">` under the webhook secret.

## Make failures recoverable

| What happened | What your application should do |
| --- | --- |
| Upload accepted with warnings | Store the IDs and warnings, and follow the run. |
| Wait deadline passed | Check the stored run later. Don't repeat an upload that may have been accepted. |
| Run failed or stopped | Check the final snapshot and control state. The loop ending doesn't mean success. |
| Progress stream drops or ends | `streamProgress(..., { transport: "auto" })` polls for the rest of its deadline. |
| Raw event stream drops or ends | Fall back to REST polling yourself, within the same overall deadline. |
| Project empty, pending or partly indexed | Wait, show partial results, or decline to answer, as your application requires. |
| Batch contains `ok: false` | Handle each result. Successful queries are still usable. |
| Chat has `finishReason: "length"` | The answer was cut off. Decide whether to ask again. |
| HTTP 401 or 403 | Check the key's validity, type and scopes, your membership, and organization and project access. |
| HTTP 409 | Fix the membership, ownership or uniqueness conflict it names. Retrying won't help. |
| HTTP 429 or a transient server error | Retry a limited number of times where the operation allows it. Avoid repeating billable writes. |

SDK reads (run progress, project state, organization reads and document reads) retry at most twice on HTTP 429, 502, 503 or 504. Retries honor `Retry-After`, wait at most five seconds each, and stay within the request deadline. Uploads of files or blobs with an `idempotencyKey` use the same policy. Network errors aren't retried.

The progress iterator's `auto` transport is separate: it switches to polling instead of retrying the SSE connection. Raw streams, organization writes, URL ingestion, search, batches and chat are never retried automatically, and the CLI doesn't retry failed requests. See [SDK timeouts, cancellation and errors](https://docslurp.io/docs/sdk-reference#timeouts-cancellation-and-errors).

Progress, project state and organization GETs count against the read rate limit, and organization writes against the write limit. Opening a stream counts as one read; heartbeats and server-side refreshes don't add requests. Every poll is another read against the key's allowance, so choose `pollIntervalMs` for your limits and the number of runs you watch. Polling once a second uses about 60 requests a minute per run. Limits vary by deployment, account and key settings, so read the `X-RateLimit-*` and `Retry-After` headers instead of assuming a fixed allowance.

### Rate limits and headers

Limits depend on deployment, account profile and each key's settings, so read them from responses instead of hard-coding them. Every limit that applied to a request is listed in the IETF [`RateLimit-Policy` and `RateLimit`](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) fields (`q` = quota, `w` = window seconds, `r` = remaining, `t` = seconds until reset), and `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` (Unix seconds) describe the tightest one:

```http
RateLimit-Policy: "ip-search";q=240;w=60, "ip-burst";q=200;w=10, "account-search";q=600;w=60, "key-requests-1h";q=1000;w=3600
RateLimit: "ip-search";r=231;t=42, "ip-burst";r=197;t=7, "account-search";r=592;t=42, "key-requests-1h";r=12;t=1630
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 12
X-RateLimit-Reset: 1791504000
X-DocSlurp-Spend: "key-spend-1d";q=500;r=212;w=86400;u=usd-cents
```

| Layer | Policy names | Applies to |
| --- | --- | --- |
| Per client IP | `ip-<category>`, `ip-burst` | Every request. Categories: `upload`, `search`, `chat-ai`, `read`, `write`, `webhook`. |
| Per key or signed-in user | `account-<category>` (`self-hosted-<category>` on self-hosted servers) | The per-category limit of the account table below, the same for every organization, capped by the key's requests per minute if it has one. |
| Custom key windows | `key-requests-<window>` | All endpoints together, e.g. 1,000 requests per hour. |
| Spend windows | `key-spend-<window>` (`X-DocSlurp-Spend`) | Credits the key's work was charged (pages, storage, searches, chat answers) in a rolling window. Once reached, uploads, search and chat return 429; reads keep working. If the spend can't be read (a database problem), those requests get a 503 `unavailable` with `Retry-After` instead of going through unchecked. |
| Searches per mode | — (`Retry-After` only) | Searches in one mode (`keyword`, `hybrid` or `deep`), counted when each starts (a search that then fails still counts), in fixed windows aligned to the clock. Once reached, searches in that mode return 429 `search_limit_exceeded` (`details.mode`, `details.limit`, `details.windowSeconds`, `details.retryAfterSeconds`); a cheaper mode keeps working under its own limit. Each batch item and each project of `/v1/search/aggregate` counts as one search. Cached answers and the searches a chat turn runs don't count. Without a shared Redis limiter each server process counts separately. |
| Daily pages | — | Uploads stop with `daily_page_limit` once the key's pages-per-day cap is used. |
| Per visitor of a browser key | `client-visitor-<category>` | Browser (publishable) keys only: each visitor address gets a share of the key's budget per minute, by default 20 `chat-ai` and 120 `search`, so one visitor cannot use up a widget's whole allowance. A visitor is an IP address (an IPv6 /64), so people behind one office or NAT address share it; requests with no known address share one bucket. |
| Chat in progress | `chat-concurrency` | AI chat turns still running or streaming at once. Browser keys: 16 per key and 3 per visitor address. Server keys: no default cap, so backend batch jobs aren't throttled; set one with a `concurrent` rule. A turn frees its slot when its response ends, the client disconnects, or the turn deadline plus 15 seconds passes, whichever is first. An MCP `chat` tool call counts as `chat-ai` and takes a slot too. |

Custom request and spend windows are set per key on the API keys page (under "Permissions and limits", then "Advanced rate limits") or with `rateLimits` on `POST`/`PATCH /v1/api-keys`, e.g. `[{ "metric": "requests", "limit": 1000, "windowSeconds": 3600 }, { "metric": "spend", "limit": 500, "windowSeconds": 86400 }, { "metric": "concurrent", "limit": 32, "windowSeconds": 1 }]` (spend in US cents; `concurrent` caps chat turns in progress, per server process, and ignores `windowSeconds`; at most five rules, one per metric and window, windows up to 31 days). Spend is recorded when the work it pays for finishes and is refreshed every few seconds, so a request already running can carry a key slightly past its spend limit.

Per-mode search limits use the `searches` metric with a `mode`, e.g. `[{ "metric": "searches", "mode": "deep", "limit": 1000, "windowSeconds": 86400 }, { "metric": "searches", "mode": "keyword", "limit": 100000, "windowSeconds": 86400 }]` for 1,000 deep and 100,000 keyword searches a day. A key takes up to 8 limits, one per metric, mode and window.

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

Every 429 has `Retry-After` and the [error envelope](https://docslurp.io/docs/search-reference#errors) with `error.code` set to `rate_limited` (with `details.category` and `details.policy`, which names the table: `account-*`, `ip-*` or `self-hosted-*`), `spend_limit_exceeded`, `search_limit_exceeded`, `daily_page_limit` or `ip_temporarily_blocked`. On docslurp.io the details also carry `links` and the response a `Link` header (`rel="payment"` for billing, `rel="help"` for these docs), and the message says where to go:

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

`spend_limit_exceeded`, `search_limit_exceeded` and `daily_page_limit` are the key's own limits, so their `links.apiKeys` points at the API keys page. IP-level limits only link these docs. An IP is blocked for a while after an extreme burst or after repeatedly presenting invalid API keys, so stop and fix credentials rather than retrying 401s in a loop.

### Processing quality

`pipeline.quality` is the one extraction setting: set it on the project (`PATCH /v1/projects/:project` with `{ "pipeline": { "quality": "fast" } }`) or per upload in the request's `pipeline` overrides (SDK `quality`, CLI `--quality`, MCP `upload`/`extract` `quality`). Indexing mode (`pipeline.indexingMode`, full or on demand) is a separate, advanced setting.

| Quality | What it does | How pages bill |
| --- | --- | --- |
| `fast` | Reads the text layer only, never OCR or a vision model. Request or project extraction settings that could read a page (OCR options, `forceOcr`, model or OCR extractors in `documentExtraction.order`, artifact-graph `enrich`) are removed for the run and logged; extractor options are validated per extractor and unknown extractors or keys are rejected. A page without a usable text layer keeps its stored page image, and its Markdown is `![Page N: scanned page image, no text layer](images/page-NNNN.png)` (the export's page-image path; the extension follows the stored image, so a JPEG upload links `images/page-0001.jpg`). Markdown-only exports include these page images. Renders are capped at `WORKER_FAST_PAGE_IMAGE_MAX_PER_DOCUMENT` (default 1,000) per document and `WORKER_FAST_PAGE_IMAGE_MAX_PER_RUN` (default 10,000) per run, a budget shared by every worker. A page counts against the budget when it is granted, so a render that then fails still uses its share and is not retried from the budget; pages past a cap, and pages whose render failed, stay unread with no reference (previews still render them on demand). On-demand indexing (search-triggered, index-all, map mode) follows the same rule: text layer only. Such a page has no text, adds no chunks and is not searchable; the ingest report lists it as `kept-as-image`. | Fast pages (a page bills Rich only when a model actually reads it, and Fast cannot be combined with visual indexing mode) |
| `auto` (default) | Reads each page the cheapest faithful way: the text layer for born-digital pages, a vision model for scans and complex layouts. | Fast or Rich per page, by what read it |
| `good` | A vision model reads every page, for the most faithful tables, figures and layout. Good turns `visionFallback` on. A run cost cap (`maxCostCents`) can still stop vision early; pages it did not read bill as in Auto. | Rich for every page a vision model reads |

Current Fast and Rich page prices are on [docslurp.io/pricing](https://docslurp.io/pricing) (and `GET /v1/billing/prices`); they are set by the hosted price card and can change.

`QUALITY_MODES` in `@docslurp/shared` holds these labels and descriptions; prices come from the deployment's pricing provider (`qualityModeInfo`), and `estimateIngest` takes the same three ids as its `profile`. The internal parser playbooks are not a setting: requests and stored pipelines that still send the retired `parserPlaybook` or `vision.forceAllPages` are accepted and mapped (`fast` to fast, `forceAllPages: true` to good, and every other playbook, `review-grade` and `agentic` included, to auto: those playbooks never read every page). Run previews (`POST /v1/runs/preview`) return one option per quality.

### Chart and diagram export

`pipeline.chartExport` re-expresses each detected chart or diagram as text an assistant or a notebook can use. You choose a **tier**, never a model:

| Tier | What runs | Cost |
| --- | --- | --- |
| `off` | Nothing. Charts stay images (and their counts are still recorded). | none |
| `free` | Charts that carry their own data: Office chart parts (DOCX, PPTX, XLSX), embedded Vega, Vega-Lite or Plotly specs, and vector figures with readable axes. No model is called. | no credits |
| `models` | The free steps, plus reading every other chart or diagram with AI. | billed per chart or diagram read (`feature-chart-export`) |

**Defaults depend on where the request comes from.** A project with no `tier` set uses the caller's default, decided by the server from how you authenticated (never from a request field):

- **API, MCP, SDK and CLI calls** (API keys and OAuth tokens): `off`.
- **The DocSlurp app** (signed-in browser sessions, including chat uploads): the deployment's app default. The code
  default is `free`; a deployment may hold it `off`, and docslurp.io currently does, until the free steps' cost and speed
  pass their gate.

The project record reports what a deployment actually runs as `chartExportDefaults`:
`{ app, machine, modelsAvailable, freeAvailable, ceiling }`. Read it instead of assuming either default.

A deployment sets these without a code change. Each value is parsed strictly, and an unknown value is treated as `off`
and logged at startup:

- `DOCSLURP_CHART_EXPORT_API_DEFAULT=off|free` (default `off`) for API callers.
- `DOCSLURP_CHART_EXPORT_APP_DEFAULT=free|off` (default `free`) for the app.
- `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT=on|off` (default `off`). While it is off, a request or project change that asks
  for `free` explicitly is refused, and a stored `free` counts as unset. Each free run boots a parser VM that is not
  billed, so only the deployment's own defaults turn it on for now.

**Precedence**, highest first:

1. The request's own override (below).
2. The project's `pipeline.chartExport.tier`.
3. The default for the caller (above).
4. The deployment ceiling, `DOCSLURP_CHART_EXPORT` (`off`, `free` or `on`), caps all of these: `off` disables chart export everywhere, `free` allows only the free steps, `on` allows `models` too.

The resolved tier is stored on the run (`pipeline.chartExport.tier`), so a retry or resume runs with the same tier.

**Per project:** `PATCH /v1/projects/:project` with `{ "pipeline": { "chartExport": { "tier": "models" } } }` (or `"off"`; a server key with `projects:manage`). An explicit `"free"` is accepted only where the deployment allows it (`chartExportDefaults.freeAvailable`, `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT=on`); elsewhere it is refused with `400 chart_export_tier_unavailable`. Remove the field to go back to the caller's default.

**Replays never raise the tier.** Reprocess, bulk reprocess, reindex and full index run each document at its source run's tier capped at what the project resolves to now: after a project moves from `models` to `off` (or unset), a plain reprocess or a later reindex runs without billed chart reads, and a contributor's plain reprocess is not refused. Only an explicit request override (`chartExport: { "tier": "models" }`) raises it, and it then needs project editor rights (and, for an API key, `pipeline:billed-features`).

**Per request:** upload, URL ingest and direct upload sessions take it in the request's `pipeline` overrides; reprocess and the estimate endpoints take a top-level `chartExport`:

```json
POST /v1/uploads/url
{ "urls": ["https://example.com/q3-earnings.pdf"], "pipeline": { "chartExport": { "tier": "off" } } }

POST /v1/runs/:runId/reprocess
{ "chartExport": { "tier": "models" } }

POST /v1/uploads/estimate
{ "files": [{ "name": "q3-earnings.pdf", "size": 2400000 }], "chartExport": { "tier": "models" } }
```

The upload estimate answers `chartExport: { tier, source, credits }`, where `source` is `request`, `project` or `default`. Only `models` adds credits. The quote in every estimate (`POST /v1/estimate`, the `quote` of `POST /v1/uploads/estimate`, SDK, CLI and MCP `uploadEstimate`) also takes `settings.chartExport` (`off`, `free` or `models`), resolves an omitted one the same way, and shows `models` as a separate `charts` line. Anonymous `POST /v1/estimate` calls are treated as API calls (default `off`). `POST /v1/runs/:runId/reprocess/estimate` prices the same override.

Website ingest (`POST /v1/web/ingest`) takes a top-level `chartExport` too.

Other surfaces: SDK `chartExport: { tier }` on `upload`, `uploadUrls`/`ingestUrls`, `reprocessRun`, `reprocessEstimate` and `uploadEstimate`; CLI `--chart-export off|free|models` on `upload`, `ingest-url`, `reprocess` and their `--estimate`; MCP `chartExport` on `upload`, `extract`, `uploadEstimate` and `reprocessEstimate`.

**Refusals:** a tier the deployment does not offer is refused with `400 chart_export_tier_unavailable` on every surface:
uploads, URL ingest, direct sessions (at creation and again at confirm), extracts, website ingest, reprocess, the
estimates and project changes. The tier is never silently lowered. `models` is offered only where the ceiling is `on`,
and an explicit `free` only where `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT=on`. The access check comes first, so a caller
without access gets its 403 or 404 before any tier refusal.

**A project's tier is a ceiling.** Choosing `models` per request on a project
whose stored tier is `off` or `free` needs project editor rights. An API key additionally needs the
`pipeline:billed-features` scope (or `projects:manage`). Otherwise the request is refused with
`403 chart_export_models_forbidden`. Projects with no tier keep the usual rules.

**Billing for `models`:** a `models` run passes the same spend admission as other model-calling work: credits, budgets,
and the `ingest` scope on a server key. An unknown tier, a `generatorModel` field, or any other unknown key is a
validation error. The model that reads charts is chosen by DocSlurp from managed settings; requests cannot pick one.

**Reindex and full index** of a project with no tier keep each document's own tier, the one its source run stamped, as
reprocess does, capped at what the project resolves to now. They do not take the tier of whoever started them.

**Figures and PDF charts:** PDF charts are read from the PDF's extracted figures, so `figures: false` also turns off
chart export for PDFs.

| Field | Default | Meaning |
| --- | --- | --- |
| `tier` | unset (caller's default) | `off`, `free` or `models`, as above. Moving up a tier recommends a reindex: a billed one for `models`, an optional free one for `free`. Turning it down or off applies to new uploads only. |
| `formats` | `["description", "mermaid"]` | Any of `description` (short prose: type, axes, series, ranges and trend), `mermaid` (rendered in chat; GitHub renders it too), `vega-lite` (v5 JSON with inline data), `matplotlib` (a self-contained Python snippet) and `csv` (RFC 4180; diagrams export an edge list). |
| `diagrams` | `true` | Also export flowcharts, org charts, sequence, state, ER and mind-map diagrams (Mermaid, description and CSV edge list). |

Charts that carry their own data (Office chart parts, embedded Vega/Vega-Lite/Plotly specs, vector graphics with readable axes) are exported without a model call (the `free` tier). With `models`, other charts are read by a model and charged once per chart or diagram the model read (`feature-chart-export`), whatever the outcome: also when the exported data came from the file in the end, when the model found no chart, or when it found a diagram while diagram export is off. The first read bills one generator call per call its formats need (formats derived from one spec share a call; each direct-mode format is its own call). When the spec's first answer needs a repair (it did not validate), or a second try because it was cut off at its length limit, that second call is billed as one more read, its own line in usage; a chart or diagram gets at most one such second read. Estimates and quotes include the expected share of second reads when a spec call runs. A request that failed before the model answered is not charged. Every format is derived from one validated `VisualSpec` (`@docslurp/shared`, `renderVisual`), and a format with no faithful form for a visual (for example a heatmap in Mermaid) is skipped and reported rather than approximated. Labels from documents are escaped for each format, so they cannot add Mermaid directives or click handlers, Python code or spreadsheet formulas. Generated Python is never executed by DocSlurp. Pricing for model-read visuals is on [docslurp.io/pricing](https://docslurp.io/pricing).

Ingest records chart and diagram counts per document whatever the tier. That lets chat suggestions (DocSlurp app) and the ingest report's `export-charts` recommendation point out charts that were not exported as data, and propose `chartExport: { tier: "models" }`.

### Figure extraction

`pipeline.figures` (default `true`) extracts figures from PDFs into the document's image map. Set it to `false` to skip the figure pass for a project's new runs; existing documents keep their figures until they are reprocessed. Turning it back on recommends a reindex, and the figure pass adds sandbox time. The deployment's `DOCSLURP_DOPPLER_IMAGE_EXTRACT` decides whether the pass exists at all. Change it per project (`PATCH /v1/projects/:project` with `{ "pipeline": { "figures": false } }`), per upload in the `pipeline` overrides, or from chat in the DocSlurp app.

### Credits and budgets

DocSlurp is prepaid: there are no plans or subscriptions. 1 credit = 1 US cent. Buy a credit pack ($25, $50 or $100) or any amount from $10 to $10,000 on the billing page; credits do not expire while the account exists. Every new account starts with 100 free credits ($1), no card needed: enough for 10,000 text pages or 400 scanned pages. You pay per unit:

| Unit | What counts |
| --- | --- |
| Fast page | Any page no vision or OCR model read: a text-layer PDF page, Office, HTML, Markdown, EPUB, text, an unread scan or image |
| Rich page | A page a vision or OCR model read: a scanned page the extractor OCR'd, an image read by OCR, a page read by a vision model. In Fast quality nothing is read, so scans and images bill as Fast pages |

The credits per Fast and Rich page are on [docslurp.io/pricing](https://docslurp.io/pricing) and in `GET /v1/billing/prices`.

Audio and video minutes, storage, searches (priced by [search mode](#search-modes)), chat answers, optional document features (summaries, structured fields, knowledge graph, propositions) and web tools are also charged per unit; [docslurp.io/pricing](https://docslurp.io/pricing) and `GET /v1/billing/prices` (no authentication) list the current prices, packs, top-up limits and the tier of each chat model. Optional features are charged when their stage actually runs. `POST /v1/uploads/estimate` estimates an upload before any bytes are sent: pass each file's page count, `durationSeconds` and `type` when known, or the file's profile from the offline profiler (`@docslurp/estimate`), and read `media` for audio and video. An estimate is never a charge: an upload is billed by what the worker measures. A file pays only for what it uses: there is no per-file minimum. A Word, slide, sheet or EPUB file arrives counted as one page; the worker measures its real pages after converting it and bills those. Searches inside a chat answer are part of the answer. An answer that never reaches you because of an error on our side is refunded.

Organizations that have bought credits (funded) run up to 250 workers at once; starter organizations run up to 50. Rate limits are the same for both. Larger ceilings and dedicated (private) machines are sold by sales.

Auto top-up is off by default. Turn it on from the billing page with a threshold in credits, a refill amount (a pack or a custom amount of at least $10) and a required monthly cap; every charge emails a receipt and appears in the credit ledger, and it pauses after two failed charges. `GET /v1/billing/overview` returns the balance, funding, worker ceiling, auto top-up settings, this month's spend by category and a monthly forecast built from what you store and the last 30 days of searches, chat answers and pages.

Work that spends credits (uploads, runs and reprocessing, search, chat, chat completions and the MCP chat and upload tools) is refused with HTTP 402 when the organization can't pay for it; a run that has started finishes even if the balance goes slightly negative. Optional AI search strategies are skipped instead of failing the search.

| `error.code` | Meaning | `details.links` |
| --- | --- | --- |
| `credit_exhausted`, `minimum_credit_required`, `payment_required` | Out of credits. | `billing`, `buyCredits`, `autoTopUp` (only while auto top-up is off), `docs` |
| `project_budget_paused`, `org_budget_paused` | A monthly budget cap was reached and AI processing is paused. | `billing`, `docs` |
| `plan_not_entitled` | The project has no billing organization. | `billing`, `docs` |

On docslurp.io the message names the page to visit (for example "Your organization is out of credits. Buy credits at https://docslurp.io/app/billing#bl-topup, or turn on auto top-up at https://docslurp.io/app/billing#bl-auto-topup."), and the response has the same `Link` header as a 429. Protocol surfaces keep their shapes and add the links too: MCP tool errors and the flat `{error, code}` body carry a top-level `links`, and the OpenAI-compatible API puts them on `error.links` with `error.code` set to the DocSlurp code. In the SDK, `DocSlurpErrorLinks` holds `billing`, `buyCredits`, `autoTopUp`, `apiKeys` and `docs`. Self-hosted servers have no billing, so they send no links.

## Authentication and integration boundaries

- Create and revoke keys on the [API keys](https://docslurp.io/app/api-keys) page, or with the session key API above. `ingest` allows uploads and URL ingestion and, on server keys, [keeping that content current](#keep-project-content-current) (reprocess, retag, delete). `search` allows search, `chat` generated answers, and `artifacts` document reads. Run progress accepts any of these scopes. Project state also requires a server key.
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
const tags = await client.listProjectTags();
// [{ tag: "finance", documentCount: 2 }, ...]
await client.search({ q: "revenue outlook", tags: "finance,FY26" });
```

JSON upload and direct-session requests accept `tags: string[]`. Multipart `/v1/uploads/bulk` accepts a `tags` field containing a JSON array. Tags are case-sensitive, trimmed, and deduplicated: up to 24 labels per request, each 1–100 characters, with no commas or NUL characters. Tags are saved with the document before processing starts, returned in the upload response, and preserved when reprocessing documents.

`GET /v1/projects/:project/tags` returns `{ "tags": [{ "tag": "finance", "documentCount": 2 }] }`, sorted by tag. Counts cover current, non-superseded documents, including pending uploads. The project accepts a UUID, slug, former slug, or `default`. Session callers need project access; API keys additionally need one of `search`, `ingest`, `artifacts`, or `projects:manage`, and stay within their organization and project restrictions. An empty project returns `{"tags":[]}`.

Document listing and search accept comma-separated `tags`; matching any supplied tag is sufficient. Chat accepts an array in `filters.tags`. `PUT /v1/documents/:docId/tags` and `POST /v1/documents/bulk` (`apply-tags`/`remove-tags`) edit labels with project edit access, from a session or a server key with `ingest`. Tag changes take effect without re-ingestion.

## Export documents as a zip

Export one document or a project's current documents as an organized zip. The worker builds the archive in the background and stages it in object storage; the API never holds it in memory.

```bash
curl -X POST "$DOCSLURP_URL/v1/exports" -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" -d '{"projectId":"default","content":"markdown"}'
# 202 { "export": { "id": "exp_…", "status": "queued", "notifyEmail": false, "expiresAt": "…" } }
curl "$DOCSLURP_URL/v1/exports/exp_…" -H "Authorization: Bearer $KEY"     # status: queued → running → ready
curl -L -o export.zip "$DOCSLURP_URL/v1/exports/exp_…/download" -H "Authorization: Bearer $KEY"
```

Pass `documentId` for one document, or `projectId` (UUID, slug or `default`) for a project; omit both to export the organization's default project. `content` is `markdown` (default) or `all`:

```text
Finance/                      one folder per document (a document export is just its folder)
  Q3 plan/
    Q3 plan.md                extracted Markdown for the whole document
    pages/page-0001.md        the same text page by page (documents with more than one page)
    structured.json           schema fields, when the project has a schema
    metadata.json             filename, type, status, page count, version, tags
    original/Q3 plan.pdf      "all" only: the uploaded file
    images/page-0001.png      "all": rendered page images; Markdown-only: pages Fast kept as images
    outputs/html.html         "all" only: readable pipeline outputs (HTML, canonical document, …)
  README.md                   the layout, a document table, and any file that could not be included
```

Project exports hold current versions only (no superseded, archived or purged documents), up to 5,000 documents; a document still processing contributes its `metadata.json`. Files the PII policy withholds are never exported, and the README lists them. Deleting or purging a document in an export withdraws the export. Limits:

- **Size:** exports estimated over **3 GB** are refused with `413 payload_too_large`; export Markdown only or one document at a time. The worker also stops adding files at that size and lists the rest in `README.md`.
- **Email:** exports estimated over **250 MB** are emailed to the requester when ready (`notifyEmail: true`), so nobody has to keep a tab open.
- **Lifetime:** every link works for **7 days** from when the export is ready (`expiresAt`). After that `download` answers `404` and the file is deleted. Each `download` call checks the export (requester, project access, expiry) and then redirects to a presigned storage link that lasts two minutes, so the zip downloads straight from storage. Call `download` again for a fresh link; resumable downloads (Range) work against the storage link.
- **Limits:** three unfinished exports per user, and 20 exports or 20 GB (estimated) per user per day (`429 rate_limited`). Asking for the same export again within an hour returns the one already in flight or finished. A single document must have finished processing (`409` otherwise).

Sessions and server keys with `artifacts` can export; keys stay within their organization and project restrictions. Objects live in the private bucket under `exports/<orgId>/<projectId>/<exportId>.zip` with an `Expires` header and `docslurp-expires-at` metadata; the API's maintenance sweep deletes them. A bucket lifecycle rule that expires `exports/` after 8 days is a useful backstop (see [operations](self-host/operations.md#export-cleanup)).

## Primary sponsor

[![17th Street Labs logo](https://docslurp.io/sponsors/17th-street-labs-readme.svg)](https://17thstreetlabs.com)

[17th Street Labs](https://17thstreetlabs.com) is DocSlurp's primary sponsor.
