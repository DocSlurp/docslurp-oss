/**
 * Recovery policy at the HTTP boundary of Better Auth's native Email OTP flows.
 *
 * **Uniform code refusals.** Native code checks answer "too many attempts"
 * (403) or "expired" only when a code was issued, which only happens for a
 * registered address. Those answers become the `400 INVALID_OTP` an
 * unregistered address gets, so wrong guesses can't tell the two apart. A hook
 * can't do this: the dispatcher keeps the original error's status. It runs in
 * `handleAuthRequest`, the only path into Better Auth's router.
 *
 * **Why a reset needs no ownership cleanup.** Better Auth's Email OTP sign-in
 * and magic links promote an unverified account with
 * `revokeUnprovenAccountAccess`; its reset only sets `emailVerified`. In this
 * configuration that is enough, because an unverified account can hold nothing
 * but its password:
 * - `requireEmailVerification` withholds every session until the address is
 *   verified, so passkeys, two-factor, trusted devices and linked sign-ins
 *   (all of which need a session) can't be added before then;
 * - OAuth implicit linking needs the provider's verified email and, through
 *   `beforeOAuthAccountCreate`, removes the unverified password as it links;
 * - magic links and Email OTP sign-in run the native promotion;
 * - company SSO never links by email (an unlinked identity is refused).
 * The reset overwrites that password in the native transaction. The
 * configuration contract in `auth-recovery.db.test.ts` fails if any of these
 * premises changes; revisit this note when it does.
 */

/** Endpoints that check an emailed code (one-time codes, not magic links), under the auth base path. */
const CODE_CHECK_ROUTES = new Set(["/email-otp/reset-password", "/email-otp/check-verification-otp", "/email-otp/verify-email", "/sign-in/email-otp"].map((path) => `/api/auth${path}`));
const ISSUED_ONLY_CODES = new Set(["TOO_MANY_ATTEMPTS", "OTP_EXPIRED"]);

/** Rewrites a code refusal that only a registered address could get into the generic one. */
export async function uniformCodeRefusal(request: Request, response: Response): Promise<Response> {
  if ((response.status !== 400 && response.status !== 403) || !CODE_CHECK_ROUTES.has(new URL(request.url).pathname)) return response;
  const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  if (!ISSUED_ONLY_CODES.has(String(body?.code))) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({ code: "INVALID_OTP", message: "Invalid OTP" }), { status: 400, headers });
}
