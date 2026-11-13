import { beforeEach, describe, expect, it, vi } from "vitest";
const dbMock = vi.hoisted(() => ({ capacity: null as { count: number; own: boolean } | null, decision: null as Record<string, unknown> | null, metadata: {} as unknown, calls: [] as Array<[TemplateStringsArray, ...unknown[]]> }));
vi.mock("../db.js", () => { const sql = Object.assign(vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { dbMock.calls.push([strings, ...values]); if (strings.join("").includes("insert into document_page_renders")) return [{generation:"2026-10-23 12:00:00+00"}]; if (strings.join("").includes("parse_source_scan_version")) return dbMock.decision ? [dbMock.decision] : []; if (strings.join("").includes("select status, metadata from documents")) return [{ status: "completed", metadata: dbMock.metadata }]; return strings.join("").includes("count(*)") && dbMock.capacity ? [dbMock.capacity] : []; }), { begin: vi.fn(async (fn: (sql: unknown) => unknown) => fn(sql)) }); return { sql }; });
vi.mock("../lib/temporal.js", () => ({ startPageRenderWorkflow: vi.fn() }));
vi.mock("../services/documents.js", () => ({ getDocumentViewerPayload: vi.fn() }));
vi.mock("../services/organizations.js", () => ({ getProjectAccess: vi.fn(), canEditProject: vi.fn() }));
vi.mock("../services/billing/spend-guard.js", () => ({ assertCanSpend: vi.fn() }));
import { getDocumentViewerPayload } from "../services/documents.js";
import { getProjectAccess, canEditProject } from "../services/organizations.js";
import { startPageRenderWorkflow } from "../lib/temporal.js";
import { requestDocumentPageRender } from "../services/document-page-render.js";
const viewer = { document: { id: "doc", runId: "run", orgId: "org", projectId: "project", mimeType: "application/pdf", status: "completed", pageCount: 3 }, artifacts: [], source: { url: "/source" } };
const decided = { source_sha256: "a".repeat(64), parse_source_key: null, parse_source_sha256: "a".repeat(64), parse_source_scan_version: 1 };
beforeEach(() => { vi.clearAllMocks(); dbMock.capacity = null; dbMock.decision = { ...decided }; dbMock.metadata = {}; dbMock.calls.length = 0; vi.mocked(getDocumentViewerPayload).mockResolvedValue(structuredClone(viewer) as never); vi.mocked(getProjectAccess).mockResolvedValue({} as never); vi.mocked(canEditProject).mockReturnValue(true); });
describe("page-scoped PII", () => {
  const scoped = { pii: { scope: "pages", withheldPages: [2], withheldArtifactUris: ["s3://bucket/source"] } };
  it("never serves or queues a withheld page, even with cached pixels", async () => {
    dbMock.metadata = scoped;
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:raster-v3-reader-120dpi-page-2", url: "/signed", uri: "s3://page" }] } as never);
    expect(await requestDocumentPageRender("doc", 2, "user", false, () => {})).toEqual({ status: "unavailable" });
    expect(await requestDocumentPageRender("doc", 2, "user", true, () => {})).toEqual({ status: "unavailable" });
    expect(startPageRenderWorkflow).not.toHaveBeenCalled();
  });
  it("renders a clean page of a partly withheld PDF although its source is withheld", async () => {
    dbMock.metadata = scoped;
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, source: { url: "", withheld: true } } as never);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toMatchObject({ status: "pending" });
    expect(startPageRenderWorkflow).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 3 }));
  });
  it("fails closed on a blocked or malformed outcome, and a withheld source without page scope stays unrenderable", async () => {
    for (const metadata of [{ pii: { blocked: true } }, { pii: { scope: "pages", withheldPages: "2" } }]) {
      dbMock.metadata = metadata;
      expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "unavailable" });
    }
    dbMock.metadata = { pii: { scope: "sections", withheldSectionCount: 1 } };
    vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, source: { url: "", withheld: true } } as never);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "unavailable" });
    expect(startPageRenderWorkflow).not.toHaveBeenCalled();
  });
});
describe("exact page image requests", () => {
  it("never queues reads, missing pages, withheld sources or read-only users", async () => {
    expect(await requestDocumentPageRender("doc", 3, "user", false, () => {})).toMatchObject({ status: "pending" });
    expect(await requestDocumentPageRender("doc", 4, "user", true, () => {})).toEqual({ status: "missing" });
    expect(await requestDocumentPageRender("doc", 0, "user", true, () => {})).toEqual({ status: "missing" });
    vi.mocked(canEditProject).mockReturnValue(false);
    expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "missing" });
    vi.mocked(canEditProject).mockReturnValue(true);
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
    vi.mocked(canEditProject).mockReturnValue(false);
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
describe("PR #339 rescan", () => {
  it("PR #339: a document quarantined before the current scan reports rescan-required instead of queueing a render it cannot do", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const decision of [{ ...decided, parse_source_scan_version: null, parse_source_sha256: null }, { ...decided, parse_source_sha256: null }, { ...decided, parse_source_sha256: "c".repeat(64) }]) {
        dbMock.decision = decision;
        expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toEqual({ status: "rescan-required", documentId: "doc" });
        expect(await requestDocumentPageRender("doc", 3, "user", false, () => {})).toEqual({ status: "rescan-required", documentId: "doc" });
      }
      // Cached pixels still serve.
      vi.mocked(getDocumentViewerPayload).mockResolvedValue({ ...viewer, artifacts: [{ slot: "doc:raster-v3-reader-120dpi-page-3", url: "/signed", uri: "s3://page" }] } as never);
      expect(await requestDocumentPageRender("doc", 3, "user", true, () => {})).toMatchObject({ status: "ready" });
    } finally {
      warn.mockRestore();
    }
    expect(startPageRenderWorkflow).not.toHaveBeenCalled();
  });
});
