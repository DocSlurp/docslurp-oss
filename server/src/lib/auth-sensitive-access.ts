import type { Pool } from "pg";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, isAPIError, sessionMiddleware } from "better-auth/api";
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { sensitiveAccessWindowSeconds } from "@docslurp/shared/auth-security";
import { getSensitiveEmailEligibility } from "./auth-sensitive-email.js";
import { sensitiveSsoOptions } from "./auth-sensitive-sso.js";
import { evaluateMfaPolicy, ssoEnforcedForEmail, type MfaConfig } from "./auth-mfa.js";

type Database = Pick<Pool, "query">;
const WINDOW_SECONDS = sensitiveAccessWindowSeconds();
const CHALLENGE_SECONDS = 120;
const REAUTH_REQUIRED = "REAUTH_REQUIRED";
// Match the existing verified-domain SSO enforcement rule at the proof commit.
const SSO_ENFORCED_SQL = `exists (select 1 from organizations so
  join sso_domains sd on sd.org_id = so.id and sd.domain = so.sso_config->>'emailDomain' and sd.verified_at is not null
  where sd.domain = lower(split_part(u.email, '@', 2)) and so.sso_config->>'enabled' = 'true'
    and so.sso_config->>'enforceSso' = 'true')`;

const denied = () => new APIError("FORBIDDEN", { code: REAUTH_REQUIRED, message: "Verify your identity to continue this sensitive account action." });

/** Never derive this grant from session creation, rotation, refresh or remembered devices. */
export async function hasSensitiveAccess(pool: Database, userId: string, sessionId: string): Promise<boolean> {
  if (!userId || !sessionId) return false;
  const { rows } = await pool.query(`select 1 from session s join "user" u on u.id = s."userId"
    where s.id = $1 and s."userId" = $2 and s."expiresAt" > now() and u.deleted_at is null
      and (s."sensitiveMfaVerified" = true or (u."twoFactorEnabled" = false and not exists (
        select 1 from org_memberships m join organizations o on o.id = m.org_id
        where m.user_id = u.id and o.require_mfa = true and o.deleted_at is null)))
      and (s."sensitiveSsoVerified" = true or not ${SSO_ENFORCED_SQL})
      and s."sensitiveVerifiedAt" <= now()
      and s."sensitiveVerifiedAt" > now() - make_interval(secs => $3)`, [sessionId, userId, WINDOW_SECONDS]);
  return rows.length === 1;
}

/** Call only after a fresh, validated proof. The session must still exist at commit time. */
export async function grantSensitiveAccess(pool: Database, userId: string, sessionId: string, options: { userVerifiedPasskey?: boolean; expectedVerifiedEmail?: string; ssoVerified?: boolean } = {}): Promise<boolean> {
  const { rows } = await pool.query(`update session s set "sensitiveVerifiedAt" = now(), "sensitiveMfaVerified" = $3, "sensitiveSsoVerified" = $5, "sensitiveFirstFactorSsoVerified" = false, "sensitiveFirstFactorAt" = null, "mfaVerified" = s."mfaVerified" or $3
    from "user" u where s.id = $1 and s."userId" = $2 and u.id = s."userId" and u.deleted_at is null
      and s."expiresAt" > now()
      and ($3::boolean or (u."twoFactorEnabled" = false and not exists (
        select 1 from org_memberships m join organizations o on o.id = m.org_id
        where m.user_id = u.id and o.require_mfa = true and o.deleted_at is null)))
      and ($5::boolean or not ${SSO_ENFORCED_SQL})
      and ($4::text is null or (u.email = $4 and u."emailVerified" = true)) returning s.id`, [sessionId, userId, options.userVerifiedPasskey === true, options.expectedVerifiedEmail ?? null, options.ssoVerified === true]);
  return rows.length === 1;
}

/** A password or freshness-verified SSO first factor still needs a newly entered TOTP. */
export async function recordSensitiveFirstFactorProof(pool: Database, userId: string, sessionId: string, options: { expectedVerifiedEmail?: string; ssoVerified?: boolean } = {}): Promise<boolean> {
  const { rows } = await pool.query(`update session s set "sensitiveFirstFactorAt" = now(), "sensitiveFirstFactorSsoVerified" = $4
    from "user" u where s.id = $1 and s."userId" = $2 and u.id = s."userId" and u.deleted_at is null
      and s."expiresAt" > now() and ($4::boolean or not ${SSO_ENFORCED_SQL})
      and ($3::text is null or (u.email = $3 and u."emailVerified" = true)) returning s.id`, [sessionId, userId, options.expectedVerifiedEmail ?? null, options.ssoVerified === true]);
  return rows.length === 1;
}

export async function completeSensitiveSecondFactor(pool: Database, userId: string, sessionId: string): Promise<boolean> {
  const { rows } = await pool.query(`update session s set "sensitiveVerifiedAt" = now(), "sensitiveMfaVerified" = true, "sensitiveSsoVerified" = s."sensitiveFirstFactorSsoVerified", "sensitiveFirstFactorSsoVerified" = false, "sensitiveFirstFactorAt" = null
    from "user" u where s.id = $1 and s."userId" = $2 and u.id = s."userId" and u.deleted_at is null
      and s."expiresAt" > now() and (s."sensitiveFirstFactorSsoVerified" = true or not ${SSO_ENFORCED_SQL})
      and s."sensitiveFirstFactorAt" <= now()
      and s."sensitiveFirstFactorAt" > now() - interval '300 seconds' returning s.id`, [sessionId, userId]);
  return rows.length === 1;
}

/** Fresh first factor permits only first-factor enrollment, never a general grant. */
export async function canBootstrapSensitiveEnrollment(pool: Database, userId: string, sessionId: string): Promise<boolean> {
  const { rows } = await pool.query(`select 1 from session s join "user" u on u.id = s."userId"
    where s.id = $1 and s."userId" = $2 and s."expiresAt" > now() and u.deleted_at is null
      and u."twoFactorEnabled" = false
      and (s."sensitiveFirstFactorSsoVerified" = true or not ${SSO_ENFORCED_SQL})
      and s."sensitiveFirstFactorAt" <= now() and s."sensitiveFirstFactorAt" > now() - interval '300 seconds'
      and not exists(select 1 from passkey p where p."userId" = u.id)
      and not exists(select 1 from "twoFactor" t where t."userId" = u.id and t.verified = true)`, [sessionId, userId]);
  return rows.length === 1;
}

export interface SensitiveAccessStatus {
  verifiedUntil: string | null;
  windowSeconds: number;
  methods: Array<"password" | "passkey" | "sso" | "email-otp">;
  requiresMfa: boolean;
  pendingMfa: boolean;
  enrollmentOnly: boolean;
  ssoUnavailable: boolean;
}

export async function getSensitiveAccessStatus(pool: Database, userId: string, sessionId: string): Promise<SensitiveAccessStatus> {
  const { rows } = await pool.query<{
    email: string; two_factor_enabled: boolean; password: boolean; passkey: boolean; totp: boolean;
    verified_until: Date | string | null; pending_mfa: boolean;
  }>(`select u.email, u."twoFactorEnabled" as two_factor_enabled,
    exists(select 1 from account a where a."userId" = u.id and a."providerId" = 'credential' and a.password is not null) as password,
    exists(select 1 from passkey p where p."userId" = u.id) as passkey,
    exists(select 1 from "twoFactor" t where t."userId" = u.id and t.verified = true) as totp,
    case when (s."sensitiveSsoVerified" = true or not ${SSO_ENFORCED_SQL}) and (s."sensitiveMfaVerified" = true or (u."twoFactorEnabled" = false and not exists (
        select 1 from org_memberships m join organizations o on o.id = m.org_id
        where m.user_id = u.id and o.require_mfa = true and o.deleted_at is null))) and s."sensitiveVerifiedAt" <= now() and s."sensitiveVerifiedAt" > now() - make_interval(secs => $3)
      then s."sensitiveVerifiedAt" + make_interval(secs => $3) else null end as verified_until,
    ((s."sensitiveFirstFactorSsoVerified" = true or not ${SSO_ENFORCED_SQL}) and s."sensitiveFirstFactorAt" <= now() and s."sensitiveFirstFactorAt" > now() - interval '300 seconds') as pending_mfa
    from session s join "user" u on u.id = s."userId"
    where s.id = $1 and s."userId" = $2 and s."expiresAt" > now() and u.deleted_at is null`, [sessionId, userId, WINDOW_SECONDS]);
  const row = rows[0];
  if (!row) throw denied();
  const requiresMfa = row.two_factor_enabled || (await evaluateMfaPolicy(pool, userId, true)).required;
  const enrollmentOnly = requiresMfa && !row.two_factor_enabled && !row.passkey && !row.totp;
  const enforcedSso = await ssoEnforcedForEmail(pool, row.email);
  const methods: SensitiveAccessStatus["methods"] = [];
  if (!enforcedSso && row.password && (!requiresMfa || enrollmentOnly || (row.two_factor_enabled && row.totp))) methods.push("password");
  if (!enforcedSso && row.passkey) methods.push("passkey");
  const ssoAvailable = (!requiresMfa || enrollmentOnly || (row.two_factor_enabled && row.totp)) && (await sensitiveSsoOptions(pool, userId, row.email)).length > 0;
  if (ssoAvailable) methods.push("sso");
  if (await getSensitiveEmailEligibility(pool, userId, sessionId)) methods.push("email-otp");
  return { verifiedUntil: row.verified_until ? new Date(row.verified_until).toISOString() : null,
    windowSeconds: WINDOW_SECONDS, methods, requiresMfa,
    pendingMfa: row.pending_mfa === true, enrollmentOnly, ssoUnavailable: enforcedSso && !ssoAvailable };
}

const ENROLLMENT_AUTH_PATHS = new Set(["/two-factor/enable", "/two-factor/get-totp-uri", "/passkey/generate-register-options", "/passkey/verify-registration"]);

const SENSITIVE_AUTH_PATHS = new Set([
  "/change-email", "/change-password", "/set-password", "/delete-user", "/link-social", "/unlink-account",
  "/two-factor/enable", "/two-factor/disable", "/two-factor/get-totp-uri", "/two-factor/generate-backup-codes",
  "/passkey/generate-register-options", "/passkey/verify-registration", "/passkey/update-passkey", "/passkey/delete-passkey",
  "/revoke-session", "/revoke-sessions", "/revoke-other-sessions",
]);

export function sensitiveAccessPlugin({ pool, config }: { pool: Database; config: MfaConfig }): BetterAuthPlugin {
  return {
    id: "docslurp-sensitive-access",
    endpoints: {
      sensitiveAccessStatus: createAuthEndpoint("/sensitive-access", { method: "GET", use: [sessionMiddleware], metadata: { noStore: true } }, async ctx => {
        const { user, session } = ctx.context.session!;
        return ctx.json(await getSensitiveAccessStatus(pool, user.id, session.id));
      }),
      sensitiveAccessPassword: createAuthEndpoint("/sensitive-access/password", {
        method: "POST", use: [sessionMiddleware], metadata: { noStore: true },
        body: z.object({ password: z.string().min(1).max(1024) }).strict(),
      }, async ctx => {
        const { user, session } = ctx.context.session!;
        const status = await getSensitiveAccessStatus(pool, user.id, session.id);
        if (!status.methods.includes("password")) throw denied();
        const accounts = await ctx.context.internalAdapter.findAccounts(user.id);
        const credential = accounts.find(account => account.providerId === "credential" && account.password);
        if (!credential?.password || !await ctx.context.password.verify({ hash: credential.password, password: ctx.body.password })) {
          throw new APIError("UNAUTHORIZED", { code: "INVALID_PASSWORD", message: "The password is incorrect." });
        }
        // Password hashing yields: policy may have changed while it ran. Re-read,
        // and the no-MFA grant also checks current policy in its atomic SQL write.
        const current = await getSensitiveAccessStatus(pool, user.id, session.id);
        if (!current.methods.includes("password")) throw denied();
        const granted = current.requiresMfa
          ? await recordSensitiveFirstFactorProof(pool, user.id, session.id)
          : await grantSensitiveAccess(pool, user.id, session.id);
        if (!granted) throw denied();
        return ctx.json({ ...await getSensitiveAccessStatus(pool, user.id, session.id), requiresTotp: current.requiresMfa && !current.enrollmentOnly });
      }),
      sensitiveAccessPasskeyOptions: createAuthEndpoint("/sensitive-access/passkey/options", {
        method: "GET", use: [sessionMiddleware], metadata: { noStore: true },
      }, async ctx => {
        const { user, session } = ctx.context.session!;
        if (!(await getSensitiveAccessStatus(pool, user.id, session.id)).methods.includes("passkey")) throw denied();
        const { rows } = await pool.query<{ credentialID: string }>(`select "credentialID" from passkey where "userId" = $1`, [user.id]);
        if (!rows.length) throw denied();
        const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: "required",
          timeout: CHALLENGE_SECONDS * 1000, allowCredentials: rows.map(row => ({ id: row.credentialID })) });
        await ctx.context.internalAdapter.createVerificationValue({ identifier: `sensitive-passkey-${options.challenge}`,
          value: JSON.stringify({ userId: user.id, sessionId: session.id }), expiresAt: new Date(Date.now() + CHALLENGE_SECONDS * 1000) });
        return ctx.json(options);
      }),
      sensitiveAccessPasskeyVerify: createAuthEndpoint("/sensitive-access/passkey/verify", {
        method: "POST", use: [sessionMiddleware], metadata: { noStore: true },
        body: z.object({ response: z.object({ id: z.string().min(1).max(2048), rawId: z.string().max(2048), type: z.literal("public-key"),
          response: z.object({ clientDataJSON: z.string().max(8192), authenticatorData: z.string().max(8192), signature: z.string().max(8192), userHandle: z.string().max(2048).optional() }).passthrough(),
          clientExtensionResults: z.record(z.string(), z.unknown()), authenticatorAttachment: z.string().optional() }).passthrough() }).strict(),
      }, async ctx => {
        const { user, session } = ctx.context.session!;
        if (!(await getSensitiveAccessStatus(pool, user.id, session.id)).methods.includes("passkey")) throw denied();
        let challenge: unknown;
        try { challenge = JSON.parse(Buffer.from(ctx.body.response.response.clientDataJSON, "base64url").toString("utf8")).challenge; }
        catch { throw denied(); }
        if (typeof challenge !== "string" || !/^[\w-]{16,256}$/.test(challenge)) throw denied();
        const binding = await ctx.context.internalAdapter.consumeVerificationValue(`sensitive-passkey-${challenge}`);
        if (!binding) throw denied();
        let owner: { userId?: unknown; sessionId?: unknown };
        try { owner = JSON.parse(binding.value); } catch { throw denied(); }
        if (owner.userId !== user.id || owner.sessionId !== session.id || new Date(binding.expiresAt).getTime() <= Date.now()) throw denied();
        const { rows } = await pool.query<{ id: string; publicKey: string; counter: number; credentialID: string }>(
          `select id, "publicKey", counter, "credentialID" from passkey where "credentialID" = $1 and "userId" = $2`, [ctx.body.response.id, user.id]);
        const credential = rows[0];
        if (!credential) throw denied();
        let verification;
        try {
          verification = await verifyAuthenticationResponse({ response: ctx.body.response as AuthenticationResponseJSON,
            expectedChallenge: challenge, expectedOrigin: config.origins, expectedRPID: config.rpID, requireUserVerification: true,
            credential: { id: credential.credentialID, publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64")), counter: credential.counter } });
        } catch { throw denied(); }
        if (!verification.verified || !verification.authenticationInfo.userVerified) throw denied();
        // CAS prevents two challenges from overwriting each other's authenticator counter.
        const update = await pool.query(`update passkey set counter = $1, "lastUsedAt" = now()
          where id = $2 and "userId" = $3 and counter = $4 returning id`,
          [verification.authenticationInfo.newCounter, credential.id, user.id, credential.counter]);
        if (update.rows.length !== 1 || !await grantSensitiveAccess(pool, user.id, session.id, { userVerifiedPasskey: true })) throw denied();
        return ctx.json(await getSensitiveAccessStatus(pool, user.id, session.id));
      }),
    },
    hooks: {
      before: [
        { matcher: ctx => (ctx.path ?? "").startsWith("/sensitive-access/") && ctx.request?.method === "POST", handler: createAuthMiddleware(async ctx => {
          const origin = ctx.headers?.get("origin");
          if (!origin || !ctx.context.isTrustedOrigin(origin)) throw new APIError("FORBIDDEN", { code: "INVALID_ORIGIN", message: "This verification request must come from the app." });
        }) },
        { matcher: ctx => SENSITIVE_AUTH_PATHS.has(ctx.path ?? ""), handler: createAuthMiddleware(async ctx => {
        // Resolve authoritative session through the plugin's standard middleware, never bearer API keys.
        const resolved = await ctx.context.internalAdapter.findSession(await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret) || "");
        if (!resolved) throw new APIError("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "Please sign in again." });
        const verified = await hasSensitiveAccess(pool, resolved.user.id, resolved.session.id);
        const enrollment = !verified && ENROLLMENT_AUTH_PATHS.has(ctx.path ?? "")
          && await canBootstrapSensitiveEnrollment(pool, resolved.user.id, resolved.session.id);
        if (!verified && !enrollment) throw denied();
        // Pinned Better Auth dispatch clones its context per call, then deep-merges
        // returned context. Replace this request's nested config, never the shared
        // object: only a live explicit grant supersedes its createdAt-based check.
        return { context: { context: { sessionConfig: { ...ctx.context.sessionConfig, freshAge: 0 } } } };
      }) }],
      after: [{ matcher: ctx => ctx.path === "/two-factor/verify-totp", handler: createAuthMiddleware(async ctx => {
        if (isAPIError(ctx.context.returned)) return;
        const active = ctx.context.session;
        const returned = ctx.context.returned as { token?: unknown } | null;
        if (!active || returned?.token !== active.session.token) return;
        await completeSensitiveSecondFactor(pool, active.user.id, active.session.id);
      }) }],
    },
  } as BetterAuthPlugin;
}
