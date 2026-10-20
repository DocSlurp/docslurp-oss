import { beforeEach, describe, expect, it, vi } from "vitest";
import { l2Normalize, packSignBits, quantizeInt8 } from "@docslurp/shared";

const DIMS = 768;
let stampValue = "t1:3";
let loadCount = 0;
const vectors = new Map<string, Float32Array>();
const sqlMock = Object.assign(
  vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("max(created_at)")) return [{ stamp: stampValue }];
    loadCount++;
    return [...vectors].map(([key, vector]) => {
      const [document_id, page] = key.split("#");
      const bits = packSignBits(vector);
      const { values, scale } = quantizeInt8(vector);
      return {
        document_id, page_number: Number(page), dims: DIMS,
        bits: Buffer.from(bits), int8: Buffer.from(values.buffer, values.byteOffset, values.byteLength), scale,
      };
    });
  }),
  { array: (values: unknown[]) => values },
);
vi.mock("../db.js", () => ({ sql: sqlMock }));

const { locatePageImageCandidates, clearPageVectorCache } = await import("../search/deferred/page-vector-locator.js");

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
}
function randomVector(next: () => number): Float32Array {
  return l2Normalize(Array.from({ length: DIMS }, () => next()));
}

beforeEach(() => {
  clearPageVectorCache();
  sqlMock.mockClear();
  loadCount = 0;
  stampValue = "t1:3";
  vectors.clear();
});

describe("locatePageImageCandidates", () => {
  it("returns the planted near-duplicate page first", async () => {
    const next = rng(7);
    for (let page = 1; page <= 60; page++) vectors.set(`doc-a#${page}`, randomVector(next));
    for (let page = 1; page <= 40; page++) vectors.set(`doc-b#${page}`, randomVector(next));
    const target = vectors.get("doc-b#17")!;
    const noise = rng(99);
    const query = l2Normalize(Array.from(target, (v) => v + noise() * 0.02));

    const hits = await locatePageImageCandidates({ workspaceId: "ws", documentIds: [], model: "m", queryVector: query, k: 5 });
    expect(hits[0]).toMatchObject({ documentId: "doc-b", page: 17 });
    expect(hits[0]!.score).toBeGreaterThan(0.95);
    expect(hits).toHaveLength(5);
  });

  it("caches the matrix: a second call within the TTL runs no SQL", async () => {
    const next = rng(3);
    for (let page = 1; page <= 10; page++) vectors.set(`doc-a#${page}`, randomVector(next));
    const query = vectors.get("doc-a#4")!;
    await locatePageImageCandidates({ workspaceId: "ws", documentIds: [], model: "m", queryVector: query, k: 3 });
    const callsAfterFirst = sqlMock.mock.calls.length;
    const again = await locatePageImageCandidates({ workspaceId: "ws", documentIds: [], model: "m", queryVector: query, k: 3 });
    expect(sqlMock.mock.calls.length).toBe(callsAfterFirst);
    expect(again[0]).toMatchObject({ documentId: "doc-a", page: 4 });
  });

  it("revalidates by max(created_at) after the TTL and reloads only when it changed", async () => {
    vi.stubEnv("DOCSLURP_PAGE_VECTOR_CACHE_TTL_MS", "0");
    try {
      const next = rng(5);
      for (let page = 1; page <= 10; page++) vectors.set(`doc-a#${page}`, randomVector(next));
      const query = vectors.get("doc-a#2")!;
      const run = () => locatePageImageCandidates({ workspaceId: "ws", documentIds: [], model: "m", queryVector: query, k: 1 });
      await run();
      await run();
      expect(loadCount).toBe(1);
      stampValue = "t2:11";
      vectors.set("doc-a#11", query);
      await run();
      expect(loadCount).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shares one load between concurrent queries", async () => {
    const next = rng(21);
    for (let page = 1; page <= 10; page++) vectors.set(`doc-a#${page}`, randomVector(next));
    const query = vectors.get("doc-a#3")!;
    await Promise.all([1, 2, 3].map(() => locatePageImageCandidates({ workspaceId: "ws", documentIds: [], model: "m", queryVector: query, k: 1 })));
    expect(loadCount).toBe(1);
  });

  it("serves a matrix larger than the cache budget without caching it", async () => {
    vi.stubEnv("DOCSLURP_PAGE_VECTOR_CACHE_MB", "1");
    vi.stubEnv("DOCSLURP_PAGE_VECTOR_CACHE_TTL_MS", "0");
    try {
      const next = rng(31);
      // 1500 pages x (96 + 768) bytes is over the 1 MB budget.
      for (let page = 1; page <= 1500; page++) vectors.set(`doc-a#${page}`, randomVector(next));
      const query = vectors.get("doc-a#3")!;
      const run = () => locatePageImageCandidates({ workspaceId: "ws", documentIds: [], model: "m", queryVector: query, k: 1 });
      expect((await run())[0]).toMatchObject({ page: 3 });
      await run();
      expect(loadCount).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("restricts to the scoped documents", async () => {
    const next = rng(11);
    for (let page = 1; page <= 20; page++) vectors.set(`doc-a#${page}`, randomVector(next));
    for (let page = 1; page <= 20; page++) vectors.set(`doc-b#${page}`, randomVector(next));
    const query = vectors.get("doc-a#9")!;
    const hits = await locatePageImageCandidates({ workspaceId: "ws", documentIds: ["doc-b"], model: "m", queryVector: query, k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.documentId === "doc-b")).toBe(true);
  });

  it("returns nothing when the query dimension does not match the stored model", async () => {
    vectors.set("doc-a#1", randomVector(rng(1)));
    expect(await locatePageImageCandidates({ workspaceId: "ws", documentIds: [], model: "m", queryVector: new Float32Array(10), k: 3 })).toEqual([]);
  });
});
