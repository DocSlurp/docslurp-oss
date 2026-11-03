# Durable chat operations (issue 319)

This is an opt-in execution path, disabled by default. Apply migration
`0114_chat_operations`, run a dedicated executor with
`pnpm --filter @docslurp/server exec tsx scripts/chat-operation-executor.ts`, and
set `DOCSLURP_DURABLE_CHAT=1` on the API. Do not enable without the executor.
No provider calls run in an HTTP request or WebSocket callback.

Session-authenticated HTTP endpoints under `/v1/chat/operations`:

- `POST /` accepts `{q, workspace?, sessionId?, model?}` with an
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
Close/abort only detaches observation. Every delivery checks workspace and
owner again. Descendants are individually authorized. The provider reconciles
SQL every second, including missed notifications; the socket host remains
responsible for connection/subscription limits and session revalidation.
Lifecycle snapshots include terminal errors even with no remaining text.

The SQL row is the queue owner. Claiming creates a unique execution attempt and
30-second lease; the executor rechecks cancellation, session expiry/revocation,
workspace membership and the 10-minute deadline every two seconds. Output and
terminal results commit atomically with their sequence. Existing chat code owns
spend admission, actual provider usage and billing. There is no automatic retry
of claimed executions: expired leases become `interrupted`, preserving accepted
output and attempt identity. A provider crash cannot resume its model loop.
A new, explicitly authorized paid request needs a new idempotency key.

Each user may have eight active roots; a tree has at most 64 tasks, a shared
10-minute deadline, 512 KiB accepted output budget and a 256 KiB per-task budget.
Child launch/cancellation locks the root. Child tasks inherit root retention and
deadline; cross-owner, cross-workspace and detached/shared children are refused.
Task IDs and attempt IDs are distinct. Parent completion does not settle active
children. No retry or shared-dependency launcher is exposed yet. One sequential
executor process executes one attempt at a time; additional executor processes
claim disjoint work with `SKIP LOCKED`.

Replay pages contain at most 256 events. Snapshots retain accumulated text,
tool outcomes, evidence and final response; the socket adapter refuses snapshots
over 512 KiB. Complete trees expire after seven days; cleanup never deletes a
live tree. Expiration also bounds idempotency retention. Recovery never starts a
provider call. The database contains scoped input and output; it contains an
authentication session **ID**, never a cookie or provider key.

## Existing pathways and remaining migration

- `routes/search.ts`: with the flag enabled, session POST chat launches durable
  operations and session SSE initiation refuses with an explicit migration
  response. Without the flag, legacy POST/SSE remain request-owned. API-key
  behavior is unchanged. First-party clients must understand operation handles
  before enabling the flag. Do not retire legacy streams yet.
- `routes/chat-completions.ts`: public OpenAI-compatible endpoint remains legacy.
- `services/chat-mcp-agent.ts`: tool and nested retrieval calls inherit the
  operation-owned signal when invoked by the durable executor; existing agent
  step/turn budgets and actual-usage recording remain. Configuration mutations
  are disabled for this path. Aborted usage receipt collection remains its
  existing bounded accounting path, not a child task launcher.
- Ingestion, materialization, page renders and document exports already use
  Temporal (`lib/temporal.ts`). They are independent durable owners and are not
  re-executed by this SQL chat queue. Linking their job/result IDs into chat task
  summaries is still integration work.
- There is no existing server subagent spawn tool. `launchChatOperation` supports
  internal parent-scoped launches, but no public subagent, dependency-wait,
  detached-child or explicit retry API is introduced here. Such launchers must
  use this owner rather than fire-and-forget HTTP work.

This branch does not complete issue 319. Remaining gates include app migration,
WS host hookup, shared projection reconciliation/load measurements, independent council review, and
production executor supervision/draining. Do not claim rolling provider
continuation or automatic retry. No deployment is authorized by this work.

## Interim council review and repairs

The independent adversarial review of `4271271d` found three issues: the
non-agent provider path missed the executor abort context; cancellation could
lose to a result append between heartbeats; and ignored evidence/tool callbacks
could leave a derived rejected promise unhandled. The follow-up establishes the
existing deferred execution context, enforces cancellation/deadline in the locked
append transaction, and returns the already-observed persistence promise.

Regression evidence: 88 tests across chat-operations.db and workspace-chat pass
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
deferred-search and workspace-chat suites pass 139 tests under strict rejection
handling, including the new spend/create/dispatch races.
