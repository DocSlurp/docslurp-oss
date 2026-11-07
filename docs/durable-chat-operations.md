# Durable chat operations (issue 319)

This is an opt-in execution path, disabled by default. Apply migrations through
`0119_native_operation_bindings`, run a dedicated executor with
`pnpm --filter @docslurp/server exec tsx scripts/chat-operation-executor.ts`, and
set `DOCSLURP_DURABLE_CHAT=1` on the API. Do not enable without the executor.
No provider calls run in an HTTP request or WebSocket callback.

Session-authenticated HTTP endpoints under `/v1/chat/operations`:

- `POST /` accepts `{q, project?, sessionId?, model?}` with an
  `Idempotency-Key` of 8–128 ASCII letters, digits, underscores or hyphens.
  Returns 202 `{operationId,rootId,status}`. Retry the same input/key after a
  lost acknowledgement; the SQL owner lock and unique key return the original
  operation. Changing input under that key is refused.
- `GET /` discovers the latest 64 retained, authorized roots.
- `GET /:id?after=N` returns the operation, accumulated snapshot, ordered
  events after the last applied cursor, sequence watermark, `hasMore`, and an
  authorized task summary list with `treeSettled`. Continue bounded replay
  while `hasMore`. A future or unavailable cursor explicitly sets `resync` and
  returns accumulated state. Do not append the snapshot and events twice.
- `POST /:id/cancel` accepts `{scope:"task"|"tree"}`. Tree cancellation requires
  the root, records intent under its lock, covers existing children and refuses
  future launches. Repeat commands are harmless. Observation has no cancel API.

`authorizedChatOperationSnapshot` is the shared HTTP/socket recovery adapter.
`createChatOperationProvider(resolveActor)` structurally implements PR278's
`RealtimeOperationProvider`. Pass a callback that revalidates the **current
socket's session**, including revocation, not a user lookup or cached actor.
Close/abort only detaches observation. Every delivery checks project and
owner again. Descendants are individually authorized. The integrated provider uses one shared tree-signature sweep per second, including
missed notifications and offline descendant changes, then coalesces identical
user/operation/cursor reads. The socket host bounds connections/subscriptions and
revalidates the actual socket session. See `realtime-protocol.md`.
Lifecycle snapshots include terminal errors even with no remaining text.

New first-party operations use native Mastra BackgroundTaskManager, native
PostgresStore and indexed Redis PubSub/cache. Apply migrations through
0119, configure an existing durable shared Redis instance with MASTRA_REDIS_URL
(or the existing API_RATE_LIMIT_REDIS_URL), and supervise the dedicated executor
only after review/authorization. Missing shared transport fails closed. Flags
remain disabled. See [native reassessment](realtime-mastra-assessment.md).

The SQL operation row is now an application binding: tenant/root/project,
idempotency, deadline, cancellation intent and quota counters. Native storage owns
task/attempt state, leases, timeouts, results and zero-retry worker recovery.
The executor reconstructs the existing project-chat policy and usage ledger
from trusted scope. Its lifetime is unrelated to HTTP responses and sockets.
Session, MFA, membership and cancellation are checked during execution; accepted
output is fenced under the root cancellation lock and native lease before native
cache publication. An interrupted provider execution is not silently restarted.

Each user may have eight active roots, including roots with active descendants
or shared Temporal dependencies after the answer completes. Trees have at most
64 task/dependency references, a ten-minute deadline, 512 KiB accepted output
budget and 256 KiB per task. Native host concurrency is bounded to eight; native
task retries default to zero. Native attempt identity includes task ID and retry
count. No arbitrary subagent/retry launcher exists in the current tool surface.

Replay pages have at most 256 indexed events. Public sequences are native indices
plus one, including non-text events. Native cache append precedes delivery.
Snapshots include accumulated text, tool outcomes and final citations, plus
authoritative project_id/root_id and independent treeSettled. Expired/future
cursors resync from the retained final result; missing active history is explicit
failure. Recovery does not launch work. Native task/cache and application binding
retention is seven days; the worker removes expired application bindings in
bounded hourly batches. No credentials are persisted in client references.

The actual chat-launched external pathway is deferred page materialization.
Its existing run allocation links an authorized shared dependency under the
operation root. Root cancellation refuses future launches but does not cancel
already accepted shared corpus work. Page-ledger completion, retries, waiting and
result references remain visible after the parent answer completes.
Ingestion/extract, render and export HTTP jobs retain their independent Temporal
owners. The chat tool allowlist excludes extract/upload/fullIndex; no render or
export tool exists. There is therefore no chat-launched render/export operation
to fabricate. Their standalone observation integration remains an explicit
application coverage item. See realtime-protocol.md for exact source pathways.

The old queue/journal implementation and its repair history below are retained
as evidence and a read adapter for already persisted legacy operations. New HTTP
launches and the dedicated executor do not use its claim/lease loop. This is not
a claim of production worker restart or proxy acceptance; final council review
and production supervision/canary remain separate gates.

## Interim council review and repairs

The independent adversarial review of `4271271d` found three issues: the
non-agent provider path missed the executor abort context; cancellation could
lose to a result append between heartbeats; and ignored evidence/tool callbacks
could leave a derived rejected promise unhandled. The follow-up establishes the
existing deferred execution context, enforces cancellation/deadline in the locked
append transaction, and returns the already-observed persistence promise.

Regression evidence: 88 tests across chat-operations.db and project-chat pass
with `NODE_OPTIONS=--unhandled-rejections=strict`. They include cancellation during
real non-agent retrieval/generation boundaries (mocked providers), committed
cancel/deadline versus late result, and rejected evidence persistence. This is an
interim repair record, not final council approval or end-to-end acceptance.

The independent reliability review also found final answers charged twice after
streaming. Final events now reference the retained text; recovery reconstructs
the original result. Large snapshot/replay combinations explicitly resynchronize
at the authoritative watermark within the response budget. The cancellation
recheck found deferred page-query embeddings omitted the executor signal; both
hosted and private embedding requests now combine cancellation with their timeout,
check before dispatch, and propagate cancellation through deferred search.

Validation for these repairs: 148 tests passed against ephemeral PostgreSQL 17,
using five client connections and strict Node unhandled-rejection handling. Tests
hold the root lock while cancellation/result appends contend and while a deadline
expires. A 240 KiB streamed answer completes and recovers without duplicate stored
answer text or an oversized recovery envelope. Embedding tests cover cancellation
during model/spend lookup and before/during provider dispatch. No provider calls or
production traffic were used; the ephemeral database was removed afterward.

A subsequent adversarial recheck cleared the above repairs and identified map
routing as a sibling cancellation gap. Router calls now receive the owner signal,
check it after spend admission, and pass it to generation. Deferred search checks
cancellation even when the map locator degrades a provider error. The audit also
added checks before materialization run/workflow creation, so cancellation during
spend admission or run creation does not launch a new paid workflow. Already
accepted workflows retain their independent ownership. The three affected routing,
deferred-search and project-chat suites pass 139 tests under strict rejection
handling, including the new spend/create/dispatch races.

## Worker shutdown policy (native runtime)

SIGTERM/SIGINT deliberately interrupt active native chat work immediately. They
are not a 300-second answer-completion drain. Mastra 1.81 `shutdown()` aborts
active controllers, persists cancellation/terminal state and allows up to its
five-second settlement window before transport teardown. Accepted output remains
available to authorized recovery; no model/tool execution is automatically retried.
A cancelled native task during worker shutdown is an interrupted answer, not proof
that the user pressed Stop. If graceful settlement fails, the surviving worker's
recurring lease reconciliation marks the expired execution failed/interrupted.
SIGKILL has no settlement opportunity and always relies on that lease path.

Host configuration should send SIGTERM and allow at least 30 seconds before
SIGKILL for shutdown/storage/transport cleanup; that timeout is cleanup allowance,
not a promise to finish generation. Restarted observers retain partial output and
show the authoritative terminal state. Rolling replacement may interrupt active
answers; keep the feature off until this product policy and production Redis
persistence are approved. Browser disconnect/unsubscribe still only detach.

The local process integration suite tests SIGTERM and SIGKILL separately with a
surviving worker already running before acceptance, retained partial output,
terminal state, zero retry count and zero survivor executor invocations.

The executor entrypoint starts a process-wide five-second exit deadline on the
first SIGTERM/SIGINT, covering startup, recovery cancellation, native shutdown and
global pool cleanup. Host shutdown starts native interruption concurrently with
recovery abort. Its five-second budget destroys tracked Redis writers/readers;
recovery owns separately abortable SQL/Redis resources with a three-second attempt
limit. The main native pool bounds acquisition to one second and statements to
four seconds. If the process deadline wins, retained output stays recoverable and
unsettled execution becomes interrupted after lease expiry; no paid retry occurs.
The 30-second platform kill allowance remains a safety margin, not extra time for
generation. See the bounded-I/O evidence in `realtime-council-review.md`.
