# Email sign-in links

DocSlurp uses Better Auth's native magic-link plugin for existing-account sign-in. The plugin generates, hashes and atomically consumes the token; the application adds an explicit confirmation step so email scanners do not sign users in or consume their links.

## Configuration

Set `RESEND_API_KEY` and `EMAIL_FROM` using the existing authentication email configuration. Both values must be present; otherwise the plugin and UI option are disabled. Set `BETTER_AUTH_URL` (or `APP_URL`) to the canonical public auth origin. That origin must serve the frontend `/auth/magic-link` page and proxy `/api/auth/*` to the server. Production requires HTTPS. No new schema migration or dependency is required.

Links expire in five minutes, work once, and do not create accounts. Registration remains a separate flow. Password, email-verification codes, passkeys and company sign-in remain available as configured.

## Flow and API

1. The client calls native `signIn.magicLink({ email, callbackURL: '/app' })`. The HTTP endpoint is `POST /api/auth/sign-in/magic-link`. Omitted callbacks default to `/app`; only normalized app-owned destinations are accepted.
2. Email delivery uses the existing Resend transport. The email contains `/auth/magic-link#token=...&callbackURL=...`; its fragment does not reach the web server or referrer headers.
3. The standalone page removes the fragment from history immediately and keeps the pending proof in memory. Loading it never confirms the token. It has no analytics and sends no-cache/no-referrer headers.
4. The person clicks **Continue to sign in**. The app sends a bounded JSON `POST /api/auth/magic-link/confirm` with `{ token, callbackURL }` from a trusted origin.
5. The server delegates verification to the native API, preserves its session/MFA cookies and returns only `{ redirectTo }`. Native GET verification is server-only; public attempts cannot bypass the confirmation step.

Native issuance is limited to three requests per minute per client address in the production Better Auth database limiter, and every address shares the per-recipient email budget described in [account recovery](account-recovery.md#rate-limits). Confirmation has an independent atomic database budget (`auth_rate_limits`) of ten requests per minute per trusted client address, including a shared unknown-address bucket. This gate remains enabled when optional API limits are disabled and fails closed on storage failure. Tokens, email bodies and session values must never be logged.

## Security and recovery

Enforced company SSO still blocks email sign-in. Enrolled MFA users still receive a second-factor challenge. A successful login does not create the separate sensitive-account access grant; changing sensitive settings still requires explicit verification. Better Auth also handles proof of mailbox ownership for an existing unverified account, including removal of unproven credentials and revocation of prior sessions; integration tests cover that behavior.

Expired, tampered and already consumed tokens cannot issue a session. Unknown addresses cannot create an account through this endpoint. The UI acknowledges sending generically, provides request-new-link recovery, and keeps provider diagnostics out of user-facing errors. Delivery failure is reported instead of silently dropping an email. The feature does not establish production email deliverability: deployment and a live delivery smoke check remain separate operations.

The integration intentionally depends on the pinned native endpoint's server-only metadata and full server-API hook dispatch. Startup checks and real-handler tests protect that seam during upgrades. See [Better Auth magic-link documentation](https://better-auth.com/docs/plugins/magic-link) and [passkeys/MFA policy](passkeys-and-mfa.md).
