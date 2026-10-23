import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ render: vi.fn(), persist: vi.fn(), clear: vi.fn(), receipts: [] as any[] }));
vi.mock("../pipeline/pdf-asset-cache.js", () => ({ PdfRasterCache: class { renderSelectedPages = mocks.render; }, PdfSourceCache: class { clear = mocks.clear; } }));
vi.mock("../db/usage-event-store.js", () => ({ persistScopedUsageEvents: mocks.persist }));
import { renderDocumentPage } from "./render-page.js";
const document = { id: "doc", runId: "run", userId: "owner", mimeType: "application/pdf", status: "completed", pageCount: 3 };
function setup(options: { withheld?: boolean; deleted?: boolean; failCommit?: boolean; existing?: string } = {}) {
  const artifacts: Record<string, string> = {};
  const sql = Object.assign(vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("select d.org_id")) return [{ org_id: "org", workspace_id: "workspace", withheld: options.withheld ?? false, existing: options.existing }];
    if (query.includes("select id from documents")) return options.deleted ? [] : [{ id: "doc" }];
    if (query.includes("update workspace_runs")) Object.assign(artifacts, values[0]);
    return [];
  }), { json: (value: unknown) => value, begin: vi.fn(async (fn: (sql: unknown) => Promise<void>) => { if (options.failCommit) throw new Error("transaction failed"); await fn(sql); }) });
  return { artifacts, deps: { store: { stageSql: sql, loadDocument: vi.fn(async () => document) }, runner: {}, storage: {} } as never };
}
beforeEach(() => { vi.clearAllMocks(); mocks.receipts.length = 0; mocks.persist.mockImplementation(async (input: unknown) => { mocks.receipts.push(structuredClone({ ...(input as any), client: undefined })); }); vi.stubEnv("STRIPE_SECRET_KEY", ""); vi.stubEnv("DOCSLURP_BILL_COMPUTE", "false"); vi.stubEnv("DOCSLURP_BILL_STORAGE", "false"); mocks.render.mockImplementation(async ({ pageNumbers }: { pageNumbers: number[] }) => { await new Promise(resolve => setTimeout(resolve, 5)); return [{ artifactUri: `s3://page-${pageNumbers[0]}`, cacheHit: false }]; }); });
describe("lazy PDF worker rendering", () => {
  it("refuses withheld, missing and out-of-bounds pages before rasterizing", async () => {
    await expect(renderDocumentPage(setup({ withheld: true }).deps, { documentId: "doc", runId: "run", pageNumber: 1 })).rejects.toThrow("unavailable");
    await expect(renderDocumentPage(setup().deps, { documentId: "doc", runId: "run", pageNumber: 4 })).rejects.toThrow("not renderable");
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("merges concurrent different pages and records scoped stable usage receipts", async () => {
    const { deps, artifacts } = setup();
    await Promise.all([1, 3].map(pageNumber => renderDocumentPage(deps, { documentId: "doc", runId: "run", pageNumber })));
    expect(artifacts).toEqual({ "doc:page-1": "s3://page-1", "doc:page-3": "s3://page-3", "doc:raster-v2-reader-page-1": "s3://page-1", "doc:raster-v2-reader-page-3": "s3://page-3" });
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    const first = mocks.receipts[0];
    expect(first.scope).toEqual({ orgId: "org", workspaceId: "workspace" });
    await renderDocumentPage(setup().deps, { documentId: "doc", runId: "run", pageNumber: 1 });
    expect(mocks.receipts[2].usageEvents[0].id).toBe(first.usageEvents[0].id);
    expect(mocks.clear).toHaveBeenCalledTimes(3);
  });
  it("does not publish or persist usage when the document was deleted or commit fails", async () => {
    await expect(renderDocumentPage(setup({ deleted: true }).deps, { documentId: "doc", runId: "run", pageNumber: 1 })).rejects.toThrow("unavailable");
    await expect(renderDocumentPage(setup({ failCommit: true }).deps, { documentId: "doc", runId: "run", pageNumber: 1 })).rejects.toThrow("transaction failed");
    expect(mocks.persist).not.toHaveBeenCalled();
    await renderDocumentPage(setup().deps, { documentId: "doc", runId: "run", pageNumber: 1 });
    expect(mocks.persist).toHaveBeenCalledOnce();
  });
  it("separates export receipts and renders the exact page at its selected quality", async () => {
    await renderDocumentPage(setup().deps, { documentId: "doc", runId: "run", pageNumber: 3 });
    await renderDocumentPage(setup().deps, { documentId: "doc", runId: "run", pageNumber: 3, quality: "export" });
    expect(mocks.render.mock.calls.map(call => [call[0].pageNumbers, call[0].dpi])).toEqual([[[3], 200], [[3], 300]]);
    expect(mocks.receipts[0].usageEvents[0].id).not.toBe(mocks.receipts[1].usageEvents[0].id);
  });
  it("does not publish or bill a render cancelled before publication", async () => {
    const controller = new AbortController();
    mocks.render.mockImplementationOnce(async () => { controller.abort(); return [{ artifactUri: "s3://cancelled" }]; });
    const { deps, artifacts } = setup();
    await expect(renderDocumentPage(deps, { documentId: "doc", runId: "run", pageNumber: 3 }, controller.signal)).rejects.toThrow();
    expect(artifacts).toEqual({});
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("does no work for an already-published image", async () => {
    await renderDocumentPage(setup({ existing: "s3://page-1" }).deps, { documentId: "doc", runId: "run", pageNumber: 1 });
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
