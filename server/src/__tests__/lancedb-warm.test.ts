import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { VectorNamespaceManager } from "@docslurp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prewarm = vi.hoisted(() => ({ calls: [] as Array<{ indexes: string[]; label: string }>, impl: null as null | (() => Promise<string[]>) }));
vi.mock("../search/lancedb-prewarm.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../search/lancedb-prewarm.js")>();
  return {
    ...original,
    prewarmSearchIndexes: async (table: never, indexes: string[], label: string) => {
      prewarm.calls.push({ indexes, label });
      if (prewarm.impl) return { indexes: [], dataColumns: [], errors: await prewarm.impl(), ms: 0 };
      return original.prewarmSearchIndexes(table, indexes, label, () => undefined);
    },
  };
});

import { lanceDbFullTextSearch, lanceDbVectorSearch, resetLanceDbConnectionForTests, warmLanceDbSearch } from "../search/lancedb.js";
import { collectSearchTimings } from "../search/timings.js";

const MODEL = "provider/small";
const target = { orgId: "org-a", projectId: "ws-a", embeddingModel: MODEL, dimension: 2 };
let dir: string | null = null;

async function createIndexedTable(projectId = "ws-a"): Promise<void> {
  const location = VectorNamespaceManager.getEmbeddingLocation(dir!, "org-a", projectId, MODEL, 2);
  const db = await lancedb.connect(location.uri);
  const table = await db.createTable(location.table, [
    { id: "chunk-a", documentId: "doc-a", text: "quarterly earnings beat", vector: [1, 0] },
    { id: "chunk-b", documentId: "doc-b", text: "expansion into london", vector: [0, 1] },
  ]);
  await table.createIndex("text", { config: lancedb.Index.fts({ withPosition: false }) });
  table.close();
  db.close();
}

const warm = (projectId = "ws-a") => collectSearchTimings(() => warmLanceDbSearch({ ...target, projectId, hydrate: true }));

describe("warmLanceDbSearch index warm-up", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-lancedb-warm-"));
    process.env.LANCEDB_URI = dir;
    prewarm.calls.length = 0;
    prewarm.impl = null;
    resetLanceDbConnectionForTests();
  });

  afterEach(async () => {
    resetLanceDbConnectionForTests();
    delete process.env.LANCEDB_URI;
    delete process.env.SEARCH_LANCE_WARM_INDEX;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("loads the search indexes on the first warm-up and never again while the table stays open", async () => {
    await createIndexedTable();
    const first = await warm();
    expect(prewarm.calls).toEqual([{ indexes: ["text_idx"], label: expect.stringContaining("org-a/ws-a/") }]);
    expect(first.timings).toMatchObject({ lanceIndexCold: 1, lanceIndexLoadMs: expect.any(Number), lanceWarmMs: expect.any(Number) });
    expect(first.timings.lanceIndexWarm).toBeUndefined();
    // `lanceWarm` is a duration only: a counter of the same name printed twice on [search-timing].
    expect(first.timings.lanceWarm).toBeUndefined();

    for (let i = 0; i < 3; i += 1) {
      const again = await warm();
      expect(again.timings).toMatchObject({ lanceIndexWarm: 1 });
      expect(again.timings.lanceIndexCold).toBeUndefined();
      expect(again.timings.lanceIndexLoadMs).toBeUndefined();
    }
    await lanceDbVectorSearch({ ...target, queryVector: [1, 0], limit: 5 });
    await lanceDbFullTextSearch({ ...target, query: "earnings", documentIds: ["doc-a", "doc-b"], limit: 5 });
    expect(prewarm.calls).toHaveLength(1);
  });

  it("shares one in-flight load between concurrent first searches", async () => {
    await createIndexedTable();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    prewarm.impl = async () => { await gate; return []; };
    const pending = [warm(), warm(), warm()];
    // The legs do not wait for the warm-up: a search answers while the load is still running.
    const hits = await lanceDbVectorSearch({ ...target, queryVector: [1, 0], limit: 5 });
    expect(hits.map((hit) => hit.id)).toEqual(["chunk-a", "chunk-b"]);
    release();
    const results = await Promise.all(pending);
    expect(prewarm.calls).toHaveLength(1);
    for (const result of results) expect(result.timings).toMatchObject({ lanceIndexCold: 1 });
  });

  it("never fails a search when the load fails, and does not retry it on every search", async () => {
    await createIndexedTable();
    prewarm.impl = async () => { throw new Error("storage offline"); };
    const failed = await warm();
    expect(failed.timings).toMatchObject({ lanceIndexCold: 1, lanceIndexWarmFailed: 1 });
    prewarm.impl = async () => ["index text_idx: boom"];
    expect((await warm()).timings).toMatchObject({ lanceIndexWarmFailed: 1 });
    expect(prewarm.calls).toHaveLength(1);
    expect((await lanceDbVectorSearch({ ...target, queryVector: [1, 0], limit: 5 })).map((hit) => hit.id)).toEqual(["chunk-a", "chunk-b"]);
    const text = await lanceDbFullTextSearch({ ...target, query: "earnings", documentIds: ["doc-a", "doc-b"], limit: 5 });
    expect(text.hits.map((hit) => hit.id)).toEqual(["chunk-a"]);
  });

  it("warms only the table of the project being searched, and loads at most two tables at once", async () => {
    const projects = ["ws-a", "ws-b", "ws-c", "ws-d"];
    for (const projectId of projects) await createIndexedTable(projectId);
    let active = 0;
    let peak = 0;
    prewarm.impl = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return [];
    };
    await Promise.all(projects.map((projectId) => warm(projectId)));
    expect(peak).toBe(2);
    expect(prewarm.calls.map((call) => call.label.split("/").slice(0, 2).join("/")).sort()).toEqual(projects.map((projectId) => `org-a/${projectId}`));
  });

  it("does nothing for a missing table or when switched off", async () => {
    expect((await warm()).timings.lanceIndexCold).toBeUndefined();
    resetLanceDbConnectionForTests();
    await createIndexedTable();
    process.env.SEARCH_LANCE_WARM_INDEX = "0";
    const off = await warm();
    expect(prewarm.calls).toHaveLength(0);
    expect(off.timings.lanceIndexCold).toBeUndefined();
    expect(off.timings.lanceIndexWarm).toBeUndefined();
  });
});
