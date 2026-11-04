import type { SearchFilters } from "./filters.js";
import { describe, expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({ sql: Object.assign(() => [], { array: (value: unknown) => value }), apiPool: {} }));
import { ilikeContainsMatcher, nativeScopeSupported, scopeEligibleDocuments } from "./eligible-documents.js";
import { escapeLikePattern } from "./filters.js";

describe("native filter capabilities", () => {
  it("allows only explicitly implemented document filters", () => {
    expect(nativeScopeSupported(undefined)).toBe(true);
    expect(nativeScopeSupported({ workspaceId: "workspace", documentIds: ["document"], tags: ["tag"] })).toBe(true);
    expect(nativeScopeSupported({ language: "en" })).toBe(false);
    expect(nativeScopeSupported({ pageRange: { from: 1 } })).toBe(false);
  });
  it("fails closed for future filters, including geo", () => {
    const filters: SearchFilters = { workspaceId: "workspace", geo: { field: "site", op: "bbox", bbox: [0, 0, 1, 1] } };
    expect(nativeScopeSupported(filters)).toBe(false);
    const future = { workspaceId: "workspace", futurePredicate: {} };
    expect(nativeScopeSupported(future)).toBe(false);
  });
  it("matches filenameContains literally and filenameEquals exactly", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    expect(ilikeContainsMatcher(escapeLikePattern("%"))("report.pdf")).toBe(false);
    expect(ilikeContainsMatcher(escapeLikePattern("report_1"))("report11.pdf")).toBe(false);
    expect(ilikeContainsMatcher(escapeLikePattern("report_1"))("Q3 REPORT_1.pdf")).toBe(true);
    const documents = ["report_1.pdf", "report11.pdf", "%.pdf"].map((filename) => ({ id: filename, filename, mimeType: "application/pdf", tags: [], runId: "r" }));
    const set = { workspaceId: "w", documents } as unknown as Parameters<typeof scopeEligibleDocuments>[0];
    const ids = (filters: SearchFilters) => scopeEligibleDocuments(set, filters, undefined).map((document) => document.id);
    expect(ids({ filenameContains: "report_1" })).toEqual(["report_1.pdf"]);
    expect(ids({ filenameContains: "%" })).toEqual(["%.pdf"]);
    expect(ids({ filenameEquals: "report11.pdf" })).toEqual(["report11.pdf"]);
    expect(ids({ filenameEquals: "REPORT11.PDF" })).toEqual([]);
    expect(nativeScopeSupported({ filenameEquals: "a.pdf" })).toBe(true);
  });
});
