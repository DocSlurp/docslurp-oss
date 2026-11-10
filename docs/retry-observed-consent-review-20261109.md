# Observed attempt consent review — 2026-11-09

A retry now requires `observedAttemptId` alongside explicit authorization and an
idempotency key. Under the existing acceptance lock, a new key must name the
latest failed native attempt. A known key must name its original predecessor.
This prevents delayed consent from retrying another client's newer failed
attempt while retaining lost-acknowledgement recovery. No schema, queue,
automatic retry or provider integration was added.

## Independent council

Three separate read-only agents reviewed the frozen code diff and threat model:

- Architect (`consent_architect`): no blocking findings; checked lock-held
  predecessor comparison, native lineage, authorization, and matching rollout.
- Ruthless Minimalist (`consent_minimalist`): no actionable core findings;
  identified the app mock assertion needing its new third argument. Corrected
  that assertion in the dependent private client change.
- Adversarial Security Paranoid (`consent_security`): no findings; examined stale
  unused keys, changed-source known keys, revocation, foreign ownership,
  wrong-scope keys, cancellation, quotas and oversized requests.

Each reviewer inspected source and tests; none claimed independent execution.
Review does not establish production readiness or authorize automatic activation.

## Executed validation

- Native operation unit suite: 2 passed, including stale and missing source,
  changed-source recovery, original-source ACK recovery and three-attempt limit.
- Real PostgreSQL/Redis runtime suite: 20 passed, with mocked model calls. The
  two-client regression asserts no third execution/native row after delayed
  consent, then accepts fresh consent for attempt 1. Existing quota, deadline,
  cancellation and authorization tests supply valid source fields so they still
  exercise the intended guard.
- Server TypeScript check and emitted build: passed.
- Dependent client API/component suites: 15 passed.

Local test services are bounded disposable instances. No production mutation or
paid model request was made by these tests. Earlier thread costs remain separate.
Deploy only with the matching client contract. Browser recovery, production
storage durability and activation acceptance remain separate gates.
