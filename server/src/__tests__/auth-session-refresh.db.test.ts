import { createHmac, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Better Auth's sliding session refresh against a real, migrated Postgres.
 * Opt-in:
 *   AUTH_SESSION_TEST_DATABASE_URL=postgres://… (a throwaway database)
 */
const databaseUrl = process.env.AUTH_SESSION_TEST_DATABASE_URL;
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

    const token = randomUUID().replaceAll("-", "");
    // Last refreshed ten days ago: past updateAge, well inside the idle timeout.
    const staleExpiry = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    await pool.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, 'Refresh', $2, true, now(), now())`, [userId, `${userId}@example.test`]);
    await pool.query(`insert into "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt") values ($1, $2, $3, $4, now(), now())`, [randomUUID(), token, userId, staleExpiry]);

    const signature = createHmac("sha256", secret).update(token).digest("base64");
    const headers = new Headers({ cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` });
    const result = await auth.api.getSession({ headers, returnHeaders: true });

    expect(result.response?.user.id).toBe(userId);
    const cookie = result.headers.getSetCookie().find((value) => value.startsWith("__Secure-better-auth.session_token="));
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const { rows } = await pool.query<{ expiresAt: Date }>(`select "expiresAt" from "session" where token = $1`, [token]);
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });
});
