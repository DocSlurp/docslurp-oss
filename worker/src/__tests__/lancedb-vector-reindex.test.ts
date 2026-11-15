import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, Index } from "@lancedb/lancedb";
import { expect, it } from "vitest";
import { rebuildVectorIndex, vectorReindexLocation } from "../stages/lancedb-vector-reindex.js";

it("dry runs without changing a table, refuses oversized builds, and atomically replaces only its vector index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vector-reindex-"));
  const db = await connect(dir);
  try {
    const table = await db.createTable("chunks", Array.from({ length: 512 }, (_, i) => ({ id: String(i), documentId: `doc-${i % 4}`, text: `text ${i}`, vector: [Math.sin(i), Math.cos(i), i / 512, 1] })));
    await table.createIndex("vector", { config: Index.hnswSq({ numPartitions: 1 }) });
    await table.createIndex("text", { config: Index.fts() });
    const before = await table.version();
    const input = { maxRows: 1000, memoryBytes: 1024 ** 3 };
    expect(await rebuildVectorIndex(table, { ...input, apply: false })).toMatchObject({ applied: false, rows: 512 });
    expect(await table.version()).toBe(before);
    await expect(rebuildVectorIndex(table, { ...input, apply: true, maxRows: 500 })).rejects.toThrow("row budget");
    await expect(rebuildVectorIndex(table, { ...input, apply: true, memoryBytes: 1 })).rejects.toThrow("memory budget");
    await expect(rebuildVectorIndex(table, { ...input, apply: true, dimensions: 1024 })).rejects.toThrow("dimension");
    expect(await table.version()).toBe(before);
    expect(await rebuildVectorIndex(table, { ...input, apply: true })).toMatchObject({ applied: true, beforeVersion: before, afterVersion: before + 1 });
    expect(await table.countRows()).toBe(512);
    expect((await table.listIndices()).map((i) => i.columns[0]).sort()).toEqual(["text", "vector"]);
    table.close();
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});


it("refuses foreign tenant/project URIs and encoded traversal before opening storage", () => {
  const root = "s3://bucket/lancedb";
  const scope = { org: "org-a", project: "project-a", model: "provider/model", dimensions: 1024 };
  for (const uri of ["s3://bucket/lancedb/org-b/project-a/vectors-x-1024", "s3://bucket/lancedb/org-a/project-b/vectors-x-1024", "s3://bucket/lancedb/org-a/project-a/..%2Fproject-b/vectors-x-1024"]) expect(() => vectorReindexLocation(root, { ...scope, uri })).toThrow();
  expect(vectorReindexLocation(root, scope).uri).toContain("/org-a/project-a/vectors-");
});
