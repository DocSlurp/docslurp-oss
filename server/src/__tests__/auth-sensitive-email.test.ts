import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sso: false, requireMfa: false, send: vi.fn(), grant: vi.fn(), firstFactor: vi.fn() }));
vi.mock("better-auth/api", () => ({
  APIError: class extends Error {
    constructor(readonly status: string, readonly body: { code: string; message: string }, readonly headers?: HeadersInit) { super(body.message); }
  },
  createAuthEndpoint: (path: string, options: unknown, handler: unknown) => ({ path, options, handler }),
  sessionMiddleware: () => undefined,
}));
vi.mock("better-auth/crypto", () => ({ generateRandomString: () => "123456" }));
vi.mock("../lib/auth-email.js", () => ({ sendAuthEmailCode: mocks.send }));
vi.mock("../lib/auth-mfa.js", () => ({
  evaluateMfaPolicy: async () => ({ required: mocks.requireMfa }), ssoEnforcedForEmail: async () => mocks.sso,
}));
import { sensitiveEmailPlugin, getSensitiveEmailEligibility } from "../lib/auth-sensitive-email.js";

type Session = { userId: string; email: string; emailVerified: boolean; live: boolean; mfa: boolean; totp: boolean; passkey?: boolean;
  hash: string | null; sentAt: number | null; expiresAt: number; attempts: number };
let sessions: Map<string, Session>;
const query = vi.fn(async (sql: string, params: unknown[] = []) => {
  const [sessionId, userId] = params as [string, string];
  const state = sessions.get(sessionId);
  const live = state?.live && state.userId === userId;
  if (sql.startsWith("select greatest")) return { rows: live && state.sentAt !== null && state.sentAt > Date.now() - 60_000
    ? [{ retry_after_seconds: Math.max(1, Math.ceil((state.sentAt + 60_000 - Date.now()) / 1000)) }] : [] };
  if (sql.startsWith("select u.email")) return { rows: live ? [{ email: state.email, email_verified: state.emailVerified, two_factor_enabled: state.mfa, totp: state.totp, passkey: state.passkey }] : [] };
  if (sql.includes('"sensitiveEmailOTPSentAt" = now()')) {
    if (!live || !state.emailVerified || state.email !== params[3] || (state.sentAt !== null && state.sentAt > Date.now() - 60_000)) return { rows: [] };
    state.hash = String(params[2]); state.sentAt = Date.now(); state.expiresAt = Date.now() + 600_000; state.attempts = 0;
    return { rows: [{ id: sessionId }] };
  }
  if (sql.includes('"sensitiveEmailOTPAttempts" = s.')) {
    if (!live || !state.emailVerified || state.email !== params[2] || !state.hash || state.expiresAt <= Date.now() || state.attempts >= Number(params[3])) return { rows: [] };
    state.attempts += 1; return { rows: [{ id: sessionId }] };
  }
  if (sql.includes('from "user" u where s.id')) {
    if (!live || !state.emailVerified || state.email !== params[3] || state.hash !== params[2] || state.expiresAt <= Date.now() || state.attempts > Number(params[4])) return { rows: [] };
    state.hash = null; return { rows: [{ id: sessionId }] };
  }
  if (sql.startsWith("update session set")) { if (live && state.hash === params[2]) state.hash = null; return { rows: [] }; }
  throw new Error("Unexpected test query");
});
const pool = { query } as unknown as Parameters<typeof sensitiveEmailPlugin>[0]["pool"];
const endpoints = () => sensitiveEmailPlugin({ pool, deliveryEnabled: true, sendCode: mocks.send,
  grant: mocks.grant, recordFirstFactor: mocks.firstFactor, getStatus: async () => ({ pendingMfa: mocks.requireMfa }) }).endpoints as any;
const context = (body: unknown = {}, sessionId = "session", userId = "user") => ({ body,
  context: { secret: "test-secret", session: { user: { id: userId, email: "stale-session@example.test" }, session: { id: sessionId } } }, json: (value: unknown) => value });
const send = (sessionId = "session", userId = "user") => endpoints().sensitiveEmailSend.handler(context({}, sessionId, userId));
const verify = (code = "123456", sessionId = "session", userId = "user") => endpoints().sensitiveEmailVerify.handler(context({ code }, sessionId, userId));
beforeEach(() => {
  vi.clearAllMocks(); mocks.sso = false; mocks.requireMfa = false;
  mocks.send.mockResolvedValue(undefined); mocks.grant.mockResolvedValue(true); mocks.firstFactor.mockResolvedValue(true);
  sessions = new Map([["session", { userId: "user", email: "current@example.test", emailVerified: true, live: true,
    mfa: false, totp: false, hash: null, sentAt: null, expiresAt: 0, attempts: 0 }]]);
});

describe("current-email sensitive verification", () => {
  it("uses only the current verified database email and never stores the raw code", async () => {
    await expect(send()).resolves.toMatchObject({ sent: true, expiresIn: 600 });
    expect(mocks.send).toHaveBeenCalledWith({ email: "current@example.test", otp: "123456" });
    expect(sessions.get("session")!.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(query.mock.calls)).not.toContain('"123456"');
    await expect(verify()).resolves.toMatchObject({ requiresTotp: false });
    expect(mocks.grant).toHaveBeenCalledWith(pool, "user", "session", { expectedVerifiedEmail: "current@example.test" });
    expect(mocks.firstFactor).not.toHaveBeenCalled();
  });
  it("rejects arbitrary email/user/session request fields", () => {
    expect(() => endpoints().sensitiveEmailSend.options.body.parse({ email: "victim@example.test" })).toThrow();
    expect(() => endpoints().sensitiveEmailVerify.options.body.parse({ code: "123456", sessionId: "other", userId: "victim" })).toThrow();
    expect(() => endpoints().sensitiveEmailVerify.options.body.parse({ code: "x".repeat(20_000) })).toThrow();
  });
  it.each(["unverified", "revoked", "wrong-user", "sso", "disabled-mail"])("refuses %s accounts without sending", async reason => {
    if (reason === "unverified") sessions.get("session")!.emailVerified = false;
    if (reason === "revoked") sessions.get("session")!.live = false;
    if (reason === "sso") mocks.sso = true;
    if (reason === "disabled-mail") {
      expect(await getSensitiveEmailEligibility(pool, "user", "session", false)).toBeNull(); return;
    }
    await expect(send("session", reason === "wrong-user" ? "victim" : "user")).rejects.toMatchObject({ body: { code: "REAUTH_REQUIRED" } });
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("binds the proof to user, session, current email and a distinct purpose", async () => {
    await send();
    const original = sessions.get("session")!;
    sessions.set("other-session", { ...original });
    await expect(verify("123456", "other-session")).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    sessions.set("victim-session", { ...original, userId: "victim" });
    await expect(verify("123456", "victim-session", "victim")).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    original.email = "changed@example.test";
    await expect(verify()).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    original.hash = "a-login-purpose-otp";
    await expect(verify()).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("binds the final grant write to the verified email and refuses a failed commit", async () => {
    await send();
    mocks.grant.mockResolvedValueOnce(false);
    await expect(verify()).rejects.toMatchObject({ body: { code: "REAUTH_REQUIRED" } });
    expect(mocks.grant).toHaveBeenCalledWith(pool, "user", "session", { expectedVerifiedEmail: "current@example.test" });
    expect(sessions.get("session")!.hash).toBeNull();
    await expect(verify()).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
  });
  it("atomically consumes a correct proof once, including concurrent verification", async () => {
    await send();
    const results = await Promise.allSettled([verify(), verify()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    await expect(verify()).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
  });
  it("rejects an expired code and locks out after five incorrect guesses", async () => {
    await send(); sessions.get("session")!.expiresAt = Date.now() - 1;
    await expect(verify()).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    sessions.get("session")!.expiresAt = Date.now() + 600_000;
    for (let index = 0; index < 5; index++) await expect(verify("999999")).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    await expect(verify()).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("enforces a send cooldown under concurrent requests", async () => {
    const result = await Promise.allSettled([send(), send()]);
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(sensitiveEmailPlugin({ pool, grant: mocks.grant, recordFirstFactor: mocks.firstFactor, getStatus: async () => ({}) }).rateLimit).toHaveLength(2);
  });
  it("returns the remaining server send cooldown as Retry-After", async () => {
    await send();
    sessions.get("session")!.sentAt = Date.now() - 45_000;
    const failure = await send().catch((error: { headers: Record<string, string> }) => error);
    const seconds = Number(failure.headers["Retry-After"]);
    expect(seconds).toBeGreaterThanOrEqual(14);
    expect(seconds).toBeLessThanOrEqual(16);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("invalidates a code when delivery fails and never grants", async () => {
    mocks.send.mockRejectedValueOnce(new Error("provider secret"));
    await expect(send()).rejects.toMatchObject({ body: { code: "EMAIL_DELIVERY_UNAVAILABLE" } });
    expect(sessions.get("session")!.hash).toBeNull();
    await expect(verify()).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("allows only enrollment-scoped first-factor proof when policy requires MFA but no factor exists", async () => {
    mocks.requireMfa = true;
    expect(await getSensitiveEmailEligibility(pool, "user", "session", true)).toMatchObject({ enrollmentOnly: true });
    await send();
    await expect(verify()).resolves.toMatchObject({ requiresTotp: false });
    expect(mocks.firstFactor).toHaveBeenCalledWith(pool, "user", "session", { expectedVerifiedEmail: "current@example.test" });
    expect(mocks.grant).not.toHaveBeenCalled();
    sessions.get("session")!.passkey = true;
    expect(await getSensitiveEmailEligibility(pool, "user", "session", true)).toBeNull();
  });
  it("requires a fresh local TOTP after email proof when MFA is required", async () => {
    mocks.requireMfa = true;
    const session = sessions.get("session")!; session.mfa = true; session.totp = true;
    await send(); await expect(verify()).resolves.toMatchObject({ requiresTotp: true });
    expect(mocks.firstFactor).toHaveBeenCalledWith(pool, "user", "session", { expectedVerifiedEmail: "current@example.test" });
    expect(mocks.grant).not.toHaveBeenCalled();
    session.totp = false;
    expect(await getSensitiveEmailEligibility(pool, "user", "session", true)).toBeNull();
  });
});
