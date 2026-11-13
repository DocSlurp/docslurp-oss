# Realtime protocol v1 (implementation contract)

Status: Node host, projections, durable-operation hookup and integration tests implemented.
Disabled by default; browser migration, council review and canary measurements remain release gates.

The first-party Node host exposes `/v1/realtime`, behind an opt-in feature
flag. Astro must attach the same upgrade adapter to its actual HTTP server.
Use one socket per tab; reference-count subscribers in the existing page store.
Uploads, mutations, generation initiation and cancellation remain HTTP operations.

## Frames

`packages/shared/src/realtime.ts` defines strict client schemas and limits.
Subscribe example:

```json
{"v":1,"type":"subscribe","subscriptionId":"selected-run","generation":1,"resource":{"kind":"run","runId":"00000000-0000-4000-8000-000000000001"}}
```

Unsubscribe carries the same subscription ID and generation, without resource.
Heartbeat is `{"v":1,"type":"heartbeat"}`. Unknown fields and versions fail.
Resources are activity/orgId, run/runId, project/projectId,
documents/projectId/page, billing/orgId, economics/orgId/page, and operation/operationId/after.
Documents use bounded pages; `after` is the last applied operation sequence.

Server resource frames carry v, type, subscriptionId, generation, resource,
epoch and revision, plus optional data/code. Types: ack, snapshot, upsert,
remove, resync-required, error. Revisions increase within a subscription
and epoch; operation output additionally preserves durable sequence identity.
A changed server epoch invalidates dashboard revisions, never operation IDs.
Snapshot replaces a collection atomically, including absent/deleted members.
Reducers reject obsolete generations and duplicate/stale revisions.

Register the listener before capturing a snapshot. Coalesce invalidations during
the read and repeat at a bounded rate until clean. Never advertise a snapshot
boundary that includes a change absent from its payload. Overflow forces resync.
NOTIFY is a wake-up signal: a shared server reconciliation mechanism must detect
missed wake-ups without browser polling. Authorization is checked before reads
and again before delivery; blocked or revoked subscriptions drop their buffers.

## Operation seam

`server/src/services/realtime-operation.ts` exports RealtimeOperationProvider,
RealtimeOperationObserver and RealtimeOperationSubscription. The durable owner
supplies subscribe with userId, resource, AbortSignal and observer. Abort/close
only detach observation. The provider owns authorization of every descendant,
persist-before-publish, replay/live boundary, retention and terminal recovery.
Expired cursors use resync with authoritative accumulated state and watermark.
Unavailable recovery returns an explicit error and never starts new paid work.
Task initiation/idempotency/cancellation and durable execution are outside this
transport module. No provider means operation subscription must fail closed.

## Security and resource budgets

Upgrade requires a live first-party session and an exact configured Origin.
Reject missing/null/hostile Origin, all Authorization/API-key credentials,
query credentials and binary input. Revalidate session/access within five seconds
and before each delivery. Billing requires explicit billing permissions.
Do not derive allowed Origin from an untrusted Host or forwarding header.

Limits: 8 KiB inbound frames, 120 messages/minute, 32 subscriptions/socket,
512 KiB snapshots, 1 MiB queued output, 15-second heartbeat. Connection admission
is bounded to 512 active/pending connections per host and eight per user,
with at most 40 authenticated connection attempts per user per minute. Slow consumers force resync/close;
never truncate terminal/delete semantics. Metrics contain counts/timing only.

Run and activity projections omit artifact maps and arbitrary diagnostic
payloads. They retain lifecycle/job/run identities, configured pipeline,
structured progress and cost rollups, stage status/errors and event identity,
message and timestamps. Numeric diagnostics use a fixed measurement allowlist;
full diagnostics remain available through authorized HTTP detail reads.
If a dashboard resource still exceeds 512 KiB (for example, a very large
configured schema or task inventory), the server sends a scoped
`error` with `code: snapshot_too_large` and detaches that subscription.
It sends no partial inventory and leaves other subscriptions connected.
The client treats this as an explicit unavailable resource, without automatic
resubscription or paid work. Operation replay and slow-consumer queue overflow
keep their existing recovery/close semantics.
Dashboard projection failures likewise detach only that subscription with the
fixed `projection_unavailable` error; they never expose the underlying cause.

## Coverage gate

| Projection | Required committed changes | Current WS coverage |
| --- | --- | --- |
| Activity/jobs | Run creation, lifecycle, parent/child membership | project_runs trigger |
| Run | Progress, completion, cancellation, retries | Run, event, run/document/page stage and performance triggers |
| Documents/viewer | Creation, update, deletion, processing/page metadata | Document, page, chunk, stage, tag and summary triggers |
| Suggestions | Curated/recent queries and corpus readiness | Query suggestion, search session, document and chunk triggers |
| Project | Settings, membership, deletion | Project, search settings, org/project membership triggers |
| Billing/economics | Attributed spend, credits, permissions | Usage, organizations, credit ledger/pending debit/lease/hold triggers |
| Operations | Output, descendants, attempts, terminal results | Shared tree signature sweep, authorized durable snapshots/replay |

Polling removal is blocked until all relevant rows have publication and negative
integration tests. Required host checks include real standalone and Astro Upgrade,
proxy idle timeout, graceful draining, revocation, overflow and reconnect races.
Canary remains disabled until independent council review and matched workload
measurements establish p95 propagation at or below two seconds within fixed budgets.

## Integration update: Node adapter and payloads (2026-11-03)

Implementation lives on `feat/realtime-core-319`, PR 278. Real Node Upgrade and
migrated-database integration tests exercise the exported host entrypoint.
Import `attachFirstPartyRealtime` from `@docslurp/server/realtime`, then call
`const realtime = attachFirstPartyRealtime(nodeServer, { operations })` once on
the actual Node HTTP server. Call `await realtime.close()` during draining.
`operations` optionally overrides the exported RealtimeOperationProvider. Otherwise,
`DOCSLURP_DURABLE_CHAT=1` wires the integrated durable provider to the actual socket
session. With that flag off, operation subscriptions fail closed. Standalone `main.ts` attaches it.
Enable server-side with `REALTIME_ENABLED=true`; exact allowed Origins come from
`CORS_ALLOWED_ORIGINS`. No Upgrade support is implied by mounting `apiApp.fetch`.

The following final projection contracts supersede the earlier generic examples:

| Resource | `snapshot.data` | Bound |
| --- | --- | --- |
| activity/orgId | `{ runs: ProjectRun[], truncated: boolean }` | 200 runs, active first then latest update |
| run/runId | ProjectRunProgressSnapshot, including recentEvents | Latest 100 lifecycle events; no durable event-history claim |
| project/projectId | ProjectRecord (`projectSchema`) | One project |
| documents/projectId/page | DocumentIndexResponse | 50 documents/page; page 0–1000 |
| billing/orgId | BillingOverview (`billingOverviewSchema`) | Owner/admin only |
| economics/orgId/page | `{ projects: [{projectId,name,documentCount,pageCount,sourceBytes,activeRuns,pagesProcessed,runtimeMs,usage}], page,hasMore }` | 50 projects/page; owner/admin only; usage from attribution service |

ProjectRun gains optional `jobId` (effective parent ID, run ID when no parent).
Keep each child's own run ID/status/progress under that parent. Activity is a
bounded inventory, not all historical runs. The run snapshot's recentEvents
is an authoritative bounded replacement window, not an append-only journal.
Do not append that window repeatedly. Older history remains an explicit HTTP read.
A resource error evicts that subscription's data (including removed runs/projects).
Collection snapshots replace missing members. Dashboard snapshots may skip revisions;
only append-only operation output uses durable replay sequence semantics.


## Consistency, reconciliation and operational limits

Migration `0114_chat_operations` owns the durable queue; `0115_realtime_revisions`
adds dashboard publication; `0116_realtime_viewer_suggestions` adds the remaining
viewer/suggestion sources and ensures triggers read scope columns only. Dashboard revisions update in the writer's transaction
and roll back with it. Multiple writes to the same organization in one transaction
produce one revision. PostgreSQL delivers the shared notification only at commit.
One batched organization-revision query per second per active host reconciles even
when every notification is lost. Expensive projections run only on changed revisions
or fresh subscriptions, keyed by user and resource; eight execute concurrently.
The organization revision row serializes concurrent writers for that organization;
production contention and latency must be measured before canary promotion.

Operations share one bounded tree-signature query per second rather than a timer
and full recovery read per subscription. Signatures include descendants and the
organization authorization revision. Changed trees load bounded recovery state;
identical user/operation/cursor reads share a result during that sweep (up to 128
cached recovery pages), while each observer still revalidates its own session.
Task summaries use one bounded query and authorize each distinct project.
Wire revisions for operation frames are independent of durable output sequences:
child-only changes must remain visible when the parent's sequence stays fixed.
Use `data.events[].sequence` and `data.watermark` for durable replay, never the wire
revision. A `resync-required` operation frame contains `{state,code}` where state is
the authoritative recovery snapshot: apply its watermark, then tail newer output.
Do not blindly repeat an expired cursor. An operation `error` evicts the subscription.

Run snapshots omit executor queries/reconciliation and project reads do not
self-title as a side effect. Run snapshots cap stage rows at 1,000 and per-document
page-progress entries at 2,000; over-limit snapshots close with an explicit resync
reason rather than silently omit state. Economics runtimeMs is the sum of completed
runs' created-to-updated wall time (includes queue/retry time), not CPU time or pure
parser throughput. Economics usage is all-time attributed project spend.

`/metrics` exports fixed-label realtime connection/subscription gauges, queued bytes,
projection reads/time, revision queries, notifications, shared-read coalescing,
resyncs, errors, fixed disconnect reasons and rejected admission counts.
REST recovery requests should send `X-Docslurp-Realtime-Fallback: 1` to increment
the authenticated fallback-request counter. It retains the existing metrics bearer
policy. Projection-read counts are not a claim about SQL statements inside each
projection; correlate with existing database telemetry for workload comparisons.

Core tests cover real Upgrade, multiple subscriptions, missed notification and
snapshot races, cross-tenant/role denial, malformed/oversized frames, admission limits,
revoked/expired cached sessions, observer detach, another-host recovery, offline child
discovery and authoritative deletion. These are local integration results, not a
production proxy-idle or throughput acceptance result. The mounted Astro host,
matched browser/CPU/memory/SQL baseline, production proxy idle/drain and canary gates
remain coordinator/app integration work. Both flags remain off by default.

## Suggestions and open-viewer processing (integration contract)

- Subscribe `{kind:"suggestions",projectId}`. Data uses the existing
  `/v1/suggest?project=…&limit=8` shape: `suggestions`, `contextualSuggestions`,
  optional `contextualPending`, and `semantic:{status,indexedChunkCount,
  completedDocuments,totalDocuments}`. Arrays are capped at eight strings of
  1,024 characters. Shared validator: `realtimeSuggestionsSnapshotSchema`.
  It reads existing query/curated/document-heading data only; observation never
  initiates generation or a paid model call. Prefix-specific suggestion searches
  remain explicit HTTP requests.
- Subscribe `{kind:"viewer",documentId}`. Data is a processing patch using the
  inspector endpoint's field names, validated by `realtimeViewerSnapshotSchema`:
  `document` (identity, status, title/reason, page count, version/supersession and
  updatedAt), `tags`, `stages` (stage_name/status/attempts/error/updated_at),
  `pageStats`, `run`, and `usage`. Stages are capped at 64; no text, page bytes,
  storage keys, signed URLs, source objects, artifact bodies, stage stats or
  changelog bodies are streamed. Bootstrap the existing full viewer once, then
  merge these fields and preserve fetched artifact/source/version data. Stage
  updates merge by stage_name. User-requested artifacts/version changes retain
  explicit authorized HTTP reads; do not fetch the full viewer on every snapshot.
  Removed/revoked documents produce a scoped error and clear the open viewer.

Both resources authorize project membership before reads and delivery, share
broker coalescing, and reconcile commit-visible revisions. Publication covers
query_suggestions, search-session queries, document/page/chunk changes, document
stages, tags, run state and attributed usage. Keep the old component timers only
while the feature flag is off or the shared transport owns REST fallback.

## External work discovery (migrations 0117–0119; native lifecycle)

Operation recovery now includes `dependencies` alongside executable chat `tasks`.
Each dependency has stable `id`, `parent_id`, `root_id`, `run_id`, project/org
scope, `status`, run execution-generation `attempt_id`, maximum `page_attempts`,
`stage`, `control_state`, `ready_pages`, `failed_pages`, document/page `result_ref`,
and `revision`. References grant no access: every dependency project is
reauthorized before the recovery response. Fetch artifacts through the existing
authorized document endpoints. The global operation reconciler includes new
links and deadline transitions; committed page ledger changes advance the org
revision. No per-dependency browser or backend timer is created.

`treeSettled` includes these dependencies even after the parent answer completes.
A deduplicated run placeholder is not a completed result: its attempt is null
and it waits for the authoritative shared page ledger. Failed pages do not hide
other pending pages. After the existing 15-minute workflow deadline an unresolved
dependency reports `interrupted`, without starting another paid execution.

Ownership is explicitly `shared`, cancellation is `observe_only`. Chat Stop
cancels chat tasks and refuses future dependency acceptance under the root lock;
already accepted materialization serves the corpus, possibly multiple queries,
and stays under its independent Temporal owner, page locks, spend caps and
workflow timeout. It is not cancelled by socket cleanup, parent completion or
chat cancellation. There is no silently detached agent task. Outstanding links
count against the eight active-root limit; chat tasks plus links share the
64-node tree limit and each link has at most 256 pages. History follows the
root's seven-day retention; underlying corpus results follow document retention.

`withChatRunOwner` and `acceptChatRunDependency` are server-only adapter seams.
Acceptance and run allocation commit atomically; input tool arguments cannot
supply operation identity. Recovery never launches work. A process dying between
allocation and Temporal dispatch leaves an interrupted dependency after the
bounded owner deadline; this is not claimed to be uninterrupted execution.

Path audit: `chat-mcp-tools.ts` excludes upload, extract, completeUpload,
ingestWebsite and fullIndex. The missing extract exclusion was repaired because
it violated the existing no-paid-ingestion tool policy. `mcp-catalog.ts` offers
no render/export launch tool. Rendering starts from `document-page-render.ts`
and exports from `document-exports.ts`/`extracts.ts`, under independent HTTP/job
owners; these are not launched by chat. Deferred search's
`materialize-client.ts` is the actual chat-to-Temporal path and now uses the seam.
No arbitrary subagent launch pathway exists. Do not invent such work to satisfy
a task-tree display. Native Mastra BackgroundTaskManager now owns first-party operation lifecycle;
this adapter checkpoint is not final issue319 acceptance.

## Native operation adapter (integrated, flags disabled)

POST /v1/chat/operations binds idempotency and trusted tenant scope, then enqueues
exactly one native BackgroundTaskManager task under that binding. The separately
supervised executor registers a static project-chat tool. Neither the socket nor
the HTTP response owns its abort signal. New operations do not use the legacy SQL
claim loop. Native PostgresStore owns task state/results and native indexed
PubSub/cache owns replay; DocSlurp adds authorization, output quotas and explicit
resync responses.

The public operation envelope retains id, root_id, project_id, org_id, status,
attempt_id, sequence and snapshot. Every task summary carries its own project_id
and root_id; dependencies retain independent shared-run attempt/status/result
references. treeSettled is false while any native child or shared materialization
is active, even if the answer is completed. Public sequence is native event index
plus one, including text, tool and terminal events. Final native results retain
citations and tool outcomes after replay-cache expiry. Missing active history is
an explicit recovery failure, never a new generation.

The shared operation sweep uses one SQL signature query across watched roots and
bounded native retained-list length reads per task, independent of socket count.
It reads output only for changed signatures/cursors and coalesces same-user reads.
No per-socket SQL reconciliation timer was introduced.

The idle resource watchdog remains independent of query completion. Fresh session
and batched resource sweeps run within the five-second revocation bound; normal
delivery still authorizes immediately. First-party session revalidation uses one
live SQL policy query after the initial BetterAuth Upgrade. No settled grants are
cached, so membership changes require no cache-invalidation guess.

Runtime requirements: migrations through 0120 and an explicitly configured durable
shared Redis connection (MASTRA_REDIS_URL, falling back to API_RATE_LIMIT_REDIS_URL).
REST-only rate-limit Redis credentials are not sufficient. No infrastructure,
provider migration or flag activation is performed by these changes. The chosen
Redis persistence, memory/eviction policy and production proxy must be validated
before activation. See realtime-mastra-assessment.md for installed API evidence
and the distinction between existing project chat logic and native ownership.

### Revision publication and ingestion lock independence

Migration 0153 adds a `scope` to every counter: `''` is the organization (written
on every change, exactly as before, and the only scope `realtime_revisions` reads),
`project:<id>` and `run:<id>` are written alongside it by the same triggers for a
change's project and run. `realtime_scope_revisions` aggregates them. The broker
(`realtime/broker.ts`) re-projects `project`, `documents` and `suggestions`
subscriptions only when their project scope moves and `run` subscriptions only when
their run scope moves; `activity`, `billing`, `economics`, `viewer` and `page-image`
still follow the organization revision. Every subscription is still re-authorized
whenever the organization revision moves (membership, sharing and project changes
all move it), so authorization is checked as often as before. Folded per-scope
checkpoints are kept (one row per project and run); the compactor folds them with
the organization's counters under the same 256-row bound.

Page, chunk and page-stage rows (`document_pages`, `document_chunks`,
`page_stage_states`) arrive thousands per statement, so from 0153 they publish
through statement-level triggers with transition tables
(`realtime_statement_changed()`, triggers `realtime_changed_insert`, `_update`
and `_delete`): one pass over the statement's distinct documents and runs, then one
counter row per distinct organization and scope. The counters written are the ones
the row trigger left behind (every row after the first of a transaction was already
a no-op), so each affected scope still moves by one per transaction and a statement
that changes no row moves nothing. A 20,000-row chunk insert spent about 1.5 s in
the row trigger and spends about 10 ms in the statement trigger. Every other source
table keeps its row trigger.

Migration 0120 preserves `realtime_revisions` as an aggregate read view while
writers insert one counter per organization/transaction. Independent transactions
no longer update a shared organization row. A nonblocking advisory try-lock allows
one publisher to fold up to 256 already-committed counters into a checkpoint;
other publishers append without waiting. Active transaction rows are invisible to
that compactor, and committed rows are never written again by their producer.
All counter changes and NOTIFY remain transactional, so rollback removes both the
change and notification. Readers see a monotonic committed sum, including when
transactions commit out of order. Normal sequential publication retains only the
checkpoint and current transaction counter. Long transactions can defer compaction;
monitor outstanding counter rows and include them in capacity testing rather than
claiming a fixed row bound under arbitrary transaction duration/concurrency.

Publication capabilities are confined to validated triggers owned by the isolated
non-login publisher role; runtime roles cannot directly mutate counters or invoke
arbitrary-org publication. See `self-host/database-roles.md` for provisioning.
The API startup shared by standalone and mounted hosts starts an independent
five-second compaction task, even without subscribers or new tenant writes. Each
pass visits at most 16 organizations using a keyset cursor over a partial index
that excludes settled checkpoints, and folds at most 256
rows per organization. A long publisher transaction makes its org's try-lock
fail; later passes retry after release. A finite backlog drains without another
tenant write; arbitrary sustained ingress above maintenance throughput is not a
fixed storage bound. The interval adds one SQL statement per API process per five
seconds, with at most one dedicated connection (closed after one idle second),
a 500ms acquisition deadline, 1s statement timeout and 1.5s client query timeout.
It never runs per observer, per read or per event. Maintenance exports query,
folded-row and failure counters; include this additional load in capacity gates.

### Organization canary

Optionally set `REALTIME_CANARY_ORG_IDS` to 1–16 comma-separated organization
UUIDs on the API. Existing global flags still apply. An omitted value preserves
the global rollout contract; an empty, malformed or oversized value fails closed
and is rejected when the first-party host attaches. No wildcard is supported.

Upgrade and ongoing socket validation require fresh membership in a listed,
undeleted organization. Dashboard subscriptions and operation trees must belong
to listed organizations. New native launch, child launch and retry admission also
require membership in their authorized project's listed organization. The cohort
is an additional restriction, never a replacement for session, MFA, project,
owner, deadline or billing checks. It does not enable API-key socket access.

Accepted task execution retains its existing policy after cohort changes.
Authorized HTTP discovery, recovery and Stop remain available while the durable
feature is enabled, so shrinking the canary cannot strand an accepted task.
Browser hosts should combine their build flags with an explicit server-rendered
eligibility marker; the marker grants no server authority.
