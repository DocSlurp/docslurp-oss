import { describe, expect, it } from "vitest";

import {
  buildVectorIndexSearchMetadata,
  vectorBackendCollectionName
} from "../stages/index-vectors.js";

describe("buildVectorIndexSearchMetadata", () => {
  it("marks vector manifests as fully indexed search surfaces", () => {
    expect(buildVectorIndexSearchMetadata(12)).toEqual({
      mode: "full-index",
      searchableChunks: 12,
      fullyIndexed: true
    });
  });
});

describe("vectorBackendCollectionName", () => {
  it("uses a plain chunks table inside the org/model/dimension directory", () => {
    expect(vectorBackendCollectionName({
      backend: "lancedb", orgId: "org-a", runId: "run",
      embedding: { model: "small", dimensions: 384 },
    })).toBe("chunks");
  });

  it("uses the per-org LanceDB table instead of a run namespace", () => {
    const collection = vectorBackendCollectionName({
      backend: "lancedb",
      orgId: "org-123",
      runId: "run-123"
    });

    expect(collection).toMatch(/^chunks_org_[0-9a-f]{32}$/);
    expect(collection).not.toContain("org-123");
    expect(collection).not.toContain("run-123");
  });

  it("fails closed when LanceDB indexing has no org id", () => {
    expect(() =>
      vectorBackendCollectionName({
        backend: "lancedb",
        orgId: null,
        runId: "run-123"
      })
    ).toThrow("LanceDB vector indexing requires a run orgId");
  });

  it("keeps non-LanceDB backends run-scoped", () => {
    expect(
      vectorBackendCollectionName({
        backend: "orama",
        orgId: null,
        runId: "run-123"
      })
    ).toBe("run-123_orama");
  });
});
