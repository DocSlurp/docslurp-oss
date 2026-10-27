import { describe, expect, it } from "vitest";

import { VectorNamespaceManager } from "../vector-namespace.js";

describe("VectorNamespaceManager", () => {
  it("gives each workspace its own database per embedding model and dimensions", () => {
    expect(VectorNamespaceManager.getEmbeddingLocation("s3://bucket/index/", "org-a", "ws-1", "Xenova/all-MiniLM-L6-v2", 384)).toEqual({
      uri: "s3://bucket/index/org-a/ws-1/vectors-Xenova%2Fall-MiniLM-L6-v2-384",
      table: "chunks",
    });
    const a = VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "ws-1", "small", 384).uri;
    expect(VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "ws-2", "small", 384).uri).not.toBe(a);
    expect(VectorNamespaceManager.getEmbeddingLocation("/data", "org-b", "ws-1", "small", 384).uri).not.toBe(a);
    expect(VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "ws-1", "small", 768).uri).not.toBe(a);
    expect(VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "ws-1", "small-2", 384).uri).not.toBe(a);
  });

  it("keeps every database of a workspace under its workspace root", () => {
    const root = VectorNamespaceManager.getWorkspaceRoot("/data/", "org-a", "ws-1");
    expect(root).toBe("/data/org-a/ws-1");
    expect(VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "ws-1", "m", 8).uri.startsWith(`${root}/`)).toBe(true);
  });

  it("encodes model ids losslessly without path traversal", () => {
    const uri = VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "ws-1", "../model", 384).uri;
    expect(uri).toBe("/data/org-a/ws-1/vectors-%2E%2E%2Fmodel-384");
    expect(VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "ws-1", "a/b", 4).uri)
      .not.toBe(VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "ws-1", "a_b", 4).uri);
  });

  it("rejects unsafe or blank org and workspace ids instead of sharing a namespace", () => {
    expect(() => VectorNamespaceManager.getEmbeddingLocation("/data", "../other-org", "ws-1", "m", 4)).toThrow();
    expect(() => VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "../ws", "m", 4)).toThrow();
    expect(() => VectorNamespaceManager.getEmbeddingLocation("/data", "", "ws-1", "m", 4)).toThrow();
    expect(() => VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "", "m", 4)).toThrow();
    expect(() => VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "ws-1", " ", 4)).toThrow();
    expect(() => VectorNamespaceManager.getEmbeddingLocation("/data", "org-a", "ws-1", "m", 0)).toThrow();
  });
});
