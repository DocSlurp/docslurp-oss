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

  it("maps a missing object to 404", async () => {
    open.mockRejectedValue(Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } }));
    expect((await get(`/v1/files/${token()}/page-0001.png`)).status).toBe(404);
  });
});
