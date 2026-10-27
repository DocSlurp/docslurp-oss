import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";
import { issueSsoSession, ssoEnforcementPlugin, ssoSessionCreatePolicy } from "../lib/sso-enforcement.js";
import { createSsoUnlinkedPass, SSO_UNLINKED_PASS_COOKIE } from "../lib/sso-unlinked-pass.js";

const secret = "local-sso-enforcement-test-secret-123456789";
const account = { name: "Employee", email: "employee@company.test", password: "local-test-password" };
function setup() {
  const database: Record<string, any[]> = { user: [], account: [], session: [], verification: [] };
  let enforced = false;
  const org = { id: "org-company", slug: "company", sso_config: { providerType: "saml" as const } };
  const query = vi.fn(async (sql: string, params: any[]) => {
    if (sql.includes('select email from "user"')) return { rows: database.user.filter(u => u.id === params[0]) };
    if (sql.includes("select o.id")) return { rows: enforced && params[0] === "company.test" ? [org] : [] };
    if (sql.includes("delete from session")) {
      database.session = database.session.filter(s => s.token !== params[0] || (sql.includes('"createdAt" <')
        ? new Date(s.createdAt).getTime() >= Date.now() - params[1] * 1000
        : !enforced || s.token.startsWith(`sso_${Buffer.from("org-company").toString("hex")}_`) || !database.user.some(u => u.id === s.userId && u.email.endsWith("@company.test"))));
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const send = vi.fn();
  const auth = betterAuth({
    baseURL: "http://localhost:4321", secret, database: memoryAdapter(database),
    emailAndPassword: { enabled: true }, session: { cookieCache: { enabled: false } },
    plugins: [emailOTP({ sendVerificationOTP: send }), ssoEnforcementPlugin({ pool: { query } as any })],
    socialProviders: { google: { clientId: "test", clientSecret: "test", verifyIdToken: async () => true,
      getUserInfo: async () => ({ user: { email: account.email, emailVerified: true, name: account.name }, data: { sub: "google-employee", aud: "test", azp: "test", iss: "https://accounts.google.com", iat: 1, exp: 2, email: account.email, email_verified: true, name: account.name, given_name: "Employee", family_name: "Test", picture: "" } }) } },
  });
  const post = (path: string, body: object, cookie = "") => auth.handler(new Request(`http://localhost:4321/api/auth${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:4321", cookie }, body: JSON.stringify(body),
  }));
  return { auth, post, database, query, send, enforce: () => { enforced = true; } };
}
function cookieOf(response: Response) { return response.headers.getSetCookie().map(c => c.split(";")[0]).join("; "); }

describe("server-side SSO enforcement through real Better Auth endpoints", () => {
  it("rejects password, signup, email code and password reset before issuing credentials", async () => {
    const f = setup();
    await f.post("/sign-up/email", account);
    f.enforce();
    for (const [path, body] of [
      ["/sign-in/email", account], ["/sign-up/email", { ...account, email: "new@company.test" }],
      ["/email-otp/send-verification-otp", { email: account.email, type: "sign-in" }],
      ["/sign-in/email-otp", { email: account.email, otp: "123456" }],
      ["/request-password-reset", { email: account.email, redirectTo: "/" }],
    ] as const) {
      const response = await f.post(path, body);
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({ code: "SSO_REQUIRED" });
      expect(response.headers.get("set-cookie"), path).toBeNull();
    }
    expect(f.send).not.toHaveBeenCalled();
  });

  it("rejects a verified social sign-in even when the endpoint body omits email", async () => {
    const f = setup(); f.enforce();
    const response = await f.post("/sign-in/social", { provider: "google", idToken: { token: "test" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "SSO_REQUIRED" });
    expect(f.database.session).toHaveLength(0);
  });

  it("revokes a previously working nonSSO session on HTTP and internal getSession", async () => {
    for (const internal of [false, true]) {
      const f = setup();
      const signup = await f.post("/sign-up/email", account);
      const headers = new Headers({ cookie: cookieOf(signup) });
      expect(await f.auth.api.getSession({ headers })).not.toBeNull();
      f.enforce();
      if (internal) expect(await f.auth.api.getSession({ headers })).toBeNull();
      else {
        const response = await f.auth.handler(new Request("http://localhost:4321/api/auth/get-session", { headers }));
        expect(await response.json()).toBeNull();
      }
      expect(f.database.session).toHaveLength(0);
    }
  });

  it("preserves unrelated domain sign-in and company-SSO issuance", async () => {
    const f = setup();
    await f.post("/sign-up/email", account); f.enforce();
    expect((await f.post("/sign-up/email", { ...account, email: "other@unrelated.test" })).status).toBe(200);
    const context = await f.auth.$context;
    const session = await issueSsoSession(id => context.internalAdapter.createSession(id), f.database.user[0].id, "org-company");
    expect(session?.token).toMatch(/^sso_/);
    const signature = createHmac("sha256", secret).update(session!.token).digest("base64");
    const headers = new Headers({ cookie: `better-auth.session_token=${encodeURIComponent(`${session!.token}.${signature}`)}` });
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    await expect(issueSsoSession(id => context.internalAdapter.createSession(id), f.database.user[0].id, "wrong-org")).rejects.toMatchObject({ body: { code: "SSO_REQUIRED" } });
  });

  it("only grants the temporary linking exception to the IdP-proven mailbox", async () => {
    const f = setup(); await f.post("/sign-up/email", account); f.enforce();
    for (const [email, key] of [["other@company.test", secret], [account.email, "forged-secret"]]) {
      const cookie = `${SSO_UNLINKED_PASS_COOKIE}=${createSsoUnlinkedPass(key, email)}`;
      expect((await f.post("/sign-in/email", account, cookie)).status).toBe(403);
    }
    const cookie = `${SSO_UNLINKED_PASS_COOKIE}=${createSsoUnlinkedPass(secret, account.email)}`;
    expect((await f.post("/sign-in/email", account, cookie)).status).toBe(200);
    expect(f.database.session.at(-1).token).toMatch(/^ssolink_/);
  });

  it("refuses a linking session after the original proof expires even if Better Auth refreshed it", async () => {
    const f = setup(); await f.post("/sign-up/email", account); f.enforce();
    const proofTime = Date.now() - 14 * 60_000;
    const cookie = `${SSO_UNLINKED_PASS_COOKIE}=${createSsoUnlinkedPass(secret, account.email, proofTime)}`;
    const response = await f.post("/sign-in/email", account, cookie);
    const headers = new Headers({ cookie: cookieOf(response) });
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    const now = vi.spyOn(Date, "now").mockReturnValue(proofTime + 16 * 60_000);
    try { expect(await f.auth.api.getSession({ headers })).toBeNull(); }
    finally { now.mockRestore(); }
  });

  it("propagates policy database errors instead of permitting a session", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("database unavailable")) };
    await expect(ssoSessionCreatePolicy(pool as any, secret, { userId: "u", token: "t" }, null)).rejects.toThrow("database unavailable");
  });
});
