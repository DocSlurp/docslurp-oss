# Independent operation scope verification

Operation subscriptions previously depended on reconciliation to notice project
and descendant access changes. The session watchdog stayed healthy if that
reconciliation stalled. A valid session alone cannot renew resource authority.

The host now sweeps operation authorization independently. The operation owner
resolves its authenticated session and reads at most 129 distinct project/org
identities, failing closed on an empty or oversized set. One SQL permission batch
checks the requested operation's live owner binding, its retained task tree and
shared run dependencies against `docslurp_project_access` and matching org IDs.
It reads no output history, Redis payloads, page-state projections or project stats.

Duplicate subscriptions for the same operation, including different replay
cursors, share one scope check within a socket sweep. The watchdog retains the
sweep start time: completing a slow check never renews earlier decisions. Errors
revoke the matching subscription generation; stalled sweeps expire the connection.
Detaching these observers cancels pending permission SQL, but does not cancel
accepted tasks or change their budgets. Query abort listeners are released after
settlement; already-detached observers cannot enqueue another permission read.

## Threat model and Council

Threats: revoked session/project/descendant access, stalled output reconciliation,
slow authorization, stale generation callbacks and duplicate subscription floods.
Tenant scope must fail closed; logical references confer no authority. Existing
frame, rate, subscription and connection caps remain enforced.

Two independent initial reviewers inspected the implementation without the
author's conclusion:

- Adversarial Security: found late sweep completion could renew an earlier access
  decision. Fixed by retaining the start timestamp. Also found duplicate-operation
  checks multiplied SQL work; fixed with per-sweep coalescing and a regression.
- Reliability/Performance: found the first draft loaded project statistics through
  the normal project loader. Replaced it with a single identity/permission query.

Each initial reviewer independently passed the then-current 30 focused host and
database tests. The coordinator's corrected suite passes 32 tests, including
duplicate-topic and slow-sweep regressions. Shared/SDK builds and server typecheck
pass after refreshing stale local declarations. Two fresh independent rechecks
(`core_final_security` and `core_final_reliability`) each passed all 32 tests and
found one remaining query-cleanup concern. The cancellation helper and six unit
cases address that condition, including absent/denied/oversized scope results,
already-aborted callers and abort-listener cleanup. The first parameterized empty
fixture incorrectly supplied no test argument; it was corrected before the six
cases passed. These checks do not establish full
feature activation, executor/Redis readiness or production capacity acceptance.

## CI fixture correction

The full server lane on the first PR head failed the idle permission-denial
assertion; matrix fail-fast then cancelled typecheck and both worker lanes.
A controlled 150ms event-loop stall reproduces that exact assertion failure:
the fixture's 100ms watchdog closes the socket before its permission sweep.
The permission-denial case now uses a 60-second test-only watchdog window and
explicitly requires an open socket plus `access_revoked`. The same controlled
stall passes with that fixture. The reproduction stall was removed afterward.
Dedicated stalled-authorization and freshness tests still verify deadline expiry;
no production deadline, security assertion or workflow fail-fast policy changed.
After removing the reproduction stall, the full server suite with `CI=1` passed:
379 files passed, 24 gated files skipped; 4,326 tests passed, 142 skipped. The run
took 325 seconds and retained the existing gate policy.
