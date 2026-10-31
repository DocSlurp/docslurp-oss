import { describe, expect, it, vi } from "vitest";
import { isFreshSensitiveSsoAuthentication, verifiedSamlSensitiveAuthTime, isSensitiveSsoStartOrigin, sensitiveSsoOptions } from "../lib/auth-sensitive-sso.js";
const start = "2026-10-28T12:00:00Z";
const now = Date.parse(start) + 10_000;
function samlProfile(overrides: { issuer?: string; request?: string; instant?: string } = {}) {
  return { issuer: overrides.issuer ?? "urn:company", getAssertion: () => ({ Assertion: {
    Issuer: [{ _: overrides.issuer ?? "urn:company" }], AuthnStatement: [{ $: { AuthnInstant: overrides.instant ?? start } }],
    Subject: [{ SubjectConfirmation: [{ SubjectConfirmationData: [{ $: { InResponseTo: overrides.request ?? "request-1" } }] }] }],
  } }) };
}
describe("fresh sensitive SSO proof policy", () => {
  it("rejects old, missing, future or expired-request authentication despite a valid token", () => {
    expect(isFreshSensitiveSsoAuthentication(Date.parse(start), start, now)).toBe(true);
    expect(isFreshSensitiveSsoAuthentication(Date.parse(start) - 6_000, start, now)).toBe(false);
    expect(isFreshSensitiveSsoAuthentication(NaN, start, now)).toBe(false);
    expect(isFreshSensitiveSsoAuthentication(now + 6_000, start, now)).toBe(false);
    expect(isFreshSensitiveSsoAuthentication(now, start, now + 600_001)).toBe(false);
  });
  it("requires verified SAML assertion issuer, authentication instant and exact signed request binding", () => {
    expect(verifiedSamlSensitiveAuthTime(samlProfile(), "urn:company", "request-1")).toBe(Date.parse(start));
    expect(verifiedSamlSensitiveAuthTime(samlProfile({ request: "other-consumed-request" }), "urn:company", "request-1")).toBeNull();
    expect(verifiedSamlSensitiveAuthTime(samlProfile({ issuer: "urn:attacker" }), "urn:company", "request-1")).toBeNull();
    expect(verifiedSamlSensitiveAuthTime(samlProfile({ instant: "bad" }), "urn:company", "request-1")).toBeNull();
    expect(verifiedSamlSensitiveAuthTime({ issuer: "urn:company", getSamlResponseXml: () => "unverified" }, "urn:company", "request-1")).toBeNull();
    const old = verifiedSamlSensitiveAuthTime(samlProfile({ instant: "2026-10-28T11:00:00Z" }), "urn:company", "request-1")!;
    expect(isFreshSensitiveSsoAuthentication(old, start, now)).toBe(false);
  });
  it("rejects absent, sibling and attacker return origins", () => {
    expect(isSensitiveSsoStartOrigin("https://app.example.com", "https://api.example.com/v1/auth/sensitive-sso/start", "https://app.example.com")).toBe(true);
    for (const origin of [undefined, "null", "https://evil.example.com", "https://app.example.com.evil.test"]) expect(isSensitiveSsoStartOrigin(origin, "https://api.example.com/start", "https://app.example.com")).toBe(false);
  });
  it("scopes selectable identity providers to exact linked user, email, verified domain and membership", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ org_id: "org-1", provider: "oidc" }] });
    expect(await sensitiveSsoOptions({ query } as never, "user-1", "user@example.com")).toEqual([{ orgId: "org-1", provider: "oidc" }]);
    expect(query.mock.calls[0][1]).toEqual(["user-1", "example.com", "user@example.com"]);
    expect(query.mock.calls[0][0]).toContain('l.user_id = $1');
    expect(query.mock.calls[0][0]).toContain('m.user_id = l.user_id');
    expect(query.mock.calls[0][0]).toContain('d.verified_at is not null');
    expect(await sensitiveSsoOptions({ query } as never, "user-1", "invalid")).toEqual([]);
  });
});
