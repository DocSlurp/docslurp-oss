# Native admission pause review — 2026-11-10

Threat model: an operator pauses new native session work while accepted work must
remain recoverable and cancellable. Hostile clients may replay lost acknowledgments,
forge ownership or project selectors, use revoked sessions or API keys, or supply
oversized input. The switch must not widen tenant, identity, budget or execution
policy. It is not a pause for the separate API-key chat contract.

Three independent agents reviewed the same frozen diff, threat model and boundary
rules without the author's conclusion or each other's findings:

| Reviewer | Lens | Findings and disposition |
| --- | --- | --- |
| admission_architect | Architect | P2 startup promise exceeded realtime attachment coverage. Narrowed the documentation: attachment validates at startup; HTTP-only admission fails closed at request time with a constant refusal log. No high-severity finding. |
| admission_minimalist | Ruthless Minimalist | Same startup mismatch and P2 insufficient pause-state evidence. Corrected the contract and added explicit-on/off, malformed, API-key and native/SQL recovery coverage described below. No high-severity finding. |
| admission_security | Adversarial Security Paranoid | No blocking vulnerability found after examining alternate session routes, API keys, child scope selectors, retry consent, revoked sessions/MFA and lost ACK behavior. Independently ran 27 focused tests. |

The reviewers identified that a paused POST replay is refused even when an earlier
request was accepted. Recovery must use authorized discovery and reads, not assume
the refusal proves that no work exists. No automatic retry or legacy paid fallback
is introduced. Browser hosts must separately reflect admission and retained recovery;
that integration remains a host release gate rather than part of this server diff.

Coordinator evidence:

- Initial regression failed before the implementation: paused admission entered
  create instead of returning 403.
- 39 tests passed across the rollout parser, HTTP admission and migrated SQL socket
  recovery suites before the additional integration case.
- A migrated database plus real native Mastra manager test accepts one task, treats
  its HTTP ACK as lost, pauses admission, publishes accepted output after the pause,
  refuses root/child/retry and the shared session-chat entry, discovers and reads
  retained output, rejects foreign-owner and expired-session reads, rejects foreign
  cancellation, then records the authorized owner's tree Stop. Both native task and
  application operation counts stay at one. No model is invoked.
- Explicit-on route tests retain session-only authorization; globally disabled
  routes stay disabled. Malformed policy yields a generic unavailable response
  and a constant log without configuration contents. Existing oversized-input
  and revoked-session regressions remain in the focused suite.

Server TypeScript checking and the core workspace build passed after the new
integration test was added. The full server suite is running separately.

Limits: the native integration uses in-memory native storage with real migrated SQL
identity and authorization. It does not replace separate durable Redis crash tests,
prove production capacity or browser behavior, or claim full native execution across
a process restart. The shared session-chat handler is mounted in the integration
fixture; the complete search router's dispatch was inspected statically. The
project-chat configuration helper is stubbed to avoid loading model execution;
existing project authorization is real. Production activation remains separate.
