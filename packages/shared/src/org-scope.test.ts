import { describe, expect, it } from "vitest";

import { OrgScopeRequiredError, orgScopedCacheKey, requireOrgId } from "./org-scope.js";

describe("orgScopedCacheKey", () => {
  it("never gives two organizations the same key for identical inputs", () => {
    const parts = ["doc.pdf", { sha256: "abc" }, [1, 2, 3]];
    expect(orgScopedCacheKey("org-a", "ns", ...parts)).not.toBe(orgScopedCacheKey("org-b", "ns", ...parts));
    expect(orgScopedCacheKey("org-a", "ns", ...parts)).toBe(orgScopedCacheKey("org-a", "ns", ...parts));
  });

  it("separates namespaces and resists part-boundary collisions", () => {
    expect(orgScopedCacheKey("org-a", "embedding", "x")).not.toBe(orgScopedCacheKey("org-a", "ocr", "x"));
    expect(orgScopedCacheKey("org-a", "ns", "a,b")).not.toBe(orgScopedCacheKey("org-a", "ns", "a", "b"));
    // An org id cannot smuggle another org's prefix through the namespace or parts.
    expect(orgScopedCacheKey("org-a", "ns", "org-b")).not.toBe(orgScopedCacheKey("org-b", "ns", "org-a"));
  });

  it.each([undefined, null, "", "   ", 42, {}, ["org-a"]])("refuses a missing or malformed organization: %j", (orgId) => {
    expect(() => orgScopedCacheKey(orgId, "ns", "x")).toThrow(OrgScopeRequiredError);
    expect(() => requireOrgId(orgId)).toThrow(OrgScopeRequiredError);
  });

  it("treats surrounding whitespace as the same organization", () => {
    expect(requireOrgId(" org-a ")).toBe("org-a");
    expect(orgScopedCacheKey(" org-a", "ns")).toBe(orgScopedCacheKey("org-a", "ns"));
  });
});
