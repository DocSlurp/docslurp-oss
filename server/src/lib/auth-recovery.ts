import { defineRequestState } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";

/**
 * Recovery policy around Better Auth's native Email OTP reset.
 *
 * **Reset as proof of mailbox ownership.** Better Auth's Email OTP sign-in and
 * magic links promote an unverified account with `revokeUnprovenAccountAccess`:
 * everything the account gathered before its email was proven is removed. Its
 * Email OTP password reset only sets `emailVerified`. A reset is the same
 * proof, so the same rule applies, more strictly: every account link except
 * the password the owner just chose, stored OAuth tokens, passkeys, two-factor
 * enrolment, trusted devices and sessions.
 *
 * The native reset commits before an after-hook can run, so the promotion is
 * made durable instead of hoped for: a marker row is written before the reset
 * runs, the cleanup and the marker's removal share one transaction, and while
 * a marker stands for a verified user every new session for that user
 * completes the cleanup and is refused. A crash between the native commit and
 * the cleanup therefore fails closed until the cleanup has run.
 *
 * **Uniform code refusals** (`uniformCodeRefusal`). Native code checks answer
 * "too many attempts" (403) or "expired" only when a code was issued, which
 * only happens for a registered address. At the HTTP boundary those become the
 * `400 INVALID_OTP` an unregistered address gets, so wrong guesses can't tell
 * the two apart. Hooks can't do this: the dispatcher keeps the original status.
 */

type Queryable = Pick<Pool, "query">;
type Transactional = Queryable & Pick<Pool, "connect">;

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
const MARKER_PREFIX = "reset-promotion:";
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Removes everything an unverified account gathered before its owner proved the address; one transaction. */
export async function completeOwnershipPromotion(pool: Transactional, userId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const removed = await client.query(`delete from account where "userId" = $1 and "providerId" <> 'credential'`, [userId]);
    await client.query(`delete from oauth_accounts where user_id = $1`, [userId]);
    await client.query(`delete from passkey where "userId" = $1`, [userId]);
    await client.query(`delete from "twoFactor" where "userId" = $1`, [userId]);
    await client.query(`update "user" set "twoFactorEnabled" = false where id = $1`, [userId]);
    await client.query(`delete from verification where identifier like 'trust-device-%' and value = $1`, [userId]);
    await client.query(`delete from session where "userId" = $1`, [userId]);
    await client.query(`delete from verification where identifier = $1`, [`${MARKER_PREFIX}${userId}`]);
    await client.query("commit");
    return removed.rowCount ?? 0;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function pendingPromotion(pool: Queryable, userId: string): Promise<{ verified: boolean } | null> {
  const { rows } = await pool.query<{ verified: boolean }>(
    `select u."emailVerified" as verified from verification v join "user" u on u.id = v.value
     where v.identifier = $1 and v."expiresAt" > now()`, [`${MARKER_PREFIX}${userId}`]);
  return rows[0] ?? null;
}

export function recoveryPolicyPlugin(options: { pool: Transactional }): BetterAuthPlugin {
  const { pool } = options;
  /** The unverified user this reset would promote, noted before the native endpoint runs. */
  const promotes = defineRequestState<{ userId: string | null }>(() => ({ userId: null }));
  return {
    id: "docslurp-recovery-policy",
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                // A promotion that committed but never finished cleaning up: finish it, and refuse this session.
                before: async (session: { userId: string }) => {
                  const pending = await pendingPromotion(pool, session.userId);
                  if (!pending?.verified) return;
                  await completeOwnershipPromotion(pool, session.userId);
                  console.warn(`[auth] completed an interrupted ownership promotion user=${session.userId}; refused a session issued meanwhile`);
                  throw new APIError("FORBIDDEN", { code: "SIGN_IN_AGAIN", message: "Sign in again to continue." });
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/email-otp/reset-password",
        handler: createAuthMiddleware(async (ctx) => {
          const email = typeof ctx.body?.email === "string" ? ctx.body.email.trim().toLowerCase() : "";
          if (!email) return;
          const { rows } = await pool.query<{ id: string; verified: boolean }>(
            `select id, "emailVerified" as verified from "user" where lower(email) = $1`, [email]);
          const user = rows[0];
          if (!user || user.verified) return;
          // Durable before the native reset can commit; harmless if the code turns out wrong.
          await pool.query(
            `insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
             values ($1, $1, $2, $3, now(), now())
             on conflict (id) do update set "expiresAt" = excluded."expiresAt", "updatedAt" = now()`,
            [`${MARKER_PREFIX}${user.id}`, user.id, new Date(Date.now() + MARKER_TTL_MS)]);
          (await promotes.get()).userId = user.id;
        }),
      }],
      after: [{
        matcher: (ctx) => ctx.path === "/email-otp/reset-password",
        handler: createAuthMiddleware(async (ctx) => {
          const userId = (await promotes.get()).userId;
          if (!userId) return;
          // Decide from the database, not the response: an error after the native commit still promoted.
          const { rows } = await pool.query<{ verified: boolean }>(`select "emailVerified" as verified from "user" where id = $1`, [userId]);
          if (rows[0]?.verified) {
            const removed = await completeOwnershipPromotion(pool, userId);
            console.info(`[auth] password reset proved ownership of an unverified account user=${userId}; removed ${removed} earlier account links`);
          } else {
            await pool.query(`delete from verification where identifier = $1`, [`${MARKER_PREFIX}${userId}`]);
          }
        }),
      }],
    },
  } as BetterAuthPlugin;
}
