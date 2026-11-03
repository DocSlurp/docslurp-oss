# Issue319 native Mastra reassessment

Decision, 2026-11-03: replace the custom agent queue/executor and lifecycle journal;
do not expand them. Keep DocSlurp authorization, idempotent operation-to-native-run
binding, spend policies, bounded browser projections and Temporal integration as
adapters. The checkpoint at 9bcf3cc4 preserves tested earlier work and the failed
local load budgets; it is not the selected final execution architecture.

## Installed evidence

`server/node_modules/@mastra/core/package.json` was **1.80.0** at reassessment; main subsequently upgraded it to **1.81.0**. Its bundled
`dist/docs/SKILL.md` and declarations were inspected, not inferred from older
versions. Local `realtime/mastra-native.test.ts` invokes the real native Agent,
DurableAgent, Mastra host, CachingPubSub and InMemoryStore with a mock model:
repeated observe/detach replays the complete answer without another model call;
clearing cached events destroys replay even while workflow storage remains.
No paid provider was called. These are capability tests, not cross-instance or
persistent-storage acceptance.

| Requirement | Native owner | DocSlurp adapter still required |
|---|---|---|
| Agent loop, saved workflow state, recovery/fencing | DurableAgent / EventedAgent; `recover`, `recoverActiveRuns`, execution-fence | Static server-side model/tool/policy reconstruction; usage for every real attempt |
| Background tools, leases, retries, suspension/results | BackgroundTaskManager; static executor registry, get/list/cancel/resume | Tenant filter, root admission/budget and shared Temporal ownership |
| Conversations | Memory resource/thread scopes | Server-derived org/workspace/user binding; no client authority |
| Ongoing input and external job notices | Signals / thread streams | Authorization and paid-follow-up policy; observing must not send a wake signal |
| Modes and approvals | AgentController Session when needed | Existing product does not currently require new modes; do not add an alternate controller |
| Tool validation and guardrails | Native Tools and processors | Existing read-only allowlist, privacy, spend, cancellation checks |
| External ingestion/render/export | Existing Temporal owners | Authorized references and discovery; never relaunch on reconnect |
| UI delivery | Native PubSub/cache + first-party WebSocket | Last-applied cursor, bounded payload, scoped authorization, resync semantics |

## Concrete integration gaps, not reasons to keep a duplicate runtime

- `dist/agent/durable/durable-agent.d.ts: observe` accepts an inclusive zero-based
  PubSub event offset, but `dist/agent/durable/types.d.ts: AgentStreamEvent.index`
  explicitly says that index is stripped before observe consumers receive it.
  Counting text chunks is incorrect because lifecycle events consume offsets.
  Use the exported native `AGENT_STREAM_TOPIC`/PubSub indexed-event surface in a
  bounded authorized transport adapter, or upstream an offset-exposing API.
- `observe` cleanup destroys shared replay. Transport teardown must call detach,
  never cleanup. Retention cleanup is the server owner's job. Expired or future
  cursors require DocSlurp's explicit authoritative resync response; native
  observe can otherwise yield an empty stream or skip lower-index live output.
- Defaults are in-memory cache/EventEmitter delivery. Native persistence and
  shared transport must be configured for replicas. `MastraServerCache`'s base
  `listPushIndexed` is explicitly non-atomic; use a native atomic persistent
  implementation, not that default. Native PostgreSQL storage supports
  `disableInit` so schema installation stays under repository migrations.
- Native durable per-call `stopWhen`, `prepareStep`, hooks, delegation callbacks
  and model instances are not all serializable. Current chat policy is closure
  heavy (`chat-mcp-agent.ts` uses AI SDK streamText). Merely wrapping that call
  in a durable workflow would not restore billing/privacy/guardrails on another
  worker. Policies must be registered statically and derived from trusted scope
  on each attempt; this is migration work, not an absent native capability.
- BackgroundTaskManager supports cross-process static executors; do not persist
  request closures. Default retries are zero. Keep unauthorized paid retry off;
  a restarted non-resumable provider call must be reported as a new attempt.
- Native abort is cooperative/best-effort across PubSub. Durable cancellation
  intent and checks before external side effects remain application policy.

Package metadata checked: native PostgresStore `@mastra/pg` 1.34.0 and Memory
1.40.0 require core >=1.80; native Redis cache 1.4.12 requires >=1.76; native
Redis Streams 0.8.0 supports core1.x. The repository already configures Redis
for rate limiting in docker-compose/.env.example; reuse an explicitly configured
supported instance if selected, never silently provision a broker or migrate a
provider. No runtime/storage flag has been enabled.

## Sources

- [Durable agents](https://mastra.ai/docs/harness/durable-agents): native execution/replay and distributed configuration.
- [Background tasks](https://mastra.ai/docs/harness/background-tasks): stored background tool ownership.
- [AgentController](https://mastra.ai/docs/harness/agent-controller): sessions and interactive modes.
- [Signals](https://mastra.ai/docs/signals/overview): thread input and native streaming.
- [Memory](https://mastra.ai/docs/memory/overview): persistent thread/resource memory.
- [PostgreSQL](https://mastra.ai/integrations/databases/postgresql): native storage and disableInit.

The requested `/docs/signals` and `/docs/memory` roots did not resolve in the web
reader; their official navigation links resolve to the overview pages above.

## Verified native boundary requiring a small adapter

Installed `event-emitter-DstvopcS.js` (`CachingPubSub.publish`) catches
`listPushIndexed` failure and still publishes an event without an index. This
cannot advertise resumable first-party output. `StrictCachingPubSub` changes
only that boundary: native cache append must succeed before native transport
publication; native replay/indexing/subscription code is inherited unchanged.
`RedisServerCacheOptions` provides TTL but no byte bound. The host wraps its
exported atomic append script with a 512 KiB event / 2 MiB topic cap and matching
TTL. It refuses atomic-write failure rather than the native CROSSSLOT fallback.
These gaps justify small transport adapters, not retaining the custom executor.

Native host verification now includes a second host over local Redis7 and the
fully migrated database using native PostgresStore with runtime init disabled.
The second host replays a completed answer without another model invocation.
Native schema migration 0118 is the exact pinned PostgresStore schema export,
verified by a reproducibility test. The HTTP runtime and dedicated worker now use BackgroundTaskManager. Native
static executors reconstruct application policy on the worker. Earlier legacy
queue functions remain only for historical recovery/regression evidence; the
first-party launch path and executor entrypoint no longer use their claim loop.

The per-run cache reserves 512 KiB of its 2 MiB cap for terminal error/abort/finish
frames; ordinary events stop at 1.5 MiB. Native global orchestration topics are
not duplicated into the replay cache (Redis Streams owns their bounded queue).
An early adapter test applied the cap to the shared orchestration topic and
failed; that policy was corrected, then cross-host replay and quota tests passed.
Mastra 1.81's native startup recovery marks expired zero-retry tasks failed and
redrives pending tasks, but its recurring pin sweep ignores unowned pending rows.
An empty startup scan also schedules no future running-lease scan. The public
manager API has no recurring full-recovery option (`recoverStaleTasks` is private).
`recovery.ts` therefore uses supported native `getStorage/getTask/updateTask`
compare-and-set and pending-only `restart` APIs, every two seconds, one page of
64 tasks at a time, without overlapping sweeps. It does not implement a queue,
claim leases, retry execution or call private native APIs. This adapter is needed
until native recurring recovery covers both cases. API hosts remain producers.
Durable-agent automatic recovery remains off because it can repeat paid calls.

## Integrated runtime and remaining acceptance

Native BackgroundTaskManager owns new first-party operations: durable enqueue,
cross-process dispatch, leases, lifecycle, cancellation, timeout, zero-retry stale
recovery and final result storage. Native indexed PubSub/cache owns replay.
The existing workspace chat/retrieval implementation is invoked as a statically
registered native background tool; its pre-existing AI SDK agent loop and usage
ledger are not serialized as request closures or replaced by a second model call.
Native DurableAgent/Memory capability tests remain useful, but this path does not
claim to have migrated the existing workspace conversation history into Memory.
No new AgentController, Signals-driven paid follow-up, subagent launcher or custom
agent loop was added merely to exercise those APIs.

The application SQL binding retains identity, tenant/workspace/root scope,
idempotency, deadline, cancellation intent and accepted-output quota counters.
It does not own native task leases, execution dispatch, output journal or result
storage. Existing shared Temporal materialization references remain application
adapters. The server-owned root lock fences cancellation against accepted output
and new materialization; observer disconnect never acquires cancellation authority.

Real local PostgreSQL17 + Redis7 integration tests now exercise HTTP lost ACK,
one native execution, partial output after observer detach, final citations,
recreated API-host recovery, real signed BetterAuth Upgrade on the built Astro
Node server, explicit Stop and retained partial output, wrong-owner/revoked
session denial, and parent completion with outstanding shared materialization.
The mounted test imports the existing built Astro entry and attaches this core's
exported first-party adapter to its actual Node server; it does not rebuild the
app or validate a production bundle/pin or proxy. Provider calls are mocked.

The worker-crash integration test SIGKILLs a separate native worker process,
with a second host already running before the owner claims any task. After the
real 30-second lease expiry, the accepted text
remains recoverable; native recovery marks the zero-retry task failed with an
interruption reason and never invokes the executor again. No clock or lease-row
mutation substitutes for process loss in this test.

Still required before activation: independently review this native delta; test
rolling deployment with the selected production Redis durability/eviction policy; verify the production app bundle and
proxy; provision/supervise the worker only with separate authorization. Native
Redis replay requires persistence appropriate to the retention guarantee; an
ephemeral rate-limit cache is insufficient. Missing retained active output fails
explicitly instead of silently restarting a paid operation.

Mastra1.81 BackgroundTaskManager.enqueue persists before dispatch. A process can
die between those steps. Worker startup recovers pending tasks, but a running
worker does not necessarily rescan when no known lease schedules another sweep.
The public restart API re-dispatches pending tasks, but also permits restarting
running tasks. The recovery adapter therefore locks a native pending row while calling that
supported API, so a concurrent claim cannot turn pending redispatch into an active
paid restart. HTTP idempotent retries now only return the existing handle; they
do not perform another lock-held restart. Native claim fencing deduplicates dispatch.

The recurring adapter also checks persisted binding scope, root cancellation and
wall-clock deadline under the existing root lock before pending redispatch.
Unavailable/expired/cancelled bindings become native terminal failures without
executor invocation. Running lease recovery uses the native expected status,
owner and exact lease expiry CAS, so a concurrent heartbeat or completion wins.
The scan continues after an empty result; neither POST retries nor worker restarts
are required. Native claim fencing deduplicates repeated pending notifications.

## Bounded recovery I/O (review repair)

Installed Mastra 1.81 `restart` and background storage APIs do not take an
AbortSignal. `restart` reads state and concurrency through other pool connections
before publishing; a SQL transaction's SET LOCAL cannot bound those operations.
A lock-held call through the long-lived host is therefore unsafe. Recovery now
creates a producer-only native manager with attempt-owned PostgreSQL and native
Redis Streams resources. It uses the supported PostgresStore `pool`, Mastra
`pubsub`, RedisStreams `client`, and node-redis `commandOptions.abortSignal`
injection points. No private native recovery/dispatch method is invoked.

Each attempt has a three-second deadline. Pool acquisition/connect is 500 ms,
server statements are one second, driver queries 1.2 seconds. Abort destroys the
owned PostgreSQL connections (including blocked native CAS), ends the pool,
aborts Redis commands and destroys its writer. Offline queuing/reconnect is off
for this short-lived dispatch transport. Future publish entry checks the signal.
The transaction remains locked until dispatch completes or its owned I/O is
aborted. Native `restart` cannot read a newly running state after lock release.
A write already accepted before a network failure may be unacknowledged; this is
not an exactly-once claim. Its native pending dispatch and claim fencing remain
idempotent, and executor authorization/cancellation is checked before paid work.

The unbounded native startup scan is disabled; this adapter covers pending,
pinned and running native rows with zero retries. Selection uses an ID keyset,
64 candidates per attempt, with a fixed creation-time horizon for each pass.
Statuses changing or rows disappearing cannot shift an offset; later ingress
cannot extend that pass indefinitely. Contended rows are attempted again on the
next pass. This assumes native server-issued creation times, not client-controlled
backdating. Latency still grows with the finite eligible backlog; there is no
constant-time recovery guarantee for unlimited tenants/tasks. A 130-task real-DB
test removes terminal rows, adds new tasks and holds an early row lock while
checking later-page settlement and eventual revisit of the blocked row.

Shutdown starts native interruption and cancels recovery concurrently under one
five-second host budget. At its deadline all tracked Redis writers/readers are
aborted/destroyed; no sweep wait can delay starting native shutdown. The worker's
native database pool also has bounded acquisition/statements/driver queries.
Tests cover paused Redis, exhausted executor pool, blocked native CAS, and
SIGTERM process exit while those faults remain in effect.
