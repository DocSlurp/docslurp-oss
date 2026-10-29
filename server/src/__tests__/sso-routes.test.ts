import { Hono } from "hono";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestSession } from "./helpers/session-app.js";
import { hasValidSsoUnlinkedPass } from "../lib/sso-unlinked-pass.js";

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
    sensitive_user_id?: string | null;
    sensitive_session_id?: string | null;
    created_at?: string;
    expires_at: string;
    consumed_at: string | null;
  }>;
}

let db: FakeDb;

function resetDb(): void {
  db = { orgs: [], memberships: [], users: [], domains: [], links: [], requests: [] };
}
resetDb();

const twoFactorUsers = new Set<string>();
const createVerificationValueMock = vi.fn(async (data: unknown) => data);

function runFakeSql(strings: TemplateStringsArray, ...values: any[]): any[] {
  const q = strings.join("?").replace(/\s+/g, " ").trim();
  const v = values;
  const now = new Date().toISOString();

  if (q.startsWith('select "twoFactorEnabled" as enabled from "user"')) {
    return twoFactorUsers.has(v[0]) ? [{ enabled: true }] : [];
  }
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
  if (q.startsWith("select state from sso_auth_requests")) {
    return db.requests.filter(row => row.state === v[0] && row.org_id === v[1] && row.provider === "saml").map(row => ({ state: row.state }));
  }
  if (q.startsWith("insert into sso_auth_requests")) {
    db.requests.push({
      state: v[0], org_id: v[1], provider: v[2], code_verifier: v[3], nonce: v[4], redirect_path: v[5],
      link_user_id: v[6], sensitive_user_id: v[7], sensitive_session_id: v[8], created_at: now, expires_at: new Date(Date.now() + 600_000).toISOString(), consumed_at: null
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

class FakeUnsafeExternalUrlError extends Error {}

vi.mock("../lib/network-security.js", () => ({
  assertSafeExternalUrl: assertSafeExternalUrlMock,
  safeExternalFetch: safeExternalFetchMock,
  UnsafeExternalUrlError: FakeUnsafeExternalUrlError
}));

const sensitiveStatusMock = vi.fn(async (): Promise<{ requiresMfa: boolean; enrollmentOnly?: boolean }> => ({ requiresMfa: false }));
const sensitiveGrantMock = vi.fn(async () => true);
const sensitiveFirstFactorMock = vi.fn(async () => true);
const hasSensitiveMock = vi.fn(async () => true);
const sessionActorMock = vi.fn(async () => ({ type: "session", userId: "admin-1", sessionId: "session-original", user: { id: "admin-1", email: "admin@acme.com" } }));
vi.mock("../lib/auth-sensitive-access.js", () => ({ getSensitiveAccessStatus: sensitiveStatusMock, grantSensitiveAccess: sensitiveGrantMock, recordSensitiveFirstFactorProof: sensitiveFirstFactorMock, hasSensitiveAccess: hasSensitiveMock }));
vi.mock("../lib/request-actor.js", () => ({ resolveBetterAuthSessionActor: sessionActorMock, getRequestActor: () => ({ type: "session", userId: "admin-1", sessionId: "session-original" }) }));
const sensitiveOptionsQuery = vi.fn(async (_query: string, values: unknown[]) => ({ rows: db.links.filter(link => link.user_id === values[0] && link.email === values[2]).map(link => ({ org_id: link.org_id, provider: link.provider })) }));

vi.mock("../lib/auth.js", () => ({
  appDbPool: { query: sensitiveOptionsQuery },
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
      createAuthCookie: (name: string) => ({ name: `better-auth.${name}`, attributes: { httpOnly: true, path: "/", secure: false, sameSite: "Lax" } }),
      internalAdapter: {
        createSession: createSessionMock,
        createVerificationValue: createVerificationValueMock
      }
    })
  }
}));

const { inferApiOrigin, setSsoRateLimitStoreForTests, samlCallbackRoutes, ssoRoutes } =
  await import("../routes/sso.js");
const { createMemoryAuthBudgetStore } = await import("../lib/auth-rate-limits.js");
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
  sensitiveGrantMock.mockReset().mockResolvedValue(true);
  sensitiveFirstFactorMock.mockReset().mockResolvedValue(true);
  sensitiveStatusMock.mockReset().mockResolvedValue({ requiresMfa: false });
  hasSensitiveMock.mockReset().mockResolvedValue(true);
  sessionActorMock.mockReset().mockResolvedValue({ type: "session", userId: "admin-1", sessionId: "session-original", user: { id: "admin-1", email: "admin@acme.com" } });
  assertSafeExternalUrlMock.mockClear();
  safeExternalFetchMock.mockClear();
  vi.stubGlobal("fetch", vi.fn());
  setTxtResolverForTests(null);
  setSsoRateLimitStoreForTests(createMemoryAuthBudgetStore());
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

  it("uses the public TLS origin for the SSO state cookie behind an HTTP proxy", async () => {
    seedOrg(oidcConfig);
    verifiedDomain("org-1");
    await stubIdp(() => ({}));
    process.env.PUBLIC_API_URL = "https://api.docslurp.example";
    const response = await buildApp().request("http://internal.local/v1/auth/oidc/org-1/init");
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=None");
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

    expect(await response.json()).toEqual({
      ok: false,
      error: "OIDC metadata endpoint host token.attacker.example is not the issuer's host or a trusted endpoint host"
    });
  });

  it("accepts Google's split token and JWKS hosts for the Google issuer only", async () => {
    const googleIssuer = "https://accounts.google.com";
    const googleMetadata = {
      issuer: googleIssuer,
      authorization_endpoint: `${googleIssuer}/o/oauth2/v2/auth`,
      token_endpoint: "https://oauth2.googleapis.com/token",
      jwks_uri: "https://www.googleapis.com/oauth2/v3/certs"
    };
    seedOrg({ ...oidcConfig, metadataUrl: `${googleIssuer}/.well-known/openid-configuration` });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(googleMetadata));
    const accepted = await buildApp().request("/v1/organizations/org-1/sso/test", { method: "POST" });
    expect(await accepted.json()).toMatchObject({ ok: true });

    seedOrg(oidcConfig, "org-2");
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...googleMetadata, issuer, authorization_endpoint: `${issuer}/authorize` }));
    const borrowed = await buildApp().request("/v1/organizations/org-2/sso/test", { method: "POST" });
    expect(await borrowed.json()).toEqual({
      ok: false,
      error: "OIDC metadata endpoint host oauth2.googleapis.com is not the issuer's host or a trusted endpoint host"
    });
  });

  it("explains that Microsoft multi-tenant metadata needs a tenant-specific URL", async () => {
    seedOrg({ ...oidcConfig, metadataUrl: "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration" });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
      authorization_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      jwks_uri: "https://login.microsoftonline.com/common/discovery/v2.0/keys"
    }));

    const response = await buildApp().request("/v1/organizations/org-1/sso/test", { method: "POST" });

    expect(JSON.stringify(await response.json())).toContain("use https://login.microsoftonline.com/<tenant-id>/v2.0");
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

    expect(await response.json()).toEqual({
      ok: false,
      error: `OIDC metadata issuer https://login.attacker.example does not match the metadata URL; expected the URL to be https://login.attacker.example/.well-known/openid-configuration`
    });
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
      error: "SAML metadata must not contain DTD or entity declarations"
    });
  });

  it("tests a well-formed OIDC IdP successfully", async () => {
    seedOrg(oidcConfig);
    await stubIdp(() => ({}));

    const response = await buildApp().request("/v1/organizations/org-1/sso/test", { method: "POST" });

    expect(await response.json()).toEqual({ ok: true });
  });

  it("explains metadata URL policy rejections, timeouts and redirects in the connection test", async () => {
    seedOrg(oidcConfig);
    const test = async () => (await buildApp().request("/v1/organizations/org-1/sso/test", { method: "POST" })).json();

    assertSafeExternalUrlMock.mockRejectedValueOnce(new FakeUnsafeExternalUrlError("URL resolves to a private or loopback address"));
    expect(await test()).toEqual({ ok: false, error: "Metadata URL rejected: URL resolves to a private or loopback address" });

    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expect(await test()).toEqual({ ok: false, error: "Timed out fetching the metadata URL" });

    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }));
    expect(await test()).toEqual({ ok: false, error: "Metadata URL redirected; use the final metadata URL (redirects are not followed)" });

    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed", { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) }));
    expect(await test()).toEqual({ ok: false, error: "Could not fetch the metadata URL (CERT_HAS_EXPIRED)" });

    vi.mocked(fetch).mockResolvedValueOnce(new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }));
    expect(await test()).toEqual({ ok: false, error: "Metadata URL did not return a JSON OpenID Connect discovery document" });

    vi.mocked(fetch).mockRejectedValueOnce(new Error("internal detail at 10.0.0.5"));
    expect(await test()).toEqual({ ok: false, error: "We couldn’t complete that request. Please try again in a moment." });
  });

  it("rate limits repeated SSO auth endpoint requests", async () => {
    process.env.SSO_RATE_LIMIT_MAX = "2";
    vi.resetModules();
    const fresh = await import("../routes/sso.js");
    fresh.setSsoRateLimitStoreForTests((await import("../lib/auth-rate-limits.js")).createMemoryAuthBudgetStore());
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

  it("vets a new metadata URL at write time even while SSO is disabled", async () => {
    seedOrg();
    assertSafeExternalUrlMock.mockRejectedValueOnce(new FakeUnsafeExternalUrlError("Only https URLs are allowed"));

    const response = await putSso(buildApp(), { providerType: "oidc", metadataUrl: "http://169.254.169.254/latest/meta-data" });

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("metadataUrl rejected: Only https URLs are allowed");
    expect(assertSafeExternalUrlMock).toHaveBeenCalledWith("http://169.254.169.254/latest/meta-data");
    expect(db.orgs[0]!.sso_config).toEqual({});
  });

  it("does not re-vet an unchanged metadata URL", async () => {
    seedOrg({ ...oidcConfig, enabled: false });

    const response = await putSso(buildApp(), { metadataUrl, clientId: "client-2" });

    expect(response.status).toBe(200);
    expect(assertSafeExternalUrlMock).not.toHaveBeenCalled();
  });

  it("keeps the client secret when omitted or masked and clears it on explicit null", async () => {
    seedOrg({ providerType: "oidc", metadataUrl, clientId: "client-id", clientSecret: "client-secret" });
    const app = buildApp();
    const storedSecret = () => (db.orgs[0]!.sso_config as { clientSecretEncrypted?: string | null }).clientSecretEncrypted ?? null;

    const omitted = await (await putSso(app, { clientId: "client-id" })).json() as { ssoConfig: { clientSecret: string | null } };
    expect(omitted.ssoConfig.clientSecret).toBe("***");
    expect(storedSecret()).not.toBeNull();

    const masked = await (await putSso(app, { clientSecret: "***" })).json() as { ssoConfig: { clientSecret: string | null } };
    expect(masked.ssoConfig.clientSecret).toBe("***");
    expect(storedSecret()).not.toBeNull();

    const cleared = await (await putSso(app, { clientSecret: null })).json() as { ssoConfig: { clientSecret: string | null } };
    expect(cleared.ssoConfig.clientSecret).toBeNull();
    expect(storedSecret()).toBeNull();
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
    // The IdP proved this email is unlinked: this browser may now sign in with
    // its password (and link) without being bounced back to the IdP.
    const passCookie = /docslurp\.sso_unlinked=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    expect(passCookie).toBeTruthy();
    expect(response.headers.get("set-cookie")).toMatch(/docslurp\.sso_unlinked=[^;]+;.*HttpOnly/i);
    expect(hasValidSsoUnlinkedPass("test-secret", passCookie, "victim@acme.com")).toBe(true);
    expect(hasValidSsoUnlinkedPass("test-secret", passCookie, "someone-else@acme.com")).toBe(false);
  });

  it("signs in a linked account", async () => {
    seedVictim();
    db.links.push({ org_id: "org-1", user_id: "victim-1", provider: "oidc", issuer, subject: "idp-victim", email: "victim@acme.com", created_at: "", last_used_at: null });
    seedRequest("s2");
    await stubIdp(() => ({ sub: "idp-victim", email: "victim@acme.com", nonce: "nonce-s2" }));

    const response = await buildApp().request("/v1/auth/oidc/org-1/callback?state=s2&code=c", { headers: ssoCookie("s2") });

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=");
    expect(response.headers.get("set-cookie")).not.toContain("docslurp.sso_unlinked=");
    expect(createSessionMock).toHaveBeenCalledWith("victim-1");
  });

  it("starts the second-factor challenge instead of a session for a 2FA user", async () => {
    seedVictim();
    twoFactorUsers.add("victim-1");
    db.links.push({ org_id: "org-1", user_id: "victim-1", provider: "oidc", issuer, subject: "idp-victim", email: "victim@acme.com", created_at: "", last_used_at: null });
    seedRequest("s2fa");
    await stubIdp(() => ({ sub: "idp-victim", email: "victim@acme.com", nonce: "nonce-s2fa" }));
    try {
      const response = await buildApp().request("/v1/auth/oidc/org-1/callback?state=s2fa&code=c", { headers: ssoCookie("s2fa") });
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/app/sign-in");
      expect(location.searchParams.get("mfa")).toBe("required");
      const cookies = response.headers.get("set-cookie") ?? "";
      expect(cookies).not.toContain("better-auth.session_token=");
      expect(cookies).toMatch(/better-auth\.two_factor=2fa-[^;]+;.*HttpOnly/i);
      expect(createSessionMock).not.toHaveBeenCalled();
      expect(createVerificationValueMock).toHaveBeenCalledWith(expect.objectContaining({ value: "victim-1" }));
    } finally {
      twoFactorUsers.delete("victim-1");
    }
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
    expect(createSessionMock).toHaveBeenCalledWith("victim-1");
    expect(linked.headers.get("set-cookie")).toContain("session_token");
    createSessionMock.mockClear();
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

describe("fresh sensitive company verification", () => {
  function seedSensitive(state = "sensitive-request") {
    seedOrg(oidcConfig); verifiedDomain("org-1");
    db.links.push({ org_id: "org-1", user_id: "admin-1", provider: "oidc", issuer, subject: "idp-admin", email: "admin@acme.com", created_at: "", last_used_at: null });
    seedRequest(state);
    Object.assign(db.requests.at(-1)!, { sensitive_user_id: "admin-1", sensitive_session_id: "session-original", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() });
  }
  it("starts a session-bound fresh authentication request with no account or return URL supplied by the client", async () => {
    seedSensitive(); await stubIdp(() => ({}));
    const response = await buildApp().request("/v1/auth/sensitive-sso/start", { method: "POST", headers: { Origin: "http://localhost:4321", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "victim", redirect: "https://evil.test" }) });
    expect(response.status).toBe(200);
    const url = new URL((await response.json() as { authorizeUrl: string }).authorizeUrl);
    expect(url.searchParams.get("prompt")).toBe("login"); expect(url.searchParams.get("max_age")).toBe("0");
    expect(db.requests.at(-1)).toMatchObject({ sensitive_user_id: "admin-1", sensitive_session_id: "session-original", link_user_id: null, redirect_path: "/auth/sensitive-sso-complete" });
  });
  it("lets a policy-blocked unenrolled session start fresh SSO proof without granting general sensitive access", async () => {
    seedSensitive();
    sessionActorMock.mockImplementation(async (...args: unknown[]) => {
      expect(args[1]).toEqual({ allowMfaPolicyBlocked: true });
      return { type: "session", userId: "admin-1", sessionId: "session-original", user: { id: "admin-1", email: "admin@acme.com" }, mfaPolicyBlocked: true };
    });
    sensitiveStatusMock.mockResolvedValue({ requiresMfa: true, enrollmentOnly: true });
    hasSensitiveMock.mockResolvedValue(false);
    await stubIdp(() => ({ sub: "idp-admin", email: "admin@acme.com", nonce: db.requests.at(-1)!.nonce, auth_time: Math.floor(Date.now() / 1000) }));
    const app = buildApp();
    const start = await app.request("/v1/auth/sensitive-sso/start", { method: "POST", headers: { Origin: "http://localhost:4321", "Content-Type": "application/json" }, body: "{}" });
    expect(start.status).toBe(200);
    expect(sensitiveGrantMock).not.toHaveBeenCalled();
    const state = db.requests.at(-1)!.state;
    const callback = await app.request(`/v1/auth/oidc/org-1/callback?state=${state}&code=c`, { headers: ssoCookie(state) });
    expect(callback.status).toBe(302);
    expect(sensitiveFirstFactorMock).toHaveBeenCalledWith(expect.anything(), "admin-1", "session-original", { ssoVerified: true });
    expect(sensitiveGrantMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
    const sensitiveMutation = await app.request("/v1/organizations/org-1/sso/link", { method: "DELETE" });
    expect(sensitiveMutation.status).toBe(403);
    expect(await sensitiveMutation.json()).toMatchObject({ error: { code: "REAUTH_REQUIRED" } });
  });

  it("requests fresh SAML authentication explicitly with ForceAuthn", async () => {
    seedSensitive();
    db.orgs[0]!.sso_config = { enabled: true, providerType: "saml", metadataUrl: "https://idp.acme.com/saml/metadata", emailDomain: "acme.com" };
    db.links[0]!.provider = "saml";
    vi.mocked(fetch).mockResolvedValue(new Response(`<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="urn:company"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>MIIFAKE</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme.com/saml/login"/></IDPSSODescriptor></EntityDescriptor>`));
    const response = await buildApp().request("/v1/auth/sensitive-sso/start", { method: "POST", headers: { Origin: "http://localhost:4321", "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    const url = new URL((await response.json() as { authorizeUrl: string }).authorizeUrl);
    const request = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString();
    expect(request).toContain('ForceAuthn="true"');
    expect(request).toContain(`ID="${db.requests.at(-1)!.state}"`);
  });

  it("rejects malicious start origins before creating a state request", async () => {
    seedSensitive(); const count = db.requests.length;
    const response = await buildApp().request("/v1/auth/sensitive-sso/start", { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(403); expect(db.requests).toHaveLength(count);
  });
  it.each([undefined, Math.floor(Date.now() / 1000) - 3600])("refuses signed but nonfresh OIDC proof auth_time=%s", async auth_time => {
    seedSensitive(); await stubIdp(() => ({ sub: "idp-admin", email: "admin@acme.com", nonce: "nonce-sensitive-request", ...(auth_time !== undefined ? { auth_time } : {}) }));
    const response = await buildApp().request("/v1/auth/oidc/org-1/callback?state=sensitive-request&code=c", { headers: ssoCookie("sensitive-request") });
    expect(response.status).toBe(403); expect(sensitiveGrantMock).not.toHaveBeenCalled(); expect(createSessionMock).not.toHaveBeenCalled();
  });
  it("grants only the existing session after fresh exact-linked proof and rejects replay", async () => {
    seedSensitive(); await stubIdp(() => ({ sub: "idp-admin", email: "admin@acme.com", nonce: "nonce-sensitive-request", auth_time: Math.floor(Date.now() / 1000) }));
    const app = buildApp(); const callback = "/v1/auth/oidc/org-1/callback?state=sensitive-request&code=c";
    const response = await app.request(callback, { headers: ssoCookie("sensitive-request") });
    expect(response.status).toBe(302); expect(response.headers.get("location")).toBe("http://localhost:4321/auth/sensitive-sso-complete");
    expect(sensitiveGrantMock).toHaveBeenCalledWith(expect.anything(), "admin-1", "session-original", { ssoVerified: true }); expect(createSessionMock).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie") ?? "").not.toContain("better-auth.session_token=");
    const replay = await app.request(callback, { headers: ssoCookie("sensitive-request") }); expect(replay.status).toBe(400); expect(sensitiveGrantMock).toHaveBeenCalledTimes(1);
  });
  it("does not replace local MFA with an IdP first factor", async () => {
    seedSensitive(); sensitiveStatusMock.mockResolvedValue({ requiresMfa: true });
    await stubIdp(() => ({ sub: "idp-admin", email: "admin@acme.com", nonce: "nonce-sensitive-request", auth_time: Math.floor(Date.now() / 1000) }));
    expect((await buildApp().request("/v1/auth/oidc/org-1/callback?state=sensitive-request&code=c", { headers: ssoCookie("sensitive-request") })).status).toBe(302);
    expect(sensitiveFirstFactorMock).toHaveBeenCalledWith(expect.anything(), "admin-1", "session-original", { ssoVerified: true }); expect(sensitiveGrantMock).not.toHaveBeenCalled();
  });
  it("rejects another subject even with the same email", async () => {
    seedSensitive(); await stubIdp(() => ({ sub: "other-idp-subject", email: "admin@acme.com", nonce: "nonce-sensitive-request", auth_time: Math.floor(Date.now() / 1000) }));
    expect((await buildApp().request("/v1/auth/oidc/org-1/callback?state=sensitive-request&code=c", { headers: ssoCookie("sensitive-request") })).status).toBe(403);
    expect(sensitiveGrantMock).not.toHaveBeenCalled();
  });
  it("refuses a proof bound to a different user even when the subject is correctly linked", async () => {
    seedSensitive(); db.requests.at(-1)!.sensitive_user_id = "victim-1";
    await stubIdp(() => ({ sub: "idp-admin", email: "admin@acme.com", nonce: "nonce-sensitive-request", auth_time: Math.floor(Date.now() / 1000) }));
    expect((await buildApp().request("/v1/auth/oidc/org-1/callback?state=sensitive-request&code=c", { headers: ssoCookie("sensitive-request") })).status).toBe(403);
    expect(sensitiveGrantMock).not.toHaveBeenCalled();
  });

  it("does not grant after the original session is revoked during the IdP round trip", async () => {
    seedSensitive(); sensitiveGrantMock.mockResolvedValue(false);
    await stubIdp(() => ({ sub: "idp-admin", email: "admin@acme.com", nonce: "nonce-sensitive-request", auth_time: Math.floor(Date.now() / 1000) }));
    expect((await buildApp().request("/v1/auth/oidc/org-1/callback?state=sensitive-request&code=c", { headers: ssoCookie("sensitive-request") })).status).toBe(403);
    expect(createSessionMock).not.toHaveBeenCalled();
  });
  it.each(["POST", "DELETE"])("requires recent sensitive proof for SSO identity %s", async method => {
    seedSensitive(); hasSensitiveMock.mockResolvedValue(false);
    const response = await buildApp().request("/v1/organizations/org-1/sso/link", { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: { code: "REAUTH_REQUIRED" } });
  });
});
