# Native child launch council

Scope: explicit authenticated child project-chat jobs and authoritative nested
tree summaries. This does not enable the runtime, automatic model delegation or
retries. Native Mastra 1.81.0 BackgroundTaskManager remains the execution, lease,
attempt and result owner. Application rows retain identity, permission, quota and
cancellation metadata; listing unaccepted intent adds no scheduler or replay log.

The installed native enqueue/list/cancel APIs and current official
[background-task](https://mastra.ai/docs/harness/background-tasks) and
[durable-agent](https://mastra.ai/docs/harness/durable-agents) documentation were
inspected. The existing static executor preserves project-chat authorization,
tools and usage accounting; the child endpoint reuses it rather than adding an
execution loop.

## Threat model

Assume hostile parent references, tenant selectors, expired/revoked/MFA sessions,
API keys, oversized JSON, repeated/lost acknowledgements, concurrent cancellation
and fanout/output exhaustion. Parent IDs never grant scope. Inherit project/org
from the authorized parent, revalidate session before persisting intent and again
under native acceptance, bound the tree and use root cancellation locking.
No file parser, credential distribution or production configuration changes.

## Independent reviewers and resolutions

Three separate agents received the diff, threat model and mandatory boundary
rules without the author's conclusion. They did not use production, paid models
or the coordinator's shared integration services.

| Reviewer | Findings and disposition | Resolution |
| --- | --- | --- |
| Architect (`child_launch_architect`) | No blocking architecture finding; scoped approval subject to integration/owner gates | Preserve native execution owner and thin application scope/identity adapters. |
| Ruthless Minimalist (`child_launch_minimalist`) | P2: persisted children invisible before native enqueue; P3: idempotency namespace wording | Enumerate bounded authorized persisted bindings, including waiting unaccepted intents; keep tree unsettled until native acceptance or terminal cancellation/expiry. Validate replay executes once. Document owner/project key namespace. |
| Security Paranoid (`child_launch_security`, adversarial) | No demonstrated high-severity bypass; conditional medium: native interruption does not update legacy application status | Explicitly define native failure/interruption as not cancelling the root. New authorized child work remains allowed before deadline/cancellation, with a fresh logical identity; a regression proves the failed parent executes once and is never retried. |

Each reviewer independently passed the native operations unit test. Architect's
database tests were blocked by sandbox socket permission; reviewers did not claim
real-service validation. The coordinator made and tested the repairs; reviewers
did not re-review those small corrections. No unresolved high-severity finding.

## Coordinator evidence

- Real PostgreSQL/Redis native integration passed 13 tests without skips:
  parallel/nested children after parent completion, second-host recovery,
  idempotent lost-ACK replay, foreign/API-key/revoked scope rejection, oversized
  input, cancel-one/tree race, root output exhaustion, visible unaccepted intent,
  64-reference limit and explicit child work after native parent failure.
- Real PostgreSQL service/race lane passed 18 tests without skips.
- Focused policy/service/native tests passed; server TypeScript check passed.
- Full server suite: 4,354 passed, 149 environment-gated skips, 382 passing files.
- Final sequential verification passed: TypeScript, 13 native integration tests
  including MFA/expired intents, 18 PostgreSQL service/race tests and all eight
  worker-crash/shutdown tests, with no gated skips.

The first worker-crash run overlapped the full server suite: six checks passed,
two timed out waiting for fixture readiness before reaching their crash scenario.
Those failures are retained; they are not successful crash evidence. The crash
lane is rerun in isolation with its original bounds, rather than loosening them.
The isolated run passed all eight checks; the earlier readiness failures remain
recorded and support a contention diagnosis rather than a successful first run.

Native producer cancellation can log that internal workflow `__background-task`
is not registered. Installed producer initialization intentionally omits it;
native cancel persists cancellation/clears ownership, catches the local workflow
lookup warning, then publishes cancellation. Tests additionally require actual
executor abort and retained output; the warning remains visible.

## Limits

Unaccepted intent is visible, not automatically executed: initiation-key replay
must complete native acceptance. Accepted work remains independent of HTTP and
socket observers. Default retries remain zero. Local mocks prove lifecycle and
scope behavior, not model quality, production capacity, Redis volume/failover
survival, browser/proxy acceptance or a canary. Activation flags remain off.
