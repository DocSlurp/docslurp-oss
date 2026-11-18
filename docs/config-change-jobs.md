# Config-change jobs and estimates

Changing a project setting can leave existing documents stale. DocSlurp classifies each change, queues the minimal re-index when one is needed, and lets you price any work before you start it.

## Impact kinds

Every change is classified as one of these:

| Kind | Meaning | Job |
| --- | --- | --- |
| `none` | Nothing changes. | No |
| `search-only` | Retrieval and chat defaults take effect immediately. | No |
| `new-uploads` | Only future ingestion is affected. | No |
| `reindex-recommended` | Old documents would benefit (summaries, structured fields, graph, propositions). | Only with `apply: "reindex"`, or when `autoConfirmReindex` is on |
| `reindex-required` | The index would become inconsistent (embedding model or dimensions, chunking, vector backend, stricter PII or privacy policy). | Locked index settings: only with `apply: "reindex"` or the reindex command (see below). Stricter PII or privacy policy: always, automatically |

The `impact` object carries `kind`, the minimal `stages`, per-field `reasons`, and the affected `documents` and `pages`.

## Locked index settings and the reindex command

The settings that define a project's search index are locked once the project has indexed documents:

| Setting | What it covers |
| --- | --- |
| `embedding` | Profile, model, dimensions, normalization, task, late chunking and its window |
| `chunkOverlap` | Overlapping chunks |
| `contextualChunkPreambles` | Contextual chunk preambles |
| `vectorBackends` | Where vectors are stored |

They are exactly the inputs of the index identity (`INDEX_IDENTITY_SETTINGS` in `@docslurp/shared` and `@docslurp/sdk`). Vectors built under one value are not comparable with queries or chunks built under another, so changing one means re-indexing every document, and that costs credits.

- **What locks:** a change locks only when it changes the index identity (`indexConfigHash`). A reordered `vectorBackends` list, an explicit default or an option the vectors don't depend on (`embedding.task`) changes nothing, and it never re-indexes.
- **Documents that count:** completed documents, archived ones (they keep their vectors and can be restored), documents still queued or processing, and upload runs still queued, blocked or processing. Runs embed with the pipeline they were created with.
- **Embedding switched off:** the lock still applies. Turning `embed` or `indexVectors` back on is locked too while vectorized documents carry another index config; the refusal then names `embed` / `indexVectors`.
- **Uploads:** an upload, URL ingest or direct-upload session whose `pipeline` overrides would change these settings on a project with documents is refused as a whole with `409 reindex_required`, before any bytes are stored. Change the project with the reindex command first.
- **Where it applies:** plain updates, settings publication, chat proposals, ingest-report recommendations and version rollbacks (`POST /v1/projects/:id/versions/:versionId/rollback` takes `apply` and `confirmEstimate` like `PATCH`).

A plain `PATCH /v1/projects/:id` that changes a locked setting is refused, and none of the body is saved, including other fields in the same request:

```json
{ "error": { "code": "reindex_required",
  "message": "Locked index settings changed: embedding. This change alters how the project's search index is built, ... It re-indexes 6 documents (240 pages), about 18-26 credits.",
  "details": { "reindex": {
    "lockedSettings": ["embedding"], "documents": 6, "pages": 240,
    "credits": { "low": 18, "high": 26 }, "signature": "3f1c…(64 hex)",
    "reindexUrl": "/v1/projects/…/reindex" } },
  "requestId": "…" } }
```

`credits` is `null` when billing is off. To apply the change, confirm the re-index in one of two equivalent ways:

- `POST /v1/projects/:id/reindex` with `{ "pipeline": { "embedding": { "profile": "fastest-local" } }, "confirmEstimate": "<signature>" }`. `pipeline` takes only the locked settings; change other settings with `PATCH`. With no `pipeline` the command rebuilds the index under the current settings. It returns `{ project, changedSettings, impact, estimate, runIds, job }`.
- The same `PATCH` with `apply: "reindex"` (and, optionally, `confirmEstimate`).

Both save the settings and queue the re-index in one transaction. The command's `outcome` is `queued` or `blocked` (re-index runs exist), `saved` (settings changed, nothing to re-index) or `unchanged`.

A plain rebuild (no `pipeline`) re-runs the embedding and indexing stages, and the summary tree when it is on, for every live document. It is billed like any re-index, so estimate it first. Page-image vectors use their own embedder and are not affected by these settings. `POST /v1/projects/:id/reindex/estimate` prices the command without changing anything and returns `{ impact, estimate, lockedSettings, signature, quote, billing }`; `POST /v1/projects/:id/estimate` also returns `lockedSettings` and `signature` for a `PATCH` body, and the refusal's `signature` matches the estimate's for the same change. `confirmEstimate` is optional, and only valid with `apply: "reindex"` (otherwise `400`). When it is sent and the documents, stages or price changed since that estimate, the request is refused with `409 estimate_stale` and nothing is saved: estimate again and retry with the new signature. A signature covers the whole resulting configuration, so the refusal's signature matches a reindex call only when that call requests the same index settings (a reindex estimate is the way to price a different body). If the project changes while the command saves, it answers `409 settings_stale`; nothing was saved and it is safe to retry. A value the project's privacy mode rules out (a hosted embedding under `local-only`) is `400 privacy_mode_violation`.

The SDK has `reindexProject(project, input)` and `reindexProjectEstimate(project, input)`, and `DocSlurpApiError.reindex` carries the refusal's details. The CLI has `docslurp reindex [--embedding-profile <profile>] [--late-chunking on|off] [--late-chunking-window <1-6>] [--chunk-overlap on|off] [--contextual-preambles on|off] [--vector-backends <a,b>] [--estimate] [--confirm <signature>]`. Access is the same as `PATCH`: an editor of the project, or a server key with `projects:manage` for that project.

The MCP server has the same pair: `reindexEstimate` (read-only) and `reindex`. Both take `project` (omit for the organization default), `embeddingProfile`, `lateChunking`, `lateChunkingWindow`, `chunkOverlap`, `contextualChunkPreambles`, `vectorBackends`, `embed`, `indexVectors` and `speedBoost`; with no setting they price or run a plain rebuild. `reindexEstimate` returns `{ lockedSettings, documents, pages, credits, signature, estimate, impact, billing }`. `reindex` **requires** `confirmEstimate` (the estimate's `signature`), so an agent cannot spend credits without first fetching an estimate, and returns `{ outcome, changedSettings, project: { id, slug, name }, runIds, job, estimate, impact }`; poll the job with `getJob`. Both have the route's access rules (an editor, or a server API key with `projects:manage`; delegated OAuth tokens are refused), and project chat never offers them.

Estimate signatures are HMACed with `DOCSLURP_ESTIMATE_SIGNING_SECRET` (preferred) or, unset, `SECRETS_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` or `FILE_TOKEN_SECRET`. A signature also covers the `speedBoost` choice and whether billing is enforced. Every API and chat-executor process must resolve the same key, or each refuses the others' signatures as `estimate_stale`: set the dedicated variable to one value on every such process before rolling it out, and check that the `fingerprint=` in each startup line (and `GET /ops/estimate-signing`, operator bearer) matches. See [estimate signing key rollout](self-host/security.md#estimate-signing-key-rollout).

Nothing is locked on a project with no indexed documents: changes there apply at once and only shape future uploads. `autoConfirmReindex` never unlocks a locked setting; it still re-indexes recommended changes when `apply` is omitted. A stricter PII or privacy policy is not locked: it still saves and queues its re-index automatically, because delaying enforcement would be worse than the spend.

## Re-indexing without downtime

Apart from locked index settings (above), config `PATCH` requests never fail because of a change. For any other `reindex-required` change, and for a confirmed locked change, the configuration is saved and the minimal re-index job is queued in the same transaction.

Until a document is re-indexed, search serves it from its previous index configuration, scoring the query against that configuration's embedding model. Vectors from different models are never mixed in one table. Each document switches as its re-index finishes.

If spend admission blocks the job (no credits or budget), the configuration is still saved and the job is `blocked` with `reason: "credits"` or `"budget"`. Documents keep serving from the previous index, and the job resumes automatically when spend is available again.

`autoConfirmReindex` (project setting, default `false`) opts a project in to re-indexing recommended changes without confirmation: the dashboard skips its cost dialog for them, and when `apply` is omitted from an API call, recommended changes re-index too. It never confirms a locked index setting. Spend admission and budgets still apply.

## Estimates

Every route that can create work has a `POST …/estimate` twin with the same body. It changes nothing.

| Operation | Estimate route | SDK | CLI | MCP tool |
| --- | --- | --- | --- | --- |
| Update project | `POST /v1/projects/:id/estimate` | `updateProjectEstimate` | Use SDK/HTTP | `updateEstimate` |
| Re-index project | `POST /v1/projects/:id/reindex/estimate` | `reindexProjectEstimate` | `reindex --estimate` | `reindexEstimate` |
| Update search settings | `POST /v1/projects/:id/search-settings/estimate` | `updateSearchSettingsEstimate` | Use SDK/HTTP | `searchSettingsEstimate` |
| Reprocess a run | `POST /v1/runs/:id/reprocess/estimate` | `reprocessEstimate` | `reprocess <runId> --estimate` | `reprocessEstimate` |
| Full index (document) | `POST /v1/documents/:id/full-index/estimate` | `fullIndexEstimate({ documentId })` | `full-index --document <id> --estimate` | `fullIndexEstimate` |
| Full index (project) | `POST /v1/projects/:id/full-index/estimate` | `fullIndexEstimate({ project })` | `full-index --estimate` | `fullIndexEstimate` |
| Indexing mode | `POST /v1/projects/:id/indexing-mode/estimate` | `estimateIndexingMode`, `setIndexingModeEstimate` | Use SDK/HTTP | `indexingModeEstimate` |
| Rebuild graph | `POST /v1/projects/:id/graph/jobs/estimate` | `rebuildGraphEstimate` | Use SDK/HTTP | `graphRebuildEstimate` |
| Upload | `POST /v1/uploads/estimate` `{ files: [{ name, size, pages? }] }` | `uploadEstimate` | `upload <files> --estimate` | `uploadEstimate` |

An estimate accepts exactly the callers that may perform the operation it prices. With an API key: project update, search-settings, indexing mode and graph rebuild estimates need a server key with `projects:manage`; full-index and upload estimates need `ingest`; reprocess estimates need a server key with `ingest`. The MCP tools follow the same rule and are listed only to keys that may use them. Keys restricted to projects can only price work in those projects.

Config estimates return `{ impact, estimate, billing }` (project update and reindex estimates add `lockedSettings` and `signature`); the others return `{ estimate, billing }`. A `CostEstimate` is:

```json
{ "pages": 240, "documents": 6, "billing": "enforced",
  "credits": { "low": 18, "high": 26 }, "seconds": { "low": 90, "high": 160 },
  "basis": "default pipeline, historical averages" }
```

A mutation's returned `job.estimate` equals its estimate route's result, and `job.estimateUrl` names that route. A slow estimate is still returned: the mutation waits for it either way.

On self-hosted deployments billing is disabled: `billing` is `"disabled"`, `credits` is `null`, and pages and time still apply. Nothing is ever priced or charged.

## Jobs

Mutations that queue work return a `job`:

```json
{ "id": "…", "kind": "reindex", "status": "queued", "reason": null,
  "queue": { "position": 1, "ahead": 0 }, "runIds": ["…"],
  "estimate": { "…": "…" }, "statusUrl": "/v1/jobs/…" }
```

`kind` is `reindex`, `full-index`, `backfill`, `graph-rebuild` or `reprocess`. `status` is `queued`, `blocked`, `processing`, `completed`, `failed` or `cancelled`.

- `GET /v1/jobs/:id` returns the current job (SDK `getJob`, CLI `jobs get <id>`, MCP `getJob`).
- `GET /v1/jobs/:id/events` is a server-sent event stream of `status`, `progress` and `done` events (SDK `streamJob`, CLI `jobs watch <id>`). Their timeout (five minutes by default) never runs out while a job is `blocked` on credits or budget; cancel with an abort signal instead.
- Where streaming is unavailable, poll `GET /v1/jobs/:id`. `streamJob` and `jobs watch` fall back to polling on their own.

```ts
const { job } = await client.reindexProject("legal", { pipeline: { embedding: { profile: "fastest-local" } } });
if (job) for await (const event of client.streamJob(job.id)) console.log(event.event, event.job.status);
```

## Coherent settings publication

`GET /v1/projects/:projectId/settings-publication` reads the public project and search/chat settings under the config lock and returns opaque `revision.project` and `revision.search` preconditions. The search revision is `absent` before the first stored row. The endpoint requires edit access; a live server API key additionally needs `projects:manage` and the matching organization/project allowlist. Browser and delegated OAuth keys cannot use it.

`POST` to that path publishes one sparse intent:

```json
{
  "requestId": "617a1ce0-bf14-429b-bbc8-7f0c72c71562",
  "expected": { "project": "opaque-from-get", "search": "absent" },
  "project": { "pipeline": { "chunkOverlap": true }, "apply": "reindex" },
  "search": { "chat": { "citations": true }, "retrievalDefaults": { "resultCount": 6 } }
}
```

The server checks both revisions under the existing config lock. Pipeline, search/chat, admitted work, reservations, audit and actor-scoped retry receipt commit together or roll back. Retry an unchanged intent with the same request ID; changing its parameters requires a new ID. A stale project or search row returns 409, including a concurrent first search-row insertion. Existing independent preference writers also serialize with publication.

A successful `POST` returns `{ requestId, snapshot, replayed, job, queuedRunIds }`: `snapshot` carries the fresh revisions for your next save, `job` and `queuedRunIds` describe admitted work, and a retried request ID returns its original result with `replayed: true` (and no new work). Errors that leave everything unsaved:

| Status and code | Meaning | What to do |
| --- | --- | --- |
| `409 settings_stale` | Either revision changed since your `GET`. | Re-read, reapply your intent, publish with a new request ID. |
| `409 settings_idempotency_conflict` | The request ID was already used with different parameters. | Resend the original intent unchanged, or use a new ID. |
| `409 settings_reprocess_consent_required` | The change queues work on existing documents and `project.apply` is not `"reindex"`. | Price it with the estimate routes, then send `apply: "reindex"`. |
| `409 policy_publication_unavailable` | Privacy/PII tightening over a project that holds documents or runs (see below). | Tighten only on an empty project for now. |

The SDK, CLI and MCP tools have no publication wrapper yet: they keep using `updateProject` / `updateSearchSettings` (and the `updateEstimate` / `searchSettingsEstimate` MCP tools), which save one record each and do not check revisions. Use HTTP when both halves must commit together.

Omitted fields retain their stored values; `false` remains explicit. Supported nullable search fields reset to inherited behavior with `null`. Arrays replace. `clearOutputSchema: true` explicitly removes the output schema; omission preserves it. Unknown keys and managed model/provider bindings are refused. The body is limited to 128 KiB. Existing estimates, billing and scope checks remain authoritative; this endpoint does not grant new execution authority. A deferred-mode change that queues work requires explicit `project.apply: "reindex"` consent.

The snapshot includes safe effective-value explanations and bounded legacy-index coverage. Resolved values cannot reconstruct whether an old normalized setting was explicitly chosen or defaulted, so their origin is labeled `project-resolved`. Template locks, independent organization/key ceilings and unavailable/inactive preferences are explained without exporting managed bindings or secrets. Saving desired settings is not proof that existing documents have migrated.

Normalization is part of vector generation identity and query-vector cache identity. Historical records without normalization cannot establish compatibility. Vector retrieval returns `index_rebuild_required` rather than reproducing an unknown space with current settings; keyword retrieval does not reproduce vectors. Use existing authorized document reprocessing, with an estimate and explicit confirmation, to rebuild bounded batches. Missing hashes are not backfilled by assuming the current recipe. A worker-written current-generation hash clears the rebuild-required condition for that document.

Privacy/PII tightening over retained documents requires immediate artifact fencing. The shared project-settings writer refuses tightening whenever any tenant/project-scoped document or run row remains, including archived/superseded versions, deferred or unindexed documents, and queued/running/terminal history. It checks inside the writing transaction under organization spend admission and project-row locks, independently of rebuild eligibility. Journaled migration `0180_policy_admission_fence.sql` makes every run insert take the same row lock and validate its policy against the committed project policy, so a stale request cannot arrive after an empty-project tightening. Stricter request policies remain allowed; weaker policies are refused. This is a conservative refusal, not artifact fencing or automatic compliance. A genuinely empty project can tighten. Template-locked pipeline mutations are rejected rather than silently restored. Full desired/building/serving lifecycle, policy purge/fencing, retained-extraction compatibility and playground workflows remain separate work.


### Admission lock order

Every common project-settings write now takes the project config advisory lock, then the organization spend-admission advisory lock, before any project row lock or UPDATE. This includes ordinary embedding/chunk rebuilds, non-reindex publication callbacks that enqueue mode work, PATCH/proposals and the common history/graph/summary writer. Taking spend only for privacy tightening would leave ordinary rebuilds holding the project while intake held spend, producing a deadlock when each requested the other lock.

The standalone full-index/mode job commit already takes spend before its full-index advisory lock and before inserting runs; publication reuses it inside the already ordered transaction. Version restoration uses the common settings writer. The stored-mode compensation helper and managed-model writer finish their own transactions without later run admission, so they do not request spend after their project writes. Intake takes spend before the policy admission trigger's project row lock. No deadlock retry or policy-fence bypass is added.
