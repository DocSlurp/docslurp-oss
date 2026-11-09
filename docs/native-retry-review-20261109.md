# Explicit native child retry review

Scope: explicit retry of a failed/interrupted child, retaining its logical
operation and earlier output while native Mastra owns each execution attempt.
Baseline: `a7b605f7e`; installed `@mastra/core@1.81.0`. Runtime activation remains
disabled. This implementation does not introduce automatic paid retries.

Three independent, read-only Council reviewers received the same frozen diff,
threat model and boundary rules without the author's conclusion. Each inspected
the implementation independently. No reviewer performed paid calls or service
mutations. No reviewer reported a demonstrated high-severity exploit.

| Reviewer | Findings | Coordinator resolution |
| --- | --- | --- |
| Architect (`attempt_review_architect`) | P2: a known first-publication quota/fence refusal can look like missing retained output and poison later attempts. P2: new-work limits run before retry-key recovery. Also raised an unproven stale-dispatch concern. | Clear the publication marker when the executor proves PubSub was never called; explicitly expose unavailable prior history without hiding current output. Recover accepted keys under fresh authorization/root lock before invoking new-work admission. Fence dispatch by immutable nonce/ordinal as well as native owner/task/lease. |
| Ruthless Minimalist (`attempt_review_minimalist`) | Independently found both P2 defects; final response bounds omit attached prior snapshots. Native task rows/topics are an appropriately small owner; no new scheduler/journal needed. | Same admission/history repairs. Bound the complete response and keep one canonical operation snapshot, dropping replay events for bounded resync before refusing an oversized envelope. |
| Security Paranoid (`attempt_review_security`) | P2: output/capacity exhaustion blocks lost-ACK recovery of an accepted retry key. Requested additional auth/race evidence and client enablement guards; no demonstrated high-severity exploit. | Same-key lookup now precedes the new-invocation admission callback under the same authorization/root lock. Added revoked-session, MFA, membership, foreign-owner/API-key, root deadline/cancellation, per-task/tree output and active-root capacity negatives. Client integration and enabled rollout remain separate gates. |

The coordinator repaired these findings; the small repairs are not represented
as a second independent review. The attributed reports remain separate. Native
API limitations and rejected automatic-retry/restart alternatives are documented
in [durable chat operations](durable-chat-operations.md#explicit-child-retry-attempts).

## Threat and ownership checks

- Each explicit session mutation consents to one additional potentially chargeable
  invocation, with fixed input/project/owner and original deadline. At most three
  native tasks represent one logical task. Repeated keys recover existing attempts.
- Native worker-loss recovery still interrupts running work and never silently
  reexecutes it. Observation, replay and detachment authorize no invocation.
- Fresh authorization and root locking serialize admission/cancellation. Native
  invocation identity, owner and lease fence output/dependency effects.
- Earlier partial text/results are separate snapshots. Known missing history is
  explicit; clients must reject stale attempts and avoid concatenating answers.
- Output quotas are cumulative across attempts and reserve before publication.
  A fault after retained append cannot roll back the reservation. Uncertain
  reservations are not refunded. Actual provider usage is never erased by retry.

## Executed verification

- Nineteen runtime integration tests passed against isolated local PostgreSQL
  and durable Redis, with mocked chat execution and no provider calls. These cover
  child failure/retry, fresh-session authority, retained partial output, lost retry
  ACK, observer detachment, quota-limited same-key recovery, known oversized-output
  refusal then retry, output publish ACK loss, and admission/security negatives.
  A full 64-logical-task tree with 190 retained native attempts reconciles within
  the bounded watcher. Retry admission racing root cancellation creates at most
  one new attempt, records cancellation, and refuses any later new attempt.
- Nineteen focused identity/history/policy tests passed. They include same-owner
  stale invocation fencing, duplicate/concurrent retry keys, three-attempt bounds,
  and explicit prior-history unavailability without hiding the latest answer.
- Server TypeScript check and emitted JavaScript build passed after the repair set. Eight worker crash/recovery
  tests passed, with a separate JSON report confirming eight passes and zero
  failures. The full server suite passed 383 files and 4,365 tests; 24 files and
  153 tests were gated/skipped. The native runtime and crash suites above were
  separately enabled against isolated PostgreSQL/Redis rather than counted as
  exercised by the default gated run.

The first retry/cancel race assertion expected only native `cancelled`, but
observed native `failed` when the application cancellation guard refused execution
before the native cancel command arrived. The projection now exposes durable
cancel intent without rewriting earlier native outcomes or inferring retry policy
from diagnostic text. The regression accepts either native stopped outcome while
requiring recorded cancellation, no active attempt and refusal of a later retry.

The mock execution tests establish invocation counts and adapter behavior, not
real provider billing, browser acceptance, persistent-volume/failover guarantees
or production activation readiness. Those remain explicit acceptance work.
