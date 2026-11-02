import { describe, expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({ sql: Object.assign(() => [], { array: (value: unknown) => value }), apiPool: {} }));
import { nativeScopeSupported } from "./eligible-documents.js";

describe("native filter capabilities", () => {
  it("allows only explicitly implemented document filters", () => {
    expect(nativeScopeSupported(undefined)).toBe(true);
    expect(nativeScopeSupported({ workspaceId: "workspace", documentIds: ["document"], tags: ["tag"] })).toBe(true);
    expect(nativeScopeSupported({ language: "en" })).toBe(false);
    expect(nativeScopeSupported({ pageRange: { from: 1 } })).toBe(false);
  });
  it("fails closed for future filters, including geo", () => {
    const filters = { workspaceId: "workspace", geo: { field: "site", op: "bbox", bbox: [0, 0, 1, 1] } };
    expect(nativeScopeSupported(filters)).toBe(false);
    const future = { workspaceId: "workspace", futurePredicate: {} };
    expect(nativeScopeSupported(future)).toBe(false);
  });
});
