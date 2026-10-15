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
