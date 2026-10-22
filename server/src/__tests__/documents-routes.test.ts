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

function buildApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1" } as never);
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

  it.each([
    new Error("database connection failed"),
    Object.assign(new Error("foreign key violation"), { code: "23503", constraint_name: "remote_media_jobs_document_id_fkey" }),
  ])("preserves unexpected delete failures as server errors", async error => {
    app.onError(() => new Response("Internal Server Error", { status: 500 }));
    deleteDocumentMock.mockRejectedValue(error);
    expect((await app.request("/documents/doc-1", { method: "DELETE" })).status).toBe(500);
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
