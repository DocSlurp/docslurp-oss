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
| `reindex-required` | The index would become inconsistent (embedding model or dimensions, chunking, vector backend, stricter PII or privacy policy). | Always, automatically |

The `impact` object carries `kind`, the minimal `stages`, per-field `reasons`, and the affected `documents` and `pages`.

## Re-indexing without downtime

Config `PATCH` requests never fail because of a change and never return `409`. For a `reindex-required` change the configuration is saved and the minimal re-index job is queued in the same transaction.

Until a document is re-indexed, search serves it from its previous index configuration, scoring the query against that configuration's embedding model. Vectors from different models are never mixed in one table. Each document switches as its re-index finishes.

If spend admission blocks the job (no credits or budget), the configuration is still saved and the job is `blocked` with `reason: "credits"` or `"budget"`. Documents keep serving from the previous index, and the job resumes automatically when spend is available again.

`autoConfirmReindex` (project setting, default `false`) opts a project in to re-indexing without confirmation. The dashboard skips its cost dialog for changes that queue a re-index, and when `apply` is omitted from an API call, recommended changes re-index too. Spend admission and budgets still apply.

## Estimates

Every route that can create work has a `POST …/estimate` twin with the same body. It changes nothing.

| Operation | Estimate route | SDK | CLI | MCP tool |
| --- | --- | --- | --- | --- |
| Update project | `POST /v1/projects/:id/estimate` | `updateProjectEstimate` | Use SDK/HTTP | `updateEstimate` |
| Update search settings | `POST /v1/projects/:id/search-settings/estimate` | `updateSearchSettingsEstimate` | Use SDK/HTTP | `searchSettingsEstimate` |
| Reprocess a run | `POST /v1/runs/:id/reprocess/estimate` | `reprocessEstimate` | `reprocess <runId> --estimate` | `reprocessEstimate` |
| Full index (document) | `POST /v1/documents/:id/full-index/estimate` | `fullIndexEstimate({ documentId })` | `full-index --document <id> --estimate` | `fullIndexEstimate` |
| Full index (project) | `POST /v1/projects/:id/full-index/estimate` | `fullIndexEstimate({ project })` | `full-index --estimate` | `fullIndexEstimate` |
| Indexing mode | `POST /v1/projects/:id/indexing-mode/estimate` | `estimateIndexingMode`, `setIndexingModeEstimate` | Use SDK/HTTP | `indexingModeEstimate` |
| Rebuild graph | `POST /v1/projects/:id/graph/jobs/estimate` | `rebuildGraphEstimate` | Use SDK/HTTP | `graphRebuildEstimate` |
| Upload | `POST /v1/uploads/estimate` `{ files: [{ name, size, pages? }] }` | `uploadEstimate` | `upload <files> --estimate` | `uploadEstimate` |

An estimate accepts exactly the callers that may perform the operation it prices. With an API key: project update, search-settings, indexing mode and graph rebuild estimates need a server key with `projects:manage`; full-index and upload estimates need `ingest`; reprocess estimates need a server key with `ingest`. The MCP tools follow the same rule and are listed only to keys that may use them. Keys restricted to projects can only price work in those projects.

Config estimates return `{ impact, estimate, billing }`; the others return `{ estimate, billing }`. A `CostEstimate` is:

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
const { job } = await client.updateProject("legal", { embedding: { model: "…" } });
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

Omitted fields retain their stored values; `false` remains explicit. Supported nullable search fields reset to inherited behavior with `null`. Arrays replace. `clearOutputSchema: true` explicitly removes the output schema; omission preserves it. Unknown keys and managed model/provider bindings are refused. The body is limited to 128 KiB. Existing estimates, billing and scope checks remain authoritative; this endpoint does not grant new execution authority. A deferred-mode change that queues work requires explicit `project.apply: "reindex"` consent.

The snapshot includes safe effective-value explanations and bounded legacy-index coverage. Resolved values cannot reconstruct whether an old normalized setting was explicitly chosen or defaulted, so their origin is labeled `project-resolved`. Template locks, independent organization/key ceilings and unavailable/inactive preferences are explained without exporting managed bindings or secrets. Saving desired settings is not proof that existing documents have migrated.

Normalization is part of vector generation identity and query-vector cache identity. Historical records without normalization cannot establish compatibility. Vector retrieval returns `index_rebuild_required` rather than reproducing an unknown space with current settings; keyword retrieval does not reproduce vectors. Use existing authorized document reprocessing, with an estimate and explicit confirmation, to rebuild bounded batches. Missing hashes are not backfilled by assuming the current recipe. A worker-written current-generation hash clears the rebuild-required condition for that document.

Privacy/PII tightening over retained documents requires immediate artifact fencing. The shared project-settings writer refuses tightening whenever any tenant/project-scoped document or run row remains, including archived/superseded versions, deferred or unindexed documents, and queued/running/terminal history. It checks inside the writing transaction under organization spend admission and project-row locks, independently of rebuild eligibility. Journaled migration `0178_policy_admission_fence.sql` makes every run insert take the same row lock and validate its policy against the committed project policy, so a stale request cannot arrive after an empty-project tightening. Stricter request policies remain allowed; weaker policies are refused. This is a conservative refusal, not artifact fencing or automatic compliance. A genuinely empty project can tighten. Template-locked pipeline mutations are rejected rather than silently restored. Full desired/building/serving lifecycle, policy purge/fencing, retained-extraction compatibility and playground workflows remain separate work.
