import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/sso-lookup is unauthenticated, so it must not reveal which
 * mailboxes at an enforce-SSO domain have linked accounts. The fake database
 * honours a per-user `sso_identity_links` predicate if the lookup ever sends
 * one again, so a regression would make the linked and unlinked answers differ.
 */
const fake = vi.hoisted(() => ({
  org: { id: "org-1", slug: "acme", sso_config: { providerType: "saml", enabled: true, enforceSso: true, emailDomain: "acme.com" } } as {
    id: string; slug: string; sso_config: Record<string, unknown>;
  },
  linkedEmails: new Set<string>(["alice@acme.com"]),
  queries: [] as Array<{ text: string; params: unknown[] }>,
  handler: vi.fn(),
}));

vi.mock("../lib/better-auth.js", () => ({
  isDevSeedQuickLoginEnabled: () => false,
  getDevSeedAccountCredential: () => null,
  handleAuthRequest: fake.handler,
  auth: { $context: Promise.resolve({ secret: "test-secret" }) },
  appDbPool: {
    query: vi.fn(async (text: string, params: unknown[]) => {
      fake.queries.push({ text, params });
      const [domain, requireEnforced, email] = params as [string, boolean, string | undefined];
      const config = fake.org.sso_config;
      if (domain !== config.emailDomain || config.enabled !== true) return { rows: [] };
      if (requireEnforced && config.enforceSso !== true) return { rows: [] };
      if (requireEnforced && text.includes("sso_identity_links") && !fake.linkedEmails.has(String(email).toLowerCase())) return { rows: [] };
      return { rows: [fake.org] };
    }),
  },
}));

import { Hono } from "hono";
import { resetApiRateLimitBuckets } from "../middleware/rate-limit.js";
import { authRoutes } from "../routes/auth.js";
import { createSsoUnlinkedPass, hasValidSsoUnlinkedPass, SSO_UNLINKED_PASS_COOKIE } from "../lib/sso-unlinked-pass.js";

const app = new Hono().route("/", authRoutes);
const samlUrl = "http://localhost/v1/auth/saml/acme/init";

async function lookup(email: string, { explicit = false, cookie }: { explicit?: boolean; cookie?: string } = {}) {
  const url = `http://localhost/api/sso-lookup?email=${encodeURIComponent(email)}${explicit ? "&explicit=1" : ""}`;
  return app.fetch(new Request(url, { headers: cookie ? { cookie } : {} }));
}

describe("GET /api/sso-lookup", () => {
  beforeEach(() => {
    resetApiRateLimitBuckets();
    fake.queries.length = 0;
    fake.org.sso_config = { providerType: "saml", enabled: true, enforceSso: true, emailDomain: "acme.com" };
  });
  afterEach(() => { vi.unstubAllEnvs(); resetApiRateLimitBuckets(); });

  it("answers linked and unlinked emails at an enforce-SSO domain identically", async () => {
    const linked = await lookup("alice@acme.com");
    const unlinked = await lookup("nobody@acme.com");
    expect(linked.status).toBe(unlinked.status);
    expect(await linked.text()).toBe(await unlinked.text());
    expect(await (await lookup("ALICE@ACME.COM")).json()).toEqual({ ssoUrl: samlUrl });
    expect(await (await lookup("nobody@acme.com")).json()).toEqual({ ssoUrl: samlUrl });
  });

  it("never sends the mailbox or a per-user predicate to the database", async () => {
    await lookup("alice@acme.com");
    await lookup("alice@acme.com", { explicit: true });
    expect(fake.queries).toHaveLength(2);
    for (const { text, params } of fake.queries) {
      expect(text).not.toMatch(/sso_identity_links|"user"/);
      expect(JSON.stringify(params)).not.toContain("alice");
    }
  });

  it("only redirects without explicit=1 when the org enforces SSO", async () => {
    fake.org.sso_config = { ...fake.org.sso_config, enforceSso: false };
    expect(await (await lookup("alice@acme.com")).json()).toEqual({ ssoUrl: null });
    expect(await (await lookup("nobody@acme.com", { explicit: true })).json()).toEqual({ ssoUrl: samlUrl });
    expect(await (await lookup("bob@elsewhere.com", { explicit: true })).json()).toEqual({ ssoUrl: null });
  });

  it("lets a browser holding an unlinked pass for that email continue with its password", async () => {
    const cookie = `${SSO_UNLINKED_PASS_COOKIE}=${createSsoUnlinkedPass("test-secret", "Nobody@acme.com")}`;
    expect(await (await lookup("nobody@acme.com", { cookie })).json()).toEqual({ ssoUrl: null });
    // The pass is bound to its email, and explicit company sign-in still works.
    expect(await (await lookup("other@acme.com", { cookie })).json()).toEqual({ ssoUrl: samlUrl });
    expect(await (await lookup("nobody@acme.com", { cookie, explicit: true })).json()).toEqual({ ssoUrl: samlUrl });
    const forged = `${SSO_UNLINKED_PASS_COOKIE}=${createSsoUnlinkedPass("wrong-secret", "nobody@acme.com")}`;
    expect(await (await lookup("nobody@acme.com", { cookie: forged })).json()).toEqual({ ssoUrl: samlUrl });
  });

  it("applies the API per-IP rate limit", async () => {
    vi.stubEnv("API_RATE_LIMIT_IP_READ_MAX", "2");
    expect((await lookup("a@acme.com")).status).toBe(200);
    expect((await lookup("b@acme.com")).status).toBe(200);
    const limited = await lookup("c@acme.com");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(fake.queries).toHaveLength(2);
  });
});

describe("POST /api/session/sign-in enforce-SSO redirect", () => {
  beforeEach(() => { resetApiRateLimitBuckets(); fake.handler.mockReset(); });

  function signIn(email: string, cookie?: string) {
    const body = new URLSearchParams({ email, password: "pw" });
    return app.fetch(new Request("http://localhost/api/session/sign-in", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
      body,
    }));
  }

  it("redirects every address at the enforced domain to the IdP before checking the password", async () => {
    for (const email of ["alice@acme.com", "nobody@acme.com"]) {
      const response = await signIn(email);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(samlUrl);
    }
    expect(fake.handler).not.toHaveBeenCalled();
  });

  it("checks the password for a browser holding the email's unlinked pass", async () => {
    fake.handler.mockResolvedValue(new Response(JSON.stringify({ message: "Invalid email or password" }), { status: 401 }));
    const cookie = `${SSO_UNLINKED_PASS_COOKIE}=${createSsoUnlinkedPass("test-secret", "nobody@acme.com")}`;
    const response = await signIn("nobody@acme.com", cookie);
    expect(fake.handler).toHaveBeenCalledTimes(1);
    expect(response.headers.get("location")).toContain("authError=");
  });
});

describe("unlinked pass", () => {
  it("expires", () => {
    const now = Date.UTC(2026, 9, 24);
    const pass = createSsoUnlinkedPass("s", "a@acme.com", now);
    expect(hasValidSsoUnlinkedPass("s", pass, "a@acme.com", now + 60_000)).toBe(true);
    expect(hasValidSsoUnlinkedPass("s", pass, "a@acme.com", now + 16 * 60_000)).toBe(false);
    expect(hasValidSsoUnlinkedPass("s", "garbage", "a@acme.com", now)).toBe(false);
  });
});
