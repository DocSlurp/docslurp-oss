import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { VectorNamespaceManager } from "@docslurp/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lanceDbVectorSearch, resetLanceDbConnectionForTests } from "../search/lancedb.js";
import { createResultCache, resetResultCacheForTests, resultCacheKey, type ResultCacheKeyInput } from "../search/result-cache.js";
import { collectSearchTimings } from "../search/timings.js";

const keyInput: ResultCacheKeyInput = {
  orgId: "org-a",
  targets: [{ uri: "/l", name: "t", version: 3, documentIds: ["d2", "d1"] }],
  queryVector: [0.1, 0.2],
  limit: 10,
  tuning: [{ ef: 15 }],
};

describe("result cache keys", () => {
  const base = resultCacheKey(keyInput);
  it("ignores document id order but not scope", () => {
    expect(resultCacheKey({ ...keyInput, targets: [{ ...keyInput.targets[0]!, documentIds: ["d1", "d2"] }] })).toBe(base);
    expect(resultCacheKey({ ...keyInput, targets: [{ ...keyInput.targets[0]!, documentIds: ["d1"] }] })).not.toBe(base);
    expect(resultCacheKey({ ...keyInput, targets: [{ ...keyInput.targets[0]!, documentIds: undefined }] })).not.toBe(base);
  });
  it("changes with org, version, vector, limit, refine and tuning", () => {
    for (const change of [
      { orgId: "org-b" }, { targets: [{ ...keyInput.targets[0]!, version: 4 }] }, { queryVector: [0.1, 0.3] },
      { limit: 11 }, { refineFactor: "4" }, { tuning: [{ ef: 30 }] }, { embeddingModel: "m" },
      { targets: [{ ...keyInput.targets[0]!, name: "u" }] },
    ]) expect(resultCacheKey({ ...keyInput, ...change })).not.toBe(base);
  });
  it("is off by default and honours env", () => {
    expect(createResultCache({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(createResultCache({ SEARCH_RESULT_CACHE_MAX_ENTRIES: "5" } as NodeJS.ProcessEnv).enabled).toBe(true);
  });
});

describe("lanceDbVectorSearch result cache", () => {
  let dir: string;
  const rec = (id: string, documentId: string, vector: number[]) => ({ id, documentId, text: id, vector });
  const search = (orgId = "org-a", documentIds?: string[]) => collectSearchTimings(() =>
    lanceDbVectorSearch({ orgId, queryVector: [1, 0], documentIds, limit: 5 }));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-result-cache-"));
    process.env.LANCEDB_URI = dir;
    process.env.SEARCH_RESULT_CACHE_MAX_ENTRIES = "50";
    resetLanceDbConnectionForTests();
    resetResultCacheForTests();
    const db = await lancedb.connect(dir);
    await db.createTable(VectorNamespaceManager.getTableName("org-a"), [rec("a1", "d1", [1, 0]), rec("a2", "d2", [0.9, 0.1])]);
    await db.createTable(VectorNamespaceManager.getTableName("org-b"), [rec("b1", "d9", [1, 0])]);
  });
  afterEach(async () => {
    resetLanceDbConnectionForTests();
    resetResultCacheForTests();
    delete process.env.LANCEDB_URI;
    delete process.env.SEARCH_RESULT_CACHE_MAX_ENTRIES;
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the second identical query from cache, per org", async () => {
    const first = await search();
    expect(first.timings.resultCacheMiss).toBe(1);
    const second = await search();
    expect(second.timings.resultCacheHit).toBe(1);
    expect(second.value).toEqual(first.value);
    const other = await search("org-b");
    expect(other.timings.resultCacheMiss).toBe(1);
    expect(other.value.map((h) => h.id)).toEqual(["b1"]);
  });

  it("misses when the scope changes", async () => {
    await search();
    const scoped = await search("org-a", ["d2"]);
    expect(scoped.timings.resultCacheMiss).toBe(1);
    expect(scoped.value.map((h) => h.id)).toEqual(["a2"]);
  });

  it("misses after a table write bumps the version", async () => {
    await search();
    const db = await lancedb.connect(dir);
    const table = await db.openTable(VectorNamespaceManager.getTableName("org-a"));
    await table.add([rec("a3", "d3", [1, 0])]);
    // Open handles re-check the manifest at most every 10 s; reopen to see the write now.
    // The result cache is deliberately kept: only the version in the key can invalidate it.
    resetLanceDbConnectionForTests();
    const after = await search();
    expect(after.timings.resultCacheMiss).toBe(1);
    expect(after.value.map((h) => h.id)).toContain("a3");
  });

  it("is a no-op when disabled", async () => {
    delete process.env.SEARCH_RESULT_CACHE_MAX_ENTRIES;
    resetResultCacheForTests();
    const result = await search();
    expect(result.timings.resultCacheMiss).toBeUndefined();
    expect(result.timings.resultCacheHit).toBeUndefined();
  });
});
