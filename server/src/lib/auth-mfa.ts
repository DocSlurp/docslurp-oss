import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";

import { passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { deleteSessionCookie, expireCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { serialize, type CookieOptions } from "hono/utils/cookie";
import type { Pool } from "pg";

import { safeRedirectPath } from "./safe-redirect.js";

/**
 * Passkeys and two-factor authentication on Better Auth's native plugins
 * (`@better-auth/passkey`, `better-auth/plugins` twoFactor), plus the DocSlurp
 * rules the plugins leave to the application:
 *
 * - **Every first factor is challenged.** The twoFactor plugin only challenges
 *   `/sign-in/email|username|phone-number`. Its after-hook is replaced by one
 *   that runs on every endpoint that issues a session (email OTP, email
 *   verification links, OAuth callbacks and anything added later), so a new
 *   sign-in path is challenged by default instead of silently skipping MFA.
 * - **Sessions carry their assurance.** `session.mfaVerified` is true only for
 *   sessions issued by a TOTP or backup-code challenge, a trusted device, or a
 *   user-verified passkey. A session without it, for a user who has 2FA on, is
 *   treated as no session at all (stripped before Better Auth or the API sees
 *   it, then deleted), whichever code path minted it.
 * - **Passkeys satisfy MFA** only with user verification (biometric or PIN):
 *   the plugin verifies with `requireUserVerification: false`, so the UV flag
 *   is enforced here after the signature check.
 * - **Factor changes need a strong session.** Adding or removing factors needs
 *   an MFA-verified session once the account has 2FA (or must have MFA by org
 *   policy), and removing one needs a sign-in within the re-auth window.
 * - **TOTP codes are single use** within their validity window.
 * - **Org SSO enforcement holds for passkeys**: a passkey can't sign in to, or
 *   be registered on, an account whose email domain must use company SSO.
 */

export const MFA_REQUIRED_CODE = "MFA_REQUIRED";
export const REAUTH_REQUIRED_CODE = "REAUTH_REQUIRED";
export const SSO_REQUIRED_CODE = "SSO_REQUIRED";
export const USER_VERIFICATION_REQUIRED_CODE = "PASSKEY_USER_VERIFICATION_REQUIRED";

/** App page that renders the second-factor step for redirect-based sign-ins. */
export const MFA_CHALLENGE_PATH = "/app/sign-in";
export const MFA_CHALLENGE_MAX_AGE_SECONDS = 600;

/** Better Auth's own names: the challenge must interoperate with the plugin's verify endpoints. */
const TWO_FACTOR_COOKIE = "two_factor";
const TRUST_DEVICE_COOKIE = "trust_device";

/** Endpoints whose new session proves a second factor (or a user-verified passkey). */
const MFA_SESSION_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code", "/passkey/verify-authentication"]);
/**
 * Endpoints that may issue a new session without a first-factor challenge:
 * the MFA paths above, and sign-out. Everything else that sets a session is a
 * first factor (or a rotation of an existing session, detected separately).
 */
const CHALLENGE_EXEMPT_PATHS = new Set([...MFA_SESSION_PATHS, "/sign-out"]);
/** Factor management: needs an MFA-verified session once the account relies on MFA. */
const FACTOR_MANAGEMENT_PATHS = new Set([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/update-passkey",
  "/passkey/delete-passkey",
]);
/** Factor removal or replacement: also needs a recent sign-in (re-auth). */
const FACTOR_REMOVAL_PATHS = new Set(["/two-factor/disable", "/two-factor/generate-backup-codes", "/passkey/delete-passkey"]);
const TRUST_REVOKING_PATHS = new Set(["/two-factor/disable", "/change-password", "/revoke-sessions", "/revoke-other-sessions", "/email-otp/reset-password"]);
const PASSKEY_REGISTRATION_PATHS = new Set(["/passkey/generate-register-options", "/passkey/verify-registration"]);

export interface MfaConfig {
  /** WebAuthn relying-party ID: the app's registrable host, never a wildcard. */
  rpID: string;
  rpName: string;
  /** Exact origins allowed in WebAuthn client data. */
  origins: string[];
  issuer: string;
  trustDeviceMaxAgeSeconds: number;
  challengeMaxAgeSeconds: number;
  reauthMaxAgeSeconds: number;
  /** App path that renders the second-factor step for redirect-based sign-ins. */
  challengePath: string;
  lockout: { maxFailedAttempts: number; durationSeconds: number };
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * Resolves the WebAuthn relying party from the auth base URL. Fails at startup
 * on anything a browser would reject or that would widen the credential scope:
 * an IP-address RP ID, an RP ID the app host isn't inside, wildcard or
 * non-HTTPS origins, or localhost in production.
 */
export function resolveMfaConfig(env: NodeJS.ProcessEnv, baseURL: string): MfaConfig {
  const base = new URL(baseURL);
  const production = env.NODE_ENV === "production";
  const host = base.hostname.toLowerCase();
  const rpID = (env.PASSKEY_RP_ID?.trim() || host).toLowerCase();
  if (rpID.includes("*") || rpID.includes("/") || rpID.includes(":")) throw new Error("PASSKEY_RP_ID must be a bare domain name");
  if (isIP(rpID) || isIP(rpID.replace(/^\[|\]$/g, ""))) throw new Error("PASSKEY_RP_ID cannot be an IP address; WebAuthn needs a domain name (use localhost in development)");
  if (!isLoopbackHost(rpID) && !rpID.includes(".")) throw new Error("PASSKEY_RP_ID must be a registrable domain, not a bare suffix");
  if (production && isLoopbackHost(rpID)) throw new Error("PASSKEY_RP_ID cannot be localhost in production");

  const withinRp = (hostname: string) => hostname === rpID || hostname.endsWith(`.${rpID}`);
  const checkOrigin = (value: string): string => {
    if (value.includes("*")) throw new Error(`Passkey origin ${value} must not contain a wildcard`);
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`Passkey origin ${value} is not a valid URL`); }
    if (parsed.origin !== value.replace(/\/$/, "")) throw new Error(`Passkey origin ${value} must be a bare origin (scheme, host and optional port)`);
    const hostname = parsed.hostname.toLowerCase();
    if (!withinRp(hostname)) throw new Error(`Passkey origin ${value} is outside the relying party ${rpID}`);
    const loopbackHttp = parsed.protocol === "http:" && isLoopbackHost(hostname) && !production;
    if (parsed.protocol !== "https:" && !loopbackHttp) throw new Error(`Passkey origin ${value} must use https`);
    return parsed.origin;
  };

  if (!withinRp(host)) throw new Error(`PASSKEY_RP_ID ${rpID} must equal or contain the app host ${host}`);
  const origins = [checkOrigin(base.origin)];
  for (const extra of (env.PASSKEY_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const origin = checkOrigin(extra);
    if (!origins.includes(origin)) origins.push(origin);
  }

  return {
    rpID,
    rpName: env.PASSKEY_RP_NAME?.trim() || "DocSlurp",
    origins,
    issuer: env.TWO_FACTOR_ISSUER?.trim() || "DocSlurp",
    trustDeviceMaxAgeSeconds: boundedInteger(env.MFA_TRUST_DEVICE_DAYS, 14, 1, 30, "MFA_TRUST_DEVICE_DAYS") * 86_400,
    challengeMaxAgeSeconds: MFA_CHALLENGE_MAX_AGE_SECONDS,
    reauthMaxAgeSeconds: boundedInteger(env.MFA_REAUTH_MAX_AGE_SECONDS, 600, 60, 3600, "MFA_REAUTH_MAX_AGE_SECONDS"),
    challengePath: MFA_CHALLENGE_PATH,
    lockout: { maxFailedAttempts: 10, durationSeconds: 900 },
  };
}

// ---------------------------------------------------------------------------
// Session assurance

interface AssuranceSession { userId: string; mfaVerified?: boolean | null; authenticatedAt?: Date | string | null; createdAt?: Date | string | null }
interface EndpointLike {
  path?: string;
  context?: { session?: { session?: AssuranceSession | null; user?: { id?: string } | null } | null } | null;
}

export interface SessionAssurance { mfaVerified: boolean; authenticatedAt: Date }

/**
 * The assurance a session gets when it is created (Better Auth's
 * `databaseHooks.session.create.before`). A session re-issued from an existing
 * session of the same user (enabling 2FA, profile updates, passkey
 * registration) keeps that session's assurance and sign-in time, so a rotation
 * can neither upgrade a session nor refresh the re-auth window.
 */
export function sessionAssuranceFor(ctx: EndpointLike | null | undefined, userId: string, now = new Date()): SessionAssurance {
  const prior = ctx?.context?.session;
  const priorSession = prior?.user?.id === userId ? prior.session ?? null : null;
  const priorAuthenticatedAt = priorSession ? toDate(priorSession.authenticatedAt) ?? toDate(priorSession.createdAt) ?? now : null;
  const path = ctx?.path;
  if (path === "/passkey/verify-authentication") return { mfaVerified: true, authenticatedAt: now };
  // A sign-in challenge has no prior session; verifying enrolment does, and
  // the user's first factor dates from that session.
  if (path && MFA_SESSION_PATHS.has(path)) return { mfaVerified: true, authenticatedAt: priorAuthenticatedAt ?? now };
  if (priorSession) return { mfaVerified: priorSession.mfaVerified === true, authenticatedAt: priorAuthenticatedAt ?? now };
  return { mfaVerified: false, authenticatedAt: now };
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Org policy

export interface MfaPolicyStatus {
  /** Some organization the user belongs to requires MFA. */
  required: boolean;
  /** Earliest enrolment deadline across those organizations. */
  deadline: string | null;
  /** Required, past the deadline, and this session has not passed MFA: block. */
  enforced: boolean;
  orgIds: string[];
}

/**
 * The org "require MFA" policy for a user's session. A member must use an
 * MFA-verified session (TOTP challenge, trusted device or passkey) once their
 * grace period ends; the period runs from when the policy was turned on or
 * from when they joined, whichever is later.
 */
export async function evaluateMfaPolicy(pool: Pick<Pool, "query">, userId: string, sessionMfaVerified: boolean, now = new Date()): Promise<MfaPolicyStatus> {
  const { rows } = await pool.query<{ org_id: string; deadline: Date }>(
    `select o.id as org_id,
            greatest(coalesce(o.require_mfa_since, now()), m.created_at) + make_interval(days => o.mfa_grace_period_days) as deadline
       from org_memberships m
       join organizations o on o.id = m.org_id
      where m.user_id = $1 and o.require_mfa and o.deleted_at is null
      order by deadline asc`,
    [userId],
  );
  if (rows.length === 0) return { required: false, deadline: null, enforced: false, orgIds: [] };
  const deadline = new Date(rows[0]!.deadline);
  return {
    required: true,
    deadline: deadline.toISOString(),
    enforced: !sessionMfaVerified && deadline.getTime() <= now.getTime(),
    orgIds: rows.map((row) => row.org_id),
  };
}

// ---------------------------------------------------------------------------
// Plugins

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

interface MfaPluginOptions {
  pool: Pick<Pool, "query">;
  config: MfaConfig;
  /** Override for tests; defaults to `ssoEnforcedForEmail`. */
  isSsoEnforced?: (email: string) => Promise<boolean>;
}

/**
 * True when the email's domain is DNS-verified by an org that enforces company
 * SSO (the same rule as `resolveSsoRedirect`). Unlike that lookup, a database
 * error propagates: the passkey checks fail closed.
 */
export async function ssoEnforcedForEmail(pool: Pick<Pool, "query">, email: string): Promise<boolean> {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return false;
  const { rows } = await pool.query(
    `select 1 from organizations o
       join sso_domains d on d.org_id = o.id and d.domain = o.sso_config->>'emailDomain' and d.verified_at is not null
      where d.domain = $1 and (o.sso_config->>'enabled')::boolean = true and (o.sso_config->>'enforceSso')::boolean = true
      limit 1`,
    [domain],
  );
  return rows.length > 0;
}

function ssoCheck(options: MfaPluginOptions): (email: string) => Promise<boolean> {
  return options.isSsoEnforced ?? ((email) => ssoEnforcedForEmail(options.pool, email));
}

interface SessionRow {
  session_id: string;
  token: string;
  user_id: string;
  email: string;
  mfa_verified: boolean;
  authenticated_at: Date | null;
  created_at: Date;
  two_factor_enabled: boolean;
  passkeys: number;
}

/** Cookie pairs named `name` (or a chunk of it, `name.0`) in a raw Cookie header. */
function countCookies(cookieHeader: string | null, name: string): number {
  if (!cookieHeader) return 0;
  return cookieHeader.split(";").filter((part) => {
    const key = part.split("=")[0]?.trim() ?? "";
    return key === name || key.startsWith(`${name}.`);
  }).length;
}

interface RequestSession {
  /** More than one session cookie: the request is treated as unauthenticated. */
  ambiguous: boolean;
  /** The session Better Auth itself would use: the signed session cookie, verified. */
  row: SessionRow | null;
}

/**
 * Resolves the caller's session exactly as Better Auth's endpoints do
 * (better-call's `getSignedCookie`: signature checked, never a raw value), so
 * the gate and the endpoint always judge the same session. A request with
 * several session cookies is ambiguous: the strip hook removes all of them.
 */
async function requestSession(ctx: HookContext, pool: Pick<Pool, "query">): Promise<RequestSession> {
  const name = sessionCookieName(ctx);
  if (countCookies(requestCookieHeader(ctx), name) > 1) return { ambiguous: true, row: null };
  const token = await ctx.getSignedCookie(name, ctx.context.secret);
  return { ambiguous: false, row: token ? await loadSessionRow(pool, token) : null };
}

/** Better Auth paths a session blocked by an org MFA policy may still use: sign-in, sign-out and enrolment. */
const POLICY_BLOCKED_ALLOWED_PATHS = new Set([
  "/get-session", "/sign-out", "/verify-email", "/email-otp/send-verification-otp", "/email-otp/verify-email",
  "/two-factor/enable", "/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/get-totp-uri",
  "/passkey/generate-register-options", "/passkey/verify-registration", "/passkey/list-user-passkeys",
  "/passkey/generate-authenticate-options", "/passkey/verify-authentication",
]);
function allowedWhilePolicyBlocked(path: string): boolean {
  // Exact paths (plus sign-in and OAuth callbacks), so a newly enabled account
  // endpoint such as an email change stays blocked by default.
  return POLICY_BLOCKED_ALLOWED_PATHS.has(path) || path.startsWith("/sign-in/") || path.startsWith("/callback/");
}

async function loadSessionRow(pool: Pick<Pool, "query">, token: string): Promise<SessionRow | null> {
  const { rows } = await pool.query<SessionRow>(
    `select s.id as session_id, s.token, s."userId" as user_id, u.email, s."mfaVerified" as mfa_verified,
            s."authenticatedAt" as authenticated_at, s."createdAt" as created_at,
            u."twoFactorEnabled" as two_factor_enabled,
            (select count(*)::int from passkey p where p."userId" = s."userId") as passkeys
       from session s join "user" u on u.id = s."userId"
      where s.token = $1 and s."expiresAt" > now()`,
    [token],
  );
  return rows[0] ?? null;
}

function sessionCookieName(ctx: HookContext): string {
  return ctx.context.authCookies.sessionToken.name;
}

function requestCookieHeader(ctx: HookContext): string | null {
  return ctx.headers?.get("cookie") ?? ctx.request?.headers.get("cookie") ?? null;
}

function forbidden(code: string, message: string): APIError {
  return new APIError("FORBIDDEN", { code, message });
}

function hmacTrustToken(secret: string, userId: string, identifier: string): string {
  return createHmac("sha256", secret).update(`${userId}!${identifier}`).digest("base64url");
}

/**
 * Starts the twoFactor plugin's sign-in challenge for `userId`: the verification
 * records and signed `two_factor` cookie its `/two-factor/verify-*` endpoints
 * consume. Mirrors the plugin's own after-hook so the stock verify endpoints,
 * attempt counter and account lockout apply unchanged.
 */
async function beginChallenge(ctx: HookContext, userId: string, maxAge: number): Promise<void> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE, { maxAge });
  const identifier = `2fa-${generateRandomString(20)}`;
  const expiresAt = new Date(Date.now() + maxAge * 1000);
  await ctx.context.internalAdapter.createVerificationValue({ value: userId, identifier, expiresAt });
  await ctx.context.internalAdapter.createVerificationValue({ value: "0", identifier: `2fa-attempts-${identifier}`, expiresAt });
  await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);
}

/** A valid trusted-device cookie for `userId` is rotated (single use) and accepted. */
async function consumeTrustedDevice(ctx: HookContext, userId: string, maxAge: number, pool: Pick<Pool, "query">): Promise<boolean> {
  const cookie = ctx.context.createAuthCookie(TRUST_DEVICE_COOKIE, { maxAge });
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!value) return false;
  const [token, identifier] = value.split("!");
  if (token && identifier && token === hmacTrustToken(ctx.context.secret, userId, identifier)) {
    const consumed = await pool.query(
      `delete from verification where identifier = $1 and value = $2 and "expiresAt" > now() returning id`,
      [identifier, userId],
    );
    if (consumed.rowCount === 1) {
      const next = `trust-device-${generateRandomString(32)}`;
      await ctx.context.internalAdapter.createVerificationValue({ value: userId, identifier: next, expiresAt: new Date(Date.now() + maxAge * 1000) });
      await ctx.setSignedCookie(cookie.name, `${hmacTrustToken(ctx.context.secret, userId, next)}!${next}`, ctx.context.secret, cookie.attributes);
      return true;
    }
  }
  expireCookie(ctx, cookie);
  return false;
}

function isRedirect(returned: unknown): returned is APIError {
  return isAPIError(returned) && (returned.statusCode === 302 || returned.statusCode === 301 || returned.statusCode === 303 || returned.statusCode === 307);
}

/** Where a redirect-based sign-in (OAuth, email link) continues after the second factor. */
function challengeRedirectUrl(ctx: HookContext, config: MfaConfig, returned: unknown): string {
  const base = new URL(ctx.context.baseURL);
  const target = new URL(config.challengePath, base.origin);
  target.searchParams.set("mfa", "required");
  const location = isAPIError(returned) ? new Headers(returned.headers as HeadersInit | undefined).get("location") : null;
  if (location) {
    try {
      const parsed = new URL(location, base.origin);
      if (parsed.origin === base.origin) target.searchParams.set("redirectTo", safeRedirectPath(`${parsed.pathname}${parsed.search}`, "/app"));
    } catch { /* fall back to the app root */ }
  }
  return target.toString();
}

/**
 * The twoFactor plugin, configured for DocSlurp: TOTP plus 10 encrypted
 * single-use backup codes, account lockout, a bounded trusted-device window,
 * and passwordless accounts (email-code and social users) allowed to enrol.
 * No email OTP second factor: for an email-code sign-in it would be the same
 * factor twice. The plugin's credential-only after-hook is removed: the
 * DocSlurp gate below challenges every first factor instead.
 */
export function docslurpTwoFactorPlugin(config: MfaConfig): BetterAuthPlugin {
  const plugin = twoFactor({
    issuer: config.issuer,
    allowPasswordless: true,
    skipVerificationOnEnable: false,
    trustDeviceMaxAge: config.trustDeviceMaxAgeSeconds,
    twoFactorCookieMaxAge: config.challengeMaxAgeSeconds,
    totpOptions: { digits: 6, period: 30 },
    backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
    accountLockout: { enabled: true, maxFailedAttempts: config.lockout.maxFailedAttempts, durationSeconds: config.lockout.durationSeconds },
  } as Parameters<typeof twoFactor>[0]);
  const after = plugin.hooks?.after ?? [];
  // Fail closed on an upgrade that changes the plugin's hook shape: the
  // replacement below assumes exactly the credential sign-in hook.
  const credentialHook = after.length === 1 && after[0]!.matcher({ path: "/sign-in/email" } as never) && !after[0]!.matcher({ path: "/sign-in/email-otp" } as never);
  if (!credentialHook || ((plugin.hooks as { before?: unknown[] } | undefined)?.before?.length ?? 0) > 0) {
    throw new Error("better-auth twoFactor hooks changed shape; review the DocSlurp MFA gate before upgrading");
  }
  return { ...plugin, hooks: { ...plugin.hooks, after: [] } } as BetterAuthPlugin;
}

/** The passkey plugin, with user verification and SSO enforcement added. */
export function docslurpPasskeyPlugin(options: MfaPluginOptions): BetterAuthPlugin {
  const { config, pool } = options;
  const isSsoEnforced = ssoCheck(options);
  return passkey({
    rpID: config.rpID,
    rpName: config.rpName,
    origin: config.origins,
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    registration: {
      afterVerification: async ({ verification }) => {
        if (!verification.registrationInfo?.userVerified) {
          throw forbidden(USER_VERIFICATION_REQUIRED_CODE, "This passkey must verify you with a fingerprint, face or PIN");
        }
        return {};
      },
    },
    authentication: {
      afterVerification: async ({ verification, clientData }) => {
        // Runs after the plugin checked the signature over authenticatorData,
        // so the UV flag it reports is authenticated.
        if (!verification.authenticationInfo.userVerified) {
          throw forbidden(USER_VERIFICATION_REQUIRED_CODE, "This passkey must verify you with a fingerprint, face or PIN");
        }
        const { rows } = await pool.query<{ email: string }>(
          `select u.email from passkey p join "user" u on u.id = p."userId" where p."credentialID" = $1 and u.deleted_at is null`,
          [clientData.id],
        );
        const owner = rows[0];
        if (!owner) throw new APIError("UNAUTHORIZED", { code: "PASSKEY_NOT_FOUND", message: "Passkey not found" });
        if (await isSsoEnforced(owner.email)) {
          throw forbidden(SSO_REQUIRED_CODE, "Your organization requires company sign-in (SSO)");
        }
        await pool.query(`update passkey set "lastUsedAt" = now() where "credentialID" = $1`, [clientData.id]);
      },
    },
  }) as unknown as BetterAuthPlugin;
}

/** The DocSlurp MFA gate (hooks only; no endpoints). */
export function docslurpMfaGatePlugin(options: MfaPluginOptions): BetterAuthPlugin {
  const { pool, config } = options;
  const isSsoEnforced = ssoCheck(options);

  /**
   * A session cookie is ignored (and its session deleted) when the user has
   * 2FA on and the session never passed it. Runs before every Better Auth
   * endpoint, including `auth.api.getSession`, which the API's session
   * middleware uses: a session minted by any path that skipped the challenge
   * authorizes nothing.
   */
  const stripUnverifiedSessions = createAuthMiddleware(async (ctx) => {
    const cookieHeader = requestCookieHeader(ctx);
    if (!cookieHeader) return;
    const { ambiguous, row } = await requestSession(ctx, pool);
    if (ambiguous) {
      console.warn(`[auth-mfa] ignored a request carrying several session cookies path=${ctx.path}`);
    } else {
      if (!row || row.mfa_verified) return;
      if (!row.two_factor_enabled) {
        // Org "require MFA" past its grace period: only sign-in, sign-out and
        // enrolment, never account changes (email, password, linked accounts).
        if (!allowedWhilePolicyBlocked(ctx.path ?? "") && (await evaluateMfaPolicy(pool, row.user_id, false)).enforced) {
          throw forbidden(MFA_REQUIRED_CODE, "Your organization requires two-factor authentication or a passkey");
        }
        return;
      }
      await pool.query(`delete from session where token = $1`, [row.token]);
      console.warn(`[auth-mfa] revoked a session that never passed 2FA user=${row.user_id} session=${row.session_id}`);
    }
    const names = new Set([sessionCookieName(ctx), ctx.context.authCookies.sessionData.name]);
    const kept = cookieHeader.split(";").map((part) => part.trim()).filter((part) => {
      const name = part.split("=")[0]?.trim() ?? "";
      return part && !names.has(name) && ![...names].some((prefix) => name.startsWith(`${prefix}.`));
    });
    const headers = new Headers(ctx.headers ?? ctx.request?.headers ?? undefined);
    headers.set("cookie", kept.join("; "));
    return { context: { headers } };
  });

  const guardFactorManagement = createAuthMiddleware(async (ctx) => {
    // No session, or an ambiguous one (stripped before the endpoint runs): the endpoint answers 401.
    const { row } = await requestSession(ctx, pool);
    if (!row) return;
    const policy = await evaluateMfaPolicy(pool, row.user_id, row.mfa_verified);
    const enrolled = row.two_factor_enabled || row.passkeys > 0;
    if ((row.two_factor_enabled || (policy.required && enrolled)) && !row.mfa_verified) {
      throw forbidden(MFA_REQUIRED_CODE, "Sign in with your second factor or passkey to change sign-in methods");
    }
    if (FACTOR_REMOVAL_PATHS.has(ctx.path)) {
      const authenticatedAt = toDate(row.authenticated_at) ?? toDate(row.created_at);
      if (!authenticatedAt || Date.now() - authenticatedAt.getTime() > config.reauthMaxAgeSeconds * 1000) {
        throw forbidden(REAUTH_REQUIRED_CODE, "Sign in again to remove a sign-in method");
      }
    }
    if (PASSKEY_REGISTRATION_PATHS.has(ctx.path) && await isSsoEnforced(row.email)) {
      throw forbidden(SSO_REQUIRED_CODE, "Your organization requires company sign-in (SSO)");
    }
  });

  /** Claims a TOTP code for its user before verification; a second use is refused. */
  const claimTotpCode = createAuthMiddleware(async (ctx) => {
    const code = typeof ctx.body?.code === "string" ? ctx.body.code.trim() : "";
    if (!code) return;
    // Claim the code for every user the plugin could verify it against: the
    // signed session's user and the signed challenge's user. Whichever one the
    // plugin picks, the code is then spent for that user.
    const candidates = new Set<string>();
    const { row } = await requestSession(ctx, pool);
    if (row) candidates.add(row.user_id);
    const challenge = await ctx.getSignedCookie(ctx.context.createAuthCookie(TWO_FACTOR_COOKIE).name, ctx.context.secret);
    if (challenge) {
      const owner = (await ctx.context.internalAdapter.findVerificationValue(challenge))?.value;
      if (owner) candidates.add(owner);
    }
    if (candidates.size === 0) return; // The endpoint rejects the missing session or challenge.
    await pool.query(`delete from mfa_totp_replay where expires_at < now()`);
    const claims: Array<{ userId: string; digest: string }> = [];
    let replayed = false;
    for (const userId of candidates) {
      const digest = createHash("sha256").update(`${userId}:${code}`).digest("hex");
      // A code is accepted one period either side of now (90 s); keep the claim a little longer.
      const claimed = await pool.query(
        `insert into mfa_totp_replay (user_id, code_digest, expires_at) values ($1, $2, now() + interval '120 seconds')
         on conflict do nothing returning user_id`,
        [userId, digest],
      );
      if (claimed.rowCount === 0) replayed = true; else claims.push({ userId, digest });
    }
    if (replayed) {
      for (const claim of claims) await pool.query(`delete from mfa_totp_replay where user_id = $1 and code_digest = $2`, [claim.userId, claim.digest]);
      throw new APIError("UNAUTHORIZED", { code: "INVALID_CODE", message: "Invalid code" });
    }
    (ctx.context as { docslurpTotpClaims?: Array<{ userId: string; digest: string }> }).docslurpTotpClaims = claims;
  });

  /** A rejected code is released, so a typo or a lockout doesn't burn the user's next valid code. */
  const releaseTotpClaim = createAuthMiddleware(async (ctx) => {
    const claims = (ctx.context as { docslurpTotpClaims?: Array<{ userId: string; digest: string }> }).docslurpTotpClaims;
    if (!claims?.length || !isAPIError(ctx.context.returned)) return;
    for (const claim of claims) await pool.query(`delete from mfa_totp_replay where user_id = $1 and code_digest = $2`, [claim.userId, claim.digest]);
  });

  /**
   * Turning 2FA off, changing the password or revoking sessions also forgets
   * every trusted device of the user, not just this browser's.
   */
  const forgetTrustedDevices = createAuthMiddleware(async (ctx) => {
    let userId = ctx.context.session?.user?.id ?? null;
    if (!userId && ctx.path === "/email-otp/reset-password" && typeof ctx.body?.email === "string") {
      userId = (await pool.query<{ id: string }>(`select id from "user" where lower(email) = lower($1)`, [ctx.body.email])).rows[0]?.id ?? null;
    }
    if (!userId || isAPIError(ctx.context.returned)) return;
    await pool.query(`delete from verification where identifier like 'trust-device-%' and value = $1`, [userId]);
  });

  /**
   * Challenges every first-factor sign-in of a 2FA user, whichever endpoint
   * issued it. Exempt: sessions issued by the second factor itself or a
   * passkey, and re-issues of the caller's existing session.
   */
  const challengeFirstFactor = createAuthMiddleware(async (ctx) => {
    const issued = ctx.context.newSession;
    if (!issued) return;
    if (CHALLENGE_EXEMPT_PATHS.has(ctx.path)) return;
    const prior = ctx.context.session;
    if (prior?.user?.id === issued.user.id) return;
    const { rows } = await pool.query<{ two_factor_enabled: boolean }>(`select "twoFactorEnabled" as two_factor_enabled from "user" where id = $1`, [issued.user.id]);
    if (!rows[0]?.two_factor_enabled) return;

    if (await consumeTrustedDevice(ctx, issued.user.id, config.trustDeviceMaxAgeSeconds, pool)) {
      await pool.query(`update session set "mfaVerified" = true where token = $1`, [issued.session.token]);
      return;
    }

    // Drop the first-factor session: no authenticated session until the second factor.
    deleteSessionCookie(ctx, true);
    await ctx.context.internalAdapter.deleteSession(issued.session.token);
    ctx.context.setNewSession(null);
    await beginChallenge(ctx, issued.user.id, config.challengeMaxAgeSeconds);
    const returned = ctx.context.returned;
    if (isRedirect(returned) || ctx.request?.method === "GET") {
      throw ctx.redirect(challengeRedirectUrl(ctx, config, returned));
    }
    return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
  });

  return {
    id: "docslurp-mfa",
    hooks: {
      before: [
        { matcher: () => true, handler: stripUnverifiedSessions },
        { matcher: (ctx) => FACTOR_MANAGEMENT_PATHS.has(ctx.path ?? ""), handler: guardFactorManagement },
        { matcher: (ctx) => ctx.path === "/two-factor/verify-totp", handler: claimTotpCode },
      ],
      after: [
        { matcher: (ctx) => ctx.path === "/two-factor/verify-totp", handler: releaseTotpClaim },
        { matcher: (ctx) => TRUST_REVOKING_PATHS.has(ctx.path ?? ""), handler: forgetTrustedDevices },
        { matcher: () => true, handler: challengeFirstFactor },
      ],
    },
  } as BetterAuthPlugin;
}

/** All MFA plugins, in hook order. */
export function createMfaPlugins(options: MfaPluginOptions): BetterAuthPlugin[] {
  return [docslurpTwoFactorPlugin(options.config), docslurpPasskeyPlugin(options), docslurpMfaGatePlugin(options)];
}

/** Session fields the plugins don't declare; written by `sessionAssuranceFor`. */
export const sessionAssuranceFields = {
  mfaVerified: { type: "boolean", required: false, defaultValue: false, input: false },
  authenticatedAt: { type: "date", required: false, input: false },
} as const;

// ---------------------------------------------------------------------------
// Sign-in paths outside Better Auth's router (company SSO)

interface ChallengeAuthContext {
  secret: string;
  createAuthCookie: (name: string, overrides?: { maxAge?: number }) => { name: string; attributes: { domain?: string; httpOnly?: boolean; path?: string; secure?: boolean; sameSite?: string; partitioned?: boolean; maxAge?: number } };
  internalAdapter: { createVerificationValue: (data: { value: string; identifier: string; expiresAt: Date }) => Promise<unknown> };
}

/**
 * For sign-ins that DocSlurp finishes itself (the SSO callback): instead of a
 * session, start the plugin's second-factor challenge and return its
 * `Set-Cookie`. Better Auth signs cookies as `value.base64(hmac-sha256)`.
 */
export async function beginTwoFactorChallengeCookie(authContext: ChallengeAuthContext, userId: string, maxAge = 600, ssoOrgId?: string): Promise<string> {
  const identifier = `2fa-${generateRandomString(20)}`;
  const expiresAt = new Date(Date.now() + maxAge * 1000);
  await authContext.internalAdapter.createVerificationValue({ value: userId, identifier, expiresAt });
  await authContext.internalAdapter.createVerificationValue({ value: "0", identifier: `2fa-attempts-${identifier}`, expiresAt });
  // Only the server's validated IdP callback supplies this org. Never read it
  // from the MFA request. Keep it separate from the stock plugin's user record.
  if (ssoOrgId) await authContext.internalAdapter.createVerificationValue({
    value: JSON.stringify({ userId, orgId: ssoOrgId }),
    identifier: `sso-mfa-${identifier}`, expiresAt,
  });
  const { name, attributes } = authContext.createAuthCookie(TWO_FACTOR_COOKIE, { maxAge });
  const signature = createHmac("sha256", authContext.secret).update(identifier).digest("base64");
  const sameSite = (attributes.sameSite ?? "lax").toLowerCase();
  return serialize(name, `${identifier}.${signature}`, {
    domain: attributes.domain,
    httpOnly: attributes.httpOnly ?? true,
    path: attributes.path ?? "/",
    secure: attributes.secure,
    partitioned: attributes.partitioned,
    sameSite: sameSite === "strict" ? "Strict" : sameSite === "none" ? "None" : "Lax",
    maxAge,
  } as CookieOptions);
}

