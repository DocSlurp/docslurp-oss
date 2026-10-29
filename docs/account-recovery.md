# Account recovery and password safety

Password recovery, breached-password rejection and the authentication rate limits that protect both. Recovery and limits run on Better Auth's native plugins and hooks, with DocSlurp policy added around them. The breach check follows the native plugin's design, but owns its network call so the call can be cancelled.

## Password recovery

Recovery uses the native Email OTP plugin's reset flow, which was already configured for verification codes:

1. `POST /api/auth/email-otp/request-password-reset` with `{ email }`. The client is `authClient.emailOtp.requestPasswordReset`. The answer is `{ success: true }` whether or not the address has an account, and an unknown address gets no email.
2. The email's subject leads with the code and says it is a password reset code. It expires in 10 minutes, allows five wrong guesses, and is stored hashed.
3. `POST /api/auth/email-otp/reset-password` with `{ email, otp, password }`. The client is `authClient.emailOtp.resetPassword`.

A completed reset:

- **ends every session** of the account (`revokeSessionsOnPasswordReset: true`) and clears its trusted devices, so whoever held the old password is signed out;
- **never signs in.** The person signs in with the new password afterwards, and an account with two-factor still gets its second-factor challenge. Recovery doesn't turn off two-factor and doesn't grant sensitive-account access;
- **sets a first password** for an account that has none (email-code, magic-link or Google/GitHub users), and marks the address verified, because the code proved mailbox ownership;
- **removes earlier links from an account that was unverified.** If someone registered the address before its owner proved it, the reset deletes every account link (and stored OAuth token) except the password just chosen. That is the rule Better Auth's Email OTP sign-in and magic links already apply (`revokeUnprovenAccountAccess`); its Email OTP reset only marks the address verified. A verified account keeps its other sign-in methods.

A domain that enforces company SSO is refused with `SSO_REQUIRED` before any code is sent. The answer depends only on the domain, like `/api/sso-lookup`.

There is one recovery path. Over HTTP, the link-based reset endpoints (`/request-password-reset`, `/reset-password`) and the deprecated `/forget-password/email-otp` alias are disabled (`disabledPaths`) and answer 404. `disabledPaths` applies to the router only. The server-side `auth.api` methods still exist, and no DocSlurp code calls them.

Better Auth never reveals whether a code email was delivered. A failed send is logged as `[Better Auth]: Failed to run background task` and the endpoint still answers `{ success: true }`. The UI therefore says a code is on its way *if* the address has an account.

## Breached passwords

Every endpoint that stores a new password checks it against the [Have I Been Pwned](https://haveibeenpwned.com/Passwords) range API: sign-up, change password, Email OTP reset, and `/set-password` and `/reset-password` if they are ever enabled. Only the first five characters of the password's SHA-1 hash leave the server (k-anonymity), and the request asks for padding. Sign-in never consults the service. The lookup runs before the password is hashed.

`server/src/lib/auth-breached-password.ts` follows Better Auth's `haveIBeenPwned` plugin: the same `ctx.password.hash` hook, path selection, range protocol and `PASSWORD_COMPROMISED` code. It is not that plugin, because the native lookup accepts no abort signal or deadline: a hung request would outlive the user's refusal. Here the request is cancelled at the deadline, at most 32 lookups run per process, and the call is traced in SigNoz as the `hibp.password-range` dependency span.

| Outcome | Response |
| --- | --- |
| The password is in the corpus | `400 PASSWORD_COMPROMISED`. Nothing is stored and a reset code stays usable until it expires. |
| The lookup times out (`AUTH_BREACHED_PASSWORD_TIMEOUT_MS`, default 3000), fails, returns an error status or a malformed body, or 32 lookups are already in flight | `503 PASSWORD_CHECK_UNAVAILABLE` with `Retry-After: 60`. The request is aborted, never stored unchecked, and the reset code survives. |

Each refusal logs `[auth-breach-check] refused a new password reason=<timeout|upstream_status|network|malformed|saturated> [status=<http>] duration_ms=<n> path=<endpoint>`. It is reported to telemetry with the same fields. Neither carries the password, its hash, the address or the request URL.

`AUTH_BREACHED_PASSWORD_CHECK` is `on` by default in production and `off` elsewhere. Tests and local seed workflows stay offline. Self-hosted deployments without internet access must set it to `off`; production logs a warning at startup when it is off. Disabling it doesn't make recovery work offline, because recovery still needs the Resend email configuration. Invalid values fail startup.

## Rate limits

| Limit | Scope | Storage |
| --- | --- | --- |
| Better Auth native limits: sign-in 3 per 10 s, email sends 3 per minute, Email OTP checks and resets 3 per minute, and the custom rules in `@docslurp/shared/auth-security` | Per trusted client IP and path | `"rateLimit"` table (0038), production only |
| Email delivery: 5 per 15 minutes | Per recipient address, across sign-up, verification codes, password reset and magic links | `auth_rate_limits` (0099) |
| Emailed-code checks: 10 per 15 minutes | Per address, across Email OTP reset, verification and sign-in | `auth_rate_limits` |
| Magic-link confirmation: 10 per minute | Per trusted client IP, plus a shared unknown-address bucket | `auth_rate_limits` |
| Company SSO endpoints: `SSO_RATE_LIMIT_MAX` per `SSO_RATE_LIMIT_WINDOW_MS` (default 30 per minute) | Per trusted client IP, method and path, after the global API limiter | `auth_rate_limits` |

**Per-recipient email.** Requests count for addresses with and without an account, so a `429 EMAIL_RATE_LIMITED` (with `Retry-After`) never reveals whether an address is registered. Mail sent from an endpoint the limit doesn't hook still counts, and over budget it is skipped rather than failing the request. That mail is an unverified account's verification code re-sent on password sign-in. A failed delivery gives the unit back, so a provider outage doesn't lock anyone out.

**Emailed-code checks.** Better Auth counts wrong guesses on each code, but parallel guesses can race that count. The per-address budget is one atomic counter, so guessing stays bounded however the requests are sent. Refusals are `429 CODE_ATTEMPTS_LIMITED`.

**Accepted trade-off: targeted lockout.** Anyone who knows an address can spend its email and code budgets; that is what makes a 429 reveal nothing. An attacker who keeps doing so pauses that person's email codes, reset and magic links. The pause lasts at most 15 minutes after the attacker stops. Password, passkey, Google/GitHub and company sign-in are never affected, and the UI says so with the wait from `Retry-After`. The window is deliberately short: before this limit, the same attacker could send unlimited mail to the address.

**Telemetry.** Each refusal logs `[auth-rate-limit] denied purpose=<email-recipient|email-recipient-indirect|email-code-check|magic-link-confirm|sso> window_s=<n> max=<n> retry_after_s=<n>`. The key and identity are never logged, so these lines measure pressure, not targets.

**Clearing one address.** To lift a lockout for someone support has verified, compute the address's keys with the production secret and delete them:

```sh
node -e 'const {createHmac}=require("node:crypto");const d=createHmac("sha256",process.env.BETTER_AUTH_SECRET).update(process.argv[1].trim().toLowerCase()).digest("hex");console.log(`email-recipient:900:${d}\nemail-code-check:900:${d}`)' person@example.com
# then: delete from auth_rate_limits where key in ('email-recipient:900:…', 'email-code-check:900:…');
```

**Storage.** `auth_rate_limits` keys never contain an address, IP or token. Recipient keys are an HMAC of the normalized address under `BETTER_AUTH_SECRET`; other keys are SHA-256 digests. Every limit is one atomic statement shared by all app machines. A database error refuses the request rather than skipping the limit; SSO and magic-link confirmation answer 500 until the database is back. Expired rows are pruned in the background. During a rolling deploy, machines still on the previous release keep the old in-process SSO counters until they are replaced.

Better Auth's limiter never applies to server-side `auth.api` calls. Every DocSlurp-owned endpoint that accepts input needs a native custom rule or a plugin `rateLimit` entry, and `auth-recovery.db.test.ts` fails when one is missing.

## Tests

`server/src/__tests__/auth-recovery.db.test.ts` runs the real configuration against a migrated database with both checks on. It covers:

- session revocation and two-factor after a reset;
- replayed, wrong-account and expired codes, and racing code guesses;
- unknown addresses, passwordless accounts, and pre-registered unverified accounts (earlier links removed, verified accounts untouched);
- SSO refusal and the disabled paths;
- breached passwords at every entry point, plus lookup failure and timeout, including that a hung lookup is aborted;
- per-recipient limits with and without an account, indirect sends, and the refund on delivery failure;
- budget atomicity under concurrency, and endpoint limit coverage.
