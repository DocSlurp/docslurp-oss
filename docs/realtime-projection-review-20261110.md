# Dashboard projection isolation review

Run progress repeated arbitrary diagnostic records and artifact maps across the
run, stage and recent-event views. A synthetic migrated-database regression
produced a 1,508,348-byte snapshot, exceeding the 524,288-byte transport limit.
The previous host response closed the shared socket and activated recovery for
otherwise healthy subscriptions.

The streaming projection now carries a fixed numeric measurement allowlist,
structured progress/cost rollups, lifecycle and parent/run identities, stage
status/errors and event identities/messages. Artifact maps and arbitrary event
payloads remain available on authorized detail reads. Source records are not
modified. Configured pipeline settings remain accurate rather than being
replaced with defaults to save bytes.

The host measures the complete dashboard frame. An oversized resource receives
the fixed scoped `snapshot_too_large` error and is detached without partial
inventory delivery. Projection exceptions similarly receive the fixed
`projection_unavailable` error without exposing the exception. Sibling
subscriptions remain attached. Early refusal also closes a subsequently
registered disposer and suppresses stale acknowledgement. Existing operation
replay, session/resource authorization and slow-consumer queue limits remain.

## Independent council

- Architect: blocked aggregate diagnostic amplification and unisolated
  projection exceptions. Resolved with the fixed metric set, full-frame refusal,
  scoped failure handling and sibling-survival regressions. Final review clear.
- Security Paranoid (adversarial): reproduced numeric-key amplification and a
  large retained schema. Resolved by fixed metric keys and a scoped refusal for
  any remaining oversized frame. Rechecked authorization order and client
  error removal; no automatic retry fan-out. Final review approved.
- Ruthless Minimalist: blocked per-record limits that did not bound a complete
  frame. Approved the scoped refusal without silent inventory truncation or
  new state machinery. The suggested early-disposer guard was also applied.

## Validation and limits

The database regression fails on the previous implementation and passes after
compaction, including unchanged diagnostics at rest. Projection tests retain
progress, failure and cost semantics and exercise a 200-record numeric attack.
Real WebSocket tests cover oversized-resource and thrown-projection isolation,
sibling survival and no subsequent delivery from detached resources. Existing
tenant, Origin, API-key, revocation and malformed-frame checks remain gates.

This does not promise that an arbitrarily large configured schema or inventory
can stream: those resources are explicitly unavailable rather than truncated.
Clients remove a rejected subscription without automatic resubscription or
paid work; explicit detail access remains authorized separately. This change
does not complete the broader live recovery/load acceptance or enable rollout.
