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
const sentEmails: Array<{ to: string; code: string }> = [];

beforeAll(async () => {
  const database = await createMigratedDatabase();
  const serving = await serveOnRandomPort(database, { maxConnections: 8 });
  const url = `postgres://postgres@127.0.0.1:${serving.port}/postgres`;
  stop = async () => { await serving.server.stop(); await database.close(); };
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", url);
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("MFA_REAUTH_MAX_AGE_SECONDS", "90");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "noreply@docslurp.io");
  vi.stubEnv("PASSKEY_ORIGINS", "");
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.startsWith("https://api.resend.com/")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; text: string };
      sentEmails.push({ to: body.to[0]!, code: /\n\n(\w+)\n\n/.exec(body.text)![1]! });
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
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stop?.();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sentEmails.length = 0;
  // Keep real endpoint requests from crossing a TOTP step between enrollment
  // (next-step code) and sign-in (current code). Database expiry remains real.
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Math.floor(now / 30_000) * 30_000 + 5_000);
});
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------
// Browser stand-in

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

/** Fresh action proof is explicit: signing in, remembered devices and fixture
 * timestamps never substitute for the sensitive-access endpoint. */
async function verifySensitive(browser: Browser, secret?: Buffer) {
  const status = await browser.json<{ verifiedUntil: string | null }>("/sensitive-access");
  if (status.body.verifiedUntil) return;
  const proof = await browser.json<{ requiresTotp?: boolean; enrollmentOnly?: boolean }>("/sensitive-access/password", { password: PASSWORD });
  expect(proof.status).toBe(200);
  if (!proof.body.requiresTotp) return;
  if (!secret) { expect(proof.body.enrollmentOnly).toBe(true); return; }
  const session = await browser.session();
  const used = new Set((await pool.query<{ code_digest: string }>(`select code_digest from mfa_totp_replay where user_id = $1`, [session!.user.id])).rows.map(row => row.code_digest));
  let code: string | undefined;
  for (let step = 0; step < 4 && !code; step++) {
    code = [-1, 0, 1].map(offset => totp(secret, offset)).find(value => !used.has(createHash("sha256").update(`${session!.user.id}:${value}`).digest("hex")));
    if (!code) { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 30_000); }
  }
  expect(code).toBeDefined();
  expect((await browser.json("/two-factor/verify-totp", { code })).status).toBe(200);
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
  await verifySensitive(browser);
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

// ---------------------------------------------------------------------------

describe("TOTP enrolment", () => {
  it("returns a QR URI and 10 backup codes, and stays off until a code is verified", async () => {
    const user = await createUser();
    const browser = new Browser();
    await signInPassword(browser, user.email);
    await verifySensitive(browser);
    const enabled = await browser.json<{ totpURI: string; backupCodes: string[] }>("/two-factor/enable", { password: PASSWORD });
    expect(enabled.body.totpURI).toMatch(/^otpauth:\/\/totp\/DocSlurp:/);
    expect(enabled.body.backupCodes).toHaveLength(10);
    expect(new Set(enabled.body.backupCodes).size).toBe(10);
    const flag = async () => (await pool.query(`select "twoFactorEnabled" from "user" where id = $1`, [user.id])).rows[0].twoFactorEnabled;
    expect(await flag()).toBe(false);

    const secret = base32Decode(new URL(enabled.body.totpURI).searchParams.get("secret")!);
    expect((await browser.json("/two-factor/verify-totp", { code: wrongCode(secret) })).status).toBe(401);
    expect(await flag()).toBe(false);
    expect((await browser.json("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
    expect(await flag()).toBe(true);
    // Enrolment re-issues this browser's session as MFA-verified.
    expect((await browser.session())?.session.mfaVerified).toBe(true);
  });

  it("refuses enrolment with a wrong password", async () => {
    const user = await createUser();
    const browser = new Browser();
    await signInPassword(browser, user.email);
    await verifySensitive(browser);
    expect((await browser.json("/two-factor/enable", { password: "wrong" })).status).toBe(400);
  });

  it("signs out other devices whose sessions predate 2FA", async () => {
    const user = await createUser();
    const laptop = new Browser(); const phone = new Browser();
    await signInPassword(laptop, user.email);
    await signInPassword(phone, user.email);
    await verifySensitive(laptop);
    const enabled = await laptop.json<{ totpURI: string }>("/two-factor/enable", { password: PASSWORD });
    const secret = base32Decode(new URL(enabled.body.totpURI).searchParams.get("secret")!);
    await laptop.json("/two-factor/verify-totp", { code: totp(secret) });
    expect(await laptop.session()).not.toBeNull();
    expect(await phone.session()).toBeNull();
  });
});

describe("sign-in challenge", () => {
  it("issues no session after the password; the second factor issues an MFA-verified one", async () => {
    const { user, secret } = await enrolledUser();
    const before = await sessionsFor(user.id);
    const browser = new Browser();
    const first = await signInPassword(browser, user.email);
    expect(first.body).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect(first.body.token).toBeUndefined();
    expect(await browser.session()).toBeNull();
    expect(await sessionsFor(user.id)).toHaveLength(before.length);
    // The raw response never carried a usable session cookie.
    const leaked = first.response.headers.getSetCookie().find((cookie) => cookie.startsWith("better-auth.session_token=") && !/max-age=0/i.test(cookie));
    expect(leaked).toBeUndefined();

    expect((await browser.json("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
    const session = await browser.session();
    expect(session?.user.id).toBe(user.id);
    expect(session?.session.mfaVerified).toBe(true);
  });

  it("does not let a half-authenticated browser reach sessions or the API", async () => {
    const { user } = await enrolledUser();
    const browser = new Browser();
    await signInPassword(browser, user.email);
    expect(browser.cookies.has("better-auth.two_factor")).toBe(true);
    expect(await browser.session()).toBeNull();
    expect(await resolveBetterAuthSessionActor(browser.headers())).toBeNull();
    // Session-requiring endpoints refuse the challenge cookie.
    expect((await browser.json("/two-factor/disable", {})).status).toBe(401);
    expect((await browser.json("/passkey/list-user-passkeys")).status).toBe(401);
    expect((await browser.json("/update-user", { name: "x" })).status).toBe(401);
  });

  it("challenges email-code sign-in, not just passwords", async () => {
    const { user } = await enrolledUser();
    const browser = new Browser();
    expect((await browser.json("/email-otp/send-verification-otp", { email: user.email, type: "sign-in" })).status).toBe(200);
    const code = sentEmails.find((email) => email.to === user.email)!.code;
    const result = await browser.json<{ twoFactorRedirect?: boolean }>("/sign-in/email-otp", { email: user.email, otp: code });
    expect(result.body.twoFactorRedirect).toBe(true);
    expect(await browser.session()).toBeNull();
  });

  it("turns redirect sign-ins (email links, OAuth callbacks) into a redirect to the challenge", async () => {
    const { user } = await enrolledUser();
    await pool.query(`update "user" set "emailVerified" = false where id = $1`, [user.id]);
    const { createEmailVerificationToken } = await import("better-auth/api");
    const token = await createEmailVerificationToken(SECRET, user.email);
    const browser = new Browser();
    const response = await browser.request(`/verify-email?token=${token}&callbackURL=${encodeURIComponent("/app/workspaces")}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/app/sign-in");
    expect(location.searchParams.get("mfa")).toBe("required");
    expect(location.searchParams.get("redirectTo")).toBe("/app/workspaces");
    expect(await browser.session()).toBeNull();
    expect(browser.cookies.has("better-auth.two_factor")).toBe(true);
  });

  it("revokes a session that skipped the challenge, whatever minted it", async () => {
    const { user } = await enrolledUser();
    // A session row created by a path that never challenged (simulating a missed endpoint).
    const context = await auth.$context;
    const rogue = await context.internalAdapter.createSession(user.id);
    const browser = new Browser();
    const signature = createHmac("sha256", SECRET).update(rogue.token).digest("base64");
    browser.cookies.set("better-auth.session_token", encodeURIComponent(`${rogue.token}.${signature}`));
    expect(await resolveBetterAuthSessionActor(browser.headers())).toBeNull();
    expect(await browser.session()).toBeNull();
    expect((await pool.query(`select 1 from session where token = $1`, [rogue.token])).rowCount).toBe(0);
  });

  it("ignores duplicate session cookies in either order (council H1)", async () => {
    const { user, browser: victim } = await enrolledUser();
    const context = await auth.$context;
    const rogue = await context.internalAdapter.createSession(user.id);
    await pool.query(`update session set "mfaVerified" = false where token = $1`, [rogue.token]);
    const signed = (token: string) => encodeURIComponent(`${token}.${createHmac("sha256", SECRET).update(token).digest("base64")}`);
    const other = await createUser();
    const decoyBrowser = new Browser();
    await signInPassword(decoyBrowser, other.email);
    const decoy = decoyBrowser.cookies.get("better-auth.session_token")!;
    for (const header of [
      `better-auth.session_token=${signed(rogue.token)}; better-auth.session_token=decoy.decoy`,
      `better-auth.session_token=decoy.decoy; better-auth.session_token=${signed(rogue.token)}`,
      `better-auth.session_token=${signed(rogue.token)}; better-auth.session_token=${decoy}`,
    ]) {
      const headers = new Headers({ cookie: header, origin: ORIGIN });
      expect(await resolveBetterAuthSessionActor(headers)).toBeNull();
      expect(await auth.api.getSession({ headers })).toBeNull();
    }
    // The victim's real MFA session can't borrow a fresh decoy session to dodge re-auth.
    await pool.query(`update session set "authenticatedAt" = now() - interval '1 hour' where "userId" = $1`, [user.id]);
    victim.cookies.set("better-auth.session_token", `${victim.cookies.get("better-auth.session_token")}; better-auth.session_token=${decoy}`);
    const regenerate = await victim.json("/two-factor/generate-backup-codes", { password: PASSWORD });
    expect(regenerate.status).not.toBe(200);
  });

  it("refuses an unverified 2FA session in the actor even if the strip hook missed it", async () => {
    const { user } = await enrolledUser();
    const original = auth.api.getSession;
    (auth.api as { getSession: unknown }).getSession = async () => ({ session: { id: "s", userId: user.id, mfaVerified: false }, user: { id: user.id, email: user.email, name: "x", twoFactorEnabled: true } });
    try {
      expect(await resolveBetterAuthSessionActor(new Headers())).toBeNull();
    } finally {
      (auth.api as { getSession: unknown }).getSession = original;
    }
  });

  it("can't replay a code by adding an unsigned session cookie for another account (council H2)", async () => {
    const { user, secret } = await enrolledUser();
    const victimBrowser = new Browser();
    await signInPassword(victimBrowser, user.email);
    const code = totp(secret);
    expect((await victimBrowser.json("/two-factor/verify-totp", { code })).status).toBe(200);

    const attackerAccount = await createUser();
    const own = new Browser();
    await signInPassword(own, attackerAccount.email);
    const rawToken = decodeURIComponent(own.cookies.get("better-auth.session_token")!).split(".")[0]!;
    const attacker = new Browser();
    await signInPassword(attacker, user.email);
    attacker.cookies.set("better-auth.session_token", rawToken);
    expect((await attacker.json("/two-factor/verify-totp", { code })).status).not.toBe(200);
    expect(await sessionsFor(user.id).then((rows) => rows.filter((row) => row.mfaVerified).length)).toBe(2);
  });

  it("rejects a wrong code and a replayed code", async () => {
    const { user, secret } = await enrolledUser();
    const first = new Browser();
    await signInPassword(first, user.email);
    expect((await first.json("/two-factor/verify-totp", { code: wrongCode(secret) })).status).toBe(401);
    const code = totp(secret);
    expect((await first.json("/two-factor/verify-totp", { code })).status).toBe(200);

    // An observed code can't be reused within its window, even on a fresh challenge.
    const attacker = new Browser();
    await signInPassword(attacker, user.email);
    const replay = await attacker.json<{ code?: string }>("/two-factor/verify-totp", { code });
    expect(replay.status).toBe(401);
    expect(await attacker.session()).toBeNull();
  });

  it("accepts each backup code once", async () => {
    const { user, backupCodes } = await enrolledUser();
    const first = new Browser();
    await signInPassword(first, user.email);
    expect((await first.json("/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBe(200);
    expect((await first.session())?.session.mfaVerified).toBe(true);

    const second = new Browser();
    await signInPassword(second, user.email);
    expect((await second.json("/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBe(401);
    expect(await second.session()).toBeNull();
    expect((await second.json("/two-factor/verify-backup-code", { code: backupCodes[1] })).status).toBe(200);
  });

  it.each([0, 1_000])("ends a challenge after 5 wrong codes and locks the account after 10 (clock advances %i ms)", async (advanceMs) => {
    // Fake only Date: database/network timers must continue running.
    const start = Math.floor(Date.now() / 30_000) * 30_000 + 29_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const { user, secret } = await enrolledUser();
    // Enrollment consumed the next step. Preserve this unconsumed current code;
    // it remains valid as the previous step after crossing the boundary.
    const unconsumedCode = totp(secret);
    vi.setSystemTime(start + advanceMs);
    const browser = new Browser();
    await signInPassword(browser, user.email);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) statuses.push((await browser.json("/two-factor/verify-totp", { code: wrongCode(secret) })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(400); // TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: the challenge is spent.

    const next = new Browser();
    await signInPassword(next, user.email);
    for (let attempt = 0; attempt < 5; attempt += 1) await next.json("/two-factor/verify-totp", { code: wrongCode(secret) });
    const third = new Browser();
    await signInPassword(third, user.email);
    if (advanceMs > 0) {
      // The now-current code was consumed by enrollment: replay rejection runs
      // before account lockout, which caused the original wall-clock flake.
      const replay = await third.json<{ code?: string }>("/two-factor/verify-totp", { code: totp(secret) });
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe("INVALID_CODE");
      expect(await third.session()).toBeNull();
    }
    // Ten failures across challenges: an unconsumed valid code reaches lockout.
    const locked = await third.json<{ code?: string }>("/two-factor/verify-totp", { code: unconsumedCode });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("ACCOUNT_TEMPORARILY_LOCKED");
    expect(await third.session()).toBeNull();
  });

  it("skips the challenge on a trusted device for that user only", async () => {
    const { user, secret } = await enrolledUser();
    const browser = new Browser();
    await signInPassword(browser, user.email);
    await browser.json("/two-factor/verify-totp", { code: totp(secret), trustDevice: true });
    expect(browser.cookies.has("better-auth.trust_device")).toBe(true);
    await browser.json("/sign-out", {});

    const again = await signInPassword(browser, user.email);
    expect(again.body.twoFactorRedirect).toBeUndefined();
    expect((await browser.session())?.session.mfaVerified).toBe(true);

    // The cookie is bound to its user: another 2FA user on this browser is challenged.
    const other = await enrolledUser();
    await browser.json("/sign-out", {});
    expect((await signInPassword(browser, other.user.email)).body.twoFactorRedirect).toBe(true);
  });
});

describe("removing factors", () => {
  it("needs fresh sensitive verification to disable 2FA or replace backup codes", async () => {
    const { user, browser, secret } = await enrolledUser();
    await pool.query(`update session set "sensitiveVerifiedAt" = now() - interval '1 hour' where "userId" = $1`, [user.id]);
    const disable = await browser.json<{ code?: string }>("/two-factor/disable", { password: PASSWORD });
    expect(disable.status).toBe(403);
    expect(disable.body.code).toBe("REAUTH_REQUIRED");
    expect((await browser.json<{ code?: string }>("/two-factor/generate-backup-codes", { password: PASSWORD })).body.code).toBe("REAUTH_REQUIRED");
    // Rotating the session (profile update) must not refresh the re-auth window.
    expect((await browser.json("/update-user", { name: "Renamed" })).status).toBe(200);
    expect((await browser.json<{ code?: string }>("/two-factor/disable", { password: PASSWORD })).body.code).toBe("REAUTH_REQUIRED");

    await verifySensitive(browser, secret);
    expect((await browser.json("/two-factor/disable", { password: PASSWORD })).status).toBe(200);
    expect((await pool.query(`select "twoFactorEnabled" from "user" where id = $1`, [user.id])).rows[0].twoFactorEnabled).toBe(false);
  });

  it("forgets every trusted device when 2FA is turned off (council L3)", async () => {
    const { user, secret, browser } = await enrolledUser();
    const laptop = new Browser();
    await signInPassword(laptop, user.email);
    await laptop.json("/two-factor/verify-totp", { code: totp(secret, -1), trustDevice: true });
    expect((await pool.query(`select 1 from verification where identifier like 'trust-device-%' and value = $1`, [user.id])).rowCount).toBe(1);
    await verifySensitive(browser, secret);
    expect((await browser.json("/two-factor/disable", { password: PASSWORD })).status).toBe(200);
    expect((await pool.query(`select 1 from verification where identifier like 'trust-device-%' and value = $1`, [user.id])).rowCount).toBe(0);
  });

  it("also needs the password for accounts that have one", async () => {
    const { browser, secret } = await enrolledUser();
    await verifySensitive(browser, secret);
    expect((await browser.json("/two-factor/disable", { password: "wrong" })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Passkeys: a software authenticator (ES256, "none" attestation)

function cbor(value: unknown): Buffer {
  const head = (major: number, length: number): Buffer => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    const out = Buffer.alloc(3); out[0] = (major << 5) | 25; out.writeUInt16BE(length, 1); return out;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") { const bytes = Buffer.from(value, "utf8"); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error("unsupported CBOR value");
}
const b64url = (buffer: Buffer) => buffer.toString("base64url");
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  readonly keys: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  counter = 0;
  constructor(readonly options: { origin?: string; rpId?: string; userVerified?: boolean } = {}) {}
  private flags(attested: boolean): number { return 0x01 | (this.options.userVerified === false ? 0 : 0x04) | (attested ? 0x40 : 0); }
  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.options.origin ?? ORIGIN, crossOrigin: false }));
  }
  register(challenge: string) {
    const jwk = this.keys.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const idLength = Buffer.alloc(2); idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([sha256(this.options.rpId ?? "localhost"), Buffer.from([this.flags(true)]), Buffer.alloc(4), Buffer.alloc(16), idLength, this.credentialId, cose]);
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64url(this.credentialId), rawId: b64url(this.credentialId), type: "public-key",
      response: { clientDataJSON: b64url(this.clientData("webauthn.create", challenge)), attestationObject: b64url(attestationObject), transports: ["internal"] },
      clientExtensionResults: {}, authenticatorAttachment: "platform",
    };
  }
  assert(challenge: string, credentialId: Buffer = this.credentialId) {
    this.counter += 1;
    const count = Buffer.alloc(4); count.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([sha256(this.options.rpId ?? "localhost"), Buffer.from([this.flags(false)]), count]);
    const clientDataJSON = this.clientData("webauthn.get", challenge);
    const signature = signData("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: b64url(credentialId), rawId: b64url(credentialId), type: "public-key",
      response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authenticatorData), signature: b64url(signature) },
      clientExtensionResults: {}, authenticatorAttachment: "platform",
    };
  }
}

async function registerPasskey(browser: Browser, authenticator: SoftAuthenticator, name = "Test key", secret?: Buffer) {
  await verifySensitive(browser, secret);
  const options = await browser.json<{ challenge: string; rp: { id: string } }>("/passkey/generate-register-options");
  expect(options.status).toBe(200);
  return browser.json<{ id?: string; code?: string }>("/passkey/verify-registration", { response: authenticator.register(options.body.challenge), name });
}

async function passkeySignIn(browser: Browser, authenticator: SoftAuthenticator, credentialId?: Buffer<ArrayBuffer>) {
  const options = await browser.json<{ challenge: string }>("/passkey/generate-authenticate-options");
  return browser.json<{ session?: unknown; code?: string }>("/passkey/verify-authentication", { response: authenticator.assert(options.body.challenge, credentialId) });
}

describe("passkeys", () => {
  it("registers with the configured RP, signs in as MFA-verified and records last use", async () => {
    const user = await createUser();
    const browser = new Browser();
    await signInPassword(browser, user.email);
    await verifySensitive(browser);
    const options = await browser.json<{ rp: { id: string }; authenticatorSelection: { userVerification: string } }>("/passkey/generate-register-options");
    expect(options.body.rp.id).toBe("localhost");
    expect(options.body.authenticatorSelection.userVerification).toBe("required");
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(browser, authenticator)).status).toBe(200);

    const fresh = new Browser();
    expect((await passkeySignIn(fresh, authenticator)).status).toBe(200);
    const session = await fresh.session();
    expect(session?.user.id).toBe(user.id);
    expect(session?.session.mfaVerified).toBe(true);
    const { rows } = await pool.query(`select "lastUsedAt" from passkey where "userId" = $1`, [user.id]);
    expect(rows[0].lastUsedAt).not.toBeNull();
  });

  it("satisfies MFA for a 2FA user without a TOTP challenge", async () => {
    const { user, browser, secret } = await enrolledUser();
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(browser, authenticator, "Test key", secret)).status).toBe(200);
    const fresh = new Browser();
    expect((await passkeySignIn(fresh, authenticator)).status).toBe(200);
    expect((await fresh.session())?.user.id).toBe(user.id);
  });

  it("rejects an assertion from another origin or for another RP ID", async () => {
    const user = await createUser();
    const browser = new Browser();
    await signInPassword(browser, user.email);
    const authenticator = new SoftAuthenticator();
    await registerPasskey(browser, authenticator);

    const phishing = new SoftAuthenticator({ origin: "https://docslurp.evil.example" });
    Object.assign(phishing, { credentialId: authenticator.credentialId, keys: authenticator.keys });
    const wrongOrigin = new Browser("https://docslurp.evil.example");
    expect((await passkeySignIn(wrongOrigin, phishing)).status).not.toBe(200);
    expect(await wrongOrigin.session()).toBeNull();

    const otherRp = new SoftAuthenticator({ rpId: "evil.example" });
    Object.assign(otherRp, { credentialId: authenticator.credentialId, keys: authenticator.keys });
    const wrongRp = new Browser();
    expect((await passkeySignIn(wrongRp, otherRp)).status).not.toBe(200);
    expect(await wrongRp.session()).toBeNull();
  });

  it("rejects another user's credential ID signed with the attacker's key", async () => {
    const victim = await createUser();
    const victimBrowser = new Browser();
    await signInPassword(victimBrowser, victim.email);
    const victimKey = new SoftAuthenticator();
    await registerPasskey(victimBrowser, victimKey);

    const attacker = await createUser();
    const attackerBrowser = new Browser();
    await signInPassword(attackerBrowser, attacker.email);
    const attackerKey = new SoftAuthenticator();
    await registerPasskey(attackerBrowser, attackerKey);

    const browser = new Browser();
    expect((await passkeySignIn(browser, attackerKey, victimKey.credentialId)).status).not.toBe(200);
    expect(await browser.session()).toBeNull();

    // Nor can the attacker register the victim's credential ID on their own account.
    const clone = new SoftAuthenticator();
    Object.assign(clone, { credentialId: victimKey.credentialId });
    expect((await registerPasskey(attackerBrowser, clone)).status).not.toBe(200);
    expect((await pool.query(`select "userId" from passkey where "credentialID" = $1`, [b64url(victimKey.credentialId)])).rows).toEqual([{ userId: victim.id }]);
  });

  it("refuses passkeys without user verification", async () => {
    const user = await createUser();
    const browser = new Browser();
    await signInPassword(browser, user.email);
    const result = await registerPasskey(browser, new SoftAuthenticator({ userVerified: false }));
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("PASSKEY_USER_VERIFICATION_REQUIRED");

    const authenticator = new SoftAuthenticator();
    await registerPasskey(browser, authenticator);
    authenticator.options.userVerified = false;
    const signIn = new Browser();
    expect((await passkeySignIn(signIn, authenticator)).status).toBe(403);
    expect(await signIn.session()).toBeNull();
  });

  it("needs re-auth to delete a passkey and an MFA session to add one once 2FA is on", async () => {
    const { user, browser, secret } = await enrolledUser();
    const authenticator = new SoftAuthenticator();
    await registerPasskey(browser, authenticator, "Test key", secret);
    const { rows: [key] } = await pool.query(`select id from passkey where "userId" = $1`, [user.id]);
    await pool.query(`update session set "sensitiveVerifiedAt" = now() - interval '1 hour' where "userId" = $1`, [user.id]);
    const stale = await browser.json<{ code?: string }>("/passkey/delete-passkey", { id: key.id });
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe("REAUTH_REQUIRED");
    // Renaming also changes the protected sign-in methods.
    expect((await browser.json("/passkey/update-passkey", { id: key.id, name: "Laptop" })).status).toBe(403);
    await verifySensitive(browser, secret);
    expect((await browser.json("/passkey/update-passkey", { id: key.id, name: "Laptop" })).status).toBe(200);
    expect((await browser.json("/passkey/delete-passkey", { id: key.id })).status).toBe(200);
  });

  it("cannot delete or rename another user's passkey", async () => {
    const owner = await createUser();
    const ownerBrowser = new Browser();
    await signInPassword(ownerBrowser, owner.email);
    await registerPasskey(ownerBrowser, new SoftAuthenticator());
    const { rows: [key] } = await pool.query(`select id from passkey where "userId" = $1`, [owner.id]);
    const other = await createUser();
    const otherBrowser = new Browser();
    await signInPassword(otherBrowser, other.email);
    await verifySensitive(otherBrowser);
    expect((await otherBrowser.json("/passkey/delete-passkey", { id: key.id })).status).not.toBe(200);
    expect((await otherBrowser.json("/passkey/update-passkey", { id: key.id, name: "mine" })).status).not.toBe(200);
    expect((await pool.query(`select name from passkey where id = $1`, [key.id])).rows[0].name).toBe("Test key");
  });

  it("can't sign in to, or be added to, an account whose domain enforces company SSO", async () => {
    const domain = `sso-${randomBytes(3).toString("hex")}.example`;
    const user = await createUser({ email: `person@${domain}` });
    const browser = new Browser();
    await signInPassword(browser, user.email);
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(browser, authenticator)).status).toBe(200);

    await pool.query(`insert into organizations(id, name, slug, created_by_user_id, sso_config) values ($1, 'SSO Co', $1, $2, $3)`,
      [`org-${domain}`, user.id, JSON.stringify({ enabled: true, enforceSso: true, emailDomain: domain, providerType: "oidc", metadataUrl: "https://idp.example/.well-known", clientId: "c" })]);
    await pool.query(`insert into sso_domains(org_id, domain, verification_token, verified_at) values ($1, $2, 'token', now())`, [`org-${domain}`, domain]);

    const signIn = new Browser();
    const result = await passkeySignIn(signIn, authenticator);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("SSO_REQUIRED");
    expect(await signIn.session()).toBeNull();
    const register = await browser.json<{ code?: string }>("/passkey/generate-register-options");
    expect(register.status).toBe(401);
    expect(register.body.code).toBe("UNAUTHORIZED");
  });
});

describe("org MFA policy", () => {
  async function orgWithMember(graceDays: number, sinceDaysAgo = 30) {
    const admin = await createUser();
    const member = await createUser();
    const orgId = `org-${randomBytes(4).toString("hex")}`;
    await pool.query(`insert into organizations(id, name, slug, created_by_user_id, require_mfa, require_mfa_since, mfa_grace_period_days)
      values ($1, 'Team', $1, $2, true, now() - make_interval(days => $4::int), $3)`, [orgId, admin.id, graceDays, sinceDaysAgo]);
    await pool.query(`insert into org_memberships(org_id, user_id, role, created_at) values ($1, $2, 'owner', now() - interval '30 days'), ($1, $3, 'member', now() - interval '30 days')`, [orgId, admin.id, member.id]);
    return { admin, member, orgId };
  }

  it("blocks a member's non-MFA session after the grace period, and allows it during", async () => {
    const lapsed = await orgWithMember(7);
    const browser = new Browser();
    await signInPassword(browser, lapsed.member.email);
    expect(await resolveBetterAuthSessionActor(browser.headers())).toBeNull();
    expect((await resolveBetterAuthSessionActor(browser.headers(), { allowMfaPolicyBlocked: true }))?.mfaPolicyBlocked).toBe(true);

    const fresh = await orgWithMember(7, 1);
    const inGrace = new Browser();
    await signInPassword(inGrace, fresh.member.email);
    const actor = await resolveBetterAuthSessionActor(inGrace.headers());
    expect(actor?.mfaPolicyBlocked).toBe(false);
  });

  it("lets a blocked member enrol, after which their verified session passes", async () => {
    const { member } = await orgWithMember(0);
    const browser = new Browser();
    await signInPassword(browser, member.email);
    await verifySensitive(browser);
    const enabled = await browser.json<{ totpURI: string }>("/two-factor/enable", { password: PASSWORD });
    expect(enabled.status).toBe(200);
    const secret = base32Decode(new URL(enabled.body.totpURI).searchParams.get("secret")!);
    expect((await browser.json("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
    const actor = await resolveBetterAuthSessionActor(browser.headers());
    expect(actor?.mfaVerified).toBe(true);
    expect(actor?.mfaPolicyBlocked).toBe(false);
  });

  it("does not let a policy-blocked password session add a passkey once the member has one", async () => {
    const { member } = await orgWithMember(0);
    const enrol = new Browser();
    await signInPassword(enrol, member.email);
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(enrol, authenticator)).status).toBe(200);
    // Someone with only the password signs in and tries to add their own passkey.
    const attacker = new Browser();
    await signInPassword(attacker, member.email);
    const attempt = await attacker.json<{ code?: string }>("/passkey/generate-register-options");
    expect(attempt.status).toBe(403);
    expect(attempt.body.code).toBe("MFA_REQUIRED");
  });

  it("keeps a blocked session away from account changes on /api/auth (council M1)", async () => {
    const { member } = await orgWithMember(0);
    const browser = new Browser();
    await signInPassword(browser, member.email);
    for (const [path, body] of [["/update-user", { name: "x" }], ["/change-email", { newEmail: "new@example.test" }], ["/change-password", { currentPassword: PASSWORD, newPassword: "another long password" }]] as const) {
      const result = await browser.json<{ code?: string }>(path, body);
      expect(result.status).toBe(403);
      expect(result.body.code).toBe("MFA_REQUIRED");
    }
    await verifySensitive(browser);
    expect((await browser.json("/two-factor/enable", { password: PASSWORD })).status).toBe(200);
    expect(await browser.session()).not.toBeNull();
  });

  it("applies one org's policy only to that org's members", async () => {
    await orgWithMember(0);
    const outsider = await createUser();
    const browser = new Browser();
    await signInPassword(browser, outsider.email);
    expect((await resolveBetterAuthSessionActor(browser.headers()))?.mfaPolicyBlocked).toBe(false);
  });

  it("answers 403 mfa_required on API routes except the security status", async () => {
    const { member } = await orgWithMember(0);
    const browser = new Browser();
    await signInPassword(browser, member.email);
    const { Hono } = await import("hono");
    const { sessionAuth } = await import("../middleware/session-auth.js");
    const app = new Hono().use("*", sessionAuth)
      .get("/v1/workspaces", (c) => c.json({ ok: true }))
      .get("/v1/account/security", (c) => c.json({ ok: true }));
    const workspaces = await app.request("http://localhost:4321/v1/workspaces", { headers: browser.headers() });
    expect(workspaces.status).toBe(403);
    expect((await workspaces.json()).error.code).toBe("mfa_required");
    expect((await app.request("http://localhost:4321/v1/account/security", { headers: browser.headers() })).status).toBe(200);
  });

  it("only lets an MFA-verified owner or admin change the policy", async () => {
    const { admin, member, orgId } = await orgWithMember(7);
    const { updateOrganizationMfaPolicy, OrganizationError } = await import("../services/organizations.js");
    await expect(updateOrganizationMfaPolicy(orgId, member.id, { requireMfa: false }, { mfaVerified: true })).rejects.toMatchObject({ code: "organization_forbidden" });
    await expect(updateOrganizationMfaPolicy(orgId, admin.id, { requireMfa: false }, { mfaVerified: false })).rejects.toBeInstanceOf(OrganizationError);
    const updated = await updateOrganizationMfaPolicy(orgId, admin.id, { requireMfa: true, gracePeriodDays: 3 }, { mfaVerified: true });
    expect(updated).toMatchObject({ requireMfa: true, gracePeriodDays: 3, members: 2 });
    await expect(updateOrganizationMfaPolicy(orgId, admin.id, { requireMfa: true, gracePeriodDays: 31 }, { mfaVerified: true })).rejects.toThrow();
  });
});

describe("separate credentials", () => {
  it("leaves API keys working for a 2FA user (they are not sessions)", async () => {
    const { user } = await enrolledUser();
    const orgId = `org-${randomBytes(4).toString("hex")}`;
    await pool.query(`insert into organizations(id, name, slug, created_by_user_id) values ($1, 'Keys', $1, $2)`, [orgId, user.id]);
    await pool.query(`insert into org_memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [orgId, user.id]);
    await pool.query(`update organizations set require_mfa = true, require_mfa_since = now() - interval '30 days', mfa_grace_period_days = 0 where id = $1`, [orgId]);
    const { resolveApiKeyActor } = await import("../lib/request-actor.js");
    const { createApiKey } = await import("../services/api-keys.js");
    const key = await createApiKey(user.id, "ci", { orgId }) as unknown as { key?: string; rawKey?: string; secret?: string };
    const raw = key.rawKey;
    expect(raw).toBeTruthy();
    const actor = await resolveApiKeyActor(`Bearer ${raw}`);
    expect(actor?.userId).toBe(user.id);
  });
});

describe("SSO second-factor issuance provenance", () => {
  async function setup() {
    const enrolled = await enrolledUser();
    // Give each case its own verified domain so enforced policy is unambiguous.
    const email = `${enrolled.user.id}@${enrolled.user.id}.sso.test`;
    await pool.query(`update "user" set email = $1 where id = $2`, [email, enrolled.user.id]);
    const orgId = `sso-${enrolled.user.id}`;
    const verifiedDomain = email.split("@")[1]!;
    await pool.query(`insert into organizations(id, name, slug, created_by_user_id, sso_config) values ($1, 'SSO MFA', $1, $2, $3)`,
      [orgId, enrolled.user.id, JSON.stringify({ enabled: true, enforceSso: true, emailDomain: verifiedDomain, providerType: "oidc" })]);
    await pool.query(`insert into sso_domains(org_id, domain, verification_token, verified_at) values ($1, $2, 'proof', now())`, [orgId, verifiedDomain]);
    return { ...enrolled, orgId };
  }
  async function challenge(userId: string, orgId?: string, maxAge = 600) {
    const { beginTwoFactorChallengeCookie } = await import("../lib/auth-mfa.js");
    const context = await auth.$context;
    const cookie = await beginTwoFactorChallengeCookie(context, userId, maxAge, orgId);
    const browser = new Browser();
    browser.store(new Response(null, { headers: { "set-cookie": cookie } }));
    return browser;
  }
  for (const method of ["totp", "backup-code"] as const) {
    it(`finishes enforced SSO via ${method} with org provenance and MFA assurance`, async () => {
      const { user, orgId, secret, backupCodes } = await setup();
      const browser = await challenge(user.id, orgId);
      const replay = new Browser(); replay.cookies = new Map(browser.cookies);
      const body = method === "totp" ? { code: totp(secret) } : { code: backupCodes[0] };
      expect((await browser.json(`/two-factor/verify-${method}`, body)).status).toBe(200);
      const session = await browser.session();
      expect(session?.session.mfaVerified).toBe(true);
      const row = (await pool.query(`select token from session where id = $1`, [session!.session.id])).rows[0];
      expect(row.token).toMatch(new RegExp(`^sso_${Buffer.from(orgId).toString("hex")}_`));
      expect((await replay.json(`/two-factor/verify-${method}`, body)).status).not.toBe(200);
    });
  }
  it("atomically consumes SSO provenance across concurrent valid backup codes", async () => {
    const { user, orgId, backupCodes } = await setup();
    const a = await challenge(user.id, orgId);
    const b = new Browser(); b.cookies = new Map(a.cookies);
    const responses = await Promise.all([
      a.json("/two-factor/verify-backup-code", { code: backupCodes[0] }),
      b.json("/two-factor/verify-backup-code", { code: backupCodes[1] }),
    ]);
    expect(responses.filter(result => result.status === 200)).toHaveLength(1);
  });
  it("refuses provenance belonging to another user", async () => {
    const { user, orgId, backupCodes } = await setup();
    const browser = await challenge(user.id, orgId);
    await pool.query(`update verification set value = $1 where identifier like 'sso-mfa-%' and value = $2`,
      [JSON.stringify({ userId: "another-user", orgId }), JSON.stringify({ userId: user.id, orgId })]);
    expect((await browser.json("/two-factor/verify-backup-code", { code: backupCodes[0] })).status).not.toBe(200);
    expect(await browser.session()).toBeNull();
  });
  it("refuses expired provenance even when the stock challenge is still valid", async () => {
    const { user, orgId, backupCodes } = await setup();
    const browser = await challenge(user.id, orgId);
    await pool.query(`update verification set "expiresAt" = now() - interval '1 second' where identifier like 'sso-mfa-%' and value = $1`, [JSON.stringify({ userId: user.id, orgId })]);
    expect((await browser.json("/two-factor/verify-backup-code", { code: backupCodes[0] })).status).not.toBe(200);
    expect(await browser.session()).toBeNull();
  });
  for (const kind of ["wrong-org", "expired", "nonSSO"] as const) {
    it(`refuses ${kind} challenge even with request-body org`, async () => {
      const { user, orgId, backupCodes } = await setup();
      const browser = await challenge(user.id, kind === "nonSSO" ? undefined : kind === "wrong-org" ? "other-org" : orgId, kind === "expired" ? -1 : 600);
      expect((await browser.json("/two-factor/verify-backup-code", { code: backupCodes[0], orgId })).status).not.toBe(200);
      expect(await browser.session()).toBeNull();
    });
  }
});

it("consumes a trusted device at most once during concurrent sign-ins", async () => {
  const { user, secret } = await enrolledUser();
  const browser = new Browser();
  await signInPassword(browser, user.email);
  expect((await browser.json("/two-factor/verify-totp", { code: totp(secret), trustDevice: true })).status).toBe(200);
  const a = new Browser(); const b = new Browser();
  a.cookies = new Map(browser.cookies); b.cookies = new Map(browser.cookies);
  a.cookies.delete("better-auth.session_token"); b.cookies.delete("better-auth.session_token");
  const results = await Promise.all([signInPassword(a, user.email), signInPassword(b, user.email)]);
  expect(results.filter(result => result.status === 200 && !result.body.twoFactorRedirect)).toHaveLength(1);
});

it("forwards refreshed cookies while applying MFA session policy options", async () => {
  const { browser } = await enrolledUser();
  const session = await browser.session();
  await pool.query(`update session set "updatedAt" = now() - interval '10 days', "expiresAt" = now() + interval '20 days' where id = $1`, [session!.session.id]);
  const refreshedHeaders = new Headers();
  const actor = await resolveBetterAuthSessionActor(browser.headers(), refreshedHeaders, { allowMfaPolicyBlocked: true });
  expect(actor?.sessionId).toBe(session!.session.id);
  expect(refreshedHeaders.getSetCookie().some(cookie => cookie.startsWith("better-auth.session_token="))).toBe(true);
});


it("reports explicit sensitive expiry separately from a young login", async () => {
  const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
  const session = await browser.session();
  const { Hono } = await import("hono");
  const { accountRoutes } = await import("../routes/account.js");
  const app = new Hono().use("*", async (c, next) => {
    c.set("requestActor", { type: "session", userId: user.id, sessionId: session!.session.id,
      user: { id: user.id, email: user.email, name: "Test" } });
    await next();
  }).route("/v1/account", accountRoutes);
  const snapshot = async () => (await (await app.request("/v1/account/security")).json());
  const status = async () => (await snapshot()).session;
  expect((await snapshot()).settings.reauthWindowSeconds).toBe(90);
  const young = await status();
  expect(young.authenticatedAt).toBeTruthy();
  expect(young.reauthUntil).toBeNull();
  await verifySensitive(browser);
  const proof = await browser.json<{ verifiedUntil: string }>("/sensitive-access");
  expect((await status()).reauthUntil).toBe(proof.body.verifiedUntil);
  await pool.query(`update session set "sensitiveVerifiedAt" = now() - interval '91 seconds' where id = $1`, [session!.session.id]);
  const expired = await status();
  expect(expired.authenticatedAt).toBe(young.authenticatedAt);
  expect(expired.reauthUntil).toBeNull();
  await verifySensitive(browser);
  expect((await status()).reauthUntil).toBeTruthy();
  const orgId = `status-policy-${randomBytes(4).toString("hex")}`;
  await pool.query(`insert into organizations(id, name, slug, created_by_user_id, require_mfa, require_mfa_since, mfa_grace_period_days)
    values($1, 'Status policy', $1, $2, true, now(), 0)`, [orgId, user.id]);
  await pool.query(`insert into org_memberships(org_id, user_id, role) values ($1, $2, 'member')`, [orgId, user.id]);
  expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
  expect((await status()).reauthUntil).toBeNull();
});

it("returns the authoritative remaining email send cooldown in the real response", async () => {
  const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
  expect((await browser.json("/sensitive-access/email-otp/send", {})).status).toBe(200);
  const session = await browser.session();
  await pool.query(`update session set "sensitiveEmailOTPSentAt" = now() - interval '40 seconds' where id = $1`, [session!.session.id]);
  const throttled = await browser.json("/sensitive-access/email-otp/send", {});
  expect(throttled.status).toBe(429);
  const delay = Number(throttled.response.headers.get("Retry-After"));
  expect(delay).toBeGreaterThanOrEqual(18);
  expect(delay).toBeLessThanOrEqual(20);
});
