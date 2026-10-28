# Error contract review — 2026-10-28

Scope: issues #219 (safe validation constraints), #220 (SDK Retry-After), and #221 (SDK/CLI recovery messages). Issue #218 remains open.

Threat model: request fields and provider response bodies are hostile. Error handling must not echo input, internal diagnostics or secrets; widen tenant/auth scope; or replay unsafe mutations or AI calls. Numeric limits and type/format names require allowlists. Retry delays must stay inside the existing request deadline.

## Independent council

Three separate gpt-6.1-sol reviewers inspected the implementation without sharing conclusions. No core blocker was identified.

| Reviewer | Lens | Findings and disposition |
| --- | --- | --- |
| council_architect | Contracts, ownership, retry invariants | Approve #219/#220/#221 after rereview of final source and envelope regression. Safe metadata is additive; retry eligibility is unchanged. |
| council_security | Adversarial input and diagnostic disclosure | Approve. Exact-envelope assertions include hostile input stripping; formatter allowlists require own-property keys. |
| council_operator | Deadlines, recovery and operational failure | No additional core blocker; inspected SDK delays, error contracts and CLI output. |

All three supported deferring #218: document/stage errors are currently text columns. Trusted producer codes, persistence, a migration, checkpoint propagation and a redacted DTO must ship together. Existing execution retry classification is not a safe public error taxonomy.

## Local evidence

- Shared error tests: 29 passed; server constraint tests: 14 passed.
- API error envelope regression: 32 passed, including exact safe metadata and removal of hostile input values.
- SDK suite: 116 passed, one existing homepage-metadata skip; focused retry recovery: 5 passed.
- CLI suite: 27 passed.
- Shared, SDK and CLI builds pass; server and CLI typechecks pass.
- Full server suite was also attempted locally; its final result is recorded in the pull request. Database-dependent tests require their own configured services.

No remote compute, hosted model calls, package release or deployment was performed for these checks. Reverting code reverses the change; no database migration is included.
