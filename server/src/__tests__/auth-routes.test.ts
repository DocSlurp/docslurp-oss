import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(), createSession: vi.fn(), verify: vi.fn(), handler: vi.fn(), sso: vi.fn(),
}));

vi.mock("../lib/better-auth.js", () => ({
  isDevSeedQuickLoginEnabled: () => process.env.NODE_ENV === "development",
  getDevSeedAccountCredential: (id: string) =>
    process.env.NODE_ENV === "development" ? { email: `${id}@docslurp.local`, password: "testtest" } : null,
  handleAuthRequest: mocks.handler,
  appDbPool: { query: vi.fn() },
  auth: { $context: Promise.resolve({
    secret: "test-secret",
    sessionConfig: { expiresIn: 604800 },
    authCookies: { sessionToken: { name: "better-auth.session_token", attributes: {
      httpOnly: true, path: "/", secure: false, sameSite: "lax",
    } } },
    internalAdapter: { findUserByEmail: mocks.findUser, createSession: mocks.createSession },
    password: { verify: mocks.verify },
  }) },
}));
vi.mock("../lib/sso-lookup.js", async (original) => ({
  ...await original<typeof import("../lib/sso-lookup.js")>(),
  resolveSsoRedirect: mocks.sso,
}));

import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { authRoutes } from "../routes/auth.js";
import { developmentTrustedOrigins } from "../lib/dev-auth-access.js";

const app = new Hono().route("/", authRoutes);

function seedSignIn(host: string, headers: Record<string, string> = {}, account = "member") {
  const url = `http://${host}/api/dev-auth/seed-signin`;
  return app.fetch(new Request(url, {
    method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin, ...headers },
    body: JSON.stringify({ account }),
  }));
}

describe("development seed sign-in", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    mocks.findUser.mockResolvedValue({ user: { id: "seed" }, accounts: [{ providerId: "credential", password: "hash" }] });
    mocks.verify.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue({ token: "seed-session" });
  });
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

  it.each(["localhost:4321", "127.0.0.1:4321", "[::1]:4321", "192.168.50.7:4321", "10.0.0.2:4321", "172.16.4.2:4321", "100.64.224.97:4321", "dev03.anaconda-porgy.ts.net:4321"])("accepts same-origin development requests on %s", async (host) => {
    const response = await seedSignIn(host);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, redirectTo: "/app" });
  });

  it("sets the signed Better Auth session cookie with its configured attributes", async () => {
    const response = await seedSignIn("localhost:4321");
    const signature = createHmac("sha256", "test-secret").update("seed-session").digest("base64");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain(`better-auth.session_token=${encodeURIComponent(`seed-session.${signature}`)}`);
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
  });

  it("redirects form submissions and still sets the cookie", async () => {
    const response = await app.fetch(new Request("http://localhost:4321/api/dev-auth/seed-signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:4321" },
      body: new URLSearchParams({ account: "admin", redirectTo: "/app/x" }),
    }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:4321/app/x");
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });

  it.each(["production", "test", "preview", "staging"])("404s in %s without touching the database", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    const response = await seedSignIn("localhost:4321");
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it.each(["example.com", "8.8.8.8", "172.32.1.1", "100.128.0.1", "evilts.net"])("blocks public host %s", async (host) => {
    expect((await seedSignIn(host)).status).toBe(404);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("blocks cross-origin browser requests and forwarded hostname spoofing", async () => {
    expect((await seedSignIn("localhost:4321", { origin: "https://unrelated.example" })).status).toBe(404);
    expect((await seedSignIn("localhost:4321", { "sec-fetch-site": "cross-site" })).status).toBe(404);
    expect((await seedSignIn("example.com", { "x-forwarded-host": "localhost" })).status).toBe(404);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("still checks the stored credential before issuing either seed session", async () => {
    mocks.verify.mockResolvedValue(false);
    const response = await seedSignIn("192.168.50.7", {}, "admin");
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("trusts only same-origin private development auth requests", () => {
    const configured = ["http://localhost:4321"];
    const privateRequest = new Request("http://dev03.example.ts.net:4321/api/auth/sign-out", { headers: { origin: "http://dev03.example.ts.net:4321" } });
    expect(developmentTrustedOrigins(configured, privateRequest)).toContain("http://dev03.example.ts.net:4321");
    expect(developmentTrustedOrigins(configured, new Request("http://example.com/api/auth/sign-out"))).toEqual(configured);
    vi.stubEnv("NODE_ENV", "production");
    expect(developmentTrustedOrigins(configured, privateRequest)).toEqual(configured);
  });
});

describe("HTML sign-in policy", () => {
  const submit = (headers: Record<string, string> = { Origin: "http://localhost:4321" }, redirectTo = "/app") =>
    app.fetch(new Request("http://localhost:4321/api/session/sign-in", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ email: "user@example.com", password: "testpassword", redirectTo }),
    }));
  beforeEach(() => { mocks.handler.mockReset(); mocks.sso.mockReset(); mocks.sso.mockResolvedValue(null); });

  it("forwards the session cookies from a successful sign-in", async () => {
    mocks.handler.mockResolvedValue(new Response("{}", { headers: { "Set-Cookie": "better-auth.session_token=verified; HttpOnly" } }));
    const response = await submit();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:4321/app");
    expect(response.headers.get("set-cookie")).toContain("session_token=verified");
    expect(mocks.handler.mock.calls[0][0].url).toBe("http://localhost:4321/api/auth/sign-in/email");
  });

  it.each(["/\\evil.example", "/\t/evil.example", "//evil.example"])("keeps the post-sign-in redirect on this origin for %j", async (redirectTo) => {
    mocks.handler.mockResolvedValue(new Response("{}", { headers: { "Set-Cookie": "better-auth.session_token=verified; HttpOnly" } }));
    const response = await submit(undefined, redirectTo);
    expect(response.headers.get("location")).toBe("http://localhost:4321/app");
  });

  it("does not turn an auth rejection into a session", async () => {
    mocks.handler.mockResolvedValue(new Response(JSON.stringify({ message: "Email is not verified" }), { status: 403 }));
    const response = await submit();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toContain("Email+is+not+verified");
  });

  it("keeps configured company SSO reachable without password auth", async () => {
    mocks.sso.mockResolvedValue("https://idp.example.com/login");
    const response = await submit();
    expect(response.headers.get("location")).toBe("https://idp.example.com/login");
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it("rejects cross-origin form posts before authenticating", async () => {
    expect((await submit({ Origin: "https://evil.example" })).status).toBe(403);
    expect(mocks.handler).not.toHaveBeenCalled();
  });
});

describe("auth passthrough and SSO lookup", () => {
  beforeEach(() => { mocks.handler.mockReset(); mocks.sso.mockReset(); });

  it("hands every /api/auth/* request to Better Auth untouched", async () => {
    mocks.handler.mockResolvedValue(new Response("ok", { headers: { "Set-Cookie": "a=b; Path=/" } }));
    const response = await app.fetch(new Request("http://localhost:4321/api/auth/get-session"));
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("set-cookie")).toBe("a=b; Path=/");
    expect(new URL(mocks.handler.mock.calls[0][0].url).pathname).toBe("/api/auth/get-session");
  });

  it("answers sso-lookup with the resolved URL, or null for non-emails", async () => {
    mocks.sso.mockResolvedValue("https://sso.example/init");
    expect(await (await app.fetch(new Request("http://localhost/api/sso-lookup?email=a@b.co&explicit=1"))).json())
      .toEqual({ ssoUrl: "https://sso.example/init" });
    expect(mocks.sso).toHaveBeenCalledWith("a@b.co", "http://localhost", false);
    expect(await (await app.fetch(new Request("http://localhost/api/sso-lookup?email=nope"))).json()).toEqual({ ssoUrl: null });
  });
});
