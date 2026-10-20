# Document versions, version retention, and config-change jobs

Date: 2026-10-14. Status: approved 2026-10-14 with the decisions in §9. Branch: `feat/versions-and-config-jobs`.

## 1. Intent (user requirements)

- **Version identity** is keyed by workspace + path + document name. Pages from different versions of a file are never mixed.
- **Auto-purge old versions only for free users.** Paid orgs get a "retain X versions" setting per org, overridable per workspace (project).
- **Version history:** old versions' page text and Markdown stay browsable, with a version picker in the document reader.
- **Config changes trigger re-indexing intelligently.** The UI shows a cost-estimate confirm screen. The API and SDK offer `…Estimate` methods; mutating calls return job status (queue state, id, and an estimate when that is cheap to compute).
- **Expensive optional passes** (multimodal page-image embedding) run only on explicit opt-in, with test coverage. This is handled on PR #199.

## 2. Findings this design fixes (2026-10-14 exploration)

- **Versions are not superseded without `canonicalId`.** Without an explicit `canonicalId`, a same-name upload gets `version_number + 1` but is never superseded (`canonical_id` stays NULL, so the 0021 trigger never fires). Both versions stay live in search and chat (`app/src/api/services/runs.ts:1051-1068`).
- **Version lookup is org-wide by filename** (not per workspace), so two workspaces' `report.pdf` chain into one history.
- **Folder paths are discarded.** `app/src/lib/file-drop.ts:29-37` flattens `webkitRelativePath` into the filename, so `a/report.pdf` and `b/report.pdf` collide.
- **Superseded data is purged after 60 s for everyone** (`worker/src/db/superseded-purge.ts`), with hard-coded settings and no plan or org setting.
- **No reader picker.** The reader is per document id. `GET /v1/documents/:id/versions` walks backwards only, and there is no picker.
- **Config changes don't trigger re-indexing.** Saving pipeline settings never computes affected stages or offers a re-index ("New uploads use this pipeline…"). An embedding-model change silently leaves a mixed-model index.
- **No shared job shape.** Async endpoints return different shapes (`WorkspaceRun`, `{runId}`, `{runId, pages, estimatedCredits}`, `indexingJob: {runIds}`), and there is no shared confirm dialog.

## 3. Version identity

- **Version key.** `version_key = canonicalId` when the caller supplies one. Otherwise it is `path:` + sha256(workspace_id + NFC-normalized, case-folded relative path + "/" + filename), truncated to 32 hex characters. The relative path is the folder path inside the upload (drag-and-drop folders, CLI/SDK `path` option, zip entries). It is empty for single files.
- **Storage.** New column `documents.source_path text not null default ''` stores the normalized relative path, used for display and the key. `canonical_id` is always set (to `version_key`) for new uploads, so the existing supersede trigger handles every upload. That makes "never mix" hold structurally: search, chat and suggest already filter `superseded_at is null`.
- **Lookup scope.** Previous-version lookup moves from org + filename to `(workspace_id, canonical_id)`, which uses the existing index.
- **Upload sources.**
  - **UI:** stop flattening paths into the filename. Send `path` alongside the file and keep the display name. The flattened display label stays for legacy rows.
  - **API, SDK, CLI and MCP uploads** accept optional `path` (string, max 1024, `/`-separated, no `..`).
- **Identical re-upload** still creates a new version (current behaviour, kept on purpose for repeat testing). Existing content-hash dedup keeps sharing artifacts between the copies. Skipping identical re-uploads is a later TODO.
- **Migration.** Backfill `canonical_id` for live rows that have none, using the key from their filename and an empty path. Where more than one live row shares a key, keep the newest live and supersede the rest. This fixes the existing mixing. It is a one-time, idempotent SQL migration.

## 4. Version retention

- **Settings.**
  - `organizations.retain_document_versions int null`: null means the plan default, 1 means "current only".
  - `workspaces.retain_document_versions int null`: null means inherit from the org.
  - Valid range 1–100.
- **Effective value.** On the **free plan** the value is always 1; the settings are ignored and the UI shows them locked with an upgrade hint. On **paid plans**: workspace override, else org setting, else the plan default.
- **Plan default: 2 versions** (the current one plus 1 extra) for Silver, Gold and Platinum, a new `ServicePlan.defaultRetainedVersions`.
- **Purge** (`superseded-purge.ts`): per `(workspace_id, canonical_id)`, keep the newest *N* versions, where *N* counts the current one.
  - **Versions beyond N:** purged exactly as today (derived tables, LanceDB rows, artifacts; the source file per the storage policy).
  - **Retained, non-current versions:** get a lighter "archive" purge after the 60 s grace. Search-only data is removed: chunks, LanceDB rows, graph evidence, staleness rows, and deferred page vectors and maps. What a reader needs is kept: `document_pages` (page text), the Markdown artifacts and page images. New column `documents.archived_at` marks this state.
  - Superseded versions stay excluded from search, chat and suggest, as today.
- **Storage billing.** Retained page text and Markdown count toward index storage (existing storage meter). The settings UI shows the retained versions' current MB and its monthly credit cost.
- **Deferred workspaces** (PR #199) retain only the pages that were materialized; the picker labels the rest "not parsed in this version".

## 5. Version picker and reader

- **API.**
  - `GET /v1/documents/:id/versions` returns the whole chain for the document's `version_key`: newest first, both directions.
  - Each entry carries `{documentId, versionNumber, createdAt, status, isCurrent, archived, purged, pageCount, sourcePath, filename, sizeBytes, changeSummary?}`.
  - Purged versions are listed as tombstones and cannot be opened.
- **Reader.** A version picker in the reader modal and the inspector header shows "v3 · current", "v2 · 12 Oct", and "v1 · purged" (disabled).
  - Selecting a version loads that document id's pages only. The Gradient Carousel and page turner are scoped to one version.
  - A "Compare with current" action reuses the existing changelog diff.
  - Citations always open the version they cite (by document id). If that version was purged, the reader opens the current version and shows a notice.

## 6. Config changes: impact, estimates, jobs

### 6.1 Impact classification (shared, pure)

`analyzePipelineChange(before: PipelineFeatures, after: PipelineFeatures, context: { indexingMode, documentCount, pageCount }): ConfigChangeImpact`

```ts
type ConfigChangeImpact = {
  kind: "none" | "search-only" | "new-uploads" | "reindex-recommended" | "reindex-required";
  stages: PipelineRunStage[];          // minimal stage set for existing documents
  reasons: Array<{ field: string; effect: string }>;
  documents: number; pages: number;
};
```

It is built on `stageDataFlow` and `compilePipelinePlan`, generalizing the private `selectStages` into an exported helper, and classifies each changed field:

- **`reindex-required`:** the change makes the existing index inconsistent or non-compliant. Examples: embedding model or dimensions, chunking parameters, vector backend, a stricter PII policy (`block`/`redact`), a stricter `privacyMode`. Leaving the old data would mix incompatible vectors or keep data the new policy forbids.
- **`reindex-recommended`:** the change adds value to old documents but doesn't break anything. Examples: enabling summaries, structured extraction, graph enrichment, propositions or a better parser playbook.
- **`new-uploads`:** only future ingestion is affected (budgets, retention, and some routing knobs).
- **`search-only`:** retrieval defaults and chat settings take effect immediately with no job.

### 6.2 Apply flow

- **`PATCH /v1/workspaces/:id`** (and the search-settings PATCH) accept `apply?: "new-uploads" | "reindex"`. This is **non-breaking**: no request that succeeds today is rejected.
  - `reindex-required` changes save and **automatically queue** the minimal re-index job for existing documents, whatever `apply` says. The response carries `job` and the estimate.
  - Until that job completes, search keeps serving each document from the index it was built with. The workspace records `index_configs`, a map from `index_config_hash` to every index config (embedding model and dimensions, chunking, vector backend) a live document is built with, current one included. Search queries each config's table restricted to that config's documents, embeds the query once per model and fuses the lists with RRF, so results never mix incompatible vectors. A newer required change cancels the older in-flight re-index and re-queues every document not yet on the new config; drained entries are pruned. The switch happens per document as each is re-indexed.
  - If spend admission blocks the job (no credits or budget), the config is still saved. The job is created with `status: "blocked"` and `reason: "credits"`, documents keep serving from their previous index, and the job starts automatically when spend is available again.
  - `reindex-recommended` defaults to `new-uploads`; `apply: "reindex"` opts in.
  - `search-only` and `new-uploads` changes save immediately, with no job.
  - The UI always shows the cost confirm dialog before saving any change that queues work (§6.4). API clients rely on the `…Estimate` routes and the returned `job`.
  - Saving the config and creating the job happen in one transaction.
- **The response always includes `job`** when work is queued:

```ts
type JobStatus = {
  id: string;                 // run id (or graph job id); stable handle
  kind: "reindex" | "full-index" | "backfill" | "graph-rebuild" | "reprocess";
  status: "queued" | "blocked" | "processing" | "completed" | "failed" | "cancelled";
  reason?: "credits" | "budget" | "policy";
  queue: { position: number | null; ahead: number | null };
  runIds: string[];
  estimate: CostEstimate | null;   // null if not computable within 150 ms; then estimateUrl
  estimateUrl?: string;
  statusUrl: string;               // GET /v1/jobs/:id
};
type CostEstimate = { pages: number; documents: number; credits: { low: number; high: number }; seconds: { low: number; high: number } | null; basis: string };
```

- **`GET /v1/jobs/:id`** is a thin, read-only view over `workspace_runs` (and `graph_jobs`), with SSE progress at `GET /v1/jobs/:id/events` and a polling fallback. This is a new, minimal shared job resource; existing endpoints keep their fields and gain a `job` property.

### 6.3 Estimates

- **Shared estimator.** `estimatePipelineWork(features, stages, pages, mix)` moves into `packages/shared`, ported from the worker's `forecastRunCost` and `estimateIngest`, so the app can price work synchronously.
- **`…/estimate` endpoint for every mutating route that can create work.** The body is identical to the mutation; nothing is changed.

| Mutation | Estimate route | SDK |
| --- | --- | --- |
| `PATCH /v1/workspaces/:id` | `POST /v1/workspaces/:id/estimate` | `updateWorkspaceEstimate` |
| `PATCH …/search-settings` | `POST …/search-settings/estimate` | `updateSearchSettingsEstimate` |
| `POST /v1/runs/:id/reprocess` | `POST /v1/runs/:id/reprocess/estimate` | `reprocessEstimate` |
| `POST /v1/documents/:id/full-index`, `POST /v1/workspaces/:id/full-index` | `…/full-index/estimate` | `fullIndexEstimate` |
| indexing-mode switch | existing `…/indexing-mode/estimate` | `estimateIndexingMode` → alias `setIndexingModeEstimate` |
| graph rebuild | `POST …/graph/jobs/estimate` | `rebuildGraphEstimate` |
| uploads | `POST /v1/uploads/estimate` `{files:[{name,size,pages?}]}` | `uploadEstimate` |

- **MCP and CLI** expose the same estimate operations.

### 6.4 UI

- **`CostConfirmDialog`** (Radix AlertDialog, shadcn style, design-language tokens) shows:
  - the impact kind and reasons;
  - the document and page counts;
  - the credit range and time range;
  - a choice between "Apply to new uploads only" and "Re-index now" when allowed;
  - the queue position after confirming.
- **Auto-confirm per workspace.** `workspaces.auto_confirm_reindex boolean default false` (API field `autoConfirmReindex`), set from a checkbox in the confirm dialog ("Always re-index this project without asking") and in workspace settings.
  - When true, the UI skips the dialog for changes that queue a re-index and applies `apply: "reindex"` for both required and recommended changes. It shows a toast with the job, the estimate and a link to the job.
  - API clients get the same default: when `apply` is omitted and auto-confirm is on, recommended changes re-index.
  - Spend admission and budgets still apply (a blocked job is still `blocked`). Search-only changes never show a dialog either way.
- **Used by:** pipeline settings Save, indexing-mode change, Index everything, reprocess (inspector), bulk reprocess, graph rebuild and workspace version rollback.
- **Settings Save** calls the estimate first. `search-only` changes save without a dialog. Anything that queues work, or that the user must decide on, opens the dialog.

## 7. Testing

- **Shared:** `analyzePipelineChange` table tests for every pipeline field (each field must be classified, so a new field without a classification fails a test); version key normalization (case, NFC, separators, `..` rejection); estimator monotonicity.
- **DB:**
  - The backfill migration resolves duplicate live versions.
  - The supersede trigger fires for path-keyed uploads.
  - Retention keeps exactly N per key: free 1, and the paid org, workspace-override and plan defaults.
  - Archive purge keeps pages and Markdown and removes vectors.
- **API:** non-breaking PATCH (every currently valid request still succeeds); reindex-required changes auto-queue a job; blocked-on-credits jobs are saved and resume; per-document serving from the previous index config until it is re-indexed (no mixed vectors); one-transaction save and job creation; job/status shape on every mutating route; estimate parity (an estimate route equals the estimate returned by its mutation); version list in both directions; never-mix (search after re-upload returns only current-version chunks).
- **UI:** confirm dialog on queue-creating saves; locked retention on free; picker loads the selected version only.

## 8. Rollout

- **Path keys and the supersede backfill** fix a correctness bug, so they ship unflagged. Their effect on existing behaviour: same-name uploads in the same folder now replace the old version.
- **Retention and archive purge** ship unflagged. Free behaviour is unchanged (purge after grace); paid orgs keep more.
- **Config-change jobs** ship unflagged and are non-breaking. Responses gain `job`; no request is rejected that succeeds today.
- **Pricing:** no rate-card change; the retained-storage cost uses the existing storage rate.
- **Self-hosted deployments:** billing stays disabled. When metering isn't enforced (no Stripe, no `DOCSLURP_BILL_*`), every estimate returns `billing: "disabled"` with null credits, and the confirm dialog shows pages, time and "Billing disabled on this deployment". This uses the shared `isBillingEnforced(env)` helper added on PR #199.

## 9. Decisions (2026-10-14)

1. Paid plans keep **1 extra** version by default (2 in total, including the current one). Free plans keep the current version only.
2. Old versions are browsable but never searchable; vectors and chunks are dropped.
3. **No 409 / no blocking.** Re-index-required changes save and auto-queue the re-index, and documents keep serving from their previous index until re-indexed. The UI confirms with an estimate; the API offers `…Estimate` routes.
4. Identical re-uploads **do** create a new version for now (needed for repeat testing). Skipping them is a TODO.
5. Per-workspace "always re-index without asking" (`autoConfirmReindex`, default off) skips the UI confirm and makes `reindex` the default `apply` for recommended changes.
