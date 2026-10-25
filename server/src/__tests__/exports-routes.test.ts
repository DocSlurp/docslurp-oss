import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findExportableDocument: vi.fn(),
  getDocumentExport: vi.fn(),
  listDocumentExports: vi.fn(),
  requestDocumentExport: vi.fn(),
  documentExportFileUrl: vi.fn(),
  getWorkspace: vi.fn(),
  resolveActorWorkspaceId: vi.fn(),
}));

vi.mock("../services/document-exports.js", async () => {
  const actual = await vi.importActual<typeof import("../services/document-exports.js")>("../services/document-exports.js");
  return { ...actual, ...mocks };
});
vi.mock("../services/workspaces.js", () => ({ getWorkspace: mocks.getWorkspace }));
vi.mock("../lib/request-actor.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/request-actor.js")>("../lib/request-actor.js");
  return { ...actual, resolveActorWorkspaceId: mocks.resolveActorWorkspaceId };
});

const { exportsRoutes } = await import("../routes/exports.js");
const { DocumentExportError } = await import("../services/document-exports.js");

function buildApp(apiKey?: { scopes: string[]; keyType?: string; workspaceIds?: string[]; orgId?: string }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1" } as never);
    if (apiKey) c.set("apiKey", { userId: "user-1", orgId: "org-1", keyType: "server", keyId: "key-1", workspaceIds: [], ...apiKey } as never);
    await next();
  });
  app.route("/exports", exportsRoutes);
  return app;
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const record = { id: "exp_1", workspaceId: "ws-1", orgId: "org-1", status: "ready", error: null };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.findExportableDocument.mockImplementation(async (id: string) => id === "missing" ? null : { id, filename: "a.pdf", workspaceId: "ws-1", orgId: id === "foreign" ? "org-2" : "org-1" });
  mocks.getWorkspace.mockImplementation(async (id: string) => id === "missing" ? null : { id, name: "Finance", orgId: "org-1" });
  mocks.requestDocumentExport.mockResolvedValue({ id: "exp_1", status: "queued" });
  mocks.resolveActorWorkspaceId.mockImplementation(async (_actor: unknown, ref: string | null) => {
    if (ref === "unknown-slug") throw new Error("workspace_not_found");
    return ref === null || ref === "default" ? "ws-default" : ref;
  });
});

describe("exportsRoutes", () => {
  it("queues a document or workspace export and answers 202", async () => {
    const app = buildApp();
    const document = await app.request("/exports", post({ documentId: "doc-1", content: "all" }));
    expect(document.status).toBe(202);
    expect(await document.json()).toEqual({ export: { id: "exp_1", status: "queued" } });
    expect(mocks.requestDocumentExport).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", content: "all", document: expect.objectContaining({ id: "doc-1" }) }));

    expect((await app.request("/exports", post({ workspaceId: "ws-1" }))).status).toBe(202);
    expect(mocks.requestDocumentExport).toHaveBeenLastCalledWith(expect.objectContaining({ content: "markdown", workspace: expect.objectContaining({ id: "ws-1" }) }));
  });

  it("validates the target and maps limits to clear errors", async () => {
    const app = buildApp();
    expect((await app.request("/exports", post({}))).status).toBe(202);
    expect(mocks.resolveActorWorkspaceId).toHaveBeenLastCalledWith(expect.anything(), null);
    expect(mocks.requestDocumentExport).toHaveBeenLastCalledWith(expect.objectContaining({ workspace: expect.objectContaining({ id: "ws-default" }) }));
    expect((await app.request("/exports", post({ workspaceId: "unknown-slug" }))).status).toBe(404);
    expect((await app.request("/exports", post({ documentId: "a", workspaceId: "b" }))).status).toBe(400);
    expect((await app.request("/exports", post({ documentId: "missing" }))).status).toBe(404);
    expect((await app.request("/exports", post({ workspaceId: "missing" }))).status).toBe(404);

    mocks.requestDocumentExport.mockRejectedValueOnce(new DocumentExportError(413, "payload_too_large", "This export would be about 4.0 GB, over the 3.0 GB limit."));
    const tooLarge = await app.request("/exports", post({ documentId: "doc-1", content: "all" }));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: { code: "payload_too_large", message: expect.stringContaining("3.0 GB limit") } });
  });

  it("needs a server key with the artifacts scope, inside the key's organization and workspaces", async () => {
    expect((await buildApp({ scopes: ["search"] }).request("/exports", post({ documentId: "doc-1" }))).status).toBe(403);
    expect((await buildApp({ scopes: ["artifacts"], keyType: "client" }).request("/exports", post({ documentId: "doc-1" }))).status).toBe(403);
    expect((await buildApp({ scopes: ["artifacts"] }).request("/exports", post({ documentId: "foreign" }))).status).toBe(404);
    expect((await buildApp({ scopes: ["artifacts"], workspaceIds: ["ws-other"] }).request("/exports", post({ workspaceId: "ws-1" }))).status).toBe(404);
    expect((await buildApp({ scopes: ["artifacts"] }).request("/exports", post({ documentId: "doc-1" }))).status).toBe(202);
  });

  it("reports status and redirects ready downloads to a signed link", async () => {
    const app = buildApp();
    mocks.getDocumentExport.mockResolvedValue(record);
    mocks.documentExportFileUrl.mockResolvedValue("/v1/files/token/Plan.zip");

    const status = await app.request("/exports/exp_1");
    expect(await status.json()).toEqual({ export: { id: "exp_1", workspaceId: "ws-1", status: "ready", error: null } });

    const download = await app.request("/exports/exp_1/download");
    expect(download.status).toBe(302);
    expect(download.headers.get("location")).toBe("/v1/files/token/Plan.zip");

    mocks.getDocumentExport.mockResolvedValue({ ...record, status: "expired" });
    const expired = await app.request("/exports/exp_1/download");
    expect(expired.status).toBe(404);
    expect(await expired.json()).toMatchObject({ error: { message: expect.stringContaining("7-day link has expired") } });

    mocks.getDocumentExport.mockResolvedValue({ ...record, status: "running" });
    expect((await app.request("/exports/exp_1/download")).status).toBe(409);

    mocks.getDocumentExport.mockResolvedValue(null);
    expect((await app.request("/exports/exp_1")).status).toBe(404);
  });
});
