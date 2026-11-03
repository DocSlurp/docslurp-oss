# Issue319 native Mastra reassessment

Decision, 2026-11-03: replace the custom agent queue/executor and lifecycle journal;
do not expand them. Keep DocSlurp authorization, idempotent operation-to-native-run
binding, spend policies, bounded browser projections and Temporal integration as
adapters. The checkpoint at 9bcf3cc4 preserves tested earlier work and the failed
local load budgets; it is not the selected final execution architecture.

## Installed evidence

`server/node_modules/@mastra/core/package.json` is **1.80.0**. Its bundled
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
verified by a reproducibility test. None of this is yet the HTTP runtime switch;
legacy queue retirement and policy integration remain work in progress.

The per-run cache reserves 512 KiB of its 2 MiB cap for terminal error/abort/finish
frames; ordinary events stop at 1.5 MiB. Native global orchestration topics are
not duplicated into the replay cache (Redis Streams owns their bounded queue).
An early adapter test applied the cap to the shared orchestration topic and
failed; that policy was corrected, then cross-host replay and quota tests passed.
The native background manager's installed `recoverStaleTasks` marks expired
zero-retry tasks failed and redrives pending tasks. Worker hosts use that native
behavior with `maxRetries=0`; API hosts are producer-only. This removes the need
for a parallel custom lease sweeper. Durable-agent automatic recovery remains
off because it can repeat model/tool calls and requires an explicit retry policy.
