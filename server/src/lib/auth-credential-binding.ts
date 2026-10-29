import { createHash } from "node:crypto";

import { defineRequestState, hasRequestState } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import type { Pool } from "pg";

/**
 * Two bindings between a password and what it unlocks.
 *
 * **Email verification belongs to whoever chose the password.** A code
 * proves the mailbox, not who chose the account's password. Without this, an
 * attacker could sign up with someone's address, send them a sign-in link that
 * opens on "enter the code we emailed you", and keep the password the owner
 * verifies. So `/email-otp/verify-email` only works in a browser holding a
 * signed binding for that address, issued when sign-up succeeds or when a
 * correct-password sign-in is refused as unverified. Everyone else gets
 * `VERIFY_WITH_PASSWORD`, the same for every address, and can reset instead.
 *
 * **Sessions issued by a password end when that password changes.** A
 * password sign-in records a fingerprint of the stored hash before Better
 * Auth reads it; the session carries it, and the MFA gate drops any session
 * whose fingerprint no longer matches the account's password on its next use
 * (auth-mfa.ts). A sign-in still in flight when a reset commits therefore
 * yields a dead session. `/change-password` carries the sessions it keeps over
 * to the new password.
 */

export const VERIFY_WITH_PASSWORD_CODE = "VERIFY_WITH_PASSWORD";
const BINDING_COOKIE = "verify_binding";
const BINDING_SECONDS = 30 * 60;

/** SHA-256 of a stored password hash; the same function as the SQL check in auth-mfa.ts. */
export function credentialFingerprint(storedHash: string): string {
  return createHash("sha256").update(storedHash, "utf8").digest("hex");
}

const passwordSignIn = defineRequestState<{ fingerprint: string | null }>(() => ({ fingerprint: null }));
const passwordChange = defineRequestState<{ userId: string | null; fingerprint: string | null }>(() => ({ userId: null, fingerprint: null }));

/** For `session.create.before`: the password this request's sign-in proved, if any. */
export async function newSessionCredentialFingerprint(): Promise<string | null> {
  return await hasRequestState() ? (await passwordSignIn.get()).fingerprint : null;
}

const normalizeEmail = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";

export function credentialBindingPlugin(options: { pool: Pick<Pool, "query"> }): BetterAuthPlugin {
  const { pool } = options;
  const storedHash = async (where: string, value: string) =>
    (await pool.query<{ password: string | null }>(
      `select a.password from account a join "user" u on u.id = a."userId"
        where ${where} and a."providerId" = 'credential' and a.password is not null limit 1`, [value])).rows[0]?.password ?? null;

  return {
    id: "docslurp-credential-binding",
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/sign-in/email",
        handler: createAuthMiddleware(async (ctx) => {
          const email = normalizeEmail(ctx.body?.email);
          const hash = email ? await storedHash(`lower(u.email) = $1`, email) : null;
          (await passwordSignIn.get()).fingerprint = hash ? credentialFingerprint(hash) : null;
        }),
      }, {
        matcher: (ctx) => ctx.path === "/change-password",
        handler: createAuthMiddleware(async (ctx) => {
          const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
          if (!token) return;
          const { rows } = await pool.query<{ user_id: string; password: string | null }>(
            `select s."userId" as user_id, a.password from session s
               left join account a on a."userId" = s."userId" and a."providerId" = 'credential'
              where s.token = $1`, [token]);
          if (rows[0]?.password) Object.assign(await passwordChange.get(), { userId: rows[0].user_id, fingerprint: credentialFingerprint(rows[0].password) });
        }),
      }, {
        matcher: (ctx) => ctx.path === "/email-otp/verify-email",
        handler: createAuthMiddleware(async (ctx) => {
          const email = normalizeEmail(ctx.body?.email);
          const binding = await ctx.getSignedCookie(ctx.context.createAuthCookie(BINDING_COOKIE).name, ctx.context.secret);
          const [boundEmail, expires] = typeof binding === "string" ? [binding.slice(0, binding.lastIndexOf(":")), Number(binding.slice(binding.lastIndexOf(":") + 1))] : ["", 0];
          if (!email || boundEmail !== email || !(expires > Date.now())) {
            throw new APIError("FORBIDDEN", {
              code: VERIFY_WITH_PASSWORD_CODE,
              message: "Sign in with this account's password to verify the address, or reset the password.",
            });
          }
        }),
      }],
      after: [{
        // Sign-up succeeded, or the password was right but the address is unverified.
        matcher: (ctx) => ctx.path === "/sign-up/email" || ctx.path === "/sign-in/email",
        handler: createAuthMiddleware(async (ctx) => {
          const returned = ctx.context.returned;
          const proved = ctx.path === "/sign-up/email"
            ? !isAPIError(returned)
            : isAPIError(returned) && (returned.body as { code?: unknown } | undefined)?.code === "EMAIL_NOT_VERIFIED";
          const email = normalizeEmail(ctx.body?.email);
          if (!proved || !email) return;
          const cookie = ctx.context.createAuthCookie(BINDING_COOKIE, { maxAge: BINDING_SECONDS });
          await ctx.setSignedCookie(cookie.name, `${email}:${Date.now() + BINDING_SECONDS * 1000}`, ctx.context.secret, cookie.attributes);
        }),
      }, {
        matcher: (ctx) => ctx.path === "/change-password",
        handler: createAuthMiddleware(async (ctx) => {
          const { userId, fingerprint } = await passwordChange.get();
          if (!userId || !fingerprint || isAPIError(ctx.context.returned)) return;
          const hash = await storedHash(`u.id = $1`, userId);
          if (!hash) return;
          // Sessions this change keeps (all, or none when others were signed out) move to the new password.
          await pool.query(`update session set "credentialFingerprint" = $3 where "userId" = $1 and "credentialFingerprint" = $2`,
            [userId, fingerprint, credentialFingerprint(hash)]);
        }),
      }],
    },
  } as BetterAuthPlugin;
}
