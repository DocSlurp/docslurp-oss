# Account recovery and password safety

Password recovery, breached-password rejection and the authentication rate limits that protect both. Everything here runs on Better Auth's native plugins; DocSlurp adds policy around them, not a parallel implementation.

## Password recovery

Recovery uses the native Email OTP plugin's reset flow, which was already configured for verification codes:

1. `POST /api/auth/email-otp/request-password-reset` with `{ email }`. The client is `authClient.emailOtp.requestPasswordReset`. The answer is `{ success: true }` whether or not the address has an account, and an unknown address gets no email.
2. The email's subject leads with the code and says it is a password reset code. It expires in 10 minutes, allows five wrong guesses, and is stored hashed.
3. `POST /api/auth/email-otp/reset-password` with `{ email, otp, password }`. The client is `authClient.emailOtp.resetPassword`.

A completed reset:

- **ends every session** of the account (`revokeSessionsOnPasswordReset: true`) and clears its trusted devices, so whoever held the old password is signed out;
- **never signs in.** The person signs in with the new password afterwards, and an account with two-factor still gets its second-factor challenge. Recovery doesn't turn off two-factor and doesn't grant sensitive-account access;
- **sets a first password** for an account that has none (email-code, magic-link or Google/GitHub users), and marks the address verified, because the code proved mailbox ownership.

A domain that enforces company SSO is refused with `SSO_REQUIRED` before any code is sent. The answer depends only on the domain, like `/api/sso-lookup`.

There is one recovery path. The link-based reset endpoints (`/request-password-reset`, `/reset-password`) and the deprecated `/forget-password/email-otp` alias are disabled (`disabledPaths`) and answer 404.

## Breached passwords

Every endpoint that stores a new password checks it against the [Have I Been Pwned](https://haveibeenpwned.com/Passwords) corpus using Better Auth's native `haveIBeenPwned` plugin. The covered endpoints are sign-up, change password, Email OTP reset, and `/set-password` and `/reset-password` if they are ever enabled. Only the first five characters of the password's SHA-1 hash leave the server (k-anonymity). Sign-in never consults the service.

| Outcome | Response |
| --- | --- |
| The password is in the corpus | `400 PASSWORD_COMPROMISED`. Nothing is stored and a reset code stays usable, so the person can choose another password. |
| The lookup fails, or takes longer than `AUTH_BREACHED_PASSWORD_TIMEOUT_MS` (default 3000) | `503 PASSWORD_CHECK_UNAVAILABLE` with `Retry-After: 60`. The password is refused, never stored unchecked. The reset code survives. The server logs `[auth-breach-check]` with the reason (`timeout` or `lookup_failed`) and reports it to telemetry, never with the password. |

`AUTH_BREACHED_PASSWORD_CHECK` is `on` by default in production and `off` elsewhere. Tests and local seed workflows stay offline. Self-hosted deployments without internet access must set it to `off`; production logs a warning at startup when it is off. Invalid values fail startup.

Better Auth's native plugin hashes inside its endpoint context only. Never call `ctx.password.hash` outside an endpoint while the check is on; hash with `hashPassword` from `better-auth/crypto` instead.

## Rate limits

| Limit | Scope | Storage |
| --- | --- | --- |
| Better Auth native limits: sign-in 3 per 10 s, email sends 3 per minute, Email OTP checks and resets 3 per minute, and the custom rules in `@docslurp/shared/auth-security` | Per trusted client IP and path | `"rateLimit"` table (0038), production only |
| Email delivery: 5 per 15 minutes and 10 per hour | Per recipient address, across sign-up, verification codes, password reset and magic links | `auth_rate_limits` (0098) |
| Magic-link confirmation: 10 per minute | Per trusted client IP, plus a shared unknown-address bucket | `auth_rate_limits` |
| Company SSO endpoints: `SSO_RATE_LIMIT_MAX` per `SSO_RATE_LIMIT_WINDOW_MS` (default 30 per minute) | Per trusted client IP, method and path, after the global API limiter | `auth_rate_limits` |

The per-recipient budget counts requests for addresses with and without an account. A `429 EMAIL_RATE_LIMITED` (with `Retry-After`) therefore never reveals whether an address is registered. Password sign-in is deliberately not limited per address, because that would let anyone lock a user out. The budget is always on in production; `AUTH_EMAIL_RECIPIENT_LIMITS=on` turns it on elsewhere.

`auth_rate_limits` keys never contain an address, IP or token. Recipient keys are an HMAC of the normalized address under `BETTER_AUTH_SECRET`; other keys are SHA-256 digests. Every limit is one atomic statement shared by all app machines. A database error refuses the request rather than skipping the limit. Expired rows are pruned in the background.

Better Auth's limiter never applies to server-side `auth.api` calls. Every DocSlurp-owned endpoint that accepts input needs a native custom rule or a plugin `rateLimit` entry, and `auth-recovery.db.test.ts` fails when one is missing.

## Tests

`server/src/__tests__/auth-recovery.db.test.ts` runs the real configuration against a migrated database with both checks on. It covers session revocation, two-factor after reset, replayed, wrong-account and expired codes, unknown addresses, passwordless accounts, SSO refusal, disabled paths, breached passwords at every entry point, lookup failure and timeout, per-recipient limits with and without an account, budget atomicity under concurrency, and endpoint limit coverage.
