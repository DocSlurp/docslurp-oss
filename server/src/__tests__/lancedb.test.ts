import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { VectorNamespaceManager } from "@docslurp/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  filterLanceDbRowsByDocumentIds,
  getOrgLanceDbPrefix,
  lanceDbVectorSearch,
  resetLanceDbConnectionForTests,
} from "../search/lancedb.js";

let lancedbDir: string | null = null;

async function createLanceDbTable(
  tableName: string,
  records: Array<{
    id: string;
    documentId: string;
    text: string;
    vector: number[];
  }>,
): Promise<void> {
  const db = await lancedb.connect(lancedbDir!);
  await db.createTable(tableName, records);
}

describe("getOrgLanceDbPrefix", () => {
  it("uses a stable hashed org namespace instead of the raw org id", () => {
    const prefix = getOrgLanceDbPrefix("org-123");

    expect(prefix).toMatch(/^chunks_org_[0-9a-f]{32}$/);
    expect(prefix).not.toContain("org-123");
    expect(prefix).toBe(getOrgLanceDbPrefix("org-123"));
  });
});

describe("lanceDbVectorSearch tenant isolation", () => {
  beforeEach(async () => {
    lancedbDir = await mkdtemp(path.join(tmpdir(), "docslurp-lancedb-test-"));
    process.env.LANCEDB_URI = lancedbDir;
    resetLanceDbConnectionForTests();
  });

  afterEach(async () => {
    resetLanceDbConnectionForTests();
    delete process.env.LANCEDB_URI;
    if (lancedbDir) {
      await rm(lancedbDir, { recursive: true, force: true });
      lancedbDir = null;
    }
  });

  it("opens only the exact org table and ignores other org tables or lookalike namespaces", async () => {
    const orgATable = VectorNamespaceManager.getTableName("org-a");
    const orgBTable = VectorNamespaceManager.getTableName("org-b");

    await createLanceDbTable(orgATable, [
      {
        id: "chunk-a",
        documentId: "doc-a",
        text: "tenant a",
        vector: [1, 0],
      },
    ]);
    await createLanceDbTable(orgBTable, [
      {
        id: "chunk-b",
        documentId: "doc-b",
        text: "tenant b",
        vector: [1, 0],
      },
    ]);
    await createLanceDbTable(`${orgATable}_malformed`, [
      {
        id: "chunk-lookalike",
        documentId: "doc-lookalike",
        text: "lookalike namespace",
        vector: [1, 0],
      },
    ]);

    const hits = await lanceDbVectorSearch({
      orgId: "org-a",
      queryVector: [1, 0],
      limit: 10,
    });

    expect(hits.map((hit) => hit.id)).toEqual(["chunk-a"]);
  });

  it("isolates different embedding models and dimensions within the same org", async () => {
    const table = (model: string, dimensions: number) => VectorNamespaceManager.getEmbeddingTableName("org-a", model, dimensions);
    await createLanceDbTable(table("small", 2), [{ id: "small", documentId: "doc-small", text: "small model", vector: [1, 0] }]);
    await createLanceDbTable(table("other", 2), [{ id: "other", documentId: "doc-other", text: "same dimensions, different model", vector: [1, 0] }]);
    await createLanceDbTable(table("large", 3), [{ id: "large", documentId: "doc-large", text: "large model", vector: [1, 0, 0] }]);
    await createLanceDbTable(VectorNamespaceManager.getTableName("org-a"), [
      { id: "legacy", documentId: "doc-legacy", text: "verified legacy model", vector: [1, 0] },
      { id: "unverified", documentId: "doc-unverified", text: "unknown legacy model", vector: [1, 0] },
    ]);
    const hits = await lanceDbVectorSearch({ orgId: "org-a", embeddingModel: "small", queryVector: [1, 0], legacyDocumentIds: ["doc-legacy"], limit: 10 });
    expect(hits.map(hit => hit.id).sort()).toEqual(["legacy", "small"]);
    const large = await lanceDbVectorSearch({ orgId: "org-a", embeddingModel: "large", queryVector: [1, 0, 0], limit: 10 });
    expect(large.map(hit => hit.id)).toEqual(["large"]);
  });

  it("searches org/model/dimension directories without mixing tenants or vector spaces", async () => {
    for (const [org, model, dims, id] of [
      ["org-a", "provider/small", 2, "wanted"],
      ["org-b", "provider/small", 2, "other-tenant"],
      ["org-a", "provider/other", 2, "other-model"],
      ["org-a", "provider/small", 3, "other-dims"],
    ] as const) {
      const location = VectorNamespaceManager.getEmbeddingLocation(lancedbDir!, org, model, dims);
      const db = await lancedb.connect(location.uri);
      const table = await db.createTable(location.table, [{ id, documentId: id, text: id, vector: Array.from({ length: dims }, (_, i) => i === 0 ? 1 : 0) }]);
      table.close();
      db.close();
    }
    const hits = await lanceDbVectorSearch({ orgId: "org-a", embeddingModel: "provider/small", queryVector: [1, 0], limit: 10 });
    expect(hits.map(hit => hit.id)).toEqual(["wanted"]);
  });

  it("keeps search results on tables the worker has optimized and vector-indexed", async () => {
    const location = VectorNamespaceManager.getEmbeddingLocation(lancedbDir!, "org-a", "provider/small", 8);
    const vector = (seed: number) => Array.from({ length: 8 }, (_, i) => Math.sin(seed * 7 + i));
    const db = await lancedb.connect(location.uri);
    const table = await db.createTable(location.table, Array.from({ length: 40 }, (_, i) => ({
      id: `chunk-${i}`, documentId: `doc-${i % 4}`, text: `chunk ${i}`, vector: vector(i),
    })));
    // Mirrors worker/src/stages/lancedb-maintenance.ts: optimize, then an L2 IVF_HNSW_SQ index.
    await table.optimize();
    await table.createIndex("vector", { config: lancedb.Index.hnswSq({ distanceType: "l2", numPartitions: 1 }), replace: false });
    await table.add([{ id: "late", documentId: "doc-late", text: "unindexed tail", vector: vector(99) }]);
    table.close();
    db.close();

    const hits = await lanceDbVectorSearch({ orgId: "org-a", embeddingModel: "provider/small", queryVector: vector(7), limit: 3 });
    expect(hits[0]?.id).toBe("chunk-7");
    const tail = await lanceDbVectorSearch({ orgId: "org-a", embeddingModel: "provider/small", queryVector: vector(99), documentIds: ["doc-late"], limit: 3 });
    expect(tail.map((hit) => hit.id)).toEqual(["late"]);
  });

  it("reuses table handles across searches and briefly remembers missing tables", async () => {
    const name = VectorNamespaceManager.getTableName("org-a");
    expect(await lanceDbVectorSearch({ orgId: "org-a", queryVector: [1, 0], limit: 10 })).toEqual([]);
    await createLanceDbTable(name, [{ id: "chunk-a", documentId: "doc-a", text: "tenant a", vector: [1, 0] }]);
    // Within the missing-table TTL the absent table is not re-probed on every query.
    expect(await lanceDbVectorSearch({ orgId: "org-a", queryVector: [1, 0], limit: 10 })).toEqual([]);
    resetLanceDbConnectionForTests();
    const first = await lanceDbVectorSearch({ orgId: "org-a", queryVector: [1, 0], limit: 10 });
    const second = await lanceDbVectorSearch({ orgId: "org-a", queryVector: [1, 0], limit: 10 });
    expect(first.map(hit => hit.id)).toEqual(["chunk-a"]);
    expect(second).toEqual(first);
  });

  it("fails closed when the org namespace is missing", async () => {
    await createLanceDbTable(VectorNamespaceManager.getTableName("org-a"), [
      {
        id: "chunk-a",
        documentId: "doc-a",
        text: "tenant a",
        vector: [1, 0],
      },
    ]);

    await expect(
      lanceDbVectorSearch({
        orgId: " ",
        queryVector: [1, 0],
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});

describe("filterLanceDbRowsByDocumentIds", () => {
  it("applies document scoping in process instead of constructing a LanceDB WHERE string", () => {
    const rows = [
      { id: "chunk-1", documentId: "doc-1", _distance: 0.1 },
      { id: "chunk-2", documentId: "doc-2", _distance: 0.2 },
    ];

    expect(filterLanceDbRowsByDocumentIds(rows, ["doc-1' OR '1'='1"])).toEqual([]);
    expect(filterLanceDbRowsByDocumentIds(rows, ["doc-1"])).toEqual([rows[0]]);
  });

  it("leaves rows unchanged when no document scope is requested", () => {
    const rows = [{ id: "chunk-1", documentId: "doc-1", _distance: 0.1 }];

    expect(filterLanceDbRowsByDocumentIds(rows)).toBe(rows);
    expect(filterLanceDbRowsByDocumentIds(rows, [])).toBe(rows);
  });
});
