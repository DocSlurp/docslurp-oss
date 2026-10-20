# Config-change jobs and estimates

Changing a workspace setting can leave existing documents stale. DocSlurp classifies each change, queues the minimal re-index when one is needed, and lets you price any work before you start it.

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

`autoConfirmReindex` (workspace setting, default `false`) opts a workspace in to re-indexing without confirmation. The dashboard skips its cost dialog for changes that queue a re-index, and when `apply` is omitted from an API call, recommended changes re-index too. Spend admission and budgets still apply.

## Estimates

Every route that can create work has a `POST …/estimate` twin with the same body. It changes nothing.

| Operation | Estimate route | SDK | CLI | MCP tool |
| --- | --- | --- | --- | --- |
| Update workspace | `POST /v1/workspaces/:id/estimate` | `updateWorkspaceEstimate` | Use SDK/HTTP | `updateEstimate` |
| Update search settings | `POST /v1/workspaces/:id/search-settings/estimate` | `updateSearchSettingsEstimate` | Use SDK/HTTP | `searchSettingsEstimate` |
| Reprocess a run | `POST /v1/runs/:id/reprocess/estimate` | `reprocessEstimate` | `reprocess <runId> --estimate` | `reprocessEstimate` |
| Full index (document) | `POST /v1/documents/:id/full-index/estimate` | `fullIndexEstimate({ documentId })` | `full-index --document <id> --estimate` | `fullIndexEstimate` |
| Full index (workspace) | `POST /v1/workspaces/:id/full-index/estimate` | `fullIndexEstimate({ workspaceId })` | `full-index --estimate` | `fullIndexEstimate` |
| Indexing mode | `POST /v1/workspaces/:id/indexing-mode/estimate` | `estimateIndexingMode`, `setIndexingModeEstimate` | Use SDK/HTTP | `indexingModeEstimate` |
| Rebuild graph | `POST /v1/workspaces/:id/graph/jobs/estimate` | `rebuildGraphEstimate` | Use SDK/HTTP | `graphRebuildEstimate` |
| Upload | `POST /v1/uploads/estimate` `{ files: [{ name, size, pages? }] }` | `uploadEstimate` | `upload <files> --estimate` | `uploadEstimate` |

An estimate accepts exactly the callers that may perform the operation it prices. With an API key: workspace update, indexing mode and graph rebuild estimates need a server key with `workspaces:manage`; full-index and upload estimates need `ingest`; search-settings and reprocess estimates are signed-in-session only (their mutations accept no API key). The MCP tools follow the same rule and are listed only to keys that may use them. Keys restricted to workspaces can only price work in those workspaces.

Config estimates return `{ impact, estimate, billing }`; the others return `{ estimate, billing }`. A `CostEstimate` is:

```json
{ "pages": 240, "documents": 6, "billing": "enforced",
  "credits": { "low": 18, "high": 26 }, "seconds": { "low": 90, "high": 160 },
  "basis": "default pipeline, historical averages" }
```

A mutation's returned `job.estimate` equals its estimate route's result. If an estimate takes longer than 150 ms, the job carries `estimate: null` and an `estimateUrl` to fetch it.

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
const { job } = await client.updateWorkspace("legal", { embedding: { model: "…" } });
if (job) for await (const event of client.streamJob(job.id)) console.log(event.event, event.job.status);
```
