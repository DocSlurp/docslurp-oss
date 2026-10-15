import { Hono } from "hono";
import { describe, it, expect, vi, beforeEach } from "vitest";
const query = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());
vi.mock("../lib/auth.js", () => ({ appDbPool: { query, connect: async () => ({ query, release }) } }));
vi.mock("../lib/request-actor.js", () => ({ resolveBetterAuthSessionActor: vi.fn(async () => null) }));
import { mcpOAuthRoutes, mcpOAuthMetadataRoutes } from "../routes/mcp-oauth.js";
import { pkceChallenge, validRedirect, validateMcpToken } from "../services/mcp-oauth.js";
const app = new Hono().route("/oauth/mcp", mcpOAuthRoutes).route("/", mcpOAuthMetadataRoutes);
const url = "http://localhost:4321";
const verifier = "x".repeat(43);
const grant = { hash: "hash", grant_id: "grant", api_key_id: "native-key", client_id: "client", user_id: "user", org_id: "org", resource: `${url}/v1/mcp`, scopes: ["read"], kind: "code", redirect_uri: "https://client.example/callback", challenge: pkceChallenge(verifier), expires_at: new Date(Date.now() + 60000), consumed_at: null, revoked_at: null };
function token(values: Record<string, string | undefined>) {
  const params = { grant_type: "authorization_code", client_id: "client", resource: `${url}/v1/mcp`, code: "code", redirect_uri: grant.redirect_uri, code_verifier: verifier, ...values };
  return app.request(`${url}/oauth/mcp/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === "string")) });
}
beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_PUBLIC_URL", url); query.mockReset(); query.mockResolvedValue({ rows: [], rowCount: 1 }); });
describe("MCP OAuth", () => {
  it("advertises PKCE and path-specific protected resource metadata", async () => { const res = await app.request(`${url}/.well-known/oauth-authorization-server`); expect((await res.json()).code_challenge_methods_supported).toEqual(["S256"]); expect((await (await app.request(`${url}/.well-known/oauth-protected-resource/v1/mcp`)).json()).resource).toBe(`${url}/v1/mcp`); });
  it("rejects unsafe redirect URIs", () => { expect(validRedirect("https://client.example/cb")).toBe(true); expect(validRedirect("http://127.0.0.1:1234/cb")).toBe(true); for (const uri of ["javascript:alert(1)", "https://user:pass@example.com", "https://example.com/#token", "http://remote.example/cb"])
    expect(validRedirect(uri)).toBe(false); });
  it("rejects dynamic confidential clients and malformed registrations", async () => { const res = await app.request(`${url}/oauth/mcp/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "client_secret_post" }) }); expect(res.status).toBe(400); expect(query).not.toHaveBeenCalled(); });
  it.each([{ code_verifier: "wrong" }, { client_id: "wrong" }, { redirect_uri: "https://evil.example/callback" }])("rejects wrong proof or client binding %j", async (values) => { query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FOR UPDATE") ? [grant] : [], rowCount: 1 })); expect((await token(values)).status).toBe(400); expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO mcp_oauth_tokens"))).toBe(false); });
  it("rejects a different audience before any DB access", async () => { expect((await token({ resource: "https://evil.example/mcp" })).status).toBe(400); expect(query).not.toHaveBeenCalled(); });
  it("consumes the code atomically and returns short-lived opaque tokens", async () => { query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FOR UPDATE") ? [grant] : [], rowCount: 1 })); const res = await token({}); expect(res.status).toBe(200); const body = await res.json(); expect(body.expires_in).toBe(900); expect(body.access_token).toMatch(/^dsmcp_/); expect(body.refresh_token).toMatch(/^dsmcpr_/); expect(query.mock.calls.some(([sql]) => String(sql).includes("consumed_at=now()"))).toBe(true); expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT"); });
  it("revokes the grant on refresh replay", async () => { query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FOR UPDATE") ? [{ ...grant, kind: "refresh", consumed_at: new Date() }] : [], rowCount: 1 })); expect((await token({ grant_type: "refresh_token", refresh_token: "refresh" })).status).toBe(400); expect(query.mock.calls.some(([sql]) => String(sql).includes("SET revoked_at=now()"))).toBe(true); });
  it("denies a removed organization membership", async () => { query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FOR UPDATE") ? [grant] : [], rowCount: sql.includes("org_memberships") ? 0 : 1 })); expect((await token({})).status).toBe(400); });
  it("rejects consent without exact origin", async () => { expect((await app.request(`${url}/oauth/mcp/authorize`, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403); });
  it("checks live membership, expiry, revocation and audience for access", async () => { expect(await validateMcpToken("token", `${url}/v1/mcp`)).toBe(null); expect(query.mock.calls[0]?.[0]).toContain("JOIN org_memberships"); expect(query.mock.calls[0]?.[0]).toContain("g.resource=$2"); });
  it("uses the persisted server-key identity for downstream operation foreign keys", async () => {
    query.mockResolvedValue({ rows: [{ id: "grant", api_key_id: "native-key-id", user_id: "user", org_id: "org", scopes: ["read"] }], rowCount: 1 });
    const key = await validateMcpToken("token", `${url}/v1/mcp`);
    expect(key?.keyId).toBe("native-key-id");
    expect(query.mock.calls[0]?.[0]).toContain("JOIN api_keys");
    expect(query.mock.calls[0]?.[0]).toContain("k.revoked_at IS NULL");
  });
  it("denies token exchange when the linked native key was revoked", async () => {
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FOR UPDATE") ? [grant] : [], rowCount: sql.includes("FROM api_keys") ? 0 : 1 }));
    expect((await token({})).status).toBe(400);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO mcp_oauth_tokens"))).toBe(false);
  });

});
