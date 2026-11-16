import { OrgScopeRequiredError } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import { embeddingCacheKey } from "../search/embedding-cache.js";
import { resultCacheKey } from "../search/result-cache.js";

/** Organization isolation: the search caches' keys bind the organization and refuse to build without one. */
const identity = { provider: "openrouter", runtime: "remote", model: "m", dimensions: 8, normalize: true };
const result = { targets: [{ uri: "s3://b/org/p", name: "chunks", version: 3 }], queryVector: [0.1, 0.2], limit: 10, tuning: [{}] };

describe("org-scoped search cache keys", () => {
  it("never give two organizations the same key for identical inputs", () => {
    expect(embeddingCacheKey({ ...identity, orgId: "org-a" }, "q")).not.toBe(embeddingCacheKey({ ...identity, orgId: "org-b" }, "q"));
    expect(resultCacheKey({ ...result, orgId: "org-a" })).not.toBe(resultCacheKey({ ...result, orgId: "org-b" }));
  });

  it.each(["", "  ", null, undefined])("refuse a missing organization (%j)", (orgId) => {
    expect(() => embeddingCacheKey({ ...identity, orgId: orgId as string }, "q")).toThrow(OrgScopeRequiredError);
    expect(() => resultCacheKey({ ...result, orgId: orgId as string })).toThrow(OrgScopeRequiredError);
  });
});
