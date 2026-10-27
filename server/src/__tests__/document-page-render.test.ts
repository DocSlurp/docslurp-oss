import { beforeEach, describe, expect, it, vi } from "vitest";
const dbMock = vi.hoisted(() => ({ capacity: null as { count: number; own: boolean } | null, calls: [] as Array<[TemplateStringsArray, ...unknown[]]> }));
vi.mock("../db.js", () => { const sql = Object.assign(vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { dbMock.calls.push([strings, ...values]); if (strings.join("").includes("insert into document_page_renders")) return [{generation:"2026-10-23 12:00:00+00"}]; return strings.join("").includes("count(*)") && dbMock.capacity ? [dbMock.capacity] : []; }), { begin: vi.fn(async (fn: (sql: unknown) => unknown) => fn(sql)) }); return { sql }; });
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
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {})).toMatchObject({ status: "pending" });
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
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:raster-v3-reader-120dpi-page-3", url: "/signed", uri: "s3://page" }] } as never);
    await expect(requestDocumentPageRender("doc", 3, "user", false, () => { throw new Error("scope"); })).rejects.toThrow("scope");
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {})).toMatchObject({ status: "ready", artifact: { slot: "doc:page-3" } });
    expect(startPageRenderWorkflow).not.toHaveBeenCalled();
  });
  it("reuses authorized existing reader pixels but never treats them as a policy-specific PNG export", async () => {
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:page-3", url: "/120dpi", uri: "s3://old" }, { slot: "doc:raster-v2-reader-page-3", url: "/200dpi", uri: "s3://reader" }] } as never);
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {}, "export")).toMatchObject({ status: "pending" });
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:page-3", url: "/150dpi", uri: "s3://old" }] } as never);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toMatchObject({ status: "ready" });
    expect(startPageRenderWorkflow).not.toHaveBeenCalled();
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
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:raster-v3-reader-120dpi-page-3", url: "/signed", uri: "s3://page" }] } as never);
    vi.mocked(canEditWorkspace).mockReturnValue(false);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "missing" });
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {})).toMatchObject({ status: "ready" });
  });
  it("queues only the exact authorized known page", async () => {
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toMatchObject({ status: "pending" });
    expect(startPageRenderWorkflow).toHaveBeenCalledWith({ documentId: "doc", runId: "run", pageNumber: 3, quality: "reader", dpi:120 });
  });
});

it("gives every organization the same reader resolution and the sharper export", async () => {
  // A cached 120-DPI export is not the sharper image: the export still renders at 250.
  vi.mocked(getDocumentViewerPayload).mockResolvedValue({
    ...viewer,
    artifacts: [{ slot: "doc:raster-v3-export-120dpi-page-3", url: "/old-export" }],
  } as never);
  expect(await requestDocumentPageRender("doc", 3, "user", false, () => {}, "reader")).toMatchObject({
    status: "pending",
    dpi: 120,
    capabilities: { sharperImage: true, exportDpi: 250 },
  });
  expect(await requestDocumentPageRender("doc", 3, "user", false, () => {}, "export")).toMatchObject({
    status: "pending",
    dpi: 250,
  });
  // Quality never depends on the organization's billing state: nothing reads it.
  expect(dbMock.calls.some((call) => call[0].join("").includes("funded_at"))).toBe(false);
});

it("reuses authorized legacy reader pixels without claiming a DPI or queuing a downgrade", async () => {
  vi.mocked(getDocumentViewerPayload).mockResolvedValue({
    ...viewer,
    artifacts: [{ slot: "doc:raster-v2-reader-page-3", url: "/old-200dpi" }],
  } as never);
  const result = await requestDocumentPageRender(
    "doc",
    3,
    "user",
    true,
    () => {},
  );
  expect(result).toMatchObject({
    status: "ready",
    capabilities: { sharperImage: true },
  });
  expect(result).not.toHaveProperty("dpi");
  expect(startPageRenderWorkflow).not.toHaveBeenCalled();
});
