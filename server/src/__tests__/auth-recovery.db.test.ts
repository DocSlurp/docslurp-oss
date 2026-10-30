import { createHash, createHmac, randomBytes } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase, serveOnRandomPort } from "@docslurp/worker/testing";

/**
 * Password recovery, breached-password rejection and shared authentication
 * budgets against the real Better Auth configuration (lib/better-auth.ts) and
 * a migrated Postgres. The breach check and per-recipient limits are on here,
 * as in production; HIBP and Resend are stubbed at `fetch`.
 */

const ORIGIN = "http://localhost:4321";
const SECRET = "recovery-test-secret-".padEnd(48, "x");
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a fresh and unbreached passphrase";
/** Stands in for any password in the breach corpus. */
const BREACHED = new Set(["password1234", "breached but long enough"]);

let pool: Pool;
let stop: () => Promise<void>;
let auth: typeof import("../lib/better-auth.js")["auth"];
let handleAuthRequest: typeof import("../lib/better-auth.js")["handleAuthRequest"];
let hashPassword: typeof import("better-auth/crypto")["hashPassword"];
const sentEmails: Array<{ to: string; subject: string; code: string | null }> = [];
let hibpMode: "live" | "error" | "hang" = "live";
const hibpRequests: string[] = [];
let hibpAborts = 0;
let resendDown = false;

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex").toUpperCase();
}

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
  vi.stubEnv("AUTH_BREACHED_PASSWORD_CHECK", "on");
  vi.stubEnv("AUTH_BREACHED_PASSWORD_TIMEOUT_MS", "500");
  vi.stubEnv("AUTH_EMAIL_RECIPIENT_LIMITS", "on");
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.startsWith("https://api.resend.com/")) {
      if (resendDown) return new Response("provider outage", { status: 503 });
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sentEmails.push({ to: body.to[0]!, subject: body.subject, code: /\n\n(\w+)\n\n/.exec(body.text)?.[1] ?? null });
      return Response.json({ id: "email" });
    }
    if (target.startsWith("https://api.pwnedpasswords.com/range/")) {
      hibpRequests.push(target);
      if (hibpMode === "hang") {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => { hibpAborts += 1; reject(init.signal!.reason); }));
      }
      if (hibpMode === "error") return new Response("unavailable", { status: 503 });
      const prefix = target.slice(-5);
      const lines = [...BREACHED].map(sha1).filter((hash) => hash.startsWith(prefix)).map((hash) => `${hash.slice(5)}:4242`);
      // Padding entries, as the real API returns with Add-Padding.
      lines.push(`${"0".repeat(34)}A:0`, `${"0".repeat(34)}B:0`);
      return new Response(lines.join("\r\n"), { headers: { "content-type": "text/plain" } });
    }
    return realFetch(input, init);
  });
  const { Pool } = await import("pg");
  pool = new Pool({ connectionString: url, max: 4 });
  (globalThis as { __docslurpAuthPool?: Pool }).__docslurpAuthPool = pool;
  ({ auth, handleAuthRequest } = await import("../lib/better-auth.js"));
  ({ hashPassword } = await import("better-auth/crypto"));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stop?.();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  sentEmails.length = 0;
  hibpRequests.length = 0;
  hibpMode = "live";
  hibpAborts = 0;
  resendDown = false;
  await pool.query(`delete from auth_rate_limits`);
});
afterEach(() => { vi.useRealTimers(); });

class Browser {
  cookies = new Map<string, string>();
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
  async json<T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<{ status: number; body: T; response: Response }> {
    // The production entry point: trusted client IP, uniform code refusals, safe errors.
    const response = await handleAuthRequest(new Request(`${ORIGIN}/api/auth${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { origin: ORIGIN, cookie: this.header(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    }));
    this.store(response);
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed as T, response };
  }
  async session(): Promise<{ session: { id: string }; user: { id: string } } | null> {
    return (await this.json<{ session: { id: string }; user: { id: string } } | null>("/get-session")).body;
  }
}

let userCounter = 0;
async function createUser(options: { password?: string | false; emailVerified?: boolean } = {}): Promise<{ id: string; email: string }> {
  userCounter += 1;
  const id = `recovery-${userCounter}-${randomBytes(3).toString("hex")}`;
  const email = `${id}@example.test`;
  await pool.query(`insert into "user"(id, name, email, "emailVerified") values ($1, $2, $3, $4)`, [id, id, email, options.emailVerified ?? true]);
  if (options.password !== false) {
    // Hash outside Better Auth's endpoint context: the native breach plugin only runs inside one.
    const hash = await hashPassword(options.password ?? PASSWORD);
    await pool.query(`insert into account(id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`, [`acct-${id}`, id, hash]);
  }
  return { id, email };
}

async function requestReset(browser: Browser, email: string) {
  return browser.json<{ success?: boolean; code?: string }>("/email-otp/request-password-reset", { email });
}

function lastCodeFor(email: string): string {
  const message = sentEmails.filter((sent) => sent.to === email).at(-1);
  expect(message, `no email sent to ${email}`).toBeDefined();
  return message!.code!;
}

describe("password recovery with native Email OTP", () => {
  it("resets with a purpose-labelled code, revokes every session and never signs in", async () => {
    const user = await createUser();
    const signedIn = new Browser();
    expect((await signedIn.json("/sign-in/email", { email: user.email, password: PASSWORD })).status).toBe(200);
    expect(await signedIn.session()).not.toBeNull();
    await pool.query(`insert into verification(id, identifier, value, "expiresAt") values ($1, $2, $3, now() + interval '1 day')`,
      [`trust-${user.id}`, `trust-device-${user.id}`, user.id]);

    const stranger = new Browser();
    expect((await requestReset(stranger, user.email)).status).toBe(200);
    const sent = sentEmails.at(-1)!;
    expect(sent.subject).toBe(`${sent.code} is your DocSlurp password reset code`);
    const reset = await stranger.json("/email-otp/reset-password", { email: user.email, otp: sent.code, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    // No session for whoever held the code, and every existing session ended.
    expect(stranger.cookies.size).toBe(0);
    expect(await signedIn.session()).toBeNull();
    expect((await pool.query(`select 1 from session where "userId" = $1`, [user.id])).rowCount).toBe(0);
    expect((await pool.query(`select 1 from verification where identifier = $1`, [`trust-device-${user.id}`])).rowCount).toBe(0);

    expect((await new Browser().json("/sign-in/email", { email: user.email, password: PASSWORD })).status).toBe(401);
    expect((await new Browser().json("/sign-in/email", { email: user.email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("keeps two-factor on: the next sign-in still stops at the second factor", async () => {
    const user = await createUser();
    await pool.query(`update "user" set "twoFactorEnabled" = true where id = $1`, [user.id]);
    const browser = new Browser();
    await requestReset(browser, user.email);
    expect((await browser.json("/email-otp/reset-password", { email: user.email, otp: lastCodeFor(user.email), password: NEW_PASSWORD })).status).toBe(200);

    const signIn = await browser.json<{ twoFactorRedirect?: boolean }>("/sign-in/email", { email: user.email, password: NEW_PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body.twoFactorRedirect).toBe(true);
    expect(await browser.session()).toBeNull();
    expect((await pool.query<{ enabled: boolean }>(`select "twoFactorEnabled" as enabled from "user" where id = $1`, [user.id])).rows[0]!.enabled).toBe(true);
  });

  it("refuses a replayed, wrong-account or expired code", async () => {
    const owner = await createUser();
    const other = await createUser();
    const browser = new Browser();
    await requestReset(browser, owner.email);
    const code = lastCodeFor(owner.email);

    // Another account's address with this code: refused, and the owner's code still works.
    expect((await browser.json("/email-otp/reset-password", { email: other.email, otp: code, password: NEW_PASSWORD })).status).toBe(400);
    expect((await browser.json("/email-otp/reset-password", { email: owner.email, otp: code, password: NEW_PASSWORD })).status).toBe(200);
    // Replay.
    expect((await browser.json("/email-otp/reset-password", { email: owner.email, otp: code, password: "another fresh passphrase" })).status).toBe(400);

    await requestReset(browser, other.email);
    const late = lastCodeFor(other.email);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 12 * 60 * 60_000 + 60_000);
    expect((await browser.json("/email-otp/reset-password", { email: other.email, otp: late, password: NEW_PASSWORD })).status).toBe(400);
    vi.useRealTimers();
    expect((await new Browser().json("/sign-in/email", { email: other.email, password: PASSWORD })).status).toBe(200);
  });

  it("keeps a code usable for hours and resends the same one, so a late email still works", async () => {
    const user = await createUser();
    const browser = new Browser();
    await requestReset(browser, user.email);
    await requestReset(browser, user.email);
    const codes = sentEmails.filter((sent) => sent.to === user.email).map((sent) => sent.code);
    expect(codes).toHaveLength(2);
    expect(codes[1]).toBe(codes[0]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60 * 60_000);
    expect((await browser.json("/email-otp/reset-password", { email: user.email, otp: codes[0], password: NEW_PASSWORD })).status).toBe(200);
  });

  it("never lets resends stretch a code past 12 hours from its first send", async () => {
    const user = await createUser();
    const browser = new Browser();
    const start = Date.now();
    await requestReset(browser, user.email);
    const expiry = async () => (await pool.query<{ expires: Date }>(`select "expiresAt" as expires from verification where identifier = $1`, [`forget-password-otp-${user.email}`])).rows[0]!.expires.getTime();
    const first = await expiry();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start + 6 * 60 * 60_000);
    await requestReset(browser, user.email);
    const codes = sentEmails.filter((sent) => sent.to === user.email).map((sent) => sent.code);
    expect(codes[1]).toBe(codes[0]);
    expect(await expiry()).toBe(first);
    vi.setSystemTime(start + 12 * 60 * 60_000 + 60_000);
    expect((await browser.json("/email-otp/reset-password", { email: user.email, otp: codes[0], password: NEW_PASSWORD })).status).toBe(400);
  });

  it("answers an unknown address like a known one and sends nothing", async () => {
    const response = await requestReset(new Browser(), `nobody-${randomBytes(3).toString("hex")}@example.test`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(sentEmails).toHaveLength(0);
  });

  it("lets a passwordless account set its first password", async () => {
    const user = await createUser({ password: false });
    const browser = new Browser();
    await requestReset(browser, user.email);
    expect((await browser.json("/email-otp/reset-password", { email: user.email, otp: lastCodeFor(user.email), password: NEW_PASSWORD })).status).toBe(200);
    expect((await new Browser().json("/sign-in/email", { email: user.email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("refuses recovery for an SSO-enforced domain before any code is sent", async () => {
    const domain = `enforced-${randomBytes(3).toString("hex")}.test`;
    const owner = `owner-${domain}`;
    await pool.query(`insert into "user"(id, name, email, "emailVerified") values ($1, $1, $2, true)`, [owner, `owner@${domain}`]);
    await pool.query(`insert into organizations (id, name, slug, created_by_user_id, sso_config) values ($1, $1, $1, $2, $3)`,
      [`org-${domain}`, owner, JSON.stringify({ enabled: true, enforceSso: true, emailDomain: domain })]);
    await pool.query(`insert into sso_domains (org_id, domain, verification_token, verified_at) values ($1, $2, 'test', now())`, [`org-${domain}`, domain]);
    for (const email of [`owner@${domain}`, `nobody@${domain}`]) {
      const response = await requestReset(new Browser(), email);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("SSO_REQUIRED");
    }
    expect(sentEmails).toHaveLength(0);
  });

  it("replaces a squatter's password on a pre-registered account, the only access it could hold", async () => {
    const squatted = await createUser({ password: "the squatters password", emailVerified: false });
    // Unverified: the squatter can't get a session, so nothing else can be attached.
    const squatter = new Browser();
    expect((await squatter.json("/sign-in/email", { email: squatted.email, password: "the squatters password" })).status).toBe(403);
    expect([...squatter.cookies.keys()].some((name) => name.includes("session_token"))).toBe(false);
    expect((await pool.query(`select 1 from session where "userId" = $1`, [squatted.id])).rowCount).toBe(0);
    const owner = new Browser();
    await requestReset(owner, squatted.email);
    expect((await owner.json("/email-otp/reset-password", { email: squatted.email, otp: lastCodeFor(squatted.email), password: NEW_PASSWORD })).status).toBe(200);
    expect((await pool.query<{ verified: boolean }>(`select "emailVerified" as verified from "user" where id = $1`, [squatted.id])).rows[0]!.verified).toBe(true);
    expect((await new Browser().json("/sign-in/email", { email: squatted.email, password: "the squatters password" })).status).toBe(401);
    expect((await new Browser().json("/sign-in/email", { email: squatted.email, password: NEW_PASSWORD })).status).toBe(200);
    const providers = (await pool.query<{ provider: string }>(`select "providerId" as provider from account where "userId" = $1`, [squatted.id])).rows.map((row) => row.provider);
    expect(providers).toEqual(["credential"]);
  });

  it("won't let the owner verify an address someone else signed up with; they take it over by reset instead", async () => {
    const email = `squatted-${randomBytes(3).toString("hex")}@example.test`;
    const attacker = new Browser();
    expect((await attacker.json("/sign-up/email", { name: "Squatter", email, password: "the squatters password" })).status).toBe(200);
    const code = lastCodeFor(email);
    // The owner follows a crafted link that opens on "enter the code we emailed you".
    const owner = new Browser();
    const refused = await owner.json<{ code?: string }>("/email-otp/verify-email", { email, otp: code });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("VERIFY_WITH_PASSWORD");
    expect((await pool.query<{ verified: boolean }>(`select "emailVerified" as verified from "user" where email = $1`, [email])).rows[0]!.verified).toBe(false);
    expect((await attacker.json("/sign-in/email", { email, password: "the squatters password" })).status).toBe(403);
    await requestReset(owner, email);
    expect((await owner.json("/email-otp/reset-password", { email, otp: lastCodeFor(email), password: NEW_PASSWORD })).status).toBe(200);
    expect((await new Browser().json("/sign-in/email", { email, password: "the squatters password" })).status).toBe(401);
    expect((await new Browser().json("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("verifies in the browser that signed up, or after a correct-password sign-in anywhere", async () => {
    const email = `owner-${randomBytes(3).toString("hex")}@example.test`;
    const signup = new Browser();
    expect((await signup.json("/sign-up/email", { name: "Owner", email, password: NEW_PASSWORD })).status).toBe(200);
    const elsewhere = new Browser();
    expect((await elsewhere.json<{ code?: string }>("/sign-in/email", { email, password: NEW_PASSWORD })).body.code).toBe("EMAIL_NOT_VERIFIED");
    expect((await elsewhere.json("/email-otp/verify-email", { email, otp: lastCodeFor(email) })).status).toBe(200);
    expect(await elsewhere.session()).not.toBeNull();

    const second = `owner-${randomBytes(3).toString("hex")}@example.test`;
    const sameBrowser = new Browser();
    await sameBrowser.json("/sign-up/email", { name: "Owner", email: second, password: NEW_PASSWORD });
    // A binding for one address doesn't verify another.
    expect((await sameBrowser.json("/email-otp/verify-email", { email: email.replace("owner-", "other-"), otp: "000000" })).status).toBe(403);
    expect((await sameBrowser.json("/email-otp/verify-email", { email: second, otp: lastCodeFor(second) })).status).toBe(200);
  });

  it("refuses verification without a binding the same way for every address", async () => {
    const known = (await createUser({ emailVerified: false })).email;
    const unknown = `nobody-${randomBytes(3).toString("hex")}@example.test`;
    const answers = await Promise.all([known, unknown].map(async (email) => {
      const response = await new Browser().json<{ code?: string }>("/email-otp/verify-email", { email, otp: "123456" });
      return `${response.status}:${response.body.code}`;
    }));
    expect(answers).toEqual(["403:VERIFY_WITH_PASSWORD", "403:VERIFY_WITH_PASSWORD"]);
  });

  it("ends a password-issued session at its next use once the password changes, however late it was issued", async () => {
    const user = await createUser();
    const browser = new Browser();
    expect((await browser.json("/sign-in/email", { email: user.email, password: PASSWORD })).status).toBe(200);
    const { rows } = await pool.query<{ fingerprint: string | null; token: string }>(`select "credentialFingerprint" as fingerprint, token from session where "userId" = $1`, [user.id]);
    const oldHash = (await pool.query<{ password: string }>(`select password from account where "userId" = $1 and "providerId" = 'credential'`, [user.id])).rows[0]!.password;
    const { credentialFingerprint } = await import("../lib/auth-credential-binding.js");
    expect(rows[0]!.fingerprint).toBe(credentialFingerprint(oldHash));

    await requestReset(new Browser(), user.email);
    expect((await new Browser().json("/email-otp/reset-password", { email: user.email, otp: lastCodeFor(user.email), password: NEW_PASSWORD })).status).toBe(200);
    // A sign-in that proved the old password and inserted its session after the reset committed.
    const late = await (await auth.$context).internalAdapter.createSession(user.id);
    await pool.query(`update session set "credentialFingerprint" = $2 where token = $1`, [late.token, credentialFingerprint(oldHash)]);
    const straggler = new Browser();
    straggler.cookies.set("better-auth.session_token", encodeURIComponent(`${late.token}.${createHmac("sha256", SECRET).update(late.token).digest("base64")}`));
    expect(await straggler.session()).toBeNull();
    expect((await pool.query(`select 1 from session where token = $1`, [late.token])).rowCount).toBe(0);
    // A session from the new password is unaffected.
    const fresh = new Browser();
    expect((await fresh.json("/sign-in/email", { email: user.email, password: NEW_PASSWORD })).status).toBe(200);
    expect(await fresh.session()).not.toBeNull();
  });

  it("carries the sessions a password change keeps over to the new password", async () => {
    // Signing out other devices (revokeOtherSessions) creates a session inside Better Auth's
    // transaction, which the single-backend test database can't serve alongside the pool.
    const user = await createUser();
    const [current, other] = [new Browser(), new Browser()];
    for (const browser of [current, other]) expect((await browser.json("/sign-in/email", { email: user.email, password: PASSWORD })).status).toBe(200);
    expect((await current.json("/sensitive-access/password", { password: PASSWORD })).status).toBe(200);
    expect((await current.json("/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false })).status).toBe(200);
    expect(await current.session()).not.toBeNull();
    expect(await other.session()).not.toBeNull();
    const newHash = (await pool.query<{ password: string }>(`select password from account where "userId" = $1 and "providerId" = 'credential'`, [user.id])).rows[0]!.password;
    const { credentialFingerprint } = await import("../lib/auth-credential-binding.js");
    const fingerprints = (await pool.query<{ fingerprint: string }>(`select "credentialFingerprint" as fingerprint from session where "userId" = $1`, [user.id])).rows.map((row) => row.fingerprint);
    expect(fingerprints).toEqual([credentialFingerprint(newHash), credentialFingerprint(newHash)]);
  });

  it("keeps the configuration that lets an unverified account hold nothing but its password", async () => {
    // auth-recovery.ts relies on each of these; if one changes, a reset needs ownership cleanup again.
    const { options } = await auth.$context;
    const { beforeOAuthAccountCreate } = await import("../lib/oauth-account-linking.js");
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(options.account?.accountLinking?.trustedProviders ?? []).toEqual([]);
    expect(options.databaseHooks?.account?.create?.before).toBe(beforeOAuthAccountCreate);
    const plugins = (options.plugins ?? []).map((plugin) => plugin.id);
    expect(plugins).toEqual(expect.arrayContaining(["email-otp", "magic-link"]));
    // Emailed codes: 12 hours, recoverable so a resend reuses them, capped at the first send.
    const emailOtp = (options.plugins ?? []).find((plugin) => plugin.id === "email-otp") as { options?: Record<string, unknown> } | undefined;
    const { EMAIL_CODE_SECONDS } = await import("../lib/auth-email.js");
    expect(emailOtp?.options).toMatchObject({ expiresIn: EMAIL_CODE_SECONDS, storeOTP: "encrypted", resendStrategy: "reuse", allowedAttempts: 5 });
    expect(EMAIL_CODE_SECONDS).toBeGreaterThanOrEqual(12 * 60 * 60);
    expect(plugins).toContain("docslurp-email-code-expiry");
    expect(plugins.filter((id) => ["admin", "anonymous", "username", "phone-number", "one-tap", "generic-oauth"].includes(id))).toEqual([]);
  });

  it("clears the reset account's trusted devices, not those of whoever is signed in", async () => {
    const caller = await createUser();
    const target = await createUser();
    for (const user of [caller, target]) {
      await pool.query(`insert into verification(id, identifier, value, "expiresAt") values ($1, $1, $2, now() + interval '1 day')`, [`trust-device-${user.id}`, user.id]);
    }
    const browser = new Browser();
    expect((await browser.json("/sign-in/email", { email: caller.email, password: PASSWORD })).status).toBe(200);
    await requestReset(browser, target.email);
    expect((await browser.json("/email-otp/reset-password", { email: target.email, otp: lastCodeFor(target.email), password: NEW_PASSWORD })).status).toBe(200);
    const left = async (userId: string) => (await pool.query(`select 1 from verification where identifier = $1`, [`trust-device-${userId}`])).rowCount;
    expect(await left(target.id)).toBe(0);
    expect(await left(caller.id)).toBe(1);
  });

  it("answers wrong codes for registered and unregistered addresses alike", async () => {
    const known = await createUser();
    const unknown = `nobody-${randomBytes(3).toString("hex")}@example.test`;
    const guesses = async (email: string) => {
      await requestReset(new Browser(), email);
      const real = sentEmails.filter((sent) => sent.to === email).at(-1)?.code;
      const wrong = real === "000000" ? "111111" : "000000";
      const answers: string[] = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await new Browser().json<{ code?: string }>("/email-otp/reset-password", { email, otp: wrong, password: NEW_PASSWORD });
        answers.push(`${response.status}:${response.body.code}`);
      }
      return answers;
    };
    const knownAnswers = await guesses(known.email);
    expect(knownAnswers).toEqual(Array(7).fill("400:INVALID_OTP"));
    expect(await guesses(unknown)).toEqual(knownAnswers);
  });

  it("keeps a verified account's other sign-in methods through a reset", async () => {
    const user = await createUser();
    await pool.query(`insert into account(id, "accountId", "providerId", "userId") values ($1, $2, 'google', $3)`, [`google-${user.id}`, `google-${user.id}`, user.id]);
    const browser = new Browser();
    await requestReset(browser, user.email);
    expect((await browser.json("/email-otp/reset-password", { email: user.email, otp: lastCodeFor(user.email), password: NEW_PASSWORD })).status).toBe(200);
    const providers = (await pool.query<{ provider: string }>(`select "providerId" as provider from account where "userId" = $1 order by 1`, [user.id])).rows.map((row) => row.provider);
    expect(providers).toEqual(["credential", "google"]);
  });

  it("bounds code guesses per address even when they race", async () => {
    const user = await createUser();
    const browser = new Browser();
    await requestReset(browser, user.email);
    const code = lastCodeFor(user.email);
    const wrong = code === "000000" ? "111111" : "000000";
    const statuses = await Promise.all(Array.from({ length: 30 }, () =>
      new Browser().json<{ code?: string }>("/email-otp/reset-password", { email: user.email, otp: wrong, password: NEW_PASSWORD }).then((result) => result.status)));
    expect(statuses.filter((status) => status !== 429).length).toBeLessThanOrEqual(10);
    const limited = await browser.json<{ code?: string }>("/email-otp/reset-password", { email: user.email, otp: code, password: NEW_PASSWORD });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("CODE_ATTEMPTS_LIMITED");
    expect((await new Browser().json("/sign-in/email", { email: user.email, password: PASSWORD })).status).toBe(200);
  });

  it("serves exactly one recovery path", async () => {
    const browser = new Browser();
    for (const path of ["/forget-password/email-otp", "/request-password-reset", "/reset-password", "/email-otp/check-verification-otp"]) {
      expect((await browser.json(path, { email: "anyone@example.test", newPassword: NEW_PASSWORD, token: "x" })).status, path).toBe(404);
    }
  });
});

describe("breached-password rejection", () => {
  it("rejects a breached password at reset and leaves the code usable", async () => {
    const user = await createUser();
    const browser = new Browser();
    await requestReset(browser, user.email);
    const code = lastCodeFor(user.email);
    const refused = await browser.json<{ code?: string }>("/email-otp/reset-password", { email: user.email, otp: code, password: "breached but long enough" });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("PASSWORD_COMPROMISED");
    // Only a five-character SHA-1 prefix leaves the server.
    expect(hibpRequests.every((url) => /\/range\/[0-9A-F]{5}$/.test(url))).toBe(true);
    expect((await browser.json("/email-otp/reset-password", { email: user.email, otp: code, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("rejects a breached password at sign-up without creating the account", async () => {
    const email = `signup-${randomBytes(3).toString("hex")}@example.test`;
    const refused = await new Browser().json<{ code?: string }>("/sign-up/email", { name: "New", email, password: "breached but long enough" });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("PASSWORD_COMPROMISED");
    expect((await pool.query(`select 1 from "user" where email = $1`, [email])).rowCount).toBe(0);
    expect((await new Browser().json("/sign-up/email", { name: "New", email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("rejects a breached password at change-password", async () => {
    const user = await createUser();
    const browser = new Browser();
    expect((await browser.json("/sign-in/email", { email: user.email, password: PASSWORD })).status).toBe(200);
    expect((await browser.json("/sensitive-access/password", { password: PASSWORD })).status).toBe(200);
    const refused = await browser.json<{ code?: string }>("/change-password", { currentPassword: PASSWORD, newPassword: "breached but long enough" });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("PASSWORD_COMPROMISED");
  });

  it("never consults the breach service on sign-in", async () => {
    const user = await createUser({ password: "password1234" });
    expect((await new Browser().json("/sign-in/email", { email: user.email, password: "password1234" })).status).toBe(200);
    expect((await new Browser().json("/sign-in/email", { email: `missing-${user.email}`, password: "password1234" })).status).toBe(401);
    expect(hibpRequests).toHaveLength(0);
  });

  it.each(["error", "hang"] as const)("fails closed with a retryable 503 when the lookup %s, keeping the code", async (mode) => {
    const user = await createUser();
    const browser = new Browser();
    await requestReset(browser, user.email);
    const code = lastCodeFor(user.email);
    hibpMode = mode;
    const refused = await browser.json<{ code?: string }>("/email-otp/reset-password", { email: user.email, otp: code, password: NEW_PASSWORD });
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe("PASSWORD_CHECK_UNAVAILABLE");
    expect(refused.response.headers.get("retry-after")).toBe("60");
    // A hung lookup is cancelled, not abandoned.
    expect(hibpAborts).toBe(mode === "hang" ? 1 : 0);
    // Nothing changed: the old password still works and the code survives the outage.
    expect((await new Browser().json("/sign-in/email", { email: user.email, password: PASSWORD })).status).toBe(200);
    hibpMode = "live";
    expect((await browser.json("/email-otp/reset-password", { email: user.email, otp: code, password: NEW_PASSWORD })).status).toBe(200);
  });
});

describe("per-recipient email limits", () => {
  it("caps sends to one address across endpoints, whether or not it has an account", async () => {
    const known = (await createUser()).email;
    const unknown = `unknown-${randomBytes(3).toString("hex")}@example.test`;
    for (const email of [known, unknown]) {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) statuses.push((await requestReset(new Browser(), attempt === 1 ? ` ${email.toUpperCase()} ` : email)).status);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        statuses.push((await new Browser().json("/email-otp/send-verification-otp", { email, type: "sign-in" })).status);
      }
      const limited = await requestReset(new Browser(), email);
      expect(statuses, email).toEqual([200, 200, 200, 200, 200]);
      expect(limited.status, email).toBe(429);
      expect(limited.body.code).toBe("EMAIL_RATE_LIMITED");
      expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    // Another address is unaffected, and the table never holds an address.
    expect((await requestReset(new Browser(), `other-${randomBytes(3).toString("hex")}@example.test`)).status).toBe(200);
    const keys = (await pool.query<{ key: string }>(`select key from auth_rate_limits`)).rows.map((row) => row.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((key) => key.includes("@") || key.includes(known.split("@")[0]!))).toBe(false);
  });

  it("shares one budget across sign-up, magic links and verification resends", async () => {
    const email = `paths-${randomBytes(3).toString("hex")}@example.test`;
    const statuses = [
      (await new Browser().json("/sign-up/email", { name: "New", email, password: NEW_PASSWORD })).status,
      (await new Browser().json("/sign-in/magic-link", { email })).status,
      (await new Browser().json("/send-verification-email", { email })).status,
      (await new Browser().json("/email-otp/send-verification-otp", { email, type: "email-verification" })).status,
      (await new Browser().json("/sign-in/magic-link", { email })).status,
    ];
    expect(statuses.every((status) => status !== 429), JSON.stringify(statuses)).toBe(true);
    const limited = await new Browser().json<{ code?: string }>("/sign-in/magic-link", { email });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("EMAIL_RATE_LIMITED");
  });

  it("never limits password sign-in per address, nor lets it spend the email budget", async () => {
    const user = await createUser();
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await new Browser().json<{ code?: string }>("/sign-in/email", { email: user.email, password: "wrong password here" });
      expect(response.status).toBe(401);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await requestReset(new Browser(), user.email)).status).toBe(200);
  });

  it("gives refused sign-ups their unit back", async () => {
    const email = `refused-${randomBytes(3).toString("hex")}@example.test`;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await new Browser().json("/sign-up/email", { name: "New", email, password: "breached but long enough" })).status).toBe(400);
    }
    expect((await new Browser().json("/sign-up/email", { name: "New", email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("fails closed, sending nothing, when the budget table is unavailable", async () => {
    const user = await createUser();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await pool.query(`alter table auth_rate_limits rename to auth_rate_limits_unavailable`);
    try {
      expect((await requestReset(new Browser(), user.email)).status).toBeGreaterThanOrEqual(500);
      expect((await new Browser().json("/email-otp/reset-password", { email: user.email, otp: "123456", password: NEW_PASSWORD })).status).toBeGreaterThanOrEqual(500);
    } finally {
      await pool.query(`alter table auth_rate_limits_unavailable rename to auth_rate_limits`);
      vi.mocked(console.error).mockRestore();
    }
    expect(sentEmails).toHaveLength(0);
    expect((await new Browser().json("/sign-in/email", { email: user.email, password: PASSWORD })).status).toBe(200);
  });

  it("counts verification mail re-sent by password sign-in without failing the sign-in", async () => {
    const user = await createUser({ emailVerified: false });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) statuses.push((await new Browser().json("/sign-in/email", { email: user.email, password: PASSWORD })).status);
    expect(statuses).toEqual(Array(7).fill(403));
    expect(sentEmails.filter((sent) => sent.to === user.email)).toHaveLength(5);
  });

  it("gives the budget back when delivery fails, so an email outage locks nobody out", async () => {
    const user = await createUser();
    resendDown = true;
    // Better Auth logs a failed Email OTP send and still answers 200 (it never
    // reveals delivery). Without the refund, the sixth request would be a 429.
    for (let attempt = 0; attempt < 6; attempt += 1) expect((await requestReset(new Browser(), user.email)).status).toBe(200);
    expect(sentEmails).toHaveLength(0);
    resendDown = false;
    expect((await requestReset(new Browser(), user.email)).status).toBe(200);
    expect(lastCodeFor(user.email)).toMatch(/^\d{6}$/);
  });
});

describe("shared authentication budgets", () => {
  it("admits exactly the budget under concurrency and restarts after the window", async () => {
    const { consumeAuthBudget } = await import("../lib/auth-rate-limits.js");
    const start = new Date();
    const at = (ms: number) => new Date(start.getTime() + ms);
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeAuthBudget(pool, "test:concurrency", { windowSeconds: 60, max: 5 }, start)));
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.find((result) => !result.allowed)!.retryAfterSeconds).toBe(60);
    expect((await pool.query<{ count: number }>(`select count from auth_rate_limits where key = 'test:concurrency'`)).rows[0]!.count).toBe(6);
    expect((await consumeAuthBudget(pool, "test:concurrency", { windowSeconds: 60, max: 5 }, at(30_000))).allowed).toBe(false);
    expect((await consumeAuthBudget(pool, "test:concurrency", { windowSeconds: 60, max: 5 }, at(60_000))).allowed).toBe(true);
  });

  it("refunds only the window a step was counted in, on the database clock", async () => {
    const { consumeAuthBudget, releaseAuthBudget } = await import("../lib/auth-rate-limits.js");
    const budget = { windowSeconds: 60, max: 1 };
    const stale = await consumeAuthBudget(pool, "test:refund", budget, new Date(Date.now() - 120_000));
    // A new window on the database clock (no explicit time).
    expect((await consumeAuthBudget(pool, "test:refund", budget)).allowed).toBe(true);
    await releaseAuthBudget(pool, "test:refund", stale.window);
    expect((await consumeAuthBudget(pool, "test:refund", budget)).allowed).toBe(false);
    const current = (await pool.query<{ window: string }>(`select (extract(epoch from window_started_at) * 1000000)::bigint::text as window from auth_rate_limits where key = 'test:refund'`)).rows[0]!.window;
    await releaseAuthBudget(pool, "test:refund", current);
    await releaseAuthBudget(pool, "test:refund", current);
    expect((await consumeAuthBudget(pool, "test:refund", budget)).allowed).toBe(true);
  });
});

describe("rate-limit coverage contract", () => {
  it("gives every DocSlurp-owned auth endpoint that accepts input an explicit limit", async () => {
    const context = await auth.$context;
    const customRules = context.options.rateLimit?.customRules ?? {};
    const uncovered: string[] = [];
    for (const plugin of context.options.plugins ?? []) {
      if (!plugin.id.startsWith("docslurp-")) continue;
      for (const endpoint of Object.values(plugin.endpoints ?? {}) as Array<{ path: string; options: { method: string | string[]; metadata?: { SERVER_ONLY?: boolean } } }>) {
        const methods = [endpoint.options.method].flat();
        if (endpoint.options.metadata?.SERVER_ONLY || methods.every((method) => method === "GET")) continue;
        const covered = Object.hasOwn(customRules, endpoint.path) || (plugin.rateLimit ?? []).some((rule) => rule.pathMatcher(endpoint.path));
        if (!covered) uncovered.push(`${plugin.id} ${endpoint.path}`);
      }
    }
    expect(uncovered).toEqual([]);
  });
});
