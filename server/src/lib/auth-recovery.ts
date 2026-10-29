import { defineRequestState } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import type { Pool } from "pg";

/**
 * Password reset as proof of mailbox ownership.
 *
 * Better Auth's Email OTP sign-in and magic links promote an unverified
 * account with `revokeUnprovenAccountAccess`: every link and session the
 * account gathered before its email was proven is removed. Its Email OTP
 * password reset only sets `emailVerified`. A reset is the same proof, so the
 * same rule applies here: after a successful reset of an unverified account,
 * every account link except the password the owner just chose is deleted,
 * with its stored OAuth tokens. Sessions are already revoked by
 * `revokeSessionsOnPasswordReset`.
 */

export function passwordResetOwnershipPlugin(options: { pool: Pick<Pool, "query"> }): BetterAuthPlugin {
  const { pool } = options;
  /** The unverified user this reset would promote, noted before the native endpoint runs. */
  const promotes = defineRequestState<{ userId: string | null }>(() => ({ userId: null }));
  return {
    id: "docslurp-password-reset-ownership",
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/email-otp/reset-password",
        handler: createAuthMiddleware(async (ctx) => {
          const email = typeof ctx.body?.email === "string" ? ctx.body.email.trim().toLowerCase() : "";
          if (!email) return;
          const { rows } = await pool.query<{ id: string; verified: boolean }>(
            `select id, "emailVerified" as verified from "user" where lower(email) = $1`, [email]);
          // Only noted here; nothing changes unless the reset itself succeeds.
          if (rows[0] && !rows[0].verified) (await promotes.get()).userId = rows[0].id;
        }),
      }],
      after: [{
        matcher: (ctx) => ctx.path === "/email-otp/reset-password",
        handler: createAuthMiddleware(async (ctx) => {
          const userId = (await promotes.get()).userId;
          if (!userId || isAPIError(ctx.context.returned)) return;
          const accounts = await ctx.context.internalAdapter.findAccounts(userId);
          const unproven = accounts.filter((account) => account.providerId !== "credential");
          for (const account of unproven) await ctx.context.internalAdapter.deleteAccount(account.id);
          await pool.query(`delete from oauth_accounts where user_id = $1`, [userId]);
          await ctx.context.internalAdapter.deleteUserSessions(userId);
          console.info(`[auth] password reset proved ownership of an unverified account user=${userId}; removed ${unproven.length} earlier account links`);
        }),
      }],
    },
  } as BetterAuthPlugin;
}
