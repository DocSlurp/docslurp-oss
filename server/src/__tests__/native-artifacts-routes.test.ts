import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => vi.fn());
const sign = vi.hoisted(() => vi.fn());
vi.mock("../services/documents.js", () => ({ userCanAccessArtifactUri: access }));
vi.mock("../lib/artifacts.js", () => ({
  parseArtifactUri: (uri: string) => uri.startsWith("s3://") ? { bucket: "artifacts", key: "fixture" } : null,
}));
vi.mock("../lib/file-urls.js", () => ({ fileUrlForArtifact: sign }));
vi.mock("../services/artifact-security.js", () => ({ buildArtifactPreview: vi.fn() }));
vi.mock("../lib/request-actor.js", () => ({
  getRequestActor: (c: any) => ({ type: "apiKey", apiKey: c.get("apiKey") }),
  actorHasAnyApiKeyScope: (actor: any, scopes: string[]) => scopes.some(scope => actor.apiKey.scopes.includes(scope)),
}));
const { artifactsRoutes } = await import("../routes/artifacts.js");
function app(scopes = ["artifacts"], orgId: string | null = "org-a") {
  const server = new Hono();
  server.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-a", email: "", name: "" });
    c.set("apiKey", { orgId, scopes } as never);
    await next();
  });
  return server.route("/artifacts", artifactsRoutes);
}

describe("native bearer artifact access", () => {
  beforeEach(() => { vi.clearAllMocks(); sign.mockReturnValue({ url: "/v1/files/token/fixture", expiresAt: "2026-01-01T00:00:00.000Z" }); });
  it("requires artifact scope before reading or signing", async () => {
    const result = await app(["search"]).request("/artifacts/resolve?uri=s3://artifacts/fixture");
    expect(result.status).toBe(403);
    expect(access).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });
  it("passes the key organization to access checks and hides foreign artifacts", async () => {
    access.mockResolvedValue(false);
    const result = await app().request("/artifacts/resolve?uri=s3://artifacts/fixture");
    expect(result.status).toBe(404);
    expect(access).toHaveBeenCalledWith("s3://artifacts/fixture", "user-a", "org-a");
    expect(sign).not.toHaveBeenCalled();
  });
  it("issues proxy URLs only for authorized artifacts and rejects the entire batch on one foreign URI", async () => {
    access.mockResolvedValueOnce(true);
    expect((await app().request("/artifacts/resolve?uri=s3://artifacts/fixture")).status).toBe(200);
    sign.mockClear(); access.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await app().request("/artifacts/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uris: ["s3://artifacts/fixture", "s3://artifacts/foreign"] }) });
    expect(result.status).toBe(404);
    expect(sign).not.toHaveBeenCalled();
  });
});
