import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBetterAuthSecurityOptions } from "@docslurp/shared/auth-security";
import { createAuthEmailOptions } from "../lib/auth-email.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function setup(enabled: boolean) {
  vi.stubEnv("RESEND_API_KEY", enabled ? "test-key" : "");
  vi.stubEnv("EMAIL_FROM", enabled ? "auth@example.com" : "");
  const database: Record<string, any[]> = { user: [], session: [], account: [], verification: [] };
  let code = "";
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    code = payload.text.match(/code is (\d{6})/)[1];
    return new Response('{}');
  });
  vi.stubGlobal("fetch", transport);
  const auth = betterAuth({
    ...createBetterAuthSecurityOptions({ APP_URL: "http://localhost:4321" }),
    ...createAuthEmailOptions(process.env),
    database: memoryAdapter(database),
    secret: "a-long-and-local-only-test-secret-12345",
  });
  const post = (path: string, body: object) => auth.handler(new Request(`http://localhost:4321/api/auth${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:4321" }, body: JSON.stringify(body),
  }));
  return { auth, post, database, transport, code: () => code };
}
const account = { name: "Verification check", email: "verification@example.com", password: "testpassword" };

describe("real email verification endpoints", () => {
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
