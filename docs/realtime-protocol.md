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
Resources are activity/orgId, run/runId, workspace/workspaceId,
documents/workspaceId/page, billing/orgId, economics/orgId/page, and operation/operationId/after.
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

## Coverage gate

| Projection | Required committed changes | Current WS coverage |
| --- | --- | --- |
| Activity/jobs | Run creation, lifecycle, parent/child membership | workspace_runs trigger |
| Run | Progress, completion, cancellation, retries | Run, event, run/document/page stage and performance triggers |
| Documents/viewer | Creation, update, deletion, processing/page metadata | Document, page, chunk, stage, tag and summary triggers |
| Suggestions | Curated/recent queries and corpus readiness | Query suggestion, search session, document and chunk triggers |
| Workspace | Settings, membership, deletion | Workspace, search settings, org/workspace membership triggers |
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
| activity/orgId | `{ runs: WorkspaceRun[], truncated: boolean }` | 200 runs, active first then latest update |
| run/runId | WorkspaceRunProgressSnapshot, including recentEvents | Latest 100 lifecycle events; no durable event-history claim |
| workspace/workspaceId | WorkspaceRecord (`workspaceSchema`) | One workspace |
| documents/workspaceId/page | DocumentIndexResponse | 50 documents/page; page 0–1000 |
| billing/orgId | BillingOverview (`billingOverviewSchema`) | Owner/admin only |
| economics/orgId/page | `{ workspaces: [{workspaceId,name,documentCount,pageCount,sourceBytes,activeRuns,pagesProcessed,runtimeMs,usage}], page,hasMore }` | 50 workspaces/page; owner/admin only; usage from attribution service |

WorkspaceRun gains optional `jobId` (effective parent ID, run ID when no parent).
Keep each child's own run ID/status/progress under that parent. Activity is a
bounded inventory, not all historical runs. The run snapshot's recentEvents
is an authoritative bounded replacement window, not an append-only journal.
Do not append that window repeatedly. Older history remains an explicit HTTP read.
A resource error evicts that subscription's data (including removed runs/workspaces).
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
Task summaries use one bounded query and authorize each distinct workspace.
Wire revisions for operation frames are independent of durable output sequences:
child-only changes must remain visible when the parent's sequence stays fixed.
Use `data.events[].sequence` and `data.watermark` for durable replay, never the wire
revision. A `resync-required` operation frame contains `{state,code}` where state is
the authoritative recovery snapshot: apply its watermark, then tail newer output.
Do not blindly repeat an expired cursor. An operation `error` evicts the subscription.

Run snapshots omit executor queries/reconciliation and workspace reads do not
self-title as a side effect. Run snapshots cap stage rows at 1,000 and per-document
page-progress entries at 2,000; over-limit snapshots close with an explicit resync
reason rather than silently omit state. Economics runtimeMs is the sum of completed
runs' created-to-updated wall time (includes queue/retry time), not CPU time or pure
parser throughput. Economics usage is all-time attributed workspace spend.

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

- Subscribe `{kind:"suggestions",workspaceId}`. Data uses the existing
  `/v1/suggest?workspace=…&limit=8` shape: `suggestions`, `contextualSuggestions`,
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

Both resources authorize workspace membership before reads and delivery, share
broker coalescing, and reconcile commit-visible revisions. Publication covers
query_suggestions, search-session queries, document/page/chunk changes, document
stages, tags, run state and attributed usage. Keep the old component timers only
while the feature flag is off or the shared transport owns REST fallback.
