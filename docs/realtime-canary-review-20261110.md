# Organization canary review — 2026-11-10

`REALTIME_CANARY_ORG_IDS` adds an optional server-owned restriction to existing
feature flags. It never grants access: the normal session, MFA, resource owner,
project, deadline and billing checks remain authoritative. A present malformed
value fails closed. Accepted execution and authorized HTTP recovery/Stop remain
independent of rollout scope.

Independent council reviewers inspected the candidate and threat model:

| Reviewer | Lens | Core findings / verification |
| --- | --- | --- |
| canary_architect | Architect | No actionable core defect; 22 focused tests passed independently |
| canary_minimalist | Ruthless Minimalist | No established core blocker; identified a host-client recovery integration gap for repair |
| canary_security | Adversarial Security Paranoid | No server authorization bypass; 22 focused tests passed; also identified the host recovery gap |

The host-client finding requires separating new admission from retained recovery
and Stop. It does not justify weakening socket or native admission checks.
Host integration is released separately after these core changes merge.

Coordinator verification: 37 tests passed across parser-free config, live migrated
PostgreSQL membership/resource authorization, socket operations, bounded task
scope checks and route admission. Server TypeScript check passed. Negative cases
include foreign/revoked membership, deleted organizations, malformed/oversized
configuration and launch input, revoked session and task-tree scope mismatch.
No production activation, real-session load result or latency claim is made by
this source review.

A final independent adversarial host review (`canary_final_security`) found that
the route normalized authorization refusals to the same HTTP 409 as unavailable
history. This prevented a fallback client from clearing revoked output. The
route now maps the internal `operation_forbidden` refusal to generic HTTP 403,
without resource details; unavailable history remains 409. Route regressions
verify both outcomes. CI also exposed an older observer fixture without an
organization membership; its explicit owner membership now matches the access
policy exercised by fresh task-tree validation.
