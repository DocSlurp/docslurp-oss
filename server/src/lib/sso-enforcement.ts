import { AsyncLocalStorage } from "node:async_hooks";

import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";

import { hasValidSsoUnlinkedPass, SSO_UNLINKED_PASS_TTL_SECONDS, ssoUnlinkedPassFromCookieHeader } from "./sso-unlinked-pass.js";

/**
 * Server-side "enforce company SSO".
 *
 * When an organization enforces SSO for a DNS-verified email domain, every
 * address at that domain must sign in through the organization's IdP. The
 * sign-in page only *redirects* (see `GET /api/sso-lookup`); this module is
 * what refuses everything else, inside Better Auth:
 *
 * 1. Every session Better Auth creates, by any endpoint or plugin (password,
 *    email code, verification-link auto sign-in, Google/GitHub callbacks,
 *    magic links, passkeys, second factors) passes `session.create.before`.
 *    For an enforced address it is refused unless it is one of:
 *    - issued by the company SSO callback (`issueSsoSession`);
 *    - a re-issue of the caller's own SSO session (password change, 2FA
 *      enrolment and similar rotate the session);
 *    - a short "link" session for a browser holding an unlinked pass for that
 *      email (the IdP just authenticated it; see sso-unlinked-pass.ts), so the
 *      user can sign in once and link SSO.
 *    Allowed sessions carry their provenance in the token prefix (below).
 * 2. First-factor endpoints that name an email (sign-in, sign-up, email-OTP
 *    send/verify, password reset, magic link, email change) are refused up
 *    front with `SSO_REQUIRED`, before a code is sent or a password checked.
 *    The answer depends only on the domain, like `/api/sso-lookup`.
 * 3. Before every Better Auth endpoint, including `auth.api.getSession` (which
 *    all API session auth uses), a session for an enforced address that lacks
 *    the SSO prefix is deleted: sessions from before enforcement was turned
 *    on, or from before this check existed, stop working on their next use.
 *    Link sessions are deleted at the original IdP proof deadline, even if
 *    Better Auth refreshes the database expiry.
 *
 * Database errors propagate, so every check fails closed.
 */

export const SSO_REQUIRED_CODE = "SSO_REQUIRED";
export const SSO_REQUIRED_MESSAGE = "Your organization requires company sign-in (SSO).";

/**
 * Session provenance, carried in the session token with the issuing org ID. Better Auth generates
 * tokens from [a-zA-Z0-9] only, so a token containing "_" was rewritten by
 * the session-create hook below and nothing else can mint one. The prefix is
 * stored in the session row and the signed cookie; it is not a secret.
 */
export const SSO_SESSION_TOKEN_PREFIX = "sso_";
export const SSO_LINK_SESSION_TOKEN_PREFIX = "ssolink_";
/** Maximum link-session age; the original proof deadline is enforced too. */
export const SSO_LINK_SESSION_MAX_AGE_SECONDS = SSO_UNLINKED_PASS_TTL_SECONDS;

type Queryable = Pick<Pool, "query">;

export interface SsoOrgForDomain {
  id: string;
  slug: string | null;
  sso_config: {
    providerType?: "saml" | "oidc" | null;
    metadataUrl?: string | null;
    clientId?: string | null;
    enforceSso?: boolean;
  } | null;
}

/** Lower-cased domain part of an email, or null. */
export function emailDomainOf(email: string | null | undefined): string | null {
  const domain = (email ?? "").split("@")[1]?.trim().toLowerCase();
  return domain || null;
}

/**
 * The org whose enabled SSO covers this email's DNS-verified domain (a
 * verified domain belongs to one org), optionally only if it enforces SSO.
 * Throws on database errors; callers that only want a UX hint catch.
 */
export async function findSsoOrgForEmail(pool: Queryable, email: string, requireEnforced: boolean): Promise<SsoOrgForDomain | null> {
  const domain = emailDomainOf(email);
  if (!domain) return null;
  const { rows } = await pool.query<SsoOrgForDomain>(
    `
      select o.id, o.slug, o.sso_config
      from organizations o
      join sso_domains d
        on d.org_id = o.id
        and d.domain = o.sso_config->>'emailDomain'
        and d.verified_at is not null
      where
        d.domain = $1
        and (o.sso_config->>'enabled')::boolean = true
        and ($2::boolean = false or (o.sso_config->>'enforceSso')::boolean = true)
      limit 1
    `,
    [domain, requireEnforced]
  );
  return rows[0] ?? null;
}

/**
 * True when the email's domain is enforced by an org's SSO. Independent of
 * whether the provider config is complete: a broken IdP config locks the
 * domain out rather than reopening passwords.
 */
export async function ssoEnforcedForEmail(pool: Queryable, email: string): Promise<boolean> {
  return (await findSsoOrgForEmail(pool, email, true)) !== null;
}

/** Base URL the browser is sent to for SSO initiation. */
export function ssoBaseUrl(request: Request): string {
  return process.env.INTERNAL_API_URL || new URL(request.url).origin;
}

/** Where the browser starts this org's SSO sign-in, or null if the provider config is incomplete. */
export function ssoStartUrl(org: SsoOrgForDomain, apiUrl: string): string | null {
  const config = org.sso_config;
  if (config?.providerType === "saml") return `${apiUrl}/v1/auth/saml/${encodeURIComponent(org.slug ?? org.id)}/init`;
  if (config?.providerType === "oidc" && config.metadataUrl && config.clientId) return `${apiUrl}/v1/auth/oidc/${encodeURIComponent(org.id)}/init`;
  return null;
}

const ssoIssuance = new AsyncLocalStorage<string>();

/**
 * Creates a session from the company SSO callback, the only first factor an
 * enforced address may use. `createSession` is Better Auth's internal adapter.
 */
export function issueSsoSession<T>(createSession: (userId: string) => Promise<T>, userId: string, orgId: string): Promise<T> {
  return ssoIssuance.run(orgId, () => createSession(userId));
}

/** The minimal slice of Better Auth's endpoint context the checks read. */
interface EndpointLike {
  path?: string;
  headers?: Headers;
  request?: Request;
  body?: unknown;
  getSignedCookie?: (name: string, secret: string) => Promise<string | null | false>;
  context?: {
    baseURL?: string;
    createAuthCookie?: (name: string) => { name: string };
    internalAdapter?: { findUserById: (id: string) => Promise<{ email: string } | null> };
    session?: { session?: { token?: string } | null; user?: { id?: string } | null } | null;
  } | null;
}

function requestHeaders(ctx: EndpointLike | null | undefined): Headers | null {
  return ctx?.headers ?? ctx?.request?.headers ?? null;
}

function hasUnlinkedPass(ctx: EndpointLike | null | undefined, secret: string, email: string): boolean {
  const pass = ssoUnlinkedPassFromCookieHeader(requestHeaders(ctx)?.get("cookie"));
  return Boolean(pass) && hasValidSsoUnlinkedPass(secret, pass, email);
}

function startUrlFor(org: SsoOrgForDomain, ctx: EndpointLike | null | undefined): string | null {
  let base = process.env.INTERNAL_API_URL || null;
  if (!base) {
    try {
      base = new URL(ctx?.request?.url ?? ctx?.context?.baseURL ?? "").origin;
    } catch {
      base = null;
    }
  }
  return base ? ssoStartUrl(org, base) : null;
}

function ssoRequired(org: SsoOrgForDomain, ctx: EndpointLike | null | undefined): APIError {
  const ssoUrl = startUrlFor(org, ctx);
  return new APIError("FORBIDDEN", { code: SSO_REQUIRED_CODE, message: SSO_REQUIRED_MESSAGE, ...(ssoUrl ? { ssoUrl } : {}) });
}

function orgTokenPrefix(orgId: string): string {
  return `${SSO_SESSION_TOKEN_PREFIX}${Buffer.from(orgId).toString("hex")}_`;
}
function isTaggedToken(token: string | undefined | null, orgId: string): boolean {
  return typeof token === "string" && token.startsWith(orgTokenPrefix(orgId));
}

/**
 * `session.create.before`: decides whether a new session may exist and tags
 * its provenance. Returns the token rewrite, or throws `SSO_REQUIRED`.
 */
export async function ssoSessionCreatePolicy(
  pool: Queryable,
  secret: string,
  session: { userId: string; token: string },
  ctx: EndpointLike | null | undefined,
  findUser?: (id: string) => Promise<{ email: string } | null>,
): Promise<{ data: { token: string; expiresAt?: Date } } | undefined> {
  // Read through Better Auth's transaction-aware adapter: signup may not yet
  // have committed the user row to the shared pool.
  const userLookup = ctx?.context?.internalAdapter?.findUserById ?? findUser;
  const user = userLookup
    ? await userLookup(session.userId)
    : (await pool.query<{ email: string }>(`select email from "user" where id = $1`, [session.userId])).rows[0];
  const email = user?.email;
  if (!email) throw new APIError("UNAUTHORIZED", { message: "Unknown user" });
  const org = await findSsoOrgForEmail(pool, email, true);
  const issuingOrg = ssoIssuance.getStore();
  if (issuingOrg) {
    if (org && org.id !== issuingOrg) throw ssoRequired(org, ctx);
    return { data: { token: `${orgTokenPrefix(issuingOrg)}${session.token}` } };
  }
  // The stock second-factor endpoint creates the session only after checking
  // TOTP/backup code. Consume server-issued provenance here, atomically: two
  // simultaneous completions can never mint two SSO sessions from one proof.
  if (ctx?.path === "/two-factor/verify-totp" || ctx?.path === "/two-factor/verify-backup-code") {
    const cookie = ctx.context?.createAuthCookie?.("two_factor");
    const challenge = cookie ? await ctx.getSignedCookie?.(cookie.name, secret) : null;
    if (challenge) {
      const { rows } = await pool.query<{ value: string }>(
        `delete from verification where identifier = $1 and "expiresAt" > now()
         and value::jsonb->>'userId' = $2
         and ($3::text is null or value::jsonb->>'orgId' = $3)
         returning value`,
        [`sso-mfa-${challenge}`, session.userId, org?.id ?? null],
      );
      if (rows.length === 1) {
        const proof = JSON.parse(rows[0]!.value) as { orgId: string };
        return { data: { token: `${orgTokenPrefix(proof.orgId)}${session.token}` } };
      }
    }
  }
  if (!org) return undefined;

  // A rotation of the caller's own SSO session (the before-hook below has
  // already deleted the caller's session if it was not one).
  const prior = ctx?.context?.session;
  if (prior?.user?.id === session.userId && isTaggedToken(prior.session?.token, org.id)) {
    return { data: { token: `${orgTokenPrefix(org.id)}${session.token}` } };
  }
  if (hasUnlinkedPass(ctx, secret, email)) {
    const pass = ssoUnlinkedPassFromCookieHeader(requestHeaders(ctx)?.get("cookie"))!;
    return { data: { token: `${SSO_LINK_SESSION_TOKEN_PREFIX}${pass.split(".")[0]}_${session.token}`, expiresAt: new Date(Number(pass.split(".")[0]) * 1000) } };
  }
  console.warn(`[sso-enforcement] refused a non-SSO session org=${org.id} user=${session.userId} path=${ctx?.path ?? "(internal)"}`);
  throw ssoRequired(org, ctx);
}

/** Better Auth paths that take an email address before or as a first factor. */
const EMAIL_FIRST_FACTOR_PREFIXES = ["/sign-in/", "/sign-up/", "/email-otp/", "/magic-link/", "/forget-password"];
const EMAIL_FIRST_FACTOR_PATHS = new Set(["/request-password-reset", "/reset-password", "/send-verification-email", "/change-email"]);

export function isEmailFirstFactorPath(path: string | undefined): boolean {
  if (!path) return false;
  return EMAIL_FIRST_FACTOR_PATHS.has(path) || EMAIL_FIRST_FACTOR_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function bodyEmails(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  return [record.email, record.newEmail].filter((value): value is string => typeof value === "string" && value.includes("@"));
}

type SessionRevocation = (token: string) => Promise<void>;

/** Deletes a non-SSO session of an enforced address; deletes a link session past its lifetime. */
export function createSsoSessionRevocation(pool: Queryable): SessionRevocation {
  return async (token) => {
    if (token.startsWith(SSO_LINK_SESSION_TOKEN_PREFIX)) {
      // Better Auth may refresh expiresAt on read. Keep the IdP proof's
      // absolute deadline in the token so a refresh cannot extend this grant.
      const deadline = token.slice(SSO_LINK_SESSION_TOKEN_PREFIX.length).split("_")[0];
      if (!/^\d+$/.test(deadline) || Number(deadline) * 1000 <= Date.now()) {
        await pool.query(`delete from session where token = $1`, [token]);
        return;
      }
      await pool.query(
        `delete from session where token = $1 and "createdAt" < now() - make_interval(secs => $2)`,
        [token, SSO_LINK_SESSION_MAX_AGE_SECONDS]
      );
      return;
    }
    const { rows } = await pool.query<{ user_id: string; org_id: string }>(
      `
        delete from session s
        using "user" u, sso_domains d, organizations o
        where s.token = $1
          and u.id = s."userId"
          and d.domain = lower(split_part(u.email, '@', 2))
          and d.verified_at is not null
          and o.id = d.org_id
          and d.domain = o.sso_config->>'emailDomain'
          and (o.sso_config->>'enabled')::boolean = true
          and (o.sso_config->>'enforceSso')::boolean = true
          and not starts_with(s.token, 'sso_' || encode(convert_to(o.id, 'UTF8'), 'hex') || '_')
        returning s."userId" as user_id, o.id as org_id
      `,
      [token]
    );
    if (rows[0]) console.warn(`[sso-enforcement] revoked a non-SSO session org=${rows[0].org_id} user=${rows[0].user_id}`);
  };
}

/**
 * The Better Auth plugin: the session-create policy (a plugin database hook,
 * so it runs before the app's own session hooks provision anything), the
 * up-front refusal, and the per-request revocation.
 */
export function ssoEnforcementPlugin(options: { pool: Queryable }): BetterAuthPlugin {
  const { pool } = options;
  const revoke = createSsoSessionRevocation(pool);
  let secret = "";

  const revokeNonSsoSession = createAuthMiddleware(async (ctx) => {
    const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
    if (typeof token === "string" && token) await revoke(token);
  });

  const refuseNonSsoFirstFactor = createAuthMiddleware(async (ctx) => {
    for (const email of bodyEmails(ctx.body)) {
      const org = await findSsoOrgForEmail(pool, email, true);
      if (!org || hasUnlinkedPass(ctx as EndpointLike, ctx.context.secret, email)) continue;
      console.warn(`[sso-enforcement] refused a non-SSO first factor org=${org.id} path=${ctx.path}`);
      throw ssoRequired(org, ctx as EndpointLike);
    }
  });

  return {
    id: "docslurp-sso-enforcement",
    init(context) {
      secret = context.secret;
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                before: async (session, ctx) => ssoSessionCreatePolicy(pool, secret, session, ctx as EndpointLike | null, (id) => context.internalAdapter.findUserById(id)),
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [
        { matcher: () => true, handler: revokeNonSsoSession },
        { matcher: (ctx) => isEmailFirstFactorPath(ctx.path), handler: refuseNonSsoFirstFactor },
      ],
    },
  } satisfies BetterAuthPlugin;
}
