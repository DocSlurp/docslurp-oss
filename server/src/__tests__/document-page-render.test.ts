import { beforeEach, describe, expect, it, vi } from "vitest";
const dbMock = vi.hoisted(() => ({ capacity: null as { count: number; own: boolean } | null, calls: [] as Array<[TemplateStringsArray, ...unknown[]]> }));
vi.mock("../db.js", () => { const sql = Object.assign(vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { dbMock.calls.push([strings, ...values]); return strings.join("").includes("count(*)") && dbMock.capacity ? [dbMock.capacity] : []; }), { begin: vi.fn(async (fn: (sql: unknown) => unknown) => fn(sql)) }); return { sql }; });
vi.mock("../lib/temporal.js", () => ({ startPageRenderWorkflow: vi.fn() }));
vi.mock("../services/documents.js", () => ({ getDocumentViewerPayload: vi.fn() }));
vi.mock("../services/organizations.js", () => ({ getWorkspaceAccess: vi.fn(), canEditWorkspace: vi.fn() }));
vi.mock("../services/billing/spend-guard.js", () => ({ assertCanSpend: vi.fn() }));
import { getDocumentViewerPayload } from "../services/documents.js";
import { getWorkspaceAccess, canEditWorkspace } from "../services/organizations.js";
import { startPageRenderWorkflow } from "../lib/temporal.js";
import { requestDocumentPageRender } from "../services/document-page-render.js";
const viewer = { document: { id: "doc", runId: "run", orgId: "org", workspaceId: "workspace", mimeType: "application/pdf", status: "completed", pageCount: 3 }, artifacts: [], source: { url: "/source" } };
beforeEach(() => { vi.clearAllMocks(); dbMock.capacity = null; dbMock.calls.length = 0; vi.mocked(getDocumentViewerPayload).mockResolvedValue(structuredClone(viewer) as never); vi.mocked(getWorkspaceAccess).mockResolvedValue({} as never); vi.mocked(canEditWorkspace).mockReturnValue(true); });
describe("exact page image requests", () => {
  it("never queues reads, missing pages, withheld sources or read-only users", async () => {
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {})).toEqual({ status: "pending" });
    expect(await requestDocumentPageRender("doc", 4, "user", true, () => {})).toEqual({ status: "missing" });
    expect(await requestDocumentPageRender("doc", 0, "user", true, () => {})).toEqual({ status: "missing" });
    vi.mocked(canEditWorkspace).mockReturnValue(false);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "missing" });
    vi.mocked(canEditWorkspace).mockReturnValue(true);
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, source: { url: "" } } as never);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "unavailable" });
    expect(startPageRenderWorkflow).not.toHaveBeenCalled();
  });
  it("authorizes cached images before returning signed URLs", async () => {
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:raster-v2-reader-page-3", url: "/signed", uri: "s3://page" }] } as never);
    await expect(requestDocumentPageRender("doc", 3, "user", false, () => { throw new Error("scope"); })).rejects.toThrow("scope");
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {})).toMatchObject({ status: "ready", artifact: { slot: "doc:page-3" } });
    expect(startPageRenderWorkflow).not.toHaveBeenCalled();
  });
  it("upgrades legacy cached images and never treats reader pixels as a PNG export", async () => {
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:page-3", url: "/120dpi", uri: "s3://old" }, { slot: "doc:raster-v2-reader-page-3", url: "/200dpi", uri: "s3://reader" }] } as never);
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {}, "export")).toEqual({ status: "pending" });
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:page-3", url: "/150dpi", uri: "s3://old" }] } as never);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "pending" });
    expect(startPageRenderWorkflow).toHaveBeenCalledOnce();
  });
  it("shares the eight-request organization limit across render qualities", async () => {
    dbMock.capacity = { count: 8, own: false };
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {}, "export")).toEqual({ status: "busy" });
    expect(startPageRenderWorkflow).not.toHaveBeenCalled();
    const query = dbMock.calls.find(call => call[0].join("").includes("count(*)"))!;
    expect(query[0].join("")).toContain("and quality=");
    expect(query).toContain("export");
  });
  it("requires editor access even when a POST could return cached pixels", async () => {
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:raster-v2-reader-page-3", url: "/signed", uri: "s3://page" }] } as never);
    vi.mocked(canEditWorkspace).mockReturnValue(false);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "missing" });
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {})).toMatchObject({ status: "ready" });
  });
  it("queues only the exact authorized known page", async () => {
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "pending" });
    expect(startPageRenderWorkflow).toHaveBeenCalledWith({ documentId: "doc", runId: "run", pageNumber: 3, quality: "reader" });
  });
});
