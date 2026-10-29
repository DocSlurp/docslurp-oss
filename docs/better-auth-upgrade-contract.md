# Better Auth upgrade contract

DocSlurp's authentication policy relies on Better Auth's documented plugin and hook API wherever it can. A few policies need more than that API offers, so they depend on native behaviour. This file lists those seams. Read it before any Better Auth upgrade.

Reviewed release: `1.7.14` (`REVIEWED_BETTER_AUTH_VERSION` in `server/src/lib/auth-compat.ts`).

## Rules

- `better-auth` and every `@better-auth/*` package release together. Every manifest pins the exact reviewed version, with no ranges. `@better-auth/utils` is versioned separately and is exempt. `better-auth-compat.test.ts` fails on a range, a mismatched pin or a mismatched install.
- Each seam below checks the reviewed version at startup through `assertReviewedBetterAuth`. Any other release refuses to start until someone has re-reviewed the seam and moved the constant.
- Supported extension points come first: plugin hooks, `databaseHooks`, `disabledPaths`, `customRules` and native plugin options. A new seam that needs native internals gets an entry here, a startup guard and a real-handler test.
- Routine security releases are expected. The pin makes them deliberate, not slow.

## Upgrade procedure

1. Bump every Better Auth package to the same version in `core/package.json`, `server/package.json`, the app's `app/package.json` and the app's root `package.json`, then refresh both lockfiles.
2. Walk every seam below against the new release's source and changelog, including the migration guides.
3. Run the auth suites against a migrated database: `auth-mfa`, `auth-magic-link`, `auth-recovery`, `auth-sensitive-access`, `auth-session-refresh`, `sso-enforcement` (`*.db.test.ts`) and `better-auth-compat.test.ts`.
4. Move `REVIEWED_BETTER_AUTH_VERSION` and the version line above, in the same change.
5. Changes to identity and access need a council review before merge (see the repository guidelines).

## Seams with startup guards

| Seam | File | Assumes | Guarded by |
| --- | --- | --- | --- |
| Two-factor challenge for every first factor | `server/src/lib/auth-mfa.ts` | The `twoFactor` plugin has exactly one after-hook, for credential sign-in, and no before-hooks. DocSlurp removes it and challenges every session-issuing endpoint instead. | Hook-shape check and version guard; `auth-mfa.db.test.ts` |
| Passkey user verification | `server/src/lib/auth-mfa.ts` | `afterVerification` runs after the signature check and reports the authenticated UV flag. | Version guard; `auth-mfa.db.test.ts` |
| Scanner-safe magic links | `server/src/lib/auth-magic-link.ts` | Marking `magicLinkVerify` `SERVER_ONLY` removes it from the HTTP router, while `auth.api` still runs every hook (MFA, SSO). | Endpoint-shape check and version guard; `auth-magic-link.db.test.ts` |
| Breached-password hash hook | `server/src/lib/auth-breached-password.ts` | Hooks `ctx.password.hash` from `init`, as the native `haveIBeenPwned` plugin does. `tryGetCurrentAuthEndpointContext().path` names the endpoint. Every native `password.hash` call is inside an endpoint, at reviewed call sites. Email OTP reset only spends its code after hashing succeeds. | Version guard (`getBetterAuthVersion()`); call-site inventory in `better-auth-compat.test.ts`; `auth-breached-password.test.ts`, `auth-recovery.db.test.ts` |

## Seams covered by tests only

| Seam | File | Assumes |
| --- | --- | --- |
| Signed session cookies outside the router | `server/src/lib/auth-fallback.ts` (`signedSessionCookie`), `server/src/lib/auth-mfa.ts` (`beginTwoFactorChallengeCookie`) | A cookie is `value.base64(hmac-sha256(secret, value))`. The `two_factor` challenge uses `2fa-<id>` and `2fa-attempts-<id>` verification rows. |
| SSO session provenance | `server/src/lib/sso-enforcement.ts` | Native session tokens are `[a-zA-Z0-9]`, so a `_` prefix written by the `session.create.before` hook marks an SSO session. |
| Sensitive-access proofs | `server/src/lib/auth-sensitive-access.ts` | `internalAdapter.findAccounts`, `findSession`, `createVerificationValue` and `consumeVerificationValue` keep their semantics. |
| Session revocation | `packages/shared/src/auth-security.ts` | `cookieCache` stays off, so every request checks the session row. |
| Native limiter storage | migration `0038`, `packages/shared/src/auth-security.ts` | The `"rateLimit"` table's shape. DocSlurp's own budgets use `auth_rate_limits` (0099) and never write native rows. |
| Trusted client IP | `server/src/lib/client-ip.ts` | `advanced.ipAddress.ipAddressHeaders` is the only IP source the native limiter reads. |
| Recovery and limits | `server/src/lib/auth-email.ts`, `server/src/lib/auth-rate-limits.ts`, `server/src/lib/auth-recovery.ts`, `handleAuthRequest` in `server/src/lib/better-auth.ts` | `revokeSessionsOnPasswordReset` applies to Email OTP reset, and that reset only sets `emailVerified` (no `revokeUnprovenAccountAccess`). Before-hooks see the parsed `ctx.body.email`. `defineRequestState` is shared by nested endpoint calls within one request. Email senders receive the endpoint context. `runInBackgroundOrAwait` swallows send errors. `disabledPaths` answers 404 in the HTTP router only. Email OTP answers `TOO_MANY_ATTEMPTS`/`OTP_EXPIRED` only for issued codes, and after-hooks can't change an error's status. |
| Unverified accounts hold nothing but a password | `server/src/lib/auth-recovery.ts`, `server/src/lib/oauth-account-linking.ts` | `requireEmailVerification` withholds sessions; implicit OAuth linking needs a provider-verified email and runs the `account.create.before` hook; magic link and Email OTP sign-in call `revokeUnprovenAccountAccess`. If any of this changes, Email OTP reset needs its own ownership cleanup. |

The test-only seams are covered by `auth-mfa.db.test.ts`, `auth-session-refresh.db.test.ts`, `sso-enforcement.db.test.ts`, `auth-sensitive-access.db.test.ts`, `auth-rate-limit.db.test.ts` and `auth-recovery.db.test.ts`.
