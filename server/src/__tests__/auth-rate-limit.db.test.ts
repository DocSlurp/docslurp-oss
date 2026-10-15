import { afterAll, describe, expect, it } from "vitest";

/**
 * Better Auth's database-backed rate limiter (migration 0038 "rateLimit")
 * against a real, migrated Postgres. Opt-in:
 *   AUTH_RATE_LIMIT_TEST_DATABASE_URL=postgres://… (a throwaway database)
 */
const databaseUrl = process.env.AUTH_RATE_LIMIT_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("Better Auth rate limits (database)", () => {
  let pool: import("pg").Pool | null = null;
  afterAll(async () => { await pool?.end(); });

  it("shares sign-in counters through the rateLimit table, keyed by the trusted client IP", async () => {
    const { Pool } = await import("pg");
    const { betterAuth } = await import("better-auth");
    const { createBetterAuthSecurityOptions } = await import("@docslurp/shared/auth-security");
    const { withTrustedAuthClientIp } = await import("../lib/client-ip.js");
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query(`delete from "rateLimit"`);
    const options = createBetterAuthSecurityOptions({ NODE_ENV: "production", APP_URL: "https://docslurp.io" });
    // Two instances stand in for two app machines sharing one database.
    const machines = [0, 1].map(() => betterAuth({ database: pool!, secret: "x".repeat(40), ...options, baseURL: "https://docslurp.io" }));
    const signIn = (machine: number, headers: Record<string, string>) => machines[machine]!.handler(withTrustedAuthClientIp(new Request("https://docslurp.io/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://docslurp.io", ...headers },
      body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password" }),
    })));

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // A rotating spoofed header must not mint a fresh bucket.
      const response = await signIn(attempt % 2, { "x-forwarded-for": `203.0.113.${attempt}, 198.51.100.9`, "cf-connecting-ip": `203.0.113.${attempt}` });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses[3]).toBe(429);

    const other = await signIn(0, { "x-forwarded-for": "198.51.100.10" });
    expect(other.status).not.toBe(429);
    const { rows } = await pool.query<{ key: string }>(`select key from "rateLimit" order by key`);
    expect(rows.map((row) => row.key)).toEqual(["198.51.100.10|/sign-in/email", "198.51.100.9|/sign-in/email"]);
  });
});
