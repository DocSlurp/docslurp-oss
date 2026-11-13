import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => vi.fn());
const preview = vi.hoisted(() => vi.fn());
const completed = vi.hoisted(() => new Set<string>());
vi.mock("../db.js", () => ({ sql: async (_s: TemplateStringsArray, ...values: unknown[]) => completed.has(String(values[0])) ? [{ ok: true }] : [] }));
vi.mock("../services/documents.js", () => ({ userCanAccessArtifactUri: access }));
vi.mock("../lib/artifacts.js", () => ({
  parseArtifactUri: (uri: string) => uri.startsWith("s3://") ? { bucket: "artifacts", key: "fixture" } : null,
}));
vi.mock("../services/artifact-security.js", () => ({ buildArtifactPreview: preview }));
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
  beforeEach(() => { vi.clearAllMocks(); preview.mockResolvedValue({ kind: "text", content: "fixture" }); });
  it("requires artifact scope before reading", async () => {
    const result = await app(["search"]).request("/artifacts/preview?uri=s3://artifacts/fixture");
    expect(result.status).toBe(403);
    expect(access).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });
  it("passes the key organization to access checks and hides foreign artifacts", async () => {
    access.mockResolvedValue(false);
    const result = await app().request("/artifacts/preview?uri=s3://artifacts/fixture");
    expect(result.status).toBe(404);
    expect(access).toHaveBeenCalledWith("s3://artifacts/fixture", "user-a", "org-a");
    expect(preview).not.toHaveBeenCalled();
  });
  it("previews authorized artifacts only", async () => {
    access.mockResolvedValueOnce(true);
    expect((await app().request("/artifacts/preview?uri=s3://artifacts/fixture")).status).toBe(200);
    expect(preview).toHaveBeenCalledWith("s3://artifacts/fixture", "text");
  });
  it("HIGH-1: refuses a Doppler folder file of a document that is not completed, and never the source pointer", async () => {
    const DOC = "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b";
    const folder = (relative: string) => `s3://artifacts/u/r/doppler/${DOC}/${relative}`;
    access.mockResolvedValue(true);
    for (const relative of ["document.md", "index.json", "images/manifest.jsonl", "images/page-0001/image-001.webp"]) {
      const result = await app().request(`/artifacts/preview?uri=${encodeURIComponent(folder(relative))}`);
      expect(result.status, relative).toBe(404);
    }
    expect(preview).not.toHaveBeenCalled();
    completed.add(DOC);
    expect((await app().request(`/artifacts/preview?uri=${encodeURIComponent(folder("document.md"))}&kind=markdown`)).status).toBe(200);
    access.mockClear();
    const pointer = await app().request(`/artifacts/preview?uri=${encodeURIComponent(folder("source.json"))}&kind=json`);
    expect(pointer.status).toBe(404);
    expect(access).not.toHaveBeenCalled();
    completed.clear();
  });
  it("no longer exposes the resolve endpoints", async () => {
    expect((await app().request("/artifacts/resolve?uri=s3://artifacts/fixture")).status).toBe(404);
    expect((await app().request("/artifacts/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uris: ["s3://artifacts/fixture"] }) })).status).toBe(404);
    expect(access).not.toHaveBeenCalled();
  });
});
