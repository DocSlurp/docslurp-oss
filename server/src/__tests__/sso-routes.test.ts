import { Hono } from "hono";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestSession } from "./helpers/session-app.js";

process.env.SSO_RATE_LIMIT_MAX = "1000";
process.env.SSO_RATE_LIMIT_WINDOW_MS = "60000";
process.env.SECRETS_ENCRYPTION_KEY = "0".repeat(64);

/**
 * A small in-memory stand-in for the tables the SSO routes touch. Queries are
 * matched by their SQL text; values arrive in template order.
 */
interface FakeDb {
  orgs: Array<{ id: string; slug: string | null; sso_config: Record<string, unknown> }>;
  memberships: Array<{ org_id: string; user_id: string; role: string }>;
  users: Array<{ id: string; email: string }>;
  domains: Array<{
    org_id: string;
    domain: string;
    verification_token: string;
    verified_at: string | null;
    last_checked_at: string | null;
    last_error: string | null;
  }>;
  links: Array<{ org_id: string; user_id: string; provider: string; issuer: string; subject: string; email: string; created_at: string; last_used_at: string | null }>;
  requests: Array<{
    state: string;
    org_id: string;
    provider: "oidc" | "saml";
    code_verifier: string | null;
    nonce: string | null;
    redirect_path: string | null;
    link_user_id: string | null;
    expires_at: string;
    consumed_at: string | null;
  }>;
}

let db: FakeDb;

function resetDb(): void {
  db = { orgs: [], memberships: [], users: [], domains: [], links: [], requests: [] };
}
resetDb();

function runFakeSql(strings: TemplateStringsArray, ...values: any[]): any[] {
  const q = strings.join("?").replace(/\s+/g, " ").trim();
  const v = values;
  const now = new Date().toISOString();

  if (q.startsWith("select role from org_memberships")) {
    return db.memberships.filter((m) => m.org_id === v[0] && m.user_id === v[1]).map(({ role }) => ({ role }));
  }
  if (q.startsWith("select user_id from org_memberships")) {
    return db.memberships.filter((m) => m.org_id === v[0] && m.user_id === v[1]).map(({ user_id }) => ({ user_id }));
  }
  if (q.startsWith("select id, slug, sso_config from organizations")) {
    return db.orgs.filter((o) => o.id === v[0] || (q.includes("slug = ?") && o.slug === v[0]));
  }
  if (q.startsWith("update organizations set sso_config")) {
    const org = db.orgs.find((o) => o.id === v[1]);
    if (org) org.sso_config = v[0];
    return [];
  }
  if (q.startsWith("select org_id, domain, verification_token")) {
    return db.domains.filter((d) => d.org_id === v[0] && d.domain === v[1]);
  }
  if (q.startsWith("select org_id from sso_domains")) {
    return db.domains.filter((d) => d.domain === v[0] && d.verified_at && d.org_id !== v[1]);
  }
  if (q.startsWith("insert into sso_domains")) {
    let row = db.domains.find((d) => d.org_id === v[0] && d.domain === v[1]);
    if (!row) {
      row = { org_id: v[0], domain: v[1], verification_token: v[2], verified_at: null, last_checked_at: null, last_error: null };
      db.domains.push(row);
    }
    return [row];
  }
  if (q.startsWith("update sso_domains")) {
    const [matched, lastError, orgId, domain] = v;
    const row = db.domains.find((d) => d.org_id === orgId && d.domain === domain);
    if (!row) return [];
    if (matched && db.domains.some((d) => d !== row && d.domain === domain && d.verified_at)) {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    }
    if (matched) row.verified_at ??= now;
    row.last_checked_at = now;
    row.last_error = lastError;
    return [row];
  }
  if (q.startsWith("delete from sso_identity_links")) {
    db.links = db.links.filter((l) => !(l.org_id === v[0] && (v.length < 2 || l.user_id === v[1])));
    return [];
  }
  if (q.startsWith("select user_id from sso_identity_links")) {
    return db.links.filter((l) => l.org_id === v[0] && l.provider === v[1] && l.issuer === v[2] && l.subject === v[3]);
  }
  if (q.startsWith("select email, created_at::text")) {
    return db.links.filter((l) => l.org_id === v[0] && l.user_id === v[1]);
  }
  if (q.startsWith("insert into sso_identity_links")) {
    db.links = db.links.filter((l) => !(l.org_id === v[0] && l.user_id === v[1]));
    db.links.push({ org_id: v[0], user_id: v[1], provider: v[2], issuer: v[3], subject: v[4], email: v[5], created_at: now, last_used_at: null });
    return [];
  }
  if (q.startsWith("update sso_identity_links")) {
    const link = db.links.find((l) => l.org_id === v[1] && l.user_id === v[2]);
    if (link) {
      link.last_used_at = now;
      link.email = v[0];
    }
    return [];
  }
  if (q.startsWith("insert into sso_auth_requests")) {
    db.requests.push({
      state: v[0], org_id: v[1], provider: v[2], code_verifier: v[3], nonce: v[4], redirect_path: v[5],
      link_user_id: v[6], expires_at: now, consumed_at: null
    });
    return [];
  }
  if (q.startsWith("update sso_auth_requests")) {
    const row = db.requests.find((r) => r.state === v[0] && r.provider === v[1] && !r.consumed_at);
    if (!row) return [];
    row.consumed_at = now;
    return [row];
  }
  if (q.startsWith('select id, email from "user"')) {
    return db.users.filter((u) => u.id === v[0]);
  }
  throw new Error(`Unhandled SQL in test: ${q}`);
}

const sqlMock = Object.assign(vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => runFakeSql(strings, ...values)), {
  json: (value: unknown) => value
});
const assertSafeExternalUrlMock = vi.fn(async (url: string) => url);
const safeExternalFetchMock = vi.fn((url: string, init?: RequestInit) => fetch(url, init));
const createSessionMock = vi.fn(async (_userId: string) => ({ token: "session-token" }));

vi.mock("../db.js", () => ({
  sql: sqlMock
}));

vi.mock("../lib/network-security.js", () => ({
  assertSafeExternalUrl: assertSafeExternalUrlMock,
  safeExternalFetch: safeExternalFetchMock
}));

vi.mock("../lib/auth.js", () => ({
  auth: {
    $context: Promise.resolve({
      secret: "test-secret",
      sessionConfig: { expiresIn: 3600 },
      authCookies: {
        sessionToken: {
          name: "better-auth.session_token",
          attributes: {
            httpOnly: true,
            path: "/",
            secure: false,
            sameSite: "Lax"
          }
        }
      },
      internalAdapter: {
        createSession: createSessionMock
      }
    })
  }
}));

const { inferApiOrigin, resetSsoRateLimitBucketsForTests, samlCallbackRoutes, ssoRoutes } =
  await import("../routes/sso.js");
const { setTxtResolverForTests, validateClaimableDomain } = await import("../services/sso-domains.js");

const issuer = "https://idp.acme.com";
const metadataUrl = `${issuer}/.well-known/openid-configuration`;

function buildApp(user: { id: string; email: string } = { id: "admin-1", email: "admin@acme.com" }) {
  const app = withTestSession(new Hono(), { ...user, name: "Test User" });
  app.route("/v1/organizations", ssoRoutes);
  app.route("/v1/auth", samlCallbackRoutes);
  return app;
}

function seedOrg(ssoConfig: Record<string, unknown> = {}, orgId = "org-1") {
  db.orgs.push({ id: orgId, slug: orgId, sso_config: ssoConfig });
  db.memberships.push({ org_id: orgId, user_id: "admin-1", role: "admin" });
  if (!db.users.some((u) => u.id === "admin-1")) db.users.push({ id: "admin-1", email: "admin@acme.com" });
}

function verifiedDomain(orgId: string, domain = "acme.com") {
  db.domains.push({ org_id: orgId, domain, verification_token: "tok", verified_at: new Date().toISOString(), last_checked_at: null, last_error: null });
}

const oidcConfig = {
  enabled: true,
  providerType: "oidc",
  metadataUrl,
  clientId: "client-id",
  clientSecret: "client-secret",
  emailDomain: "acme.com"
};

function putSso(app: Hono, body: Record<string, unknown>) {
  return app.request("/v1/organizations/org-1/sso", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

/** Stub IdP: discovery, token endpoint and JWKS, signing id_tokens for `claims`. */
async function stubIdp(claims: () => Record<string, unknown>) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  vi.mocked(fetch).mockImplementation(async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === metadataUrl) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`
      });
    }
    if (url === `${issuer}/token`) {
      const idToken = await new SignJWT(claims())
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience("client-id")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return Response.json({ id_token: idToken });
    }
    if (url === `${issuer}/jwks`) {
      return Response.json({ keys: [jwk] });
    }
    return new Response("not found", { status: 404 });
  });
}

function seedRequest(state: string, linkUserId: string | null = null) {
  db.requests.push({
    state, org_id: "org-1", provider: "oidc", code_verifier: "verifier", nonce: `nonce-${state}`,
    redirect_path: "/app", link_user_id: linkUserId, expires_at: new Date().toISOString(), consumed_at: null
  });
}

/** The state-binding cookie a callback must carry to prove it returns to the starting browser. */
function ssoCookie(state: string): { Cookie: string } {
  return { Cookie: `docslurp_sso_state=${createHash("sha256").update(state).digest("hex")}` };
}

beforeEach(() => {
  resetDb();
  sqlMock.mockClear();
  createSessionMock.mockClear();
  assertSafeExternalUrlMock.mockClear();
  safeExternalFetchMock.mockClear();
  vi.stubGlobal("fetch", vi.fn());
  setTxtResolverForTests(null);
  resetSsoRateLimitBucketsForTests();
  delete process.env.PUBLIC_API_URL;
  delete process.env.API_URL;
  delete process.env.APP_URL;
  delete process.env.BETTER_AUTH_TRUST_PROXY_HEADERS;
});

describe("ssoRoutes security hardening", () => {
  it("prefers configured API origin over spoofable forwarded headers", () => {
    process.env.PUBLIC_API_URL = "https://api.docslurp.example/v1";
    const origin = inferApiOrigin(new Request("https://internal.local/v1/auth/oidc/org/callback", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example"
      }
    }));

    expect(origin).toBe("https://api.docslurp.example");
  });

  it("ignores forwarded headers unless proxy trust is explicitly enabled", () => {
    const origin = inferApiOrigin(new Request("https://api.docslurp.example/v1/auth/oidc/org/callback", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example"
      }
    }));

    expect(origin).toBe("https://api.docslurp.example");
  });

  it("rejects OIDC metadata that points token or JWKS endpoints at untrusted hosts", async () => {
    seedOrg(oidcConfig);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: "https://token.attacker.example/oauth2/token",
      jwks_uri: `${issuer}/oauth2/jwks`
    }));

    const response = await buildApp().request("/v1/organizations/org-1/sso/test", { method: "POST" });

    expect(await response.json()).toEqual({ ok: false, error: "We couldn’t complete that request. Please try again in a moment." });
  });

  it("rejects OIDC metadata whose issuer is not the discovery URL's issuer", async () => {
    seedOrg(oidcConfig);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      issuer: "https://login.attacker.example",
      authorization_endpoint: "https://login.attacker.example/authorize",
      token_endpoint: "https://login.attacker.example/token",
      jwks_uri: "https://login.attacker.example/jwks"
    }));

    const response = await buildApp().request("/v1/organizations/org-1/sso/test", { method: "POST" });

    expect(await response.json()).toEqual({ ok: false, error: "We couldn’t complete that request. Please try again in a moment." });
  });

  it("rejects SAML metadata with DTD or entity declarations before xml2js parses it", async () => {
    seedOrg({ enabled: true, providerType: "saml", metadataUrl: "https://idp.acme.com/saml/metadata", emailDomain: "acme.com" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(`<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
]>
<EntityDescriptor entityID="https://idp.acme.com"></EntityDescriptor>`, {
      status: 200,
      headers: { "Content-Type": "application/xml" }
    }));

    const response = await buildApp().request("/v1/organizations/org-1/sso/test", { method: "POST" });

    expect(await response.json()).toEqual({
      ok: false,
      error: "We couldn’t complete that request. Please try again in a moment."
    });
  });

  it("rate limits repeated SSO auth endpoint requests", async () => {
    process.env.SSO_RATE_LIMIT_MAX = "2";
    vi.resetModules();
    const fresh = await import("../routes/sso.js");
    const app = new Hono().route("/v1/auth", fresh.samlCallbackRoutes);
    process.env.SSO_RATE_LIMIT_MAX = "1000";

    const headers = { "User-Agent": "rate-limit-test" };
    expect((await app.request("/v1/auth/oidc/missing/init", { headers })).status).toBe(404);
    expect((await app.request("/v1/auth/oidc/missing/init", { headers })).status).toBe(404);

    const blocked = await app.request("/v1/auth/oidc/missing/init", { headers });

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(await blocked.json()).toEqual({ error: { code: "rate_limited", message: "Too many SSO requests" } });
  });
});

describe("SSO domain verification", () => {
  it("issues a TXT record for a claimed domain but won't enable or enforce SSO until it is verified", async () => {
    seedOrg();
    const app = buildApp();

    const claimed = await putSso(app, { emailDomain: "Acme.com" });
    expect(claimed.status).toBe(200);
    const claim = await claimed.json() as { domainVerification: { status: string; recordName: string; recordValue: string } };
    expect(claim.domainVerification).toMatchObject({ status: "pending", recordName: "_docslurp-verify.acme.com" });
    expect(claim.domainVerification.recordValue).toMatch(/^docslurp-verify=[\w-]{20,}$/);

    const enable = await putSso(app, { ...oidcConfig, enforceSso: true });
    expect(enable.status).toBe(422);
    expect((await enable.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/Verify ownership of acme\.com/) });

    const enforceOnly = await putSso(app, { enforceSso: true });
    expect(enforceOnly.status).toBe(422);

    expect(db.orgs[0]!.sso_config.enabled ?? false).toBe(false);
    expect(db.orgs[0]!.sso_config.enforceSso ?? false).toBe(false);
  });

  it("verifies the domain through DNS and then allows SSO to be enabled", async () => {
    seedOrg();
    const app = buildApp();
    const claim = await (await putSso(app, { emailDomain: "acme.com" })).json() as { domainVerification: { recordValue: string } };

    const resolver = vi.fn(async () => [["unrelated"]]);
    setTxtResolverForTests(resolver);
    const miss = await app.request("/v1/organizations/org-1/sso/domain/verify", { method: "POST" });
    expect(await miss.json()).toMatchObject({ domainVerification: { status: "pending", lastError: expect.stringContaining("none equal") } });
    expect(resolver).toHaveBeenCalledWith("_docslurp-verify.acme.com");

    const value = claim.domainVerification.recordValue;
    setTxtResolverForTests(async () => [[value.slice(0, 10), value.slice(10)]]);
    const hit = await app.request("/v1/organizations/org-1/sso/domain/verify", { method: "POST" });
    expect(await hit.json()).toMatchObject({ domainVerification: { status: "verified" } });

    const enable = await putSso(app, { ...oidcConfig, enforceSso: true });
    expect(enable.status).toBe(200);
    expect(db.orgs[0]!.sso_config).toMatchObject({ enabled: true, enforceSso: true, emailDomain: "acme.com" });
  });

  it("treats a missing TXT record as not verified", async () => {
    seedOrg();
    const app = buildApp();
    await putSso(app, { emailDomain: "acme.com" });
    setTxtResolverForTests(async () => {
      throw Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });
    });

    const response = await app.request("/v1/organizations/org-1/sso/domain/verify", { method: "POST" });

    expect(await response.json()).toMatchObject({ domainVerification: { status: "pending", lastError: "TXT record not found" } });
  });

  it("rejects public email providers and their subdomains", async () => {
    seedOrg();
    const app = buildApp();
    for (const domain of ["gmail.com", "outlook.com", "proton.me", "mail.yahoo.com", "@icloud.com"]) {
      const response = await putSso(app, { emailDomain: domain });
      expect(response.status, domain).toBe(422);
      expect((await response.json() as { error: { message: string } }).error.message).toMatch(/Public email providers/);
    }
    expect(validateClaimableDomain("not a domain")).toMatch(/valid domain/);
    expect(db.domains).toHaveLength(0);
  });

  it("rejects a domain that another organization already verified", async () => {
    seedOrg();
    db.orgs.push({ id: "org-2", slug: "org-2", sso_config: {} });
    verifiedDomain("org-2");
    const app = buildApp();

    const claim = await putSso(app, { emailDomain: "acme.com" });

    expect(claim.status).toBe(409);
    expect(db.domains.filter((d) => d.org_id === "org-1")).toHaveLength(0);
  });

  it("refuses to verify when another org won the race to verify the same domain", async () => {
    seedOrg();
    const app = buildApp();
    const claim = await (await putSso(app, { emailDomain: "acme.com" })).json() as { domainVerification: { recordValue: string } };
    db.orgs.push({ id: "org-2", slug: "org-2", sso_config: {} });
    verifiedDomain("org-2");
    setTxtResolverForTests(async () => [[claim.domainVerification.recordValue]]);

    const response = await app.request("/v1/organizations/org-1/sso/domain/verify", { method: "POST" });

    expect(response.status).toBe(409);
    expect(db.domains.find((d) => d.org_id === "org-1")!.verified_at).toBeNull();
  });

  it("drops identity links when the IdP or domain changes", async () => {
    seedOrg(oidcConfig);
    verifiedDomain("org-1");
    db.links.push({ org_id: "org-1", user_id: "admin-1", provider: "oidc", issuer, subject: "s", email: "admin@acme.com", created_at: "", last_used_at: null });

    const response = await putSso(buildApp(), { metadataUrl: "https://idp2.acme.com/.well-known/openid-configuration" });

    expect(response.status).toBe(200);
    expect(db.links).toHaveLength(0);
  });
});

describe("SSO callback account binding", () => {
  function seedVictim() {
    seedOrg(oidcConfig);
    verifiedDomain("org-1");
    // The account predates the SSO connection and is a member of this org.
    db.users.push({ id: "victim-1", email: "victim@acme.com" });
    db.memberships.push({ org_id: "org-1", user_id: "victim-1", role: "member" });
  }

  it("refuses to sign in as a pre-existing account that never linked this SSO identity", async () => {
    seedVictim();
    seedRequest("s1");
    await stubIdp(() => ({ sub: "idp-victim", email: "victim@acme.com", nonce: "nonce-s1" }));

    const response = await buildApp().request("/v1/auth/oidc/org-1/callback?state=s1&code=c", { headers: ssoCookie("s1") });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("authError=");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("better-auth.session_token=");
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("signs in a linked account", async () => {
    seedVictim();
    db.links.push({ org_id: "org-1", user_id: "victim-1", provider: "oidc", issuer, subject: "idp-victim", email: "victim@acme.com", created_at: "", last_used_at: null });
    seedRequest("s2");
    await stubIdp(() => ({ sub: "idp-victim", email: "victim@acme.com", nonce: "nonce-s2" }));

    const response = await buildApp().request("/v1/auth/oidc/org-1/callback?state=s2&code=c", { headers: ssoCookie("s2") });

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=");
    expect(createSessionMock).toHaveBeenCalledWith("victim-1");
  });

  it("does not sign in a linked identity whose user left the org", async () => {
    seedVictim();
    db.links.push({ org_id: "org-1", user_id: "victim-1", provider: "oidc", issuer, subject: "idp-victim", email: "victim@acme.com", created_at: "", last_used_at: null });
    db.memberships = db.memberships.filter((m) => m.user_id !== "victim-1");
    seedRequest("s3");
    await stubIdp(() => ({ sub: "idp-victim", email: "victim@acme.com", nonce: "nonce-s3" }));

    const response = await buildApp().request("/v1/auth/oidc/org-1/callback?state=s3&code=c", { headers: ssoCookie("s3") });

    expect(response.status).toBe(403);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("refuses callbacks once the org's domain is no longer verified", async () => {
    seedVictim();
    db.domains = [];
    db.links.push({ org_id: "org-1", user_id: "victim-1", provider: "oidc", issuer, subject: "idp-victim", email: "victim@acme.com", created_at: "", last_used_at: null });
    seedRequest("s4");
    await stubIdp(() => ({ sub: "idp-victim", email: "victim@acme.com", nonce: "nonce-s4" }));

    const response = await buildApp().request("/v1/auth/oidc/org-1/callback?state=s4&code=c", { headers: ssoCookie("s4") });

    expect(response.status).toBe(403);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("links an identity only through a flow the signed-in user started, then signs in with it", async () => {
    seedVictim();
    await stubIdp(() => ({ sub: "idp-victim", email: "victim@acme.com", nonce: db.requests.at(-1)!.nonce }));
    const victimApp = buildApp({ id: "victim-1", email: "victim@acme.com" });

    const formPost = await victimApp.request("/v1/organizations/org-1/sso/link", { method: "POST", body: "x" });
    expect(formPost.status).toBe(415);

    const started = await victimApp.request("/v1/organizations/org-1/sso/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    expect(started.status).toBe(200);
    const { authorizeUrl } = await started.json() as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    expect(db.requests.at(-1)).toMatchObject({ state, link_user_id: "victim-1" });

    const linked = await victimApp.request(`/v1/auth/oidc/org-1/callback?state=${state}&code=c`, { headers: { Cookie: started.headers.get("set-cookie")!.split(";")[0]! } });
    expect(linked.status).toBe(302);
    expect(linked.headers.get("location")).toContain("/app/sso?linked=1");
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(db.links).toMatchObject([{ org_id: "org-1", user_id: "victim-1", issuer, subject: "idp-victim" }]);

    seedRequest("s5");
    const signIn = await buildApp().request("/v1/auth/oidc/org-1/callback?state=s5&code=c", { headers: ssoCookie("s5") });
    expect(createSessionMock).toHaveBeenCalledWith("victim-1");
    expect(signIn.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });

  it("refuses a link flow whose IdP identity has a different email than the signed-in account", async () => {
    seedVictim();
    seedRequest("s6", "victim-1");
    await stubIdp(() => ({ sub: "idp-other", email: "other@acme.com", nonce: "nonce-s6" }));

    const response = await buildApp().request("/v1/auth/oidc/org-1/callback?state=s6&code=c", { headers: ssoCookie("s6") });

    expect(response.status).toBe(403);
    expect(db.links).toHaveLength(0);
  });

  it("won't start a link flow for an email outside the verified domain", async () => {
    seedVictim();
    db.users.push({ id: "guest-1", email: "guest@elsewhere.io" });
    db.memberships.push({ org_id: "org-1", user_id: "guest-1", role: "member" });

    const response = await buildApp({ id: "guest-1", email: "guest@elsewhere.io" }).request("/v1/organizations/org-1/sso/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });

    expect(response.status).toBe(403);
  });

  it("rejects a callback that arrives without the state-binding cookie (SEC-2026-10-06)", async () => {
    seedVictim();
    seedRequest("s7");
    await stubIdp(() => ({ sub: "idp-victim", email: "victim@acme.com", nonce: "nonce-s7" }));

    const response = await buildApp().request("/v1/auth/oidc/org-1/callback?state=s7&code=c");

    expect(response.status).toBe(400);
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});
