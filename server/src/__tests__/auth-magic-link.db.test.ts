import { createHash, createHmac, generateKeyPairSync, randomBytes, sign as signData, type KeyObject } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase, serveOnRandomPort } from "@docslurp/worker/testing";

/**
 * Passkeys and two-factor auth against the real Better Auth configuration
 * (server/src/lib/better-auth.ts) and a migrated Postgres. Most cases are
 * negative: every way to reach a session without the second factor, replay,
 * brute force, passkey origin/RP/credential confusion, factor removal without
 * re-auth, and the org MFA policy.
 */

const ORIGIN = "http://localhost:4321";
const SECRET = "mfa-test-secret-".padEnd(48, "x");
const PASSWORD = "correct horse battery staple";

let pool: Pool;
let stop: () => Promise<void>;
let auth: typeof import("../lib/better-auth.js")["auth"];
let resolveBetterAuthSessionActor: typeof import("../lib/request-actor.js")["resolveBetterAuthSessionActor"];
const sentEmails: Array<{ to: string; text: string; html: string }> = [];
let routes: import("hono").Hono;

beforeAll(async () => {
  const database = await createMigratedDatabase();
  const serving = await serveOnRandomPort(database, { maxConnections: 8 });
  const url = `postgres://postgres@127.0.0.1:${serving.port}/postgres`;
  stop = async () => { await serving.server.stop(); await database.close(); };
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", url);
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "noreply@docslurp.io");
  vi.stubEnv("PASSKEY_ORIGINS", "");
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.startsWith("https://api.resend.com/")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; text: string; html: string };
      sentEmails.push({ to: body.to[0]!, text: body.text, html: body.html });
      return Response.json({ id: "email" });
    }
    return realFetch(input, init);
  });
  const { Pool } = await import("pg");
  pool = new Pool({ connectionString: url, max: 4 });
  // better-auth.ts reuses this pool outside production.
  (globalThis as { __docslurpAuthPool?: Pool }).__docslurpAuthPool = pool;
  ({ auth } = await import("../lib/better-auth.js"));
  ({ resolveBetterAuthSessionActor } = await import("../lib/request-actor.js"));
  routes = (await import("../routes/auth.js")).authRoutes;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stop?.();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(async () => { sentEmails.length = 0; await pool.query(`delete from "rateLimit" where key like 'magic-confirm:%'`); });
afterEach(() => { vi.useRealTimers(); });


class Browser {
  cookies = new Map<string, string>();
  constructor(readonly origin = ORIGIN) {}
  header(): string { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "); }
  store(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(";");
      const index = pair!.indexOf("=");
      const name = pair!.slice(0, index).trim();
      const value = pair!.slice(index + 1).trim();
      const expired = attributes.some((part) => /max-age=0\b/i.test(part.trim())) || value === "";
      if (expired) this.cookies.delete(name); else this.cookies.set(name, value);
    }
  }
  async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const response = await auth.handler(new Request(`${ORIGIN}/api/auth${path}`, {
      method,
      headers: { origin: this.origin, cookie: this.header(), ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    }));
    this.store(response);
    return response;
  }
  async json<T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<{ status: number; body: T; response: Response }> {
    const response = await this.request(path, { body, method });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T, response };
  }
  async session(): Promise<{ session: { id: string; mfaVerified?: boolean }; user: { id: string } } | null> {
    return (await this.json<{ session: { id: string; mfaVerified?: boolean }; user: { id: string } } | null>("/get-session")).body;
  }
  headers(): Headers { return new Headers({ cookie: this.header(), origin: this.origin }); }
}

let userCounter = 0;
async function createUser(options: { email?: string; password?: boolean } = {}): Promise<{ id: string; email: string }> {
  userCounter += 1;
  const id = `user-${userCounter}-${randomBytes(3).toString("hex")}`;
  const email = options.email ?? `${id}@example.test`;
  await pool.query(`insert into "user"(id, name, email, "emailVerified") values ($1, $2, $3, true)`, [id, id, email]);
  if (options.password !== false) {
    const context = await auth.$context;
    const hash = await context.password.hash(PASSWORD);
    await pool.query(`insert into account(id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`, [`acct-${id}`, id, hash]);
  }
  return { id, email };
}

async function signInPassword(browser: Browser, email: string) {
  return browser.json<{ twoFactorRedirect?: boolean; twoFactorMethods?: string[]; token?: string }>("/sign-in/email", { email, password: PASSWORD });
}

// RFC 6238 TOTP over the raw secret Better Auth encodes in the otpauth URI.
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0; let value = 0; const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret: Buffer, offsetSteps = 0): string {
  const counter = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}
function wrongCode(secret: Buffer): string {
  const valid = new Set([-1, 0, 1].map((step) => totp(secret, step)));
  for (let n = 0; ; n += 1) { const candidate = String(n).padStart(6, "0"); if (!valid.has(candidate)) return candidate; }
}

/** Signs in with a password, enrols TOTP and returns the secret and backup codes. */
async function enrolledUser(): Promise<{ user: { id: string; email: string }; browser: Browser; secret: Buffer; backupCodes: string[] }> {
  const user = await createUser();
  const browser = new Browser();
  expect((await signInPassword(browser, user.email)).status).toBe(200);
  expect((await browser.json("/sensitive-access/password", { password: PASSWORD })).status).toBe(200);
  const enabled = await browser.json<{ totpURI: string; backupCodes: string[] }>("/two-factor/enable", { password: PASSWORD });
  expect(enabled.status).toBe(200);
  const secret = base32Decode(new URL(enabled.body.totpURI).searchParams.get("secret")!);
  // Enrolment codes are claimed too; use the next step so sign-in can use the current one.
  const verified = await browser.json("/two-factor/verify-totp", { code: totp(secret, 1) });
  expect(verified.status).toBe(200);
  return { user, browser, secret, backupCodes: enabled.body.backupCodes };
}

async function sessionsFor(userId: string): Promise<Array<{ token: string; mfaVerified: boolean }>> {
  return (await pool.query<{ token: string; mfaVerified: boolean }>(`select token, "mfaVerified" from session where "userId" = $1`, [userId])).rows;
}



async function linkFor(browser: Browser, email: string, callbackURL = "/app") {
  const sent = await browser.json("/sign-in/magic-link", { email, callbackURL });
  expect(sent.status).toBe(200);
  const url = new URL(sentEmails.at(-1)!.text.match(/https?:\/\/\S+/)![0]);
  return { url, token: new URLSearchParams(url.hash.slice(1)).get("token")! };
}
async function confirm(browser: Browser, token: string, callbackURL = "/app", origin = ORIGIN) {
  const response = await routes.fetch(new Request(`${ORIGIN}/api/auth/magic-link/confirm`, { method: "POST",
    headers: { origin, cookie: browser.header(), "content-type": "application/json" }, body: JSON.stringify({ token, callbackURL }) }));
  browser.store(response);
  return { response, body: await response.json() as { code?: string; redirectTo?: string } };
}

describe("native scanner-safe magic-link login", () => {
  it("supports the native email-only request by defaulting to the app callback", async () => {
    const user = await createUser(); const browser = new Browser();
    expect((await browser.json("/sign-in/magic-link", { email: user.email })).status).toBe(200);
    const url = new URL(sentEmails.at(-1)!.text.match(/https?:\/\/\S+/)![0]);
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get("callbackURL")).toBe("/app");
    const result = await confirm(browser, fragment.get("token")!);
    expect(result.response.status).toBe(200); expect(result.body).toEqual({ redirectTo: "/app" });
  });

  it("sends only a fragment landing link, stores a hash, and requires explicit POST confirmation", async () => {
    const user = await createUser(); const browser = new Browser();
    const { url, token } = await linkFor(browser, user.email, "/app?source=email");
    expect(url.pathname).toBe("/auth/magic-link"); expect(url.search).toBe(""); expect(token).toMatch(/^[a-zA-Z]{32}$/);
    const records = await pool.query(`select identifier,value from verification where identifier like 'magic-link:%'`);
    expect(records.rows.some(row => row.identifier.includes(token) || row.value.includes(token))).toBe(false);
    // Public native verification has no consuming GET route, even with a valid token.
    expect((await browser.request(`/magic-link/verify?token=${token}&callbackURL=/app`)).status).toBe(404);
    expect(await browser.session()).toBeNull();
    const result = await confirm(browser, token, "/app?source=email");
    expect(result.response.status).toBe(200); expect(result.body).toEqual({ redirectTo: "/app?source=email" });
    expect((await browser.session())!.user.id).toBe(user.id);
    expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
    expect(JSON.stringify(result.body)).not.toContain(token); expect(JSON.stringify(result.body)).not.toContain("session");
    const replay = await confirm(new Browser(), token); expect(replay.response.status).toBe(400); expect(replay.body.code).toBe("MAGIC_LINK_INVALID_OR_EXPIRED");
  });

  it("consumes atomically across concurrent redemption attempts", async () => {
    const user = await createUser(); const { token } = await linkFor(new Browser(), user.email);
    const result = await Promise.all([confirm(new Browser(), token), confirm(new Browser(), token)]);
    expect(result.map(value => value.response.status).sort()).toEqual([200, 400]);
  });

  it("refuses expired, tampered, hostile redirect, cross-origin and oversized requests", async () => {
    const user = await createUser(); const browser = new Browser(); const { token } = await linkFor(browser, user.email);
    expect((await confirm(browser, token, "https://evil.invalid")).response.status).toBe(400);
    expect((await confirm(browser, token, "/app", "https://evil.invalid")).response.status).toBe(403);
    expect((await browser.json("/sign-in/magic-link", { email: user.email, callbackURL: "/api/auth/sign-out" })).status).toBe(400);
    expect((await confirm(browser, "x".repeat(32))).response.status).toBe(400);
    await pool.query(`update verification set "expiresAt" = now() - interval '1 second' where identifier like 'magic-link:%'`);
    expect((await confirm(browser, token)).response.status).toBe(400);
    const oversized = await routes.fetch(new Request(`${ORIGIN}/api/auth/magic-link/confirm`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "x".repeat(5000) }));
    expect(oversized.status).toBe(400);
  });

  it("does not auto-register unknown users", async () => {
    const browser = new Browser(); const email = `unknown-${randomBytes(3).toString("hex")}@example.test`;
    const { token } = await linkFor(browser, email);
    expect((await confirm(browser, token)).body.code).toBe("MAGIC_LINK_INVALID_OR_EXPIRED");
    expect((await pool.query(`select id from "user" where email=$1`, [email])).rows).toHaveLength(0);
    expect(await browser.session()).toBeNull();
  });

  it("preserves the MFA challenge and never grants sensitive verification", async () => {
    const { user, secret } = await enrolledUser(); const browser = new Browser();
    const { token } = await linkFor(browser, user.email);
    const result = await confirm(browser, token);
    expect(result.response.status).toBe(200); expect(result.body.redirectTo).toContain("/app/sign-in");
    expect(browser.cookies.has("better-auth.two_factor")).toBe(true); expect(await browser.session()).toBeNull();
    expect((await browser.json("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
    expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
  });

  it("honors verified-domain SSO before delivery and after a link was sent", async () => {
    const domain = `magic-${randomBytes(4).toString("hex")}.example`; const user = await createUser({ email: `person@${domain}` });
    const browser = new Browser(); const { token } = await linkFor(browser, user.email);
    await pool.query(`insert into organizations(id,name,slug,created_by_user_id,sso_config) values($1,'SSO',$1,$2,$3)`, [domain,user.id,JSON.stringify({ enabled:true,enforceSso:true,emailDomain:domain })]);
    await pool.query(`insert into sso_domains(org_id,domain,verification_token,verified_at) values($1,$1,'test',now())`, [domain]);
    expect((await browser.json("/sign-in/magic-link", { email: user.email })).status).toBe(403);
    expect((await confirm(browser, token)).response.status).toBe(403); expect(await browser.session()).toBeNull();
  });

  it("verifies email ownership while revoking pre-hijacked unverified credentials and sessions", async () => {
    const user = await createUser(); const attacker = new Browser(); await signInPassword(attacker,user.email);
    await pool.query(`update "user" set "emailVerified"=false where id=$1`,[user.id]);
    const browser = new Browser(); const { token } = await linkFor(browser,user.email);
    expect((await confirm(browser,token)).response.status).toBe(200);
    expect((await pool.query(`select password from account where "userId"=$1 and "providerId"='credential'`,[user.id])).rows.every(row=>row.password===null)).toBe(true);
    expect(await attacker.session()).toBeNull(); expect((await browser.session())!.user.id).toBe(user.id);
  });
});

describe("magic-link confirmation policy", () => {
  it("rate limits confirmation even when global API limits are disabled", async () => {
    const original = process.env.API_RATE_LIMIT_ENABLED;
    vi.stubEnv("API_RATE_LIMIT_ENABLED", "false");
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 11; index++) statuses.push((await confirm(new Browser(), "z".repeat(32))).response.status);
      expect(statuses.slice(0,10)).toEqual(Array(10).fill(400));
      expect(statuses[10]).toBe(429);
    } finally { if (original === undefined) delete process.env.API_RATE_LIMIT_ENABLED; else process.env.API_RATE_LIMIT_ENABLED = original; }
  });

  it("never copies a previously verified sensitive grant into magic-link login", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser,user.email);
    await browser.json("/sensitive-access/password", { password: PASSWORD });
    const prior = (await browser.session())!.session.id;
    const { token } = await linkFor(browser,user.email);
    expect((await confirm(browser,token)).response.status).toBe(200);
    expect((await browser.session())!.session.id).not.toBe(prior);
    expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
  });
});
