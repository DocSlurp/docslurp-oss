# Sensitive account verification validation

Tracks [#224](https://github.com/DocSlurp/docslurp-oss/issues/224). See [the authentication contract](../../passkeys-and-mfa.md) for scope, proof methods and rollout. Migration 0097 adds explicit session proof timestamps and default-false proof provenance; existing sessions receive no inferred grant.

## Independent council

Three separate `gpt-6.1-sol` reviewers received the diff, threat model and mandatory security boundary rules without the author's conclusion. Architect and adversarial Security approved the final core mechanism; Operator approved recovery behavior and migration shape. No unresolved high-severity finding remains.

| Reviewer | Finding | Resolution | Final disposition |
| --- | --- | --- | --- |
| Architect | High: password validation could grant using pre-hash MFA/SSO policy | Recheck after hash, atomically enforce live policy on writes, track fresh MFA/SSO provenance, invalidate weaker grants on reads | Approve |
| Architect; adversarial Security | Required-MFA SSO user could not begin initial enrollment proof | Resolve policy-blocked live actor only at proof start; require signed linked-identity proof; first factor alone never grants mutation access | Approve |
| Operator | Expired/exhausted email code and expired first factor trapped recovery | Explicit resend with authoritative cooldown, method reset and contextual messages; no action replay or draft clearing | Approve |

Reviewers performed independent source inspection; execution evidence is coordinator/worker-run. Final status projection uses the shared authoritative grant helper; cooldown responses use remaining Retry-After. Migration was reviewed as 0096, then renumbered 0097 after unrelated upstream migration 0096 landed.

## Negative coverage

Tests cover live user/session binding, expired/revoked sessions, wrong credentials, cross-user passkeys, user-verification requirements, one-use challenges, atomic email proof/cooldown/attempt limits, current-email changes, password-policy races, remembered assurance rejection, current MFA/SSO invalidation, initial-enrollment scope, native freshness context isolation, hostile bodies before authorization and preserved tenant/role/machine-key restrictions. Signed SAML cases reject altered assertions, cross-request proofs and replay.

Local checks use migrated test databases and synthetic identities; no production identity-provider/email request or deployment was performed.
