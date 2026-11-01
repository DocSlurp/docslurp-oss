# OTP generation fence

Migration 0108 fixes Better Auth 1.7.14's wrong-code restoration race. A verifier consumes A, a resend issues B, then the verifier restores A with a later creation timestamp. Without the fence, A becomes the newest valid code.

The verification INSERT trigger serializes issuance and restoration by identifier with a PostgreSQL transaction advisory lock. Issuance replaces the generation marker and deletes older verification rows. Restoration is accepted only when the stored digest and original expiry match the current marker and have not expired. The marker survives consumption of B, so delayed restoration of A cannot resurrect A even after B is used. All database writers, including different API processes and native server-only endpoints, encounter the trigger. No process-local coordination or plaintext OTP storage is introduced.

## Boundary and threat model

The boundary is email identity proof for verification, sign-in, password recovery and email changes. An attacker may know A, send concurrent guesses, request B, replay A, or switch recipient addresses. The fence is scoped to the full native identifier (purpose plus recipient), not an organization or session: these proofs precede tenant selection. Unrelated verification identifiers are untouched. Existing rate limits, five-attempt limits, hashed storage and the 12-hour lifetime remain in place.

The migration seeds current unexpired generations. Missing markers refuse restoration; they never weaken verification. Generation markers currently retain one digest, address identifier and expiry per identifier until replaced. They may be pruned after expiry; a missing marker refuses any delayed restoration. This retention is a remaining operational consideration. No API-key scope or file-processing boundary is changed; wrong-account/replay/expiry tests cover the relevant negative identity cases.

The trigger depends on the reviewed native `purpose-otp-email` identifier and `digest:attempts` format. A Better Auth upgrade must review this migration contract. It intentionally applies only to the four native email OTP purposes, not custom sensitive-account proofs, which already use atomic database updates.

## Evidence

The original memory-adapter reproduction failed with `111111:1` instead of `222222:0`. The regression now runs the real PostgreSQL adapter against the complete migrated schema. It also checks restoration after B is consumed. A native endpoint test pauses verification immediately after consuming A, issues B through another Better Auth instance, then resumes verification; A fails and B succeeds. Hashing and the 12-hour expiry are asserted.

Focused race, recovery, rate-limit and sensitive-email suites: 62 tests pass. Recovery covers wrong-account, replay, expired codes, eleven-hour acceptance, five guesses and per-recipient budgets.

Prior council evidence: https://github.com/DocSlurp/docslurp-app/tree/feat/email-code-lifetime/docs/qa/2026-10-30-email-code-lifetime . Those reviews do not cover this change. Two independent council reviewers, including an adversarial reviewer, must assess the new head before merge. The coordinator owns that review, integration and deployment.
