import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../db.js", () => { const sql = Object.assign(vi.fn(async () => []), { begin: vi.fn(async (fn: (sql: unknown) => unknown) => fn(sql)) }); return { sql }; });
vi.mock("../lib/temporal.js", () => ({ startPageRenderWorkflow: vi.fn() }));
vi.mock("../services/documents.js", () => ({ getDocumentViewerPayload: vi.fn() }));
vi.mock("../services/organizations.js", () => ({ getWorkspaceAccess: vi.fn(), canEditWorkspace: vi.fn() }));
vi.mock("../services/billing/spend-guard.js", () => ({ assertCanSpend: vi.fn() }));
import { getDocumentViewerPayload } from "../services/documents.js";
import { getWorkspaceAccess, canEditWorkspace } from "../services/organizations.js";
import { startPageRenderWorkflow } from "../lib/temporal.js";
import { requestDocumentPageRender } from "../services/document-page-render.js";
const viewer = { document: { id: "doc", runId: "run", orgId: "org", workspaceId: "workspace", mimeType: "application/pdf", status: "completed", pageCount: 3 }, artifacts: [], source: { url: "/source" } };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getDocumentViewerPayload).mockResolvedValue(structuredClone(viewer) as never); vi.mocked(getWorkspaceAccess).mockResolvedValue({} as never); vi.mocked(canEditWorkspace).mockReturnValue(true); });
describe("exact page image requests", () => {
  it("never queues reads, missing pages, withheld sources or read-only users", async () => {
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {})).toEqual({ status: "pending" });
    expect(await requestDocumentPageRender("doc", 4, "user", true, () => {})).toEqual({ status: "missing" });
    expect(await requestDocumentPageRender("doc", 0, "user", true, () => {})).toEqual({ status: "missing" });
    vi.mocked(canEditWorkspace).mockReturnValue(false);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "missing" });
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, source: { url: "" } } as never);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "unavailable" });
    expect(startPageRenderWorkflow).not.toHaveBeenCalled();
  });
  it("authorizes cached images before returning signed URLs", async () => {
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:page-3", url: "/signed", uri: "s3://page" }] } as never);
    await expect(requestDocumentPageRender("doc", 3, "user", false, () => { throw new Error("scope"); })).rejects.toThrow("scope");
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {})).toMatchObject({ status: "ready", artifact: { slot: "doc:page-3" } });
    expect(startPageRenderWorkflow).not.toHaveBeenCalled();
  });
  it("queues only the exact authorized known page", async () => {
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "pending" });
    expect(startPageRenderWorkflow).toHaveBeenCalledWith({ documentId: "doc", runId: "run", pageNumber: 3 });
  });
});
