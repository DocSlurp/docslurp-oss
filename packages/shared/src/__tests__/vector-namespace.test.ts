import { describe, expect, it } from "vitest";

import { VectorNamespaceManager, hashOrgIdForNamespace } from "../vector-namespace.js";

describe("VectorNamespaceManager", () => {
  it("scopes storage by readable org, model, and dimensions without an org hash", () => {
    expect(VectorNamespaceManager.getEmbeddingLocation("s3://bucket/index/", "org-a", "Xenova/all-MiniLM-L6-v2", 384)).toEqual({
      uri: "s3://bucket/index/org-a/vectors/Xenova%2Fall-MiniLM-L6-v2/384",
      table: "chunks",
    });
    expect(() => VectorNamespaceManager.getEmbeddingLocation("/tmp/index", "../other-org", "small", 384)).toThrow();
    expect(VectorNamespaceManager.getEmbeddingLocation("/tmp/index", "org-a", "../model", 384).uri).toContain("%2E%2E%2Fmodel");
  });

  it("puts the readable embedding model and dimensions in the physical table path", () => {
    const table = VectorNamespaceManager.getEmbeddingTableName("org-a", "Xenova/all-MiniLM-L6-v2", 384);
    expect(table).toMatch(/_embedding_xenova_all_minilm_l6_v2_d384_[a-f0-9]{32}$/);
    expect(table).not.toBe(VectorNamespaceManager.getEmbeddingTableName("org-a", "Xenova/all_MiniLM-L6-v2", 384));
    expect(table).not.toBe(VectorNamespaceManager.getEmbeddingTableName("org-a", "Xenova/all-MiniLM-L6-v2", 768));
  });

  it("derives stable hashed LanceDB table names without exposing org ids", () => {
    const tableName = VectorNamespaceManager.getTableName("org-123");

    expect(tableName).toMatch(/^chunks_org_[0-9a-f]{32}$/);
    expect(tableName).not.toContain("org-123");
    expect(tableName).toBe(VectorNamespaceManager.getTableName("org-123"));
  });

  it("rejects blank org ids instead of deriving a shared fallback namespace", () => {
    expect(() => hashOrgIdForNamespace(" ")).toThrow();
    expect(() => VectorNamespaceManager.getTableName("")).toThrow();
  });

  it("distinguishes live org tables from archives and lookalike prefixes", () => {
    const orgId = "org-123";
    const liveTable = VectorNamespaceManager.getTableName(orgId);

    expect(VectorNamespaceManager.isLiveTableNameForOrg(liveTable, orgId)).toBe(true);
    expect(
      VectorNamespaceManager.isLiveTableNameForOrg(`${liveTable}_archived_20260617010101`, orgId),
    ).toBe(false);
    expect(
      VectorNamespaceManager.isLiveTableNameForOrg(`${liveTable}_malformed`, orgId),
    ).toBe(false);
  });

  it("requires an explicit schema when lifecycle code creates an empty table", async () => {
    await expect(
      VectorNamespaceManager.ensureTable(
        {
          connect: async () => ({
            tableNames: async () => [],
            openTable: async () => {
              throw new Error("should not open table");
            },
            createTable: async () => {
              throw new Error("should not create table without a schema");
            },
            dropTable: async () => undefined,
          }),
        },
        "/tmp/lancedb",
        "org-123",
      ),
    ).rejects.toThrow();
  });
});
