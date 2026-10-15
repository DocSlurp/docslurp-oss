# Workspace knowledge graph (GraphRAG)

Each workspace owns exactly one knowledge graph: entities (`kg_nodes`),
relationships (`kg_edges` + per-document `kg_edge_evidence`), chunk mentions
(`chunk_entities`) and communities (`kg_communities`). Every query, write and
estimate is scoped by `workspace_id`; nothing is shared across workspaces.
Search uses the graph for neighbor expansion (`graphHops`) and
community-summary retrieval.

## Settings

The graph is off by default. Turning it on is the only required step. The
three levers are optional and live under `pipeline.graph`:

| Lever | Default | Effect |
| --- | --- | --- |
| `domain` | `null` | What the workspace is about (≤ 2,000 chars). Extraction and community summaries use it as trusted context, keeping what matters for that scope and skipping incidental mentions. When empty, the scope falls back to the workspace's own definition: its name and template description. |
| `entityTypes` | `[]` (generic set: person, organization, concept, date, location, product) | Node vocabulary (≤ 16 `snake_case` types). Off-vocabulary entities become `concept`. Templates provide starting vocabularies (Legal: party, agreement, clause, obligation…). |
| `depth` | `standard` | `lean` makes 1 pass per document (16k chars, confidence ≥ 0.6). `standard` makes up to 4 passes of 12k chars (≥ 0.5). `deep` makes up to 12 passes (≥ 0.35). Passes are spread evenly across long documents. |

Update them with a **partial** PATCH. Fields you leave out keep their value,
and the rest of the pipeline is never resent:

```http
PATCH /v1/workspaces/:ref/graph
{ "enabled": true, "domain": "Supplier contracts for a mid-size manufacturer…", "depth": "deep" }
```

`GET /v1/workspaces/:ref/graph` returns the settings, entity/relationship/
community counts, the entity-type distribution, document coverage, rebuild
estimates and the active/last job. Coverage counts each current document as
`current` (extracted with these settings), `stale` (extracted with other
settings) or `missing` (never extracted). The dashboard's workspace settings
shows the same view. The scope box shows the fallback scope, entity types are
editable chips with template presets, each depth card shows what a full
rebuild at that depth would cost and take, and the on/off switch saves
immediately.

## Progressive extraction

New uploads always extract with the workspace's current settings. The
`graph-enrich` stage extracts **one document at a time and merges it into the
workspace graph immediately**, so the graph (and graph search) grows during
long runs. Communities are re-clustered across the whole workspace once the
run's documents are in.

Per-document writes (`worker/src/graph/graph-store.ts`) are idempotent. In one
transaction under a per-workspace advisory lock, a document's chunk mentions
and edge evidence are replaced, nodes and edges upsert on their workspace keys
(`normalized_name, entity_type`, and `endpoints, predicate`), and every touched
node and edge is re-derived:

- edge weight = sum of its `kg_edge_evidence`
- node mentions = sum of its `chunk_entities`
- node documents = distinct documents from mentions and evidence

Elements no current document supports are deleted. Re-extracting a document
therefore replaces exactly its contribution, retries never double count, and
the superseded-version purge and manual deletes use the same refresh.
`kg_document_state` records which settings fingerprint (`domain`, entity types,
depth and model) each document was extracted with.

## Rebuilds with estimates and live progress

Changing settings marks earlier extractions stale. They keep serving search
until they are rebuilt:

```http
POST /v1/workspaces/:ref/graph/rebuild
{ "mode": "stale", "maxCostCents": 500 }      # or "full"
```

- **Estimate first.** The status response includes `estimates.stale`,
  `estimates.full` and `estimates.fullByDepth`, each with documents,
  extraction calls, input/output tokens, community summaries, cost and time
  (point value plus low–high range). Rates come from `COST_PER_1K_*_TOKENS`,
  the same rates the worker bills. Once documents have been extracted with the
  same settings in this workspace (or org), per-call tokens and seconds are
  calibrated from them (`basis: "observed"`, ±25–35%). Otherwise typical rates
  apply (`basis: "default"`, −50%/+100%). Time accounts for
  `WORKER_GRAPH_JOB_CONCURRENCY`.
- **Run.** `graph_jobs` are claimed by worker pollers
  (`WORKER_GRAPH_JOB_POLL_INTERVAL`) with `SKIP LOCKED` and a lease. A job
  re-reads stored chunk text (no re-parsing), extracts
  `WORKER_GRAPH_JOB_CONCURRENCY` documents at a time and merges each one, then
  re-clusters communities. After each batch it records documents, extraction
  calls, tokens, cost and a cursor, so a crashed worker's job resumes
  elsewhere once its lease expires. There is one active job per workspace.
- **Watch.** `GET .../graph/jobs/:id/events` streams `progress` events (the
  job JSON, including `etaSeconds` at the observed pace), then `done`. When
  SSE is unavailable or drops, `GET .../graph/jobs/:id` is the polling
  fallback; the dashboard switches to it automatically.
- **Stop.** `POST .../graph/jobs/:id/cancel` cancels a queued job immediately
  and stops a running one after its current batch. `maxCostCents` stops a job
  once actual spend reaches it. Documents already merged stay.

Rebuild spend is written to `usage_events` without a run, with
`metadata.workspaceId` (attributed to the workspace) and `graphJobId`.
Settings changes and rebuild start/cancel are audit-logged.

## Communities

Communities are computed over the entire workspace graph with weighted label
propagation (co-mention edges count half), which splits large connected
components into topical clusters. Level 1 groups level-0 communities by the
edges between them. Each community has a member fingerprint (`member_hash`).
Unchanged communities keep their summary, and only new ones are summarized:
by LLM up to 200 per refresh, heuristically beyond that. Summaries are matched
by full-text search; Postgres keeps no vectors (see migration 0008).
