import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { generateRandomString } from "better-auth/crypto";
import { isEmailAuthConfigured } from "@docslurp/shared/auth-security";
import { z } from "zod";
import { sendAuthEmailCode } from "./auth-email.js";
import { evaluateMfaPolicy, ssoEnforcedForEmail } from "./auth-mfa.js";

type Database = Pick<Pool, "query">;
const denied = () => new APIError("FORBIDDEN", { code: "REAUTH_REQUIRED", message: "Verify your identity to continue this sensitive account action." });
const invalidCode = () => new APIError("BAD_REQUEST", { code: "INVALID_OTP", message: "That code is invalid or has expired. Request a new code." });
const CODE_SECONDS = 600;
const SEND_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;

/** Current verified email only; policy and session liveness come from the database. */
export async function getSensitiveEmailEligibility(pool: Database, userId: string, sessionId: string,
  deliveryEnabled = isEmailAuthConfigured(process.env)): Promise<{ email: string; requiresMfa: boolean; enrollmentOnly: boolean } | null> {
  if (!deliveryEnabled || !userId || !sessionId) return null;
  const { rows } = await pool.query<{ email: string; email_verified: boolean; two_factor_enabled: boolean; totp: boolean; passkey: boolean }>(
    `select u.email, u."emailVerified" as email_verified, u."twoFactorEnabled" as two_factor_enabled,
      exists(select 1 from "twoFactor" t where t."userId" = u.id and t.verified = true) as totp,
      exists(select 1 from passkey p where p."userId" = u.id) as passkey
      from session s join "user" u on u.id = s."userId"
      where s.id = $1 and s."userId" = $2 and s."expiresAt" > now() and u.deleted_at is null`, [sessionId, userId]);
  const row = rows[0];
  if (!row || !row.email_verified || await ssoEnforcedForEmail(pool, row.email)) return null;
  const requiresMfa = row.two_factor_enabled || (await evaluateMfaPolicy(pool, userId, true)).required;
  const enrollmentOnly = requiresMfa && !row.two_factor_enabled && !row.totp && !row.passkey;
  if (requiresMfa && !enrollmentOnly && !(row.two_factor_enabled && row.totp)) return null;
  return { email: row.email, requiresMfa, enrollmentOnly };
}

/** Separate purpose and same user/session/email binding: login OTPs never qualify. */
function digestCode(secret: string, userId: string, sessionId: string, email: string, code: string): string {
  return createHmac("sha256", secret).update(JSON.stringify(["sensitive-email-otp-v1", userId, sessionId, email, code])).digest("hex");
}

interface EmailPluginOptions {
  pool: Database;
  deliveryEnabled?: boolean;
  sendCode?: (args: { email: string; otp: string }) => Promise<void>;
  grant: (pool: Database, userId: string, sessionId: string, options?: { expectedVerifiedEmail?: string }) => Promise<boolean>;
  recordFirstFactor: (pool: Database, userId: string, sessionId: string, options?: { expectedVerifiedEmail?: string }) => Promise<boolean>;
  getStatus: (pool: Database, userId: string, sessionId: string) => Promise<object>;
}

/** No account creation, login, email-verification mutation, session rotation or cookies. */
export function sensitiveEmailPlugin({ pool, deliveryEnabled = isEmailAuthConfigured(process.env), sendCode = sendAuthEmailCode,
  grant, recordFirstFactor, getStatus }: EmailPluginOptions): BetterAuthPlugin {
  return {
    id: "docslurp-sensitive-email",
    rateLimit: [
      { pathMatcher: path => path === "/sensitive-access/email-otp/send", window: 60, max: 3 },
      { pathMatcher: path => path === "/sensitive-access/email-otp/verify", window: 60, max: 5 },
    ],
    endpoints: {
      sensitiveEmailSend: createAuthEndpoint("/sensitive-access/email-otp/send", {
        method: "POST", use: [sessionMiddleware], metadata: { noStore: true }, body: z.object({}).strict(),
      }, async ctx => {
        const { user, session } = ctx.context.session!;
        const eligible = await getSensitiveEmailEligibility(pool, user.id, session.id, deliveryEnabled);
        if (!eligible) throw denied();
        const code = generateRandomString(6, "0-9");
        const hash = digestCode(ctx.context.secret, user.id, session.id, eligible.email, code);
        const result = await pool.query(`update session s set "sensitiveEmailOTPHash" = $3,
          "sensitiveEmailOTPExpiresAt" = now() + interval '600 seconds', "sensitiveEmailOTPSentAt" = now(), "sensitiveEmailOTPAttempts" = 0
          from "user" u where s.id = $1 and s."userId" = $2 and u.id = s."userId" and u.deleted_at is null
            and s."expiresAt" > now() and u.email = $4 and u."emailVerified" = true
            and (s."sensitiveEmailOTPSentAt" is null or s."sensitiveEmailOTPSentAt" <= now() - interval '60 seconds') returning s.id`,
          [session.id, user.id, hash, eligible.email]);
        if (result.rows.length !== 1) {
          const cooldown = await pool.query<{ retry_after_seconds: number }>(`select greatest(1, ceil(extract(epoch from
              (s."sensitiveEmailOTPSentAt" + interval '60 seconds' - now()))))::integer as retry_after_seconds
            from session s join "user" u on u.id = s."userId"
            where s.id = $1 and s."userId" = $2 and s."expiresAt" > now() and u.deleted_at is null
              and u.email = $3 and u."emailVerified" = true and s."sensitiveEmailOTPSentAt" > now() - interval '60 seconds'`,
            [session.id, user.id, eligible.email]);
          const seconds = cooldown.rows[0]?.retry_after_seconds;
          if (!seconds) throw denied();
          throw new APIError("TOO_MANY_REQUESTS", { code: "TOO_MANY_REQUESTS", message: "Wait before requesting another code." }, { "Retry-After": String(seconds) });
        }
        try { await sendCode({ email: eligible.email, otp: code }); }
        catch {
          await pool.query(`update session set "sensitiveEmailOTPHash" = null, "sensitiveEmailOTPExpiresAt" = null
            where id = $1 and "userId" = $2 and "sensitiveEmailOTPHash" = $3`, [session.id, user.id, hash]);
          throw new APIError("SERVICE_UNAVAILABLE", { code: "EMAIL_DELIVERY_UNAVAILABLE", message: "The code could not be sent. Try again in a minute." });
        }
        return ctx.json({ sent: true, expiresIn: CODE_SECONDS, retryAfterSeconds: SEND_COOLDOWN_SECONDS });
      }),
      sensitiveEmailVerify: createAuthEndpoint("/sensitive-access/email-otp/verify", {
        method: "POST", use: [sessionMiddleware], metadata: { noStore: true },
        body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict(),
      }, async ctx => {
        const { user, session } = ctx.context.session!;
        const eligible = await getSensitiveEmailEligibility(pool, user.id, session.id, deliveryEnabled);
        if (!eligible) throw denied();
        // Every guess consumes an attempt atomically, including concurrent requests.
        const attempt = await pool.query(`update session s set "sensitiveEmailOTPAttempts" = s."sensitiveEmailOTPAttempts" + 1
          from "user" u where s.id = $1 and s."userId" = $2 and u.id = s."userId" and u.deleted_at is null
            and s."expiresAt" > now() and u.email = $3 and u."emailVerified" = true
            and s."sensitiveEmailOTPHash" is not null and s."sensitiveEmailOTPExpiresAt" > now()
            and s."sensitiveEmailOTPAttempts" < $4 returning s.id`, [session.id, user.id, eligible.email, MAX_ATTEMPTS]);
        if (attempt.rows.length !== 1) throw invalidCode();
        const hash = digestCode(ctx.context.secret, user.id, session.id, eligible.email, ctx.body.code);
        // A correct proof is claimed once before granting access; it cannot be
        // reused by a concurrent request or another session, user, email or purpose.
        const consumed = await pool.query(`update session s set "sensitiveEmailOTPHash" = null, "sensitiveEmailOTPExpiresAt" = null
          from "user" u where s.id = $1 and s."userId" = $2 and u.id = s."userId" and u.deleted_at is null
            and s."expiresAt" > now() and u.email = $4 and u."emailVerified" = true
            and s."sensitiveEmailOTPHash" = $3 and s."sensitiveEmailOTPExpiresAt" > now()
            and s."sensitiveEmailOTPAttempts" <= $5 returning s.id`, [session.id, user.id, hash, eligible.email, MAX_ATTEMPTS]);
        if (consumed.rows.length !== 1) throw invalidCode();
        const current = await getSensitiveEmailEligibility(pool, user.id, session.id, deliveryEnabled);
        if (!current || current.email !== eligible.email) throw denied();
        const granted = current.requiresMfa ? await recordFirstFactor(pool, user.id, session.id, { expectedVerifiedEmail: current.email })
          : await grant(pool, user.id, session.id, { expectedVerifiedEmail: current.email });
        if (!granted) throw denied();
        return ctx.json({ ...await getStatus(pool, user.id, session.id), requiresTotp: current.requiresMfa && !current.enrollmentOnly });
      }),
    },
  };
}
