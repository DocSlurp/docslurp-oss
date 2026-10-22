import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBetterAuthSecurityOptions } from "@docslurp/shared/auth-security";
import { createAuthEmailOptions } from "../lib/auth-email.js";
import { safeErrorResponse } from "@docslurp/shared/error-response";
import { beforeOAuthAccountCreate } from "../lib/oauth-account-linking.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function setup(enabled: boolean, oauthVerified = true) {
  vi.stubEnv("RESEND_API_KEY", enabled ? "test-key" : "");
  vi.stubEnv("EMAIL_FROM", enabled ? "auth@example.com" : "");
  const database: Record<string, any[]> = { user: [], session: [], account: [], verification: [] };
  let code = "";
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    code = payload.subject.match(/^(\d{6}) is your DocSlurp code$/)[1];
    return new Response('{}');
  });
  vi.stubGlobal("fetch", transport);
  const auth = betterAuth({
    ...createBetterAuthSecurityOptions({ APP_URL: "http://localhost:4321" }),
    ...createAuthEmailOptions(process.env),
    database: memoryAdapter(database),
    secret: "a-long-and-local-only-test-secret-12345",
    socialProviders: { google: {
      clientId: "local-test", clientSecret: "local-test",
      verifyIdToken: async token => token === "signed-test-token",
      getUserInfo: async () => ({ user: { id: "google-owner", email: account.email, name: account.name, emailVerified: oauthVerified }, data: { sub: "google-owner" } }),
    } },
    databaseHooks: { account: { create: { before: beforeOAuthAccountCreate } } },
  });
  const post = (path: string, body: object) => auth.handler(new Request(`http://localhost:4321/api/auth${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:4321" }, body: JSON.stringify(body),
  }));
  return { auth, post, database, transport, code: () => code };
}
const account = { name: "Verification check", email: "verification@example.com", password: "testpassword" };

describe("real email verification endpoints", () => {
  it("links verified OAuth email without another email code and removes the unverified password", async () => {
    const flow = setup(true);
    await flow.post("/sign-up/email", account);
    const id = flow.database.user[0].id;
    const response = await flow.post("/sign-in/social", { provider: "google", idToken: { token: "signed-test-token" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token");
    expect(flow.database.user).toHaveLength(1);
    expect(flow.database.user[0]).toMatchObject({ id, emailVerified: true });
    expect(flow.database.account).toHaveLength(1);
    expect(flow.database.account[0]).toMatchObject({ userId: id, providerId: "google" });
    expect(flow.transport).toHaveBeenCalledTimes(1); // Only the original password signup.
    expect((await flow.post("/sign-in/email", account)).ok).toBe(false);
  });

  it("does not merge an OAuth identity whose provider has not verified the email", async () => {
    const flow = setup(true, false);
    await flow.post("/sign-up/email", account);
    const response = await flow.post("/sign-in/social", { provider: "google", idToken: { token: "signed-test-token" } });
    expect(response.ok).toBe(false);
    expect(flow.database.account).toHaveLength(1);
    expect(flow.database.account[0].providerId).toBe("credential");
    expect(flow.database.user[0].emailVerified).toBe(false);
  });

  it("signs up through verified OAuth without sending an email confirmation", async () => {
    const flow = setup(true);
    const response = await flow.post("/sign-in/social", { provider: "google", idToken: { token: "signed-test-token" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token");
    expect(flow.database.user[0].emailVerified).toBe(true);
    expect(flow.transport).not.toHaveBeenCalled();
  });
  it("rejects repeated signups, including email case variants, without synthetic IDs", async () => {
    const flow = setup(true);
    expect((await flow.post("/sign-up/email", account)).status).toBe(200);
    for (const email of [account.email, account.email.toUpperCase()]) {
      const response = await safeErrorResponse(await flow.post("/sign-up/email", { ...account, email }), undefined, () => "");
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "EMAIL_ALREADY_REGISTERED", message: "This email is already registered. Sign in or reset your password." });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(flow.database.user).toHaveLength(1);
    expect(flow.database.account).toHaveLength(1);
    expect(flow.transport).toHaveBeenCalledTimes(1);
  });
  it("withholds sessions until a correct one-use code verifies the account", async () => {
    const flow = setup(true);
    const signup = await flow.post("/sign-up/email", account);
    expect(signup.status).toBe(200);
    expect(signup.headers.get("set-cookie")).toBeNull();
    expect(flow.transport).toHaveBeenCalledTimes(1);
    expect(flow.code()).toMatch(/^\d{6}$/);
    expect(flow.database.user[0].emailVerified).toBe(false);
    expect(JSON.stringify(flow.database.verification)).not.toContain(flow.code());
    const blocked = await flow.post("/sign-in/email", account);
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    const wrong = await flow.post("/email-otp/verify-email", { email: account.email, otp: "abcdef" });
    expect(wrong.ok).toBe(false);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const correct = await flow.post("/email-otp/verify-email", { email: account.email, otp: flow.code() });
    expect(correct.status).toBe(200);
    expect(correct.headers.get("set-cookie")).toContain("session_token");
    expect(flow.database.user[0].emailVerified).toBe(true);
    const reused = await flow.post("/email-otp/verify-email", { email: account.email, otp: flow.code() });
    expect(reused.ok).toBe(false);
  });

  it("expires codes instead of accepting stale verification", async () => {
    const flow = setup(true);
    await flow.post("/sign-up/email", account);
    flow.database.verification.forEach(record => { record.expiresAt = new Date(0); });
    const expired = await flow.post("/email-otp/verify-email", { email: account.email, otp: flow.code() });
    expect(expired.ok).toBe(false);
    expect(expired.headers.get("set-cookie")).toBeNull();
    expect(flow.database.user[0].emailVerified).toBe(false);
  });

  it("locks out repeated incorrect codes", async () => {
    const flow = setup(true);
    await flow.post("/sign-up/email", account);
    const wrongCode = flow.code() === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await flow.post("/email-otp/verify-email", { email: account.email, otp: wrongCode })).ok).toBe(false);
    }
    const locked = await flow.post("/email-otp/verify-email", { email: account.email, otp: flow.code() });
    expect(locked.ok).toBe(false);
    expect(flow.database.user[0].emailVerified).toBe(false);
  });

  it("disables registration and OTP endpoints when no sender is configured", async () => {
    const flow = setup(false);
    for (const path of ["/sign-up/email", "/email-otp/send-verification-otp"]) {
      const response = await flow.post(path, { ...account, type: "email-verification" });
      expect(response.ok).toBe(false);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(flow.transport).not.toHaveBeenCalled();
    expect(flow.database.session ?? []).toHaveLength(0);
  });
  it("allows an existing verified account to sign in without email delivery", async () => {
    const flow = setup(false);
    const hash = await (await flow.auth.$context).password.hash(account.password);
    const now = new Date();
    flow.database.user.push({ id: "existing", ...account, emailVerified: true, createdAt: now, updatedAt: now });
    flow.database.account.push({ id: "credential", userId: "existing", accountId: "existing", providerId: "credential", password: hash, createdAt: now, updatedAt: now });
    const response = await flow.post("/sign-in/email", account);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token");
    flow.database.user[0].emailVerified = false;
    const unverified = await flow.post("/sign-in/email", account);
    expect(unverified.status).toBe(403);
    expect(unverified.headers.get("set-cookie")).toBeNull();
    expect(flow.transport).not.toHaveBeenCalled();
  });
});
