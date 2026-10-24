import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const addDocumentTagsMock = vi.fn();
const bulkReprocessDocumentsMock = vi.fn();
const deleteDocumentMock = vi.fn();
const deleteDocumentsMock = vi.fn();
const exportDocumentArtifactsMock = vi.fn();
const getDocumentVersionChangelogMock = vi.fn();
const getDocumentVersionsWithTagsMock = vi.fn();
const getDocumentViewerPayloadMock = vi.fn();
const listDocumentsWithFiltersMock = vi.fn();
const listDocumentOwnersMock = vi.fn();
const removeDocumentTagsMock = vi.fn();
const setDocumentTagsMock = vi.fn();
const appendAuditLogMock = vi.fn();

vi.mock("../services/documents.js", () => ({
  addDocumentTags: addDocumentTagsMock,
  bulkReprocessDocuments: bulkReprocessDocumentsMock,
  deleteDocument: deleteDocumentMock,
  deleteDocuments: deleteDocumentsMock,
  exportDocumentArtifacts: exportDocumentArtifactsMock,
  getDocumentVersionChangelog: getDocumentVersionChangelogMock,
  getDocumentVersionsWithTags: getDocumentVersionsWithTagsMock,
  getDocumentViewerPayload: getDocumentViewerPayloadMock,
  listDocumentsWithFilters: listDocumentsWithFiltersMock,
  listDocumentOwners: listDocumentOwnersMock,
  removeDocumentTags: removeDocumentTagsMock,
  setDocumentTags: setDocumentTagsMock
}));

vi.mock("../services/document-review.js", () => ({
  getCorrectionWorkbench: vi.fn(),
  listLowConfidenceReviewQueue: vi.fn(),
  reindexDocumentCorrection: vi.fn(),
  saveDocumentCorrection: vi.fn()
}));

vi.mock("../services/audit-log.js", () => ({
  appendAuditLog: appendAuditLogMock
}));

vi.mock("../lib/artifacts.js", () => ({
  getArtifactJson: vi.fn()
}));

vi.mock("../lib/request-context.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/request-context.js")>("../lib/request-context.js");
  return {
    ...actual,
    requestIp: vi.fn(() => "127.0.0.1"),
    requestUserAgent: vi.fn(() => "vitest")
  };
});

const { documentsRoutes } = await import("../routes/documents.js");

function buildApp(apiKey?: { scopes: string[]; keyType?: string; orgId?: string; workspaceIds?: string[] }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1" } as never);
    if (apiKey) c.set("apiKey", { userId: "user-1", orgId: "org-1", keyType: "server", keyId: "key-1", workspaceIds: [], ...apiKey } as never);
    await next();
  });
  app.route("/documents", documentsRoutes);
  return app;
}

describe("documentsRoutes bulk actions", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    addDocumentTagsMock.mockReset();
    bulkReprocessDocumentsMock.mockReset();
    deleteDocumentMock.mockReset();
    deleteDocumentsMock.mockReset();
    exportDocumentArtifactsMock.mockReset();
    getDocumentVersionChangelogMock.mockReset();
    getDocumentVersionsWithTagsMock.mockReset();
    getDocumentViewerPayloadMock.mockReset();
    listDocumentsWithFiltersMock.mockReset();
    removeDocumentTagsMock.mockReset();
    setDocumentTagsMock.mockReset();
  });

  it("removes tags across the selected documents", async () => {
    removeDocumentTagsMock.mockResolvedValue(2);

    const response = await app.request("/documents/bulk", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        action: "remove-tags",
        documentIds: ["doc-1", "doc-2"],
        tags: ["legal", "invoice"]
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      updated: 2,
      documentIds: ["doc-1", "doc-2"]
    });
    expect(removeDocumentTagsMock).toHaveBeenCalledWith(["doc-1", "doc-2"], "user-1", ["legal", "invoice"]);
  });

  it("preserves unexpected delete failures as server errors", async () => {
    app.onError(() => new Response("Internal Server Error", { status: 500 }));
    deleteDocumentMock.mockRejectedValue(new Error("database connection failed"));
    expect((await app.request("/documents/doc-1", { method: "DELETE" })).status).toBe(500);
  });
  it("answers 409 when a foreign key still references the document (SEC-2026-10-PROD-06)", async () => {
    deleteDocumentMock.mockRejectedValue(Object.assign(new Error("foreign key violation"), { code: "23503", constraint_name: "remote_media_jobs_document_id_fkey" }));
    expect((await app.request("/documents/doc-1", { method: "DELETE" })).status).toBe(409);
  });

  it("deletes a single document through the dedicated route", async () => {
    deleteDocumentMock.mockResolvedValue({
      documentId: "doc-1",
      workspaceId: "ws-1",
      filename: "contract.pdf",
      runId: "run-1",
      sourceKey: "uploads/contract.pdf"
    });

    const response = await app.request("/documents/doc-1", {
      method: "DELETE"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      documentId: "doc-1",
      workspaceId: "ws-1",
      filename: "contract.pdf",
      runId: "run-1",
      sourceKey: "uploads/contract.pdf"
    });
    expect(deleteDocumentMock).toHaveBeenCalledWith("doc-1", "user-1");
    const audit = appendAuditLogMock.mock.calls.at(-1)?.[0];
    expect(audit.resourceId).toBe("doc-1");
    expect(audit.documentId).toBeUndefined();
  });
});

describe("documentsRoutes API key content updates", () => {
  beforeEach(() => {
    deleteDocumentMock.mockReset();
    deleteDocumentsMock.mockReset();
    setDocumentTagsMock.mockReset();
    bulkReprocessDocumentsMock.mockReset();
    exportDocumentArtifactsMock.mockReset();
    listDocumentOwnersMock.mockReset();
    appendAuditLogMock.mockReset();
    listDocumentOwnersMock.mockImplementation(async (ids: string[]) => ids
      .filter((id) => id !== "missing")
      .map((id) => ({ id, workspaceId: id === "doc-other" ? "ws-2" : "ws-1", orgId: id === "doc-foreign" ? "org-2" : "org-1" })));
    deleteDocumentMock.mockResolvedValue({ documentId: "doc-1", workspaceId: "ws-1", filename: "a.md", runId: "run-1", sourceKey: "k" });
    deleteDocumentsMock.mockResolvedValue(2);
    setDocumentTagsMock.mockResolvedValue(["docs"]);
  });
  const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("lets an ingest server key delete, retag and bulk-update documents, attributed to the key", async () => {
    const app = buildApp({ scopes: ["ingest"] });
    expect((await app.request("/documents/doc-1", { method: "DELETE" })).status).toBe(200);
    expect(appendAuditLogMock).toHaveBeenLastCalledWith(expect.objectContaining({ action: "document.deleted", apiKeyId: "key-1" }));
    expect((await app.request("/documents/doc-1/tags", json("PUT", { tags: ["docs"] }))).status).toBe(200);
    expect(setDocumentTagsMock).toHaveBeenCalledWith("doc-1", "user-1", ["docs"]);
    const bulk = await app.request("/documents/bulk", json("POST", { action: "delete", documentIds: ["doc-1", "doc-2"] }));
    expect(bulk.status).toBe(200);
    expect(deleteDocumentsMock).toHaveBeenCalledWith(["doc-1", "doc-2"], "user-1");
    expect(appendAuditLogMock).toHaveBeenLastCalledWith(expect.objectContaining({ action: "documents.deleted", apiKeyId: "key-1" }));
  });

  it.each([
    ["a search-only server key", { scopes: ["search"] }],
    ["an artifacts-only server key", { scopes: ["artifacts"] }],
    ["a client key, even with ingest", { scopes: ["ingest"], keyType: "client" }],
  ])("rejects %s", async (_label, key) => {
    const app = buildApp(key);
    expect((await app.request("/documents/doc-1", { method: "DELETE" })).status).toBe(403);
    expect((await app.request("/documents/doc-1/tags", json("PUT", { tags: [] }))).status).toBe(403);
    expect((await app.request("/documents/bulk", json("POST", { action: "reprocess", documentIds: ["doc-1"] }))).status).toBe(403);
    expect(deleteDocumentMock).not.toHaveBeenCalled();
    expect(setDocumentTagsMock).not.toHaveBeenCalled();
    expect(bulkReprocessDocumentsMock).not.toHaveBeenCalled();
  });

  it("answers 404 before any change when a document is outside the key's organization or workspaces", async () => {
    const restricted = buildApp({ scopes: ["ingest"], workspaceIds: ["ws-1"] });
    for (const ids of [["doc-1", "doc-foreign"], ["doc-1", "doc-other"], ["missing"]]) {
      expect((await restricted.request("/documents/bulk", json("POST", { action: "delete", documentIds: ids }))).status).toBe(404);
    }
    expect((await restricted.request("/documents/doc-foreign", { method: "DELETE" })).status).toBe(404);
    expect((await restricted.request("/documents/doc-other/tags", json("PUT", { tags: [] }))).status).toBe(404);
    expect(deleteDocumentsMock).not.toHaveBeenCalled();
    expect(deleteDocumentMock).not.toHaveBeenCalled();
    expect(setDocumentTagsMock).not.toHaveBeenCalled();
  });

  it("keeps bulk artifact export on the artifacts scope", async () => {
    exportDocumentArtifactsMock.mockResolvedValue({});
    const body = json("POST", { action: "export-artifacts", documentIds: ["doc-1"] });
    expect((await buildApp({ scopes: ["ingest"] }).request("/documents/bulk", body)).status).toBe(403);
    expect((await buildApp({ scopes: ["artifacts"] }).request("/documents/bulk", json("POST", { action: "export-artifacts", documentIds: ["doc-1"] }))).status).toBe(200);
  });

  it("declares the content-update routes as API-key routes", async () => {
    const { listRouteAuthModes } = await import("../lib/route-auth.js");
    const modes = Object.fromEntries(listRouteAuthModes(documentsRoutes).map((route) => [`${route.method} ${route.path}`, route.mode]));
    expect(modes["DELETE /:docId"]).toBe("apiKey");
    expect(modes["PUT /:docId/tags"]).toBe("apiKey");
    expect(modes["POST /bulk"]).toBe("apiKey");
    expect(modes["PUT /:docId/correction-workbench"]).toBe("session");
  });
});
