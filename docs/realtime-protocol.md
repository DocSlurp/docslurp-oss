# Realtime protocol v1 (implementation contract)

Status: contract only; the WebSocket host and projections are not yet implemented.
Do not retire SSE or polling based on this document.

The first-party Node host will expose `/v1/realtime`, behind an opt-in feature
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
documents/workspaceId/page, billing/orgId, and operation/operationId/after.
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
also needs process-wide and per-user bounds. Slow consumers force resync/close;
never truncate terminal/delete semantics. Metrics contain counts/timing only.

## Coverage gate

| Projection | Required committed changes | Current WS coverage |
| --- | --- | --- |
| Activity/jobs | Run creation, lifecycle, parent/child membership | Pending |
| Run | Progress, completion, cancellation, retries | Pending |
| Documents | Creation, update, deletion, ordering | Pending |
| Workspace | Settings, membership, deletion | Pending |
| Billing | Attributed spend, credits, permissions | Pending |
| Operations | Output, descendants, attempts, terminal results | Separate durable owner |

Polling removal is blocked until all relevant rows have publication and negative
integration tests. Required host checks include real standalone and Astro Upgrade,
proxy idle timeout, graceful draining, revocation, overflow and reconnect races.
Canary remains disabled until independent council review and matched workload
measurements establish p95 propagation at or below two seconds within fixed budgets.
