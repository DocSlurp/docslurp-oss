# Native chat startup and retention council

Scope: native startup readiness and interrupted-output retention. This is a
partial hardening change; it does not enable realtime or durable chat.

## Threat model and native API

Assume unavailable, stalled, evicting or incorrectly configured shared Redis,
late initialization, repeated requests and interrupted model output. Preserve
tenant/identity checks, VM file isolation, cancellation fences and zero retries
of accepted paid work. No new parsing or tenant authorization path is added.

Installed `@mastra/core` 1.81.0 provides a memoized
`BackgroundTaskManager.init(pubsub)` promise. The Mastra constructor starts it but
catches its rejection; the host now awaits that native barrier. Installed shutdown
fences dispatch before awaiting late initialization. No scheduler or lease store
is added. References: [background tasks](https://mastra.ai/docs/harness/background-tasks)
and [durable agents](https://mastra.ai/docs/harness/durable-agents).

## Independent reviewers and resolutions

Three separate agents received the diff, threat model and mandatory boundary
rules, without the author's conclusion:

| Reviewer | Findings | Resolution |
| --- | --- | --- |
| Architect (`native_startup_architect`) | P2: rejected producer startup stays cached | Identity-guarded rejection clears only that startup promise; regression proves single flight and later successful initialization. |
| Battle-scarred Operator (`native_startup_operator`) | Same P2; P2: setup still documents limiter fallback | Fixed singleton; environment template and setup guide now require explicit durable URL and enumerate policy/operational limits. |
| Security Paranoid (`native_startup_security`, adversarial) | No high/medium; low: test late initialization; low: inherited clear leaves byte counter | Added late-resolution regression proving recovery never starts after timeout. Byte counter cleanup deferred: it contains no output, expires, and operation topics use unique IDs; explicit same-topic reuse can inherit old quota. |

Architect approved continued validation with the singleton finding; operator
withheld scoped approval pending the two repairs above; security approved this
implementation subject to other review and owner authorization. The coordinator
made and verified the small repairs; reviewers did not re-review those repairs.
There is no unresolved high-severity council finding. These opinions do not
establish activation readiness.

## Changes and verification

- Explicit `MASTRA_REDIS_URL`; startup reads policy and refuses weak/uninspectable
  persistence. Runtime never changes Redis configuration.
- Ten-second connection/initialization deadline, Redis I/O destruction, bounded
  failure cleanup and post-initialization abort fence.
- Application output replay list, index and byte counter retain seven days,
  including interrupted output; unrelated native topic TTL behavior remains.
- Focused policy/startup/retention tests pass. Actual local Redis integration
  verifies all three TTLs and cross-host mock-model replay without re-execution.
- Server TypeScript check passes. CI configures only its ephemeral test Redis
  service with the required policy; application setup does not configure it.

The regression tests initially exposed premature readiness, one-day output TTL
and the permanently cached startup rejection before their respective repairs.
New empty AOF and established compaction have separate accepted-policy cases.

## Open activation gates

Policy inspection is a startup snapshot. AOF configuration is not proof of volume
survival, failover acknowledgement, disk/fsync failure handling or available
capacity. No full-disk, maxmemory-pressure or Redis process-restart experiment is
claimed here. Readiness of the supervised deployment, scoped canary admission,
native child/retry capability, matched capacity testing and browser/proxy/restart
acceptance remain separate gates. Flags remain off.
