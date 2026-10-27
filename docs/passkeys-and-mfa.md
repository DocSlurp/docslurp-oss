# Passkeys and two-factor authentication

DocSlurp uses Better Auth's native plugins for both:

- Passkeys: [`@better-auth/passkey`](https://www.better-auth.com/docs/plugins/passkey) 1.7.12 (WebAuthn via SimpleWebAuthn).
- Two-factor authentication: the [`twoFactor` plugin](https://www.better-auth.com/docs/plugins/2fa) in `better-auth` 1.7.12, with TOTP and single-use backup codes.

The plugin tables come from migration `0091_passkey_two_factor.sql`, not from Better Auth's auto-migrate. The DocSlurp rules on top of the plugins live in `server/src/lib/auth-mfa.ts`.

## Flows

**Enrol TOTP.** In Settings, Security, the user calls `POST /api/auth/two-factor/enable`. Users with a password must enter it; email-code and social users don't need one (`allowPasswordless`). The response holds an `otpauth://` URI, which the app draws as a QR code in the browser and also shows as a manual key, plus 10 backup codes. The codes are shown once and can be downloaded. 2FA stays off until the user verifies a code with `POST /api/auth/two-factor/verify-totp`. Verifying it turns 2FA on and re-issues the browser's session as MFA-verified. Sessions on other devices that predate 2FA stop working, and those devices must sign in again with the second factor.

**Sign in with 2FA on.** The first factor can be a password, an email code, Google or GitHub, an email-verification link, or company SSO. None of them returns a session. A JSON sign-in gets `{ twoFactorRedirect: true, twoFactorMethods: ["totp"] }`. Redirect sign-ins such as OAuth callbacks, email links and SSO are sent to `/app/sign-in?mfa=required&redirectTo=…`. Each case sets a signed `two_factor` cookie that lasts 10 minutes. The app then asks for a TOTP code (`/two-factor/verify-totp`) or a backup code (`/two-factor/verify-backup-code`). Only that step issues a session.

**Trusted device.** When verifying a code, the user can tick "Trust this device". The browser then skips the challenge for `MFA_TRUST_DEVICE_DAYS` (14 by default, 30 at most). The plugin's trust cookie is signed and bound to the user. The server keeps a matching record, rotates it on each use, and revokes it when 2FA is disabled from that browser.

**Passkeys.** Users add, rename and delete passkeys in Settings, Security. The page lists each passkey's authenticator, creation date and last use. A user signs in with one from the login screen's passkey button, or through browser autofill (conditional UI) in the email field.

**Org policy.** An owner or admin can require MFA for members (`PUT /v1/organizations/:orgId/security-policy` with `{ requireMfa, gracePeriodDays }`, 0 to 30 days). Each member's grace period starts when the policy is turned on or when they join, whichever is later. After it ends, a member whose session hasn't passed MFA gets `403 mfa_required` from every API route except `GET /v1/account/security`. That session can still enrol a factor through `/api/auth`. Other session consumers, such as MCP OAuth consent, treat a blocked session as signed out. Only an admin on an MFA-verified session can change the policy, so nobody can impose a requirement they couldn't meet themselves.

## Decisions

- **A passkey satisfies MFA, but only with user verification.** A passkey proves possession, and its biometric or PIN proves the user. The plugin verifies with `requireUserVerification: false`, so DocSlurp asks for `userVerification: "required"` and refuses any registration or assertion without the UV flag. The check runs after the signature check, so the flag is authenticated. Better Auth's own model is the same: passkey sign-in is not 2FA-challenged.
- **Every first factor is challenged.** The twoFactor plugin challenges only `/sign-in/email`, `/sign-in/username` and `/sign-in/phone-number`. DocSlurp removes that hook and runs its own after-hook on every Better Auth endpoint that issues a session. A future endpoint is therefore challenged by default. Startup fails if the plugin's hook shape changes in an upgrade.
- **Sessions carry their assurance.** `session.mfaVerified` is set when the session is created, from the endpoint that created it and never from request input. It is true only for the TOTP and backup-code verify endpoints, a trusted device, or a user-verified passkey. Re-issues such as profile updates or enabling 2FA copy the old session's assurance and `authenticatedAt`. If a session without `mfaVerified` reaches Better Auth or the API for a user with 2FA on, it is stripped from the request and deleted, whichever code path minted it.
- **Changing factors needs a strong session.** Adding, renaming or removing factors needs an MFA-verified session once the account has 2FA on, or once it has a factor and an org requires MFA. This stops someone with only the password from enrolling their own factor. Disabling 2FA, regenerating backup codes and deleting a passkey also need a sign-in within `MFA_REAUTH_MAX_AGE_SECONDS` (600 by default), plus the password for accounts that have one.
- **Rate limits and lockout.** Each challenge allows 5 wrong codes. After 10 consecutive failures across challenges, the account locks for 15 minutes; this counter is shared by TOTP and backup codes, and the plugin enforces it. On top of that are per-IP limits of 10 attempts a minute for each verify endpoint and 20 a minute for passkey sign-in. A TOTP code is accepted once. A replay inside its 90-second validity window is refused (`mfa_totp_replay`), even on a different challenge.
- **No email OTP second factor.** For a user who signs in with an email code, an emailed second code would be the same factor twice.
- **SSO stays enforced.** A passkey can't sign in to an account whose email domain is DNS-verified by an org that enforces SSO, and such an account can't register one. A company SSO sign-in still triggers the TOTP challenge for a user who has 2FA on. An org that requires both SSO and MFA should enforce MFA at its IdP. The DocSlurp policy counts only DocSlurp factors.
- **API keys and OAuth/CLI tokens are unaffected.** They are separate bearer credentials: the session MFA checks don't apply to them, and they are scoped and revocable on their own. Creating them needs a signed-in session, so under an org policy a new key or token can only come from an MFA-satisfying session.
- **Dev quick login is exempt, in development only.** The seed-user quick login (`/api/dev-auth/seed-signin`) returns 404 unless `NODE_ENV=development` and the request comes from a local origin. Its sessions are marked MFA-verified, so the button stays one click after a developer enrols TOTP on a seed user. To test the challenge locally, use the password form with the seed credentials.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BETTER_AUTH_URL` / `APP_URL` | `http://localhost:4321` | The app origin. Its host is the passkey RP ID (`docslurp.io` in production, `localhost` in development). |
| `PASSKEY_RP_ID` | app host | Optional parent domain for the RP ID. It must contain the app host, can't be an IP address or a bare suffix, and can't be localhost in production. |
| `PASSKEY_ORIGINS` | none | Extra exact origins, comma-separated, each inside the RP ID. They must use HTTPS (HTTP only for localhost outside production) and wildcards are rejected. |
| `PASSKEY_RP_NAME`, `TWO_FACTOR_ISSUER` | `DocSlurp` | Names shown by authenticators and authenticator apps. |
| `MFA_TRUST_DEVICE_DAYS` | `14` | Trusted-device lifetime, 1 to 30 days. |
| `MFA_REAUTH_MAX_AGE_SECONDS` | `600` | How recent a sign-in must be to remove a factor, 60 to 3600 seconds. |

An invalid passkey configuration fails at startup.

## Endpoints

- Better Auth, under `/api/auth`: `two-factor/{enable,disable,get-totp-uri,verify-totp,generate-backup-codes,verify-backup-code}` and `passkey/{generate-register-options,verify-registration,generate-authenticate-options,verify-authentication,list-user-passkeys,update-passkey,delete-passkey}`.
- DocSlurp: `GET /v1/account/security` returns factors, passkey last use, this session's assurance and re-auth deadline, and policy status. `GET` and `PUT /v1/organizations/:orgId/security-policy` read and change the org policy, and accept sessions only.
