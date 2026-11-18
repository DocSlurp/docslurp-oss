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
  setDocumentTags: setDocumentTagsMock,
  DocumentMutationForbiddenError: class DocumentMutationForbiddenError extends Error {},
  DocumentDeletionPartialError: class DocumentDeletionPartialError extends Error {
    constructor(readonly deleted: Array<{ documentId: string }>, readonly remainingDocumentIds: string[], override readonly cause: unknown) { super("partial"); }
  },
}));

vi.mock("../services/document-review.js", () => ({
  getCorrectionWorkbench: vi.fn(),
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

function buildApp(apiKey?: { scopes: string[]; keyType?: string; orgId?: string; projectIds?: string[] }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1" } as never);
    if (apiKey) c.set("apiKey", { userId: "user-1", orgId: "org-1", keyType: "server", keyId: "key-1", projectIds: [], ...apiKey } as never);
    await next();
  });
  app.route("/documents", documentsRoutes);
  return app;
}

describe("documentsRoutes bulk actions", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    // Every listed document is readable here; who may change them is covered against a database (reprocess-editors-only).
    listDocumentOwnersMock.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id, projectId: "ws-1", orgId: "org-1" })));
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

  it("refuses more than 500 documents with a 400 and public copy, before any lookup", async () => {
    listDocumentOwnersMock.mockClear();
    const documentIds = Array.from({ length: 501 }, (_, i) => `doc-${i}`);
    const response = await app.request("/documents/bulk", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "apply-tags", documentIds, tags: ["t"] }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string; details: Record<string, unknown> } };
    expect(body.error).toMatchObject({ code: "invalid_request", details: { policy: "bulk_documents_limit", limit: 500 } });
    expect(body.error.message).toContain("at most 500");
    expect(listDocumentOwnersMock).not.toHaveBeenCalled();
    expect(deleteDocumentsMock).not.toHaveBeenCalled();
  });

  it("reports a delete that stopped part-way: what was deleted (audited) and what remains, retryable when busy", async () => {
    const { DocumentDeletionPartialError } = await import("../services/documents.js");
    const { HTTPException } = await import("hono/http-exception");
    appendAuditLogMock.mockClear();
    const busy = new HTTPException(503, { message: "busy" });
    deleteDocumentsMock.mockRejectedValue(new DocumentDeletionPartialError([{ documentId: "doc-1" }], ["doc-2", "doc-3"], busy));
    const response = await app.request("/documents/bulk", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", documentIds: ["doc-1", "doc-2", "doc-3"] }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    const body = await response.json() as { error: { details: Record<string, unknown> } };
    expect(body.error.details).toMatchObject({ policy: "bulk_delete_partial", deleted: 1, deletedDocumentIds: ["doc-1"], remainingDocumentIds: ["doc-2", "doc-3"] });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: "documents.deleted", resourceId: "doc-1", metadata: expect.objectContaining({ count: 1, documentIds: ["doc-1"] }) }));
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
      projectId: "ws-1",
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
      projectId: "ws-1",
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
      .map((id) => ({ id, projectId: id === "doc-other" ? "ws-2" : "ws-1", orgId: id === "doc-foreign" ? "org-2" : "org-1" })));
    deleteDocumentMock.mockResolvedValue({ documentId: "doc-1", projectId: "ws-1", filename: "a.md", runId: "run-1", sourceKey: "k" });
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

  it("answers 404 before any change when a document is outside the key's organization or projects", async () => {
    const restricted = buildApp({ scopes: ["ingest"], projectIds: ["ws-1"] });
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
