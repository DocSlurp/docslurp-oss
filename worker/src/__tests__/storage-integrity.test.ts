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

describe("groupReferencesByRunPrefix", () => {
  it("groups artifact keys by user/run prefix and leaves shorter keys for HEAD", async () => {
    const { groupReferencesByRunPrefix } = await import("../db/store.js");
    const { byPrefix, ungrouped } = groupReferencesByRunPrefix([
      "u1/run-a/markdown/doc-1.md", "u1/run-a/pages/doc-1/manifest.json", "u1/run-b/x.json", "u2/raw/upload.pdf", "loose.json", "u3/onlytwo",
    ]);
    expect([...byPrefix.entries()]).toEqual([
      ["u1/run-a/", ["u1/run-a/markdown/doc-1.md", "u1/run-a/pages/doc-1/manifest.json"]],
      ["u1/run-b/", ["u1/run-b/x.json"]],
      ["u2/raw/", ["u2/raw/upload.pdf"]],
    ]);
    expect(ungrouped).toEqual(["loose.json", "u3/onlytwo"]);
  });
});

describe("runStorageIntegritySweep existence checks", () => {
  it("lists each run prefix once and HEADs only what the listing lacks", async () => {
    const { Store } = await import("../db/store.js");
    const references = ["u1/run-a/a.json", "u1/run-a/b.json", "u1/run-a/gone.json", "u1/run-b/c.json", "loose.json"].map((key) => ({ kind: "stage-artifact", key, runId: null, documentId: null, workspaceId: null, orgId: null, userId: null, source: key }));
    const store = Object.create(Store.prototype) as InstanceType<typeof Store>;
    Object.assign(store, {
      loadStorageIntegrityReferences: async () => references,
      loadStorageIntegrityRunChecks: async () => [],
      appendAuditLog: async () => undefined,
    });
    const listed: string[] = [];
    const heads: string[] = [];
    const storage = {
      bucket: "b",
      listKeys: async ({ prefix }: { prefix?: string }) => {
        if (prefix) listed.push(prefix);
        const keys = prefix === "u1/run-a/" ? ["u1/run-a/a.json", "u1/run-a/b.json"] : prefix === "u1/run-b/" ? ["u1/run-b/c.json"] : [];
        return { keys, truncated: false, nextContinuationToken: null };
      },
      objectExists: async (key: string) => { heads.push(key); return key === "loose.json"; },
      putJson: async () => undefined,
      uri: (key: string) => `s3://b/${key}`,
    };
    const report = await store.runStorageIntegritySweep(storage as never, { maxKeys: 100 });
    expect(listed.sort()).toEqual(["u1/run-a/", "u1/run-b/"]);
    expect(heads.sort()).toEqual(["loose.json", "u1/run-a/gone.json"]);
    expect(JSON.stringify(report)).toContain("u1/run-a/gone.json");
  });
});
