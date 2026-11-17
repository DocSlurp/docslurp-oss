import { createHmac, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Better Auth's sliding session refresh against a real, migrated Postgres.
 * Opt-in:
 *   TEST_DATABASE_URL=postgres://… (a throwaway database)
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const secret = "x".repeat(40);

describe.skipIf(!databaseUrl)("Better Auth session refresh (database)", () => {
  let pool: import("pg").Pool | null = null;
  const userId = `session-refresh-${randomUUID()}`;
  afterAll(async () => {
    await pool?.query(`delete from "session" where "userId" = $1`, [userId]);
    await pool?.query(`delete from "user" where id = $1`, [userId]);
    await pool?.end();
  });

  it("extends an active session and returns a refreshed 30-day cookie", async () => {
    const { Pool } = await import("pg");
    const { betterAuth } = await import("better-auth");
    const { createBetterAuthSecurityOptions } = await import("@docslurp/shared/auth-security");
    pool = new Pool({ connectionString: databaseUrl });
    const options = createBetterAuthSecurityOptions({ NODE_ENV: "production", APP_URL: "https://docslurp.io" });
    const auth = betterAuth({ database: pool, secret, ...options, baseURL: "https://docslurp.io" });

    // Every cookie Better Auth or a plugin creates goes through this getter.
    const context = await auth.$context;
    for (const cookie of [context.authCookies.sessionToken, context.authCookies.sessionData, context.authCookies.dontRememberToken, context.authCookies.accountData,
      context.createAuthCookie("two_factor"), context.createAuthCookie("trust_device", { maxAge: 60 }), context.createAuthCookie("oauth_state"), context.createAuthCookie("better-auth-passkey")]) {
      expect(cookie.name).toMatch(/^__Host-better-auth\./);
      expect(cookie.attributes).toMatchObject({ secure: true, path: "/", httpOnly: true, sameSite: "lax" });
      expect(cookie.attributes.domain).toBeUndefined();
    }

    const token = randomUUID().replaceAll("-", "");
    // Last refreshed ten days ago: past updateAge, well inside the idle timeout.
    const staleExpiry = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    await pool.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, 'Refresh', $2, true, now(), now())`, [userId, `${userId}@example.test`]);
    await pool.query(`insert into "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt") values ($1, $2, $3, $4, now(), now())`, [randomUUID(), token, userId, staleExpiry]);

    const signature = createHmac("sha256", secret).update(token).digest("base64");
    const headers = new Headers({ cookie: `__Host-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` });
    const result = await auth.api.getSession({ headers, returnHeaders: true });

    expect(result.response?.user.id).toBe(userId);
    const cookie = result.headers.getSetCookie().find((value) => value.startsWith("__Host-better-auth.session_token="));
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    // What a browser requires of a `__Host-` cookie; without them it drops the cookie.
    expect(cookie).toMatch(/Path=\/(;|$)/);
    expect(cookie).not.toMatch(/Domain=/i);
    // The old name is no longer a session: a sibling host can set a `__Secure-` cookie.
    const old = await auth.api.getSession({ headers: new Headers({ cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}; better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` }) });
    expect(old).toBeNull();
    const { rows } = await pool.query<{ expiresAt: Date }>(`select "expiresAt" from "session" where token = $1`, [token]);
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });
});
