import { describe, expect, it } from "vitest";

import { buildStorageIntegrityReport } from "../db/store.js";

describe("buildStorageIntegrityReport", () => {
  it("reports missing objects, orphaned objects, and dangling index metadata", () => {
    const report = buildStorageIntegrityReport({
      bucket: "docslurp-files",
      prefix: null,
      maxKeys: 100,
      references: [
        {
          kind: "document-source",
          key: "docs/source.pdf",
          runId: "run-1",
          documentId: "doc-1",
          workspaceId: "ws-1",
          orgId: "org-1",
          userId: "user-1",
          source: "source.pdf"
        }
      ],
      runChecks: [
        {
          runId: "run-1",
          userId: "user-1",
          orgId: "org-1",
          workspaceId: "ws-1",
          status: "completed",
          pipeline: {
            embed: true,
            indexVectors: true,
            summarize: true,
            graphRag: true,
            entityIndex: true
          },
          documentCount: 1,
          chunkCount: 0,
          vectorIndexCount: 0,
          summaryCount: 0,
          propositionCount: 0,
          graphNodeCount: 0,
          graphEdgeCount: 0,
          chunkEntityCount: 0,
          communityCount: 0
        }
      ],
      listedKeys: ["orphaned/object.json"],
      listedKeysTruncated: false,
      nextContinuationToken: null,
      checkedKeys: ["docs/source.pdf"],
      existingKeys: new Set<string>()
    });

    expect(report.summary.missingObjectCount).toBe(1);
    expect(report.summary.orphanedObjectCount).toBe(1);
    expect(report.summary.danglingMetadataCount).toBe(3);
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "missing-storage-object",
      "orphaned-storage-object",
      "missing-index-rows",
      "missing-summary-rows",
      "missing-graph-rows"
    ]);
  });
});

describe("classifyListedReferences", () => {
  it("answers existence from the listing and leaves only keys past a truncated listing for HEAD", async () => {
    const { classifyListedReferences } = await import("../db/store.js");
    const complete = classifyListedReferences(["a/1", "a/2", "b/9"], { keys: ["a/1", "b/9", "c/0"], truncated: false });
    expect([...complete.existing]).toEqual(["a/1", "b/9"]);
    expect(complete.unknown).toEqual([]);

    // Truncated at "m/5": "a/2" sorts before it and is missing; "z/1" is beyond and unknown.
    const truncated = classifyListedReferences(["a/1", "a/2", "m/5", "z/1"], { keys: ["a/1", "m/5"], truncated: true });
    expect([...truncated.existing]).toEqual(["a/1", "m/5"]);
    expect(truncated.unknown).toEqual(["z/1"]);
    // Binary order, not locale order: "B" (0x42) sorts before "a" (0x61).
    expect(classifyListedReferences(["B/1"], { keys: ["a/1"], truncated: true }).unknown).toEqual([]);
    expect(classifyListedReferences(["x"], { keys: [], truncated: true }).unknown).toEqual(["x"]);
  });
});
