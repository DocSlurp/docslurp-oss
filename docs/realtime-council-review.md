# Realtime council review evidence

Status: implementation and reviews in progress; not merge approval.

## Security Paranoid — GPT-6-astra, integrated core 5b2dc6d5

- High: activity delivery checked organization membership but could expose a
  captured private-workspace run after workspace membership removal. Repair:
  authorize the bounded set of constituent workspace IDs again before delivery;
  missing collection authorization support fails closed.
- Medium: unrelated successful session checks could extend a stalled resource
  verification sweep forever. Repair: track the last completed resource sweep
  independently and close on its deadline.
- Medium: timed-out Upgrade authentication retained the pending connection
  reservation. Repair: exactly-once cleanup on timeout, close and settlement,
  cancellation signal, and a separate cap of 32 outstanding authentication calls.
  Non-cooperative providers retain their work slot until settlement, so timeout
  cannot create unbounded abandoned authentication work. Better Auth lookup itself
  has no cancellation API; later lookup phases stop on abort and the explicit
  database liveness query is cancelled. Existing connections share concurrent
  session checks within each socket.

Validation: 40 focused socket/backend/operation/auth tests passed. Regression
cases cover membership removal during projection, a stalled resource alongside
healthy session checks, 544 timed-out cooperative authentication attempts followed
by a successful connection, and capped abandoned work for an uncooperative provider.
The adapter also prevents a stale revocation callback removing a newer subscription
generation. Independent final recheck remains required.

## Native ownership and authorization batching delta awaiting council

After the earlier reviewed security fixes, the integrated branch replaces new
first-party chat claim/replay ownership with native Mastra1.81 background tasks,
PostgresStore and indexed persistent PubSub/cache. Review the new agent-runtime
adapters, migrations0118–0119, existing Temporal allocation linkage and session
revalidation/batched authorization changes independently; earlier approvals do
not cover this delta.

Local evidence: 149 affected server tests passed with strict unhandled rejection
handling (six optional integration tests skipped in that command), followed by
real PostgreSQL17/Redis7 tests covering signed BetterAuth sessions on the built
Astro host, native HTTP idempotency, API-host recreation, explicit Stop, shared
materialization settlement and a separate worker SIGKILL with real lease expiry.
A further targeted run passed17 tests (two legacy concurrency opt-ins skipped),
including dropped native dispatch recovery without duplicate execution, active
root reactivation admission, and native bindings excluded from legacy claims.
Shared/SDK builds, final server tsc and all11 shared protocol tests passed.
Final native replay checks also cover authoritative terminal resync after a
retained-history gap.

Dashboard matched idle SQL fell896→43 versus legacy89; progress826 versus722,
burst140 versus1215 and reconnect154 versus100. Raw workload, CPU/RSS/query
attribution and limitations are in realtime-local-workload.md. Do not infer full
capacity acceptance from the idle fix. Flags remain off; no merge/deployment.

## Final adversarial review repairs (2026-11-03)

Review of frozen `f10b6e86` identified a high-severity gap: shared materialization acceptance checked task lease/cancellation but not the originating session or current workspace authority after waiting for the root lock. Both execution adapters now carry the trusted session identity and abort signal. Acceptance uses the same transaction to revalidate the session and existing workspace-access policy immediately before allocation, and checks abort before dispatch. Existing accepted shared work retains its documented independent lifecycle.

Validation: eight dependency tests pass on isolated PostgreSQL 17 with five connections. Deterministic contention tests hold the root lock, confirm acceptance is waiting, revoke the session or org membership (or abort), then release the lock; each produces zero allocated runs and dependency records. Server TypeScript passes. The disposable database was removed. Independent security recheck remains required.
