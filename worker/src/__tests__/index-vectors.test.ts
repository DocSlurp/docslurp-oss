import { describe, expect, it } from "vitest";

import { decodeLanceChunkHydration } from "@docslurp/shared/lancedb-hydration";

import {
  buildVectorIndexSearchMetadata,
  buildVectorRecords,
  vectorBackendCollectionName
} from "../stages/index-vectors.js";
import { workspaceVectorLocation } from "../stages/lancedb-location.js";

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
  it("uses a plain chunks table inside the workspace's database", () => {
    expect(vectorBackendCollectionName({
      backend: "lancedb", orgId: "org-a", workspaceId: "ws-1", runId: "run",
    })).toBe("chunks");
  });

  it("fails closed when LanceDB indexing has no org or workspace id", () => {
    for (const scope of [{ orgId: null, workspaceId: "ws-1" }, { orgId: "org-a", workspaceId: null }, { orgId: "org-a" }]) {
      expect(() => vectorBackendCollectionName({ backend: "lancedb", runId: "run-123", ...scope }))
        .toThrow("LanceDB vector indexing requires the run's orgId and workspaceId");
    }
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

describe("workspaceVectorLocation", () => {
  it("resolves the run's workspace database and fails closed without its ids", () => {
    expect(workspaceVectorLocation({ orgId: "org-a", workspaceId: "ws-1" }, { model: "m/x", dimensions: 4 }, "/data"))
      .toEqual({ uri: "/data/org-a/ws-1/vectors-m%2Fx-4", table: "chunks" });
    expect(() => workspaceVectorLocation({ orgId: "org-a" }, { model: "m", dimensions: 4 }, "/data")).toThrow();
    expect(() => workspaceVectorLocation({ workspaceId: "ws-1", orgId: " " }, { model: "m", dimensions: 4 }, "/data")).toThrow();
  });
});

describe("buildVectorRecords", () => {
  const chunk = (documentId: string, index: number) => ({
    id: `${documentId}-${index.toString().padStart(3, "0")}`, index, text: `text ${index}`, vector: [index, 1],
    tokenEstimate: 3, headingPath: ["H"], pageNumber: 2, metadata: { documentId, locator: "x" },
  });

  it("keeps a document's own artifact ids", () => {
    const records = buildVectorRecords({ documentId: "doc", chunks: [chunk("doc", 0)] }, "doc", {}, "run-1");
    expect(records[0]).toMatchObject({ id: "doc-000", documentId: "doc", runId: "run-1" });
  });

  it("rebinds another document's artifact to this document's own chunk ids by chunk index", () => {
    // A partial reprocess or older copy has random chunk ids; index 7 has no chunk here.
    const chunkIds = new Map([[0, "9b2f-uuid"]]);
    const records = buildVectorRecords({ documentId: "src", chunks: [chunk("src", 0), chunk("src", 7)] }, "copy", { filename: "c.pdf" }, "run-copy", chunkIds);
    expect(records.map((record) => record.id)).toEqual(["9b2f-uuid"]);
    expect(records[0]).toMatchObject({ documentId: "copy", runId: "run-copy", chunkIndex: 0 });
    expect(records[0]!.metadata).toMatchObject({ documentId: "copy", filename: "c.pdf" });
    expect(decodeLanceChunkHydration(records[0]!.hydration)).toMatchObject({ runId: "run-copy", metadata: { documentId: "copy", locator: "x" } });
  });
});
