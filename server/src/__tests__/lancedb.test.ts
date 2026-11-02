import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { VectorNamespaceManager } from "@docslurp/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  filterLanceDbRowsByDocumentIds,
  lanceDbVectorSearch,
  resetLanceDbConnectionForTests,
} from "../search/lancedb.js";

let lancedbDir: string | null = null;

const MODEL = "provider/small";

type Scope = { orgId?: string; workspaceId?: string; model?: string };

/** Opens (creating) the LanceDB table of one workspace and embedding space. */
async function openWorkspaceTable(
  records: Array<Record<string, unknown> & { vector: number[] }>,
  scope: Scope = {},
): Promise<{ table: lancedb.Table; close: () => void }> {
  const location = VectorNamespaceManager.getEmbeddingLocation(
    lancedbDir!, scope.orgId ?? "org-a", scope.workspaceId ?? "ws-a", scope.model ?? MODEL, records[0]!.vector.length,
  );
  const db = await lancedb.connect(location.uri);
  const table = await db.createTable(location.table, records);
  return { table, close: () => { table.close(); db.close(); } };
}

async function createLanceDbTable(
  records: Array<{ id: string; documentId: string; text: string; vector: number[] }>,
  scope: Scope = {},
): Promise<void> {
  (await openWorkspaceTable(records, scope)).close();
}

/** A search in org-a / ws-a with the default model unless overridden. */
function search(args: Omit<Parameters<typeof lanceDbVectorSearch>[0], "orgId" | "workspaceId" | "embeddingModel"> & Partial<Pick<Parameters<typeof lanceDbVectorSearch>[0], "orgId" | "workspaceId" | "embeddingModel">>) {
  return lanceDbVectorSearch({ orgId: "org-a", workspaceId: "ws-a", embeddingModel: MODEL, ...args });
}

describe("lanceDbVectorSearch tenant isolation", () => {
  beforeEach(async () => {
    lancedbDir = await mkdtemp(path.join(tmpdir(), "docslurp-lancedb-test-"));
    process.env.LANCEDB_URI = lancedbDir;
    resetLanceDbConnectionForTests();
  });

  afterEach(async () => {
    resetLanceDbConnectionForTests();
    delete process.env.LANCEDB_URI;
    delete process.env.LANCEDB_REFINE_FACTOR;
    delete process.env.LANCEDB_MISSING_TABLE_TTL_SECONDS;
    delete process.env.LANCEDB_MAX_OPEN_TABLES;
    if (lancedbDir) {
      await rm(lancedbDir, { recursive: true, force: true });
      lancedbDir = null;
    }
  });

  it("opens only the workspace's own database, never another workspace's or org's", async () => {
    await createLanceDbTable([{ id: "chunk-a", documentId: "doc-a", text: "workspace a", vector: [1, 0] }]);
    await createLanceDbTable([{ id: "chunk-sibling", documentId: "doc-a", text: "same org, other workspace", vector: [1, 0] }], { workspaceId: "ws-b" });
    await createLanceDbTable([{ id: "chunk-other-org", documentId: "doc-a", text: "other org, same workspace id", vector: [1, 0] }], { orgId: "org-b" });

    // Even an unscoped search (no document filter) sees only this workspace's rows.
    expect((await search({ queryVector: [1, 0], limit: 10 })).map((hit) => hit.id)).toEqual(["chunk-a"]);
    expect((await search({ queryVector: [1, 0], documentIds: ["doc-a"], limit: 10 })).map((hit) => hit.id)).toEqual(["chunk-a"]);
    expect((await search({ workspaceId: "ws-b", queryVector: [1, 0], limit: 10 })).map((hit) => hit.id)).toEqual(["chunk-sibling"]);
  });

  it("never widens explicit empty eligibility to the workspace", async () => {
    await createLanceDbTable([{ id: "chunk-a", documentId: "doc-a", text: "private", vector: [1, 0] }]);
    expect(await search({ queryVector: [1, 0], limit: 10, documentIds: [] })).toEqual([]);
    expect((await search({ queryVector: [1, 0], limit: 10 })).map(hit => hit.id)).toEqual(["chunk-a"]);
    expect(await search({ queryVector: [1, 0], limit: 10, documentIds: [] })).toEqual([]);
  });

  it("searches workspace/model/dimension databases without mixing vector spaces", async () => {
    for (const [model, dims, id] of [
      [MODEL, 2, "wanted"],
      ["provider/other", 2, "other-model"],
      [MODEL, 3, "other-dims"],
    ] as const) {
      await createLanceDbTable([{ id, documentId: id, text: id, vector: Array.from({ length: dims }, (_, i) => i === 0 ? 1 : 0) }], { model });
    }
    expect((await search({ queryVector: [1, 0], limit: 10 })).map(hit => hit.id)).toEqual(["wanted"]);
    expect((await search({ queryVector: [1, 0, 0], limit: 10 })).map(hit => hit.id)).toEqual(["other-dims"]);
  });

  it("keeps search results on tables the worker has optimized and vector-indexed", async () => {
    const vector = (seed: number) => Array.from({ length: 8 }, (_, i) => Math.sin(seed * 7 + i));
    const { table, close } = await openWorkspaceTable(Array.from({ length: 40 }, (_, i) => ({
      id: `chunk-${i}`, documentId: `doc-${i % 4}`, text: `chunk ${i}`, vector: vector(i),
    })));
    // Mirrors worker/src/stages/lancedb-maintenance.ts: optimize, then an L2 IVF_HNSW_SQ index.
    await table.optimize();
    await table.createIndex("vector", { config: lancedb.Index.hnswSq({ distanceType: "l2", numPartitions: 1 }), replace: false });
    await table.add([{ id: "late", documentId: "doc-late", text: "unindexed tail", vector: vector(99) }]);
    close();

    const hits = await search({ queryVector: vector(7), limit: 3 });
    expect(hits[0]?.id).toBe("chunk-7");
    const tail = await search({ queryVector: vector(99), documentIds: ["doc-late"], limit: 3 });
    expect(tail.map((hit) => hit.id)).toEqual(["late"]);
  });

  it("supports opt-in refinement for indexed unscoped/scoped search and the fresh tail", async () => {
    process.env.LANCEDB_REFINE_FACTOR = "16";
    const { table, close } = await openWorkspaceTable(Array.from({ length: 256 }, (_, i) => ({
      id: `refine-${i}`, documentId: "doc-a", vector: [Math.cos(i), Math.sin(i), 0, 0, 0, 0, 0, 0],
    })));
    try {
      await table.createIndex("vector", { config: lancedb.Index.hnswSq({ distanceType: "l2", numPartitions: 1 }) });
      for (const documentIds of [undefined, ["doc-a"]]) {
        const hits = await search({ queryVector: [1, 0, 0, 0, 0, 0, 0, 0], documentIds, limit: 50 });
        expect(hits).toHaveLength(50);
        expect(hits[0]?.id).toBe("refine-0");
      }
      await table.add([{ id: "fresh-refined", documentId: "doc-fresh", vector: [0, 0, 1, 0, 0, 0, 0, 0] }]);
      resetLanceDbConnectionForTests();
      const fresh = await search({ queryVector: [0, 0, 1, 0, 0, 0, 0, 0], documentIds: ["doc-fresh"], limit: 50 });
      expect(fresh.map(hit => hit.id)).toEqual(["fresh-refined"]);
    } finally { close(); }
  });

  it("reuses table handles across searches and briefly remembers missing tables", async () => {
    expect(await search({ queryVector: [1, 0], limit: 10 })).toEqual([]);
    await createLanceDbTable([{ id: "chunk-a", documentId: "doc-a", text: "tenant a", vector: [1, 0] }]);
    // Within the missing-table TTL the absent table is not re-probed on every query.
    expect(await search({ queryVector: [1, 0], limit: 10 })).toEqual([]);
    resetLanceDbConnectionForTests();
    const first = await search({ queryVector: [1, 0], limit: 10 });
    const second = await search({ queryVector: [1, 0], limit: 10 });
    expect(first.map(hit => hit.id)).toEqual(["chunk-a"]);
    expect(second).toEqual(first);
  });

  it("finds a new workspace's first rows soon after an earlier search missed its table", async () => {
    process.env.LANCEDB_MISSING_TABLE_TTL_SECONDS = "0";
    expect(await search({ queryVector: [1, 0], documentIds: ["doc-a"], limit: 10 })).toEqual([]);
    await createLanceDbTable([{ id: "chunk-a", documentId: "doc-a", text: "first upload", vector: [1, 0] }]);
    expect((await search({ queryVector: [1, 0], documentIds: ["doc-a"], limit: 10 })).map((hit) => hit.id)).toEqual(["chunk-a"]);
  });

  it("keeps a bounded number of workspace tables open and reopens evicted ones", async () => {
    process.env.LANCEDB_MAX_OPEN_TABLES = "1";
    for (const workspaceId of ["ws-a", "ws-b"]) {
      await createLanceDbTable([{ id: `chunk-${workspaceId}`, documentId: "doc", text: workspaceId, vector: [1, 0] }], { workspaceId });
    }
    for (const workspaceId of ["ws-a", "ws-b", "ws-a"]) {
      expect((await search({ workspaceId, queryVector: [1, 0], limit: 10 })).map((hit) => hit.id)).toEqual([`chunk-${workspaceId}`]);
    }
  });

  it("finds the nearest scoped documents beyond the global 1,000-row cutoff", async () => {
    const documentIds = Array.from({ length: 400 }, (_, i) => `scoped-doc-${i}`);
    await createLanceDbTable([
      ...Array.from({ length: 2_000 }, (_, i) => ({
        id: `outside-${i}`, documentId: `outside-doc-${i}`, text: "outside the requested scope", vector: [0, i / 100_000],
      })),
      ...documentIds.map((documentId, i) => ({
        id: `scoped-${i}`, documentId, text: "requested scope", vector: [1 + i / 400, 0],
      })),
    ]);

    const hits = await search({ documentIds, queryVector: [0, 0], limit: 3 });
    expect(hits.map(hit => hit.id)).toEqual(["scoped-0", "scoped-1", "scoped-2"]);
  });

  it("preserves HNSW search breadth when a scope includes the whole table", async () => {
    let seed = 8128;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const records = Array.from({ length: 12_000 }, (_, i) => ({
      id: `chunk-${i}`, documentId: `doc-${i % 200}`, vector: Array.from({ length: 64 }, random),
    }));
    const queryVector = Array.from({ length: 64 }, random);
    const { table, close } = await openWorkspaceTable(records);
    try {
      await table.createIndex("vector", { config: lancedb.Index.hnswSq({ distanceType: "l2", numPartitions: 1 }) });
      // The previous adapter requested 1,000 rows. An all-document scope must
      // not lose its nearest results just because fewer rows cross the boundary.
      const previous = await table.vectorSearch(queryVector).select(["id", "_distance"]).limit(1_000).toArray();
      const hits = await search({
        queryVector, documentIds: Array.from({ length: 200 }, (_, i) => `doc-${i}`), limit: 10,
      });
      expect(hits.map(hit => hit.id)).toEqual(previous.slice(0, 10).map(row => row.id));
    } finally {
      close();
    }
  }, 30_000);

  it("treats quoted document IDs as literals without widening the scope", async () => {
    const quotedId = "doc' OR '1'='1";
    await createLanceDbTable([
      { id: "other", documentId: "other-doc", text: "outside scope", vector: [1, 0] },
      { id: "quoted", documentId: quotedId, text: "inside scope", vector: [0.9, 0.1] },
    ]);

    const hits = await search({ documentIds: [quotedId], queryVector: [1, 0], limit: 3 });
    expect(hits.map(hit => hit.id)).toEqual(["quoted"]);
    expect(await search({ documentIds: ["missing' OR TRUE --"], queryVector: [1, 0], limit: 3 })).toEqual([]);
  });

  it("fails closed when the org or workspace namespace is missing", async () => {
    await createLanceDbTable([{ id: "chunk-a", documentId: "doc-a", text: "tenant a", vector: [1, 0] }]);

    await expect(search({ orgId: " ", queryVector: [1, 0], limit: 10 })).resolves.toEqual([]);
    await expect(search({ workspaceId: " ", queryVector: [1, 0], limit: 10 })).resolves.toEqual([]);
  });
});

describe("filterLanceDbRowsByDocumentIds", () => {
  it("independently rejects rows outside the requested document scope", () => {
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
    expect(filterLanceDbRowsByDocumentIds(rows, [])).toEqual([]);
  });
});
