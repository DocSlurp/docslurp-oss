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
0119, explicitly configure a durable shared Redis instance with `MASTRA_REDIS_URL`,
and supervise the dedicated executor only after review/authorization. There is no
rate-limiter Redis fallback. Startup requires permission to inspect `CONFIG GET`
and `INFO`, a writable primary, positive finite `maxmemory`, `noeviction`, healthy
initialized AOF, `appendfsync always`, and `no-appendfsync-on-rewrite no`. Missing,
weak or uninspectable policy fails closed with a sanitized error.

The host awaits Mastra 1.81.0's native BackgroundTaskManager initialization before
readiness or recovery. Connection and initialization have a ten-second deadline,
followed by bounded cleanup; caller-owned PostgreSQL pools require their own
timeouts. A failed producer startup releases its cached promise so a later request
can retry initialization. Accepted tasks retain their zero-retry policy.

These checks establish configured persistence and seven-day output retention,
including interrupted output. Operators must independently prove persistent
volume survival, restart recovery, capacity, disk/fsync failure handling and any
replication/failover guarantees. Policy is checked at startup; keep it stable
afterward. AOF does not establish volume-loss or replicated acknowledgement
guarantees. Flags remain disabled. See [native reassessment](realtime-mastra-assessment.md).

The SQL operation row is now an application binding: tenant/root/project,
idempotency, deadline, cancellation intent and quota counters. Native storage owns
task/attempt state, leases, timeouts, results and zero-retry worker recovery.
The executor reconstructs the existing project-chat policy and usage ledger
from trusted scope. Its lifetime is unrelated to HTTP responses and sockets.
Session, MFA, membership and cancellation are checked during execution; accepted
output is fenced under the root cancellation lock and native lease before native
cache publication. Streamed text is coalesced: one fenced, quota-reserved append
per 250 ms (`DOCSLURP_CHAT_OUTPUT_FLUSH_MS`, 10 to 2000) or 16 KiB of text, and
always before a tool, evidence or result event, so event order is unchanged.
Buffered text is dropped, never published, once the turn is cancelled or aborted.
Session, MFA and project access are re-read immediately before every append is
published, so nothing is published after a revocation, and every two seconds
while the turn is idle, so revoked work that publishes nothing still stops. An interrupted provider execution is not silently restarted.

Each user may have eight active roots, including roots with active descendants
or shared Temporal dependencies after the answer completes. Trees have at most
64 task/dependency references, a ten-minute deadline, 512 KiB accepted output
budget and 256 KiB per task. Native host concurrency is bounded to eight; native
task retries default to zero. Native attempt identity includes task ID and retry
count. The session-only `POST /v1/chat/operations/:id/tasks` endpoint explicitly
launches a child project-chat background task through that same native manager.
It requires a fresh `Idempotency-Key` and the root launch body (`q`, optional
`model`/`sessionId`) without a `project` selector: project and organization are
inherited from the authorized parent. Keys are scoped to owner and project: a
repeated key in that namespace returns the same child; changed input or a different
parent in that namespace conflicts. Nested children retain their real
persisted `parent_id`, rather than being flattened under the root.

The current session is revalidated before persisting launch intent, and native
acceptance revalidates again under the root cancellation lock. Expired/cancelled
roots, incompatible runtimes, unauthorized parents and tree limits refuse new
launches. A completed parent answer does not prevent explicit child work during
the remaining root deadline; new children inherit that deadline and retention.
Native parent failure/interruption also does not itself cancel the root. A new
explicit authorized child request is permitted until deadline/cancellation; it is
new work, never an automatic retry or restart of that failed parent.
Cancel-one leaves siblings running; cancel-tree fences new acceptance and covers
accepted descendants. There is no implicit model/tool delegation; child launch
adds explicit background jobs, not automatic subagent orchestration.

### Explicit child retry attempts

`POST /:id/retry` requires a first-party session, a fresh `Idempotency-Key` and
`{"authorizeNewAttempt":true,"observedAttemptId":"<attempt_id>"}` (maximum body
256 bytes). This explicitly
authorizes another execution and its potential charges, using the original input
and project. It only accepts failed/interrupted children, never completed,
cancelled or active tasks or root operations. Repeating a retry key returns the
same accepted attempt, including after a lost enqueue/HTTP acknowledgement,
only when its observed source also matches. A new key must name the latest failed
attempt under the acceptance lock. Delayed consent from an older attempt is
refused without starting work, even when a different client already retried it.
The logical operation ID stays fixed. There are at most three native attempts
per logical task, with zero automatic retries on each. Fresh session/MFA/project
checks, cancellation, the original deadline, active-root capacity and cumulative
task/tree output quotas apply to admission and execution. A fresh authorized
session may retry work whose original session expired; observers never replace
execution authority or initiate a retry.

Native Mastra 1.81.0 `restart()` accepts pending/running tasks and `resume()`
accepts suspended tasks. Neither retries terminal failures. Its automatic
background retry wrapper does not apply the retry-filter/backoff fields declared
in its types, and its stale-running recovery can requeue without advancing the
retry counter. Consequently explicit retries enqueue a new native task with
lineage/idempotency metadata. Native task rows/topics retain attempts; no new
execution queue or journal is introduced. Worker loss stays interrupted.

Current output remains separate from `snapshot.priorAttempts`, which retains each
earlier attempt's status, snapshot and watermark. If earlier history is no longer
recoverable, that reference has `historyUnavailable:true`, a null watermark and
an explicit error; a separately retained current answer remains recoverable.
No earlier text is invented. Attempt zero keeps existing
native-index-plus-one cursors. Later attempts use
`attemptOrdinal * 1_000_000 + nativeIndex + 1`, with an empty attempt's watermark
at that range's base. The 256-KiB cumulative logical output budget bounds frame
count below one range. Moving from an older range explicitly resyncs. Clients
must reject an older attempt even when its snapshot says resync, and must not
concatenate earlier partial text/citations/tools into the latest answer.

Each dispatch carries an immutable server-created invocation nonce and ordinal;
an old invocation cannot select a newer attempt on the same worker. Quota
reservations commit before cache publication and are never refunded on an
uncertain append or transport acknowledgement. Publication rechecks the native
lease and cancellation under the root lock. This can conservatively consume
output quota without visible output; it prevents retained output escaping its
quota when Redis succeeds and a later acknowledgement fails. Persisted native
metadata distinguishes pending publication from known accepted output. Missing
retained accepted output fails loudly; a still-pending first append may return
an empty running snapshot. Actual provider usage remains recorded for every real
invocation; replay and repeated keys add no invocation or usage write.

Persisted intents awaiting native acceptance remain visible as waiting summaries
with a null native task/attempt ID, keeping the tree unsettled. Replaying the
initiation key can finish acceptance exactly once. No worker or observer silently
turns an unaccepted intent into paid execution. An expired intent becomes an
explicit interruption; accepted native output missing its history fails loudly.

```sh
curl -X POST "$DOCSLURP_URL/v1/chat/operations/$PARENT_OPERATION_ID/tasks" \
  -H "Origin: $DOCSLURP_URL" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: child-request-001' \
  -b first-party-session.cookies --data '{"q":"Summarize the remaining evidence"}'
```

The cookie is a first-party session; API keys are intentionally refused. Normal
first-party Origin/CSRF policy still applies. HTTP responses and observers do not
own execution, and the existing per-task/root output budgets remain shared.

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

Stopping an executor drains it. The first SIGTERM/SIGINT stops claiming new
tasks (the worker leaves the native dispatch group, so new launches go to other
workers at once) and lets running turns finish, up to `CHAT_EXECUTOR_DRAIN_MS`
(default 25 seconds; `0` restores the immediate interrupt, the maximum is 900
seconds). A second signal ends the drain early. Native shutdown then interrupts
whatever is left, as before: a turn still running at the drain limit keeps its
accepted output and is not retried. A draining executor claims nothing, so with
a single executor machine no new turn starts until its replacement is running;
the default keeps that gap to about 25 seconds per deploy. With several
executors and rolling restarts, a longer drain (up to the chat turn deadline
plus five seconds) lets more turns finish without a claim gap. Configure the
platform kill timeout above the drain plus the five-second teardown (for the
default at least 30 seconds; 45 leaves a margin), or SIGKILL interrupts the drain.
During a drain, cancellation of a running turn reaches it through the executor's
two-second authorization and cancellation recheck, and every append stays fenced.
Restarted observers retain partial output and show the authoritative terminal
state. Browser disconnect/unsubscribe still only detach.

The local process integration suite tests SIGTERM and SIGKILL separately with a
surviving worker already running before acceptance, retained partial output,
terminal state, zero retry count and zero survivor executor invocations.

The executor entrypoint starts a process-wide exit deadline of the drain plus five
seconds on the first SIGTERM/SIGINT, covering startup, the drain, recovery
cancellation, native shutdown and global pool cleanup. Host shutdown starts native
interruption concurrently with
recovery abort. Its five-second budget destroys tracked Redis writers/readers;
recovery owns separately abortable SQL/Redis resources with a three-second attempt
limit. The main native pool bounds acquisition to one second and statements to
four seconds. If the process deadline wins, retained output stays recoverable and
unsettled execution becomes interrupted after lease expiry; no paid retry occurs.
See the bounded-I/O evidence in `realtime-council-review.md`.

### Pause new admission during rollback

With `DOCSLURP_DURABLE_CHAT=1`, set `DOCSLURP_DURABLE_CHAT_ADMISSION=0` to refuse
new root, child and retry attempts before native launch or paid work. Authorized
discovery, retained output, cancellation and accepted native execution keep their
existing policies. Missing admission configuration preserves the existing global
opt-in; explicit values must be `0` or `1`, otherwise admission fails closed.
First-party realtime host attachment also validates the policy at startup. HTTP-only hosts report a generic unavailable
response and log a constant invalid-policy refusal without logging its value.

Do not disable the global durable feature while accepted work needs recovery or
Stop. Browser hosts should also reflect the new-admission decision in their
server-rendered eligibility marker, while retaining accepted-handle recovery.
The admission switch never substitutes for session, MFA, owner, project, cohort,
deadline or budget checks and does not automatically retry accepted tasks.
