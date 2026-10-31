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

beforeEach(() => { sentEmails.length = 0; });
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

async function registerPasskey(browser: Browser, authenticator: SoftAuthenticator, name = "Test key") {
  const options = await browser.json<{ challenge: string; rp: { id: string } }>("/passkey/generate-register-options");
  expect(options.status).toBe(200);
  return browser.json<{ id?: string; code?: string }>("/passkey/verify-registration", { response: authenticator.register(options.body.challenge), name });
}

async function passkeySignIn(browser: Browser, authenticator: SoftAuthenticator, credentialId?: Buffer<ArrayBuffer>) {
  const options = await browser.json<{ challenge: string }>("/passkey/generate-authenticate-options");
  return browser.json<{ session?: unknown; code?: string }>("/passkey/verify-authentication", { response: authenticator.assert(options.body.challenge, credentialId) });
}


describe("explicit sensitive account proof", () => {
  it("does not trust a new sign-in, wrong password, another user/session, or a revoked session", async () => {
    const user = await createUser();
    const browser = new Browser();
    await signInPassword(browser, user.email);
    const original = (await browser.session())!;
    expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
    expect((await browser.json("/sensitive-access/password", { password: "wrong" })).status).toBe(401);
    expect((await browser.json("/change-email", { newEmail: "other@example.test" })).status).toBe(403);
    const verified = await browser.json<{ verifiedUntil: string; windowSeconds: number }>("/sensitive-access/password", { password: PASSWORD });
    expect(verified.status).toBe(200);
    expect(verified.body.windowSeconds).toBe(600);
    expect(Date.parse(verified.body.verifiedUntil)).toBeGreaterThan(Date.now());
    expect((await browser.session())!.session.id).toBe(original.session.id);
    const { hasSensitiveAccess } = await import("../lib/auth-sensitive-access.js");
    expect(await hasSensitiveAccess(pool, "another-user", original.session.id)).toBe(false);
    const other = new Browser();
    await signInPassword(other, user.email);
    expect((await other.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
    await pool.query(`delete from session where id = $1`, [original.session.id]);
    expect(await hasSensitiveAccess(pool, user.id, original.session.id)).toBe(false);
    expect((await browser.json("/sensitive-access")).status).toBe(401);
  });

  it("rejects every sensitive auth path without a grant, including newly created sessions", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    const paths = ["/change-email", "/change-password", "/set-password", "/delete-user", "/link-social", "/unlink-account",
      "/two-factor/enable", "/two-factor/disable", "/two-factor/get-totp-uri", "/two-factor/generate-backup-codes",
      "/passkey/generate-register-options", "/passkey/verify-registration", "/passkey/update-passkey", "/passkey/delete-passkey",
      "/revoke-session", "/revoke-sessions", "/revoke-other-sessions"];
    for (const path of paths) {
      const result = path.endsWith("generate-register-options") ? await browser.json(path) : await browser.json(path, {});
      // Better Auth keeps set-password server-only; it has no HTTP route.
      if (path === "/set-password") { expect(result.status).toBe(404); continue; }
      expect(result.status, path).toBe(403);
      expect(result.body, path).toMatchObject({ code: "REAUTH_REQUIRED" });
    }
  });

  it("allows old-session enrollment after proof without changing the shared native freshness config", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    const other = new Browser(); await signInPassword(other, user.email);
    const first = (await browser.session())!; const second = (await other.session())!;
    await pool.query(`update session set "createdAt" = now() - interval '2 hours' where "userId" = $1`, [user.id]);
    expect((await browser.json("/sensitive-access/password", { password: PASSWORD })).status).toBe(200);
    const [registered, unrelated] = await Promise.all([
      registerPasskey(browser, new SoftAuthenticator()), other.json("/passkey/generate-register-options"),
    ]);
    expect(registered.status).toBe(200);
    expect(unrelated.status).toBe(403);
    expect((await browser.session())!.session.id).toBe(first.session.id);
    expect((await other.session())!.session.id).toBe(second.session.id);
    expect((await auth.$context).sessionConfig.freshAge).toBe(3600);
  });

  it("refresh does not extend the fixed window, and session rotation does not inherit it", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    await browser.json("/sensitive-access/password", { password: PASSWORD });
    const original = (await browser.session())!;
    const before = (await browser.json<{ verifiedUntil: string }>("/sensitive-access")).body.verifiedUntil;
    await pool.query(`update session set "updatedAt" = now() - interval '2 days' where id = $1`, [original.session.id]);
    await browser.session();
    expect((await browser.json<{ verifiedUntil: string }>("/sensitive-access")).body.verifiedUntil).toBe(before);
    const rotated = await (await auth.$context).internalAdapter.createSession(user.id);
    const { hasSensitiveAccess } = await import("../lib/auth-sensitive-access.js");
    expect(await hasSensitiveAccess(pool, user.id, rotated!.id)).toBe(false);
    await pool.query(`update session set "sensitiveVerifiedAt" = now() - interval '11 minutes' where id = $1`, [original.session.id]);
    expect(await hasSensitiveAccess(pool, user.id, original.session.id)).toBe(false);
  });

  it("requires a fresh first factor and TOTP together, consumes pending proof, and preserves the session", async () => {
    const { user, browser, secret } = await enrolledUser();
    const original = (await browser.session())!;
    // Enrollment rotated the session; neither its new creation nor MFA mark grants access.
    expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
    expect((await browser.json("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
    expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
    const first = await browser.json<{ requiresTotp: boolean }>("/sensitive-access/password", { password: PASSWORD });
    expect(first.body.requiresTotp).toBe(true);
    // Free only this fixture's consumed code so the same time-step can exercise a second complete ceremony.
    await pool.query(`delete from mfa_totp_replay where user_id = $1`, [user.id]);
    expect((await browser.json("/two-factor/verify-totp", { code: wrongCode(secret) })).status).toBe(401);
    expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
    expect((await browser.json("/two-factor/verify-totp", { code: totp(secret), trustDevice: false })).status).toBe(200);
    expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).not.toBeNull();
    expect((await browser.session())!.session.id).toBe(original.session.id);
    expect((await pool.query(`select "sensitiveFirstFactorAt" from session where id = $1`, [original.session.id])).rows[0].sensitiveFirstFactorAt).toBeNull();
  });

  it("binds user-verified passkey challenges to one session and consumes them once", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    await browser.json("/sensitive-access/password", { password: PASSWORD });
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(browser, authenticator)).status).toBe(200);
    const original = (await browser.session())!;
    await pool.query(`update session set "sensitiveVerifiedAt" = null where id = $1`, [original.session.id]);
    const options = await browser.json<{ challenge: string; userVerification: string }>("/sensitive-access/passkey/options");
    expect(options.body.userVerification).toBe("required");
    const response = authenticator.assert(options.body.challenge);
    const proof = await browser.json("/sensitive-access/passkey/verify", { response });
    expect(proof.status).toBe(200);
    expect((await browser.session())!.session.id).toBe(original.session.id);
    expect((await browser.session())!.session.mfaVerified).toBe(true);
    expect((await browser.json("/sensitive-access/passkey/verify", { response })).status).toBe(403);
    const other = new Browser(); await signInPassword(other, user.email);
    const bound = await browser.json<{ challenge: string }>("/sensitive-access/passkey/options");
    expect((await other.json("/sensitive-access/passkey/verify", { response: authenticator.assert(bound.body.challenge) })).status).toBe(403);
    expect((await other.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
  });

  it("refuses missing UV, hostile origins, invalid signatures and oversized proof input", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    await browser.json("/sensitive-access/password", { password: PASSWORD });
    const authenticator = new SoftAuthenticator(); await registerPasskey(browser, authenticator);
    const options = await browser.json<{ challenge: string }>("/sensitive-access/passkey/options");
    authenticator.options.userVerified = false;
    expect((await browser.json("/sensitive-access/passkey/verify", { response: authenticator.assert(options.body.challenge) })).status).toBe(403);
    authenticator.options.userVerified = true;
    const signed = await browser.json<{ challenge: string }>("/sensitive-access/passkey/options");
    const broken = authenticator.assert(signed.body.challenge);
    broken.response.signature = Buffer.alloc(64).toString("base64url");
    expect((await browser.json("/sensitive-access/passkey/verify", { response: broken })).status).toBe(403);
    const hostile = new Browser("https://attacker.invalid"); hostile.cookies = new Map(browser.cookies);
    expect((await hostile.json("/sensitive-access/password", { password: PASSWORD })).status).toBe(403);
    const invalid = await browser.json<{ challenge: string }>("/sensitive-access/passkey/options");
    const response = authenticator.assert(invalid.body.challenge); response.response.clientDataJSON = "x".repeat(9000);
    expect((await browser.json("/sensitive-access/passkey/verify", { response })).status).toBe(400);
  });
});

describe("native fallback and database failures", () => {
  it("lets a verified old session revoke sessions while an unverified one cannot", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    await pool.query(`update session set "createdAt" = now() - interval '2 hours' where "userId" = $1`, [user.id]);
    expect((await browser.json("/revoke-sessions", {})).status).toBe(403);
    await browser.json("/sensitive-access/password", { password: PASSWORD });
    expect((await browser.json("/revoke-sessions", {})).status).toBe(200);
    expect((await auth.$context).sessionConfig.freshAge).toBe(3600);
  });

  it("propagates database failure instead of granting access", async () => {
    const { hasSensitiveAccess } = await import("../lib/auth-sensitive-access.js");
    const unavailable = { query: async () => { throw new Error("database unavailable"); } } as unknown as Pick<Pool, "query">;
    await expect(hasSensitiveAccess(unavailable, "user", "session")).rejects.toThrow("database unavailable");
  });
});

describe("required-MFA initial enrollment bootstrap", () => {
  async function requiredMfaUser() {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    await pool.query(`update organizations set require_mfa = true, require_mfa_since = now() - interval '1 day', mfa_grace_period_days = 0
      where id in (select org_id from org_memberships where user_id = $1)`, [user.id]);
    return { user, browser };
  }

  it("permits only initial enrollment after fresh first factor and removes allowance when a factor exists", async () => {
    const { user, browser } = await requiredMfaUser();
    const initial = await browser.json<{ enrollmentOnly: boolean; methods: string[] }>("/sensitive-access");
    expect(initial.status).toBe(200);
    expect(initial.body.enrollmentOnly).toBe(true);
    expect(initial.body.methods).toContain("password");
    expect((await browser.json("/passkey/generate-register-options")).status).toBe(403);
    const proof = await browser.json<{ verifiedUntil: string | null; enrollmentOnly: boolean; pendingMfa: boolean; requiresTotp: boolean }>("/sensitive-access/password", { password: PASSWORD });
    expect(proof.status).toBe(200);
    expect(proof.body).toMatchObject({ verifiedUntil: null, enrollmentOnly: true, pendingMfa: true, requiresTotp: false });
    for (const path of ["/change-email", "/change-password", "/two-factor/disable", "/two-factor/generate-backup-codes", "/passkey/delete-passkey", "/revoke-sessions"]) {
      expect((await browser.json(path, {})).status, path).toBe(403);
    }
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(browser, authenticator)).status).toBe(200);
    const after = await browser.json<{ verifiedUntil: string | null; enrollmentOnly: boolean }>("/sensitive-access");
    expect(after.body).toMatchObject({ verifiedUntil: null, enrollmentOnly: false });
    // A password-only caller cannot add another factor after one exists.
    expect((await browser.json("/passkey/generate-register-options")).status).toBe(403);
    const options = await browser.json<{ challenge: string }>("/sensitive-access/passkey/options");
    expect((await browser.json("/sensitive-access/passkey/verify", { response: authenticator.assert(options.body.challenge) })).status).toBe(200);
    const { hasSensitiveAccess } = await import("../lib/auth-sensitive-access.js");
    expect(await hasSensitiveAccess(pool, user.id, (await browser.session())!.session.id)).toBe(true);
  });

  it("expires first-factor allowance and cannot borrow it from another session", async () => {
    const { user, browser } = await requiredMfaUser();
    await browser.json("/sensitive-access/password", { password: PASSWORD });
    const session = (await browser.session())!;
    const { canBootstrapSensitiveEnrollment } = await import("../lib/auth-sensitive-access.js");
    expect(await canBootstrapSensitiveEnrollment(pool, "another-user", session.session.id)).toBe(false);
    await pool.query(`update session set "sensitiveFirstFactorAt" = now() - interval '6 minutes' where id = $1`, [session.session.id]);
    expect(await canBootstrapSensitiveEnrollment(pool, user.id, session.session.id)).toBe(false);
    expect((await browser.json("/passkey/generate-register-options")).status).toBe(403);
  });
});

describe("atomic email proof binding", () => {
  it("requires the expected verified email at the final grant or first-factor write", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    const session = (await browser.session())!;
    const { grantSensitiveAccess, recordSensitiveFirstFactorProof } = await import("../lib/auth-sensitive-access.js");
    expect(await grantSensitiveAccess(pool, user.id, session.session.id, { expectedVerifiedEmail: "another@example.test" })).toBe(false);
    expect(await recordSensitiveFirstFactorProof(pool, user.id, session.session.id, { expectedVerifiedEmail: "another@example.test" })).toBe(false);
    await pool.query(`update "user" set "emailVerified" = false where id = $1`, [user.id]);
    expect(await grantSensitiveAccess(pool, user.id, session.session.id, { expectedVerifiedEmail: user.email })).toBe(false);
    expect(await recordSensitiveFirstFactorProof(pool, user.id, session.session.id, { expectedVerifiedEmail: user.email })).toBe(false);
    expect((await pool.query(`select "sensitiveVerifiedAt", "sensitiveFirstFactorAt" from session where id = $1`, [session.session.id])).rows[0]).toEqual({ sensitiveVerifiedAt: null, sensitiveFirstFactorAt: null });
  });
});

describe("MFA policy races", () => {
  async function requireMfa(userId: string) {
    await pool.query(`update organizations set require_mfa = true where id in
      (select org_id from org_memberships where user_id = $1)`, [userId]);
  }

  it("rechecks policy after password verification and records only enrollment proof", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    const context = await auth.$context;
    const originalVerify = context.password.verify;
    const verification = vi.spyOn(context.password, "verify").mockImplementationOnce(async input => {
      const valid = await originalVerify(input);
      await requireMfa(user.id);
      return valid;
    });
    try {
      const response = await browser.json<{ verifiedUntil: string | null; pendingMfa: boolean; enrollmentOnly: boolean }>("/sensitive-access/password", { password: PASSWORD });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ verifiedUntil: null, pendingMfa: true, enrollmentOnly: true });
    } finally { verification.mockRestore(); }
  });

  it("refuses an atomic password-only grant under MFA policy and invalidates earlier weaker grants", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    const session = (await browser.session())!;
    const { grantSensitiveAccess, hasSensitiveAccess } = await import("../lib/auth-sensitive-access.js");
    expect(await grantSensitiveAccess(pool, user.id, session.session.id)).toBe(true);
    expect(await hasSensitiveAccess(pool, user.id, session.session.id)).toBe(true);
    await requireMfa(user.id);
    expect(await hasSensitiveAccess(pool, user.id, session.session.id)).toBe(false);
    expect(await grantSensitiveAccess(pool, user.id, session.session.id)).toBe(false);
    expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
  });
});

describe("fresh assurance rather than remembered session state", () => {
  it("never treats the existing MFA session mark as fresh verification", async () => {
    const user = await createUser(); const browser = new Browser(); await signInPassword(browser, user.email);
    const session = (await browser.session())!;
    await pool.query(`update session set "mfaVerified" = true where id = $1`, [session.session.id]);
    await pool.query(`update organizations set require_mfa = true where id in (select org_id from org_memberships where user_id = $1)`, [user.id]);
    const { grantSensitiveAccess, hasSensitiveAccess } = await import("../lib/auth-sensitive-access.js");
    expect(await hasSensitiveAccess(pool, user.id, session.session.id)).toBe(false);
    expect(await grantSensitiveAccess(pool, user.id, session.session.id)).toBe(false);
    expect((await browser.json<{ verifiedUntil: string | null }>("/sensitive-access")).body.verifiedUntil).toBeNull();
  });

  it("rejects weaker grants and pending first factors when verified-domain SSO becomes enforced", async () => {
    const domain = `race-${randomBytes(4).toString("hex")}.example`;
    const user = await createUser({ email: `person@${domain}` }); const browser = new Browser(); await signInPassword(browser, user.email);
    const session = (await browser.session())!;
    const { grantSensitiveAccess, recordSensitiveFirstFactorProof, hasSensitiveAccess, canBootstrapSensitiveEnrollment } = await import("../lib/auth-sensitive-access.js");
    expect(await grantSensitiveAccess(pool, user.id, session.session.id)).toBe(true);
    expect(await recordSensitiveFirstFactorProof(pool, user.id, session.session.id)).toBe(true);
    await pool.query(`insert into organizations(id, name, slug, created_by_user_id, sso_config) values ($1, 'SSO', $1, $2, $3)`,
      [domain, user.id, JSON.stringify({ enabled: true, enforceSso: true, emailDomain: domain })]);
    await pool.query(`insert into sso_domains(org_id,domain,verification_token,verified_at) values ($1,$1,'test',now())`, [domain]);
    expect(await hasSensitiveAccess(pool, user.id, session.session.id)).toBe(false);
    expect(await canBootstrapSensitiveEnrollment(pool, user.id, session.session.id)).toBe(false);
    expect(await grantSensitiveAccess(pool, user.id, session.session.id)).toBe(false);
    expect(await recordSensitiveFirstFactorProof(pool, user.id, session.session.id)).toBe(false);
    // Only a trusted callback that independently verified freshness may mark SSO proof.
    expect(await grantSensitiveAccess(pool, user.id, session.session.id, { ssoVerified: true })).toBe(true);
    expect(await hasSensitiveAccess(pool, user.id, session.session.id)).toBe(true);
  });
});
