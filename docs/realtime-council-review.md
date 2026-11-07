# Realtime council review evidence

Status: implementation and reviews in progress; not merge approval.

## Security Paranoid — GPT-6-astra, integrated core 5b2dc6d5

- High: activity delivery checked organization membership but could expose a
  captured private-project run after project membership removal. Repair:
  authorize the bounded set of constituent project IDs again before delivery;
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

Review of frozen `f10b6e86` identified a high-severity gap: shared materialization acceptance checked task lease/cancellation but not the originating session or current project authority after waiting for the root lock. Both execution adapters now carry the trusted session identity and abort signal. Acceptance uses the same transaction to revalidate the session and existing project-access policy immediately before allocation, and checks abort before dispatch. Existing accepted shared work retains its documented independent lifecycle.

Validation: eight dependency tests pass on isolated PostgreSQL 17 with five connections. Deterministic contention tests hold the root lock, confirm acceptance is waiting, revoke the session or org membership (or abort), then release the lock; each produces zero allocated runs and dependency records. Server TypeScript passes. The disposable database was removed. Independent security recheck remains required.

## Recurring native recovery and shutdown delta (2026-11-03)

Preserves trusted-session and locked materialization reauthorization at a413bb75.
Reliability findings addressed: a live idle worker now discovers unowned pending
work after lost dispatch, and rescans running leases first created after its own
startup. Mastra 1.81 lacks a public recurring full-recovery entrypoint; the bounded
adapter uses public native storage CAS and pending-only restart, not private APIs
or a replacement queue. Expired/cancelled bindings settle without execution.
Native running-task recovery never invokes the executor or consumes paid retries.

Shutdown policy is immediate interruption with retained output, explicitly not a
300-second completion drain. Native SIGTERM settlement is tested separately from
SIGKILL lease recovery. Host cleanup allowance should be at least 30 seconds;
Mastra's settlement budget is explicitly five seconds. App host configuration is
owned by the app change, and no flags or deployments are enabled here.

Validation: 15 tests passed across five suites under strict unhandled-rejection
handling, including eight real PostgreSQL17/Redis7 runtime/process tests. The
surviving worker starts before the future owner; live work remains running across
multiple recovery ticks; SIGKILL yields failed/interrupted and SIGTERM cancelled,
both preserving text with retryCount=0 and no survivor executor invocation.
Pending dispatch tests use no repeated POST/restart, including expiry and root
cancellation with zero executor calls. Authorization/output regression suites and
server TypeScript checking pass. No paid providers or production services used.

Final independent delta review is still required. Production Redis persistence,
proxy/rolling-deployment behavior and capacity acceptance remain separate gates.
The two-second per-worker native list scan adds bounded SQL work even when idle;
prior dashboard-only matched-load evidence does not include this new worker scan.

## Recovery I/O and process shutdown repair

Both independent findings are addressed: lock-held native restart could wait on
another pool or Redis indefinitely; native CAS could block outside SET LOCAL;
shutdown awaited the sweep before starting its own budget. Recovery now uses
attempt-owned native producer/storage/Redis resources with a three-second deadline,
500 ms connection acquisition, one-second SQL statements, abortable Redis commands
and connection destruction. Native claim/restart fencing is retained. The old
HTTP pending redispatch path is removed; retries return the original handle.
Native shutdown starts concurrently with recovery cancellation. A five-second
host deadline destroys Redis I/O, and the actual executor entrypoint separately
enforces the same encompassing process exit deadline, including global clients.
This is interruption, not a completion drain or an automatic paid retry.

Keyset selection replaces offset pagination. A fixed creation-time horizon bounds
each pass against continued ingress; contended candidates advance the cursor and
are revisited next pass. A real-DB 130-task test holds the first row, deletes
completed rows and adds arrivals while verifying later-page progress and revisit.

Validation uses isolated PostgreSQL17 and Redis7, strict unhandled-rejection mode,
and the registered database CI harness (no skipped native integration files).
Real Redis CLIENT PAUSE tests cover handshake outage and a paused write that times
out without SIGTERM: cancellation unblocks, the same worker makes later progress,
and resuming Redis produces no late dispatch. Other process tests exhaust the
executor pool and block native CAS with an external row lock. Prior pending/lost
ACK, surviving-worker SIGKILL, explicit Stop, tenant authorization and retained
output regressions remain included. Final independent council review, production
bundle/capacity/Redis/proxy prerequisites and authorized rollout remain coordinator
gates; this repair does not activate either feature flag.

Final local verification for this delta: 23 distinct tests passed—16 native
integration tests (native-host 2, runtime 6, worker/process 8) through the database
CI runner with zero skips, plus 7 policy/idempotency/output regressions. Server
TypeScript and public-history checks pass. The actual executor entrypoint test
imports the production script, observes worker readiness, sends SIGTERM, and
measures exit, rather than substituting a fixture's process cleanup.

Measured final process evidence (milliseconds, isolated local services):

| Fault / process | Host close | Recovery SQL connections gone / process observation |
| --- | ---: | ---: |
| Redis paused (all commands) | 5005 | 5038 |
| Redis writes paused; prior attempt timed out and later sweep progressed | 3039 | 3083 |
| Executor pool exhausted | 974 | 1013 |
| Native CAS blocked by external row lock | 90 | 1003 |
| Actual executor entrypoint, SIGTERM | — | exit 1084 |

PostgreSQL may retain a disconnected blocked waiter until its one-second server
statement timeout fires; the test checks that it disappears within that bound.
The bounded recovery pool is recreated per attempt (at most three connections),
so connection churn must be included in the coordinator's capacity gate. These
numbers prove the local failure cases, not production proxy/network behavior or
full workload-budget acceptance. No paid providers, production traffic, feature
activation or deployment were used for this verification.

## CI database role and trigger locking repair

CI run 41737838621 had two distinct causes: the role drift guard found four
unclassified relations, and database job 126271520215 timed out in the existing
retry-first pending supersession test. The latter was caused by unrelated
same-organization writes contending on the realtime revision row, not by the
retirement code's Run-lock policy. Its three-second timeout is unchanged.

Migration 0120 replaces that write hotspot with transaction-owned counters and
nonblocking compaction, preserving the aggregate revision reader contract and
commit-only notifications. Ingestion workers are explicitly denied all chat
identity/output/dependency tables and the aggregate API view. The first repair
granted counter DML to ingestion; the council rejected that permission below.
Tests exercise actual run,
document and materialization writes as the worker, negative permissions, repeated
write coalescing, compaction, and concurrent out-of-order commit/rollback. No
relaxed CI skip/timeout/budget was introduced. The initial invoker-only design
is superseded by the constrained definer repair below.
This migration/permission delta requires the coordinator's security review before
merge. The reviewed native recovery implementation is unchanged.

The audit additionally found native-schema grants missing from role reconciliation.
The application role now receives usage/DML/sequence access to the migrated
`docslurp_mastra` schema without CREATE; ingestion-worker and PUBLIC grants there
are revoked. A negative test grants the worker access deliberately, reconciles,
and verifies it is denied again. The full server run also exposed a stale
suggestion-route fixture: it lacked the shared projection's project-access
result. The fixture now models authorized access and adds a denial-before-read
case; production authorization behavior was not changed.

Local verification of this delta: all 34 registered database/Redis integration
files passed with zero skipped tests against PostgreSQL 17 and Redis 7. The
original pending-supersession suite passed all three tests, retaining its original
three-second statement timeout. The focused permissions, suggestions and revision
suite passed 27 tests. The full server suite (`vitest run --bail=0`, which only
disables early stopping) passed 3,674 tests across 346 files; its usual 104 gated
tests were skipped there and the registered service-backed suites ran separately
through the database harness above. Server `tsc --noEmit`, the shared-package
build, and the database migration/credit checks passed. The standalone database
script's optional native contention branch was not enabled in that invocation;
the real PostgreSQL harness ran the registered contention suites without skips.
Remote CI and the coordinator's final council remain separate gates.

### Migration-safety annotation (no executable SQL change)

CI run 41742548170 rejected migration 0120's table rename. At the freshly fetched
main baseline `e6d2e6bdfdd3b8a9c2aeaff4ed7be03ea222168e`, `git grep` finds no
`realtime_revisions` references in server, worker or packages. Migration 0115
creates that relation only in this unreleased PR; it is not an N-1 relation being
removed. Migration 0120 now records this evidence using the existing gate's
documented `destructive-migration` annotation. The gate and executable SQL remain
unchanged.

For rolling compatibility, prior-main application queries do not use this new
relation. Its ingestion writes still invoke the database trigger functions, whose
bodies are replaced by 0120 and their constrained owner supplies counter access.
Candidate readers retain the `realtime_revisions` name and columns through
the aggregate view. The migration runner applies the migration through Drizzle's
PostgreSQL transaction, so readers do not observe a committed rename without its
replacement view/functions. This establishes compatibility with the previous main
schema, not support for deploying an arbitrary intermediate commit of this PR.
No production deployment was inspected or performed for this annotation.


### Council follow-up: publication capability and maintenance

The adversarial review correctly found that numeric counter DML still allowed a
worker to forge/reset another tenant's revision or overflow a bigint. Removed
that grant for both runtime roles. A dedicated non-login, non-inheriting publisher
owns only the publication functions, has counter DML and three narrow identity
lookup grants, and no runtime role may assume it. Public trigger entrypoints use
SECURITY DEFINER with exact source validation; fixed search paths and qualified
references prevent temp/schema shadowing. PUBLIC and runtime EXECUTE are revoked
on trigger and internal arbitrary-org helpers. Only the API may invoke the
bounded compactor, which derives sums from already-committed counters rather than
accepting a revision. Provisioning requirements are explicit in database-roles.md.

The reliability review found the view/grant cutover gap and a finite-burst
compaction backlog. Migration 0120 now installs default optional runtime grants
atomically with the schema change; reconciliation cannot re-expose internals.
Already-connected restricted PostgreSQL sessions are tested immediately after
COMMIT without reconciliation. Independent bounded maintenance drains counters
after a long transaction releases its lock without another write. It retains
try-lock/SKIP LOCKED publication independence and advances through organization
pages. This adds one maintenance statement per process per five seconds, not
per observer or event; capacity accounting must include it.

This is a substantive security delta from a00e087d and needs fresh independent
review. Native recovery/execution behavior remains unchanged. No activation,
merge, paid provider calls or deployment was performed.

Validation: all 35 registered PostgreSQL/Redis files passed with zero skips on
the final indexed migration, including the original three-second supersession
regression and all eight native process recovery tests. The focused final
publication suite passed five real PostgreSQL tests: session-cutover grants,
actual worker denial, long-transaction burst drainage with no further writes,
35-organization paging, and recovery after an idle connection is terminated.
The 300-write fixture verifies the reader's execution plan returns to one
checkpoint row after asynchronous drainage; its accelerated 20ms test timer does
not claim production five-second cadence latency. Role/revision tests passed
23 cases, and the full server suite passed 3,677 tests (its gated tests run in
the separate real-service harness). Server TypeScript and all nine migration
safety/registration guard tests passed. The new gated file is registered in
`scripts/run-database-tests.mjs`.

One initial full database run overlapped the full server suite and failed the
native pool-outage test's child readiness deadline before fault injection; the
other 34 files passed. The full database rerun without that competing server
workload passed all 35 files without changing readiness/shutdown timeouts or
assertions. The pool-outage shutdown/release measurements on that rerun were
996ms/1,062ms. This records the initial failure rather than erasing it with the
rerun; production capacity and final remote CI remain coordinator gates.

Before publishing, merged fresh main `bcec22ef2717afab35ef9cc4ada6fa254b82d917`
(documentation/comments only). It still has no realtime revision schema or
server/worker/package references; the N-1 rename-safety conclusion is unchanged.
The migration and registration gates passed again after the merge.
