import { Hono } from "hono";

import {
  appDbPool,
  auth,
  configuredMagicLinkAuth,
  getDevSeedAccountCredential,
  handleAuthRequest,
  isDevSeedQuickLoginEnabled,
  type DevSeedAccountKey
} from "../lib/better-auth.js";
import {
  buildAuthFailureUrl,
  isForbiddenFormRequest,
  jsonResponse,
  normalizeRedirectTarget,
  signedSessionCookie,
  type AuthFallbackContextShape
} from "../lib/auth-fallback.js";
import { isInProcessEnv } from "../lib/client-ip.js";
import { isDevSeedRequestAllowed } from "../lib/dev-auth-access.js";
import { resolveSsoRedirect, ssoBaseUrl } from "../lib/sso-lookup.js";
import { hasValidSsoUnlinkedPass, ssoUnlinkedPassFromCookieHeader } from "../lib/sso-unlinked-pass.js";
import { confirmMagicLink, consumeMagicLinkConfirmation } from "../lib/auth-magic-link.js";
import { AUTH_CLIENT_IP_HEADER, withTrustedAuthClientIp } from "../lib/client-ip.js";
import { apiIpRateLimit } from "../middleware/rate-limit.js";

/**
 * Authentication endpoints, served at the same public URLs the app has always
 * used. Mounted before the API's global middleware (see `createApiApp`): these
 * paths skip request context and widget CORS, and Better Auth applies its own
 * rate limits and trusted-origin checks. `/api/sso-lookup` is the exception
 * that runs the API's per-IP limit itself: it is unauthenticated and queries
 * the database on every call.
 */
export const authRoutes = new Hono();

/**
 * The enforce-SSO redirect for a password sign-in, or null to continue with
 * the password. Domain-only (see `resolveSsoRedirect`), except that a browser
 * holding an unlinked pass for this email, minted by the SSO callback after
 * the IdP authenticated it, is let through so the user can sign in and link.
 */
async function enforcedSsoRedirect(request: Request, email: string): Promise<string | null> {
  const ssoUrl = await resolveSsoRedirect(email, ssoBaseUrl(request));
  if (!ssoUrl) return null;
  const pass = ssoUnlinkedPassFromCookieHeader(request.headers.get("cookie"));
  if (pass && hasValidSsoUnlinkedPass((await auth.$context).secret, pass, email)) return null;
  return ssoUrl;
}

// Explicit confirmation precedes the native catch-all. Native verification is server-only.
authRoutes.post("/api/auth/magic-link/confirm", async c => {
  if (!configuredMagicLinkAuth) return new Response(null, { status: 404 });
  const request = withTrustedAuthClientIp(c.req.raw, { trustedInternal: isInProcessEnv(c.env) });
  if (!await consumeMagicLinkConfirmation(appDbPool, request.headers.get(AUTH_CLIENT_IP_HEADER))) {
    return new Response(JSON.stringify({ code: "RATE_LIMITED", message: "Wait a minute before confirming another sign-in link." }),
      { status: 429, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "60" } });
  }
  const context = await auth.$context;
  return confirmMagicLink(request, input => auth.api.magicLinkVerify(input), async origin => context.isTrustedOrigin(origin));
});

// Better Auth's router: sign-in/up, OAuth callbacks, sessions, OTP, password reset...
authRoutes.all("/api/auth/*", (c) => handleAuthRequest(c.req.raw, { trustedInternal: isInProcessEnv(c.env) }));

/**
 * GET /api/sso-lookup?email=...[&explicit=1]  ->  { ssoUrl: string | null }
 *
 * Unauthenticated, so the answer depends only on the email's domain: two
 * addresses at the same domain get the same response whether or not either
 * has an account or SSO link. `explicit=1` ("Continue with company SSO")
 * returns any enabled provider; without it only an enforcing org redirects.
 */
authRoutes.get("/api/sso-lookup", apiIpRateLimit, async (c) => {
  const email = c.req.query("email")?.trim();
  if (!email || !email.includes("@")) return jsonResponse({ ssoUrl: null });
  const ssoUrl = c.req.query("explicit") === "1"
    ? await resolveSsoRedirect(email, ssoBaseUrl(c.req.raw), false)
    : await enforcedSsoRedirect(c.req.raw, email);
  return jsonResponse({ ssoUrl });
});

/** The HTML form uses the same verified-email policy as the auth API. */
authRoutes.post("/api/session/sign-in", async (c) => {
  const request = c.req.raw;
  if (isForbiddenFormRequest(request)) return new Response("Forbidden", { status: 403 });
  const form = await request.formData().catch(() => null);
  if (!(form instanceof FormData)) return new Response("Invalid sign-in form", { status: 400 });
  const email = typeof form.get("email") === "string" ? String(form.get("email")).trim() : "";
  const password = typeof form.get("password") === "string" ? String(form.get("password")) : "";
  const redirectTo = normalizeRedirectTarget(form.get("redirectTo"));
  const ssoUrl = await enforcedSsoRedirect(request, email);
  if (ssoUrl) return Response.redirect(ssoUrl, 302);
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const result = await handleAuthRequest(new Request(new URL("/api/auth/sign-in/email", request.url), {
    method: "POST", headers, body: JSON.stringify({ email, password, rememberMe: true }),
  }));
  if (!result.ok) {
    const payload = await result.json().catch(() => null) as { message?: string } | null;
    // Keep the verification binding an unverified sign-in earns (auth-credential-binding.ts).
    const failure = new Response(null, { status: 302, headers: { location: buildAuthFailureUrl(request.url, payload?.message ?? "Unable to sign in").toString() } });
    for (const cookie of result.headers.getSetCookie()) failure.headers.append("set-cookie", cookie);
    return failure;
  }
  const response = new Response(null, { status: 302, headers: { location: new URL(redirectTo, request.url).toString() } });
  for (const cookie of result.headers.getSetCookie()) response.headers.append("set-cookie", cookie);
  return response;
});

/**
 * Development quick login for the two seeded credential users. Answers 404
 * unless NODE_ENV=development and the request is same-origin from a local,
 * private-LAN or tailnet host (see `isDevSeedRequestAllowed`).
 */
authRoutes.post("/api/dev-auth/seed-signin", async (c) => {
  const request = c.req.raw;
  if (!isDevSeedQuickLoginEnabled() || !isDevSeedRequestAllowed(request)) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  const contentType = request.headers.get("content-type") ?? "";
  const isFormSubmission = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");
  const payload = isFormSubmission
    ? await request.formData().catch(() => null)
    : await request.json().catch(() => null);
  const accountField = payload instanceof FormData ? payload.get("account") : payload?.account;
  const redirectField = payload instanceof FormData ? payload.get("redirectTo") : payload?.redirectTo;
  const accountId = typeof accountField === "string" ? (accountField as DevSeedAccountKey) : null;
  const redirectTo = normalizeRedirectTarget(redirectField);

  function fail(error: string, status: number): Response {
    if (isFormSubmission) return Response.redirect(buildAuthFailureUrl(request.url, error), 302);
    return jsonResponse({ error }, status);
  }

  if (accountId !== "admin" && accountId !== "member") return fail("Invalid seed account", 400);

  const seedAccount = getDevSeedAccountCredential(accountId);
  if (!seedAccount) return fail("Seed quick login unavailable", 404);

  const authContext = (await auth.$context) as unknown as AuthFallbackContextShape;
  const existingUser = await authContext.internalAdapter.findUserByEmail(seedAccount.email, { includeAccounts: true });
  if (!existingUser) return fail(`Seed user ${seedAccount.email} was not found`, 404);

  const credentialAccount = existingUser.accounts.find((account) => account.providerId === "credential");
  if (!credentialAccount?.password) {
    return fail(`Seed user ${seedAccount.email} does not have password auth enabled`, 400);
  }

  const passwordMatches = await authContext.password.verify({
    hash: credentialAccount.password,
    password: seedAccount.password
  });
  if (!passwordMatches) return fail(`Seed credentials for ${seedAccount.email} are out of sync`, 401);

  const session = await authContext.internalAdapter.createSession(existingUser.user.id);
  if (!session) return fail("Unable to create auth session", 500);
  // Seed users skip the second factor, in development only (this route 404s
  // anywhere else): the quick login stays one click even after a developer
  // enrols TOTP on a seed account. Use the password form to exercise MFA.
  await appDbPool.query(`update session set "mfaVerified" = true where token = $1`, [session.token]);

  const cookie = signedSessionCookie(authContext, session.token);
  const response = isFormSubmission
    ? new Response(null, { status: 302, headers: { location: new URL(redirectTo, request.url).toString() } })
    : jsonResponse({ ok: true, redirectTo });
  response.headers.append("set-cookie", cookie);
  return response;
});
