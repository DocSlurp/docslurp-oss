import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));

const { createKeywordFanout, withKeywordFanoutPostgresSlot } = await import("../services/search.js");
type Chunk = import("../services/search.js").SearchChunk;

function chunk(documentId: string, chunkIndex: number): Chunk {
  return { id: `${documentId}:${chunkIndex}`, documentId, chunkIndex, runId: "run", text: "", headingPath: [], pageNumber: 1,
    tokenEstimate: 1, score: 0, filename: "f.pdf", pageNumbers: [1], blockIds: [], blockTypes: [], evidenceType: null, canonicalDocumentUri: null } as unknown as Chunk;
}

function result(documentId: string, chunkIndex: number) {
  return { text: "", score: 0, citation: { documentId, chunkIndex } } as never;
}

describe("keyword fan-out", () => {
  it("runs each distinct query once, fuses by rank and reports which queries matched each result", async () => {
    const lists: Record<string, Chunk[]> = {
      alpha: [chunk("d1", 0), chunk("d1", 1)],
      beta: [chunk("d1", 1), chunk("d2", 0)],
      gamma: [],
    };
    const fanout = createKeywordFanout(["alpha", "beta", "alpha", "gamma"]);
    const run = vi.fn(async (term: string) => lists[term]!);
    const fused = await fanout.search("text", run, 20);
    expect(run).toHaveBeenCalledTimes(3);
    // d1:1 is in two lists, so it ranks first.
    expect(fused.map((item) => item.id)).toEqual(["d1:1", "d1:0", "d2:0"]);
    expect(fused.every((item) => item.lexicalMatch === "partial")).toBe(true);
    const response = { results: [result("d1", 1), result("d2", 0), result("d9", 0)] } as never as Parameters<typeof fanout.annotate>[0];
    fanout.annotate(response);
    expect(response.keywordQueries).toEqual([{ q: "alpha", hits: 2 }, { q: "beta", hits: 2 }, { q: "alpha", hits: 2 }, { q: "gamma", hits: 0 }]);
    expect(response.results.map((item) => item.matchedQueries)).toEqual([[0, 1, 2], [1], undefined]);
  });

  it("keeps the fused list within the limit", async () => {
    const fanout = createKeywordFanout(["a", "b"]);
    const fused = await fanout.search("text", async (term: string) => Array.from({ length: 10 }, (_, i) => chunk(term, i)), 5);
    expect(fused).toHaveLength(5);
  });

  it("runs at most 16 queries at once", async () => {
    let active = 0;
    let peak = 0;
    const fanout = createKeywordFanout(Array.from({ length: 40 }, (_, i) => `t${i}`));
    await fanout.search("text", async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return [];
    }, 20);
    expect(peak).toBe(16);
  });

  it("stops starting queries after a failure and settles the running ones before it rejects", async () => {
    let started = 0;
    let running = 0;
    const fanout = createKeywordFanout(Array.from({ length: 100 }, (_, i) => `t${i}`));
    const failed = fanout.search("text", async (term: string) => {
      started += 1; running += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, term === "t3" ? 1 : 5));
        if (term === "t3") throw new Error("statement timeout");
        return [];
      } finally {
        running -= 1;
      }
    }, 20);
    await expect(failed).rejects.toThrow("statement timeout");
    // Only the first wave (16) started; none is still running once the search has failed.
    expect(started).toBe(16);
    expect(running).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(16);
  });

  it("caps Postgres legs across every fan-out in the process, wherever they come from", async () => {
    let active = 0;
    let peak = 0;
    const leg = () => withKeywordFanoutPostgresSlot(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return [];
    });
    // Two concurrent fan-outs whose every query falls back to Postgres.
    await Promise.all([0, 1].map((n) => createKeywordFanout(Array.from({ length: 30 }, (_, i) => `f${n}-${i}`)).search("text", leg, 20)));
    expect(peak).toBe(4);
    const failing = withKeywordFanoutPostgresSlot(async () => { throw new Error("boom"); });
    await expect(failing).rejects.toThrow("boom");
    // A failed leg releases its slot.
    await Promise.all(Array.from({ length: 8 }, leg));
  });

  it("scores each chunk against the queries that found it, not the joined text (default relevance floor)", async () => {
    const quarterly = { ...chunk("d1", 0), text: "Quarterly revenue grew 12% on record demand", lexicalMatch: "partial" as const };
    const fanout = createKeywordFanout(["quarterly revenue", "earnings beat", "guidance raised", "record bookings"]);
    const fused = await fanout.search("text", async (term) => term === "quarterly revenue" ? [quarterly] : [], 20);
    expect(fused[0]!.queryRelevance).toBe(1);
    const { annotateEvidenceRelevance } = await import("../search/relevance.js");
    const [annotated] = annotateEvidenceRelevance([{ adapter: "lexical", chunks: fused }], { query: "quarterly revenue earnings beat guidance raised record bookings" });
    expect(annotated![0]!.relevance).toBe(1);
  });

  it("shrinks each query's candidate depth so a fan-out fetches about 1,000 candidates at most", async () => {
    const depths: number[] = [];
    await createKeywordFanout(Array.from({ length: 100 }, (_, i) => `t${i}`)).search("text", async (_term, depth) => { depths.push(depth); return []; }, 100);
    expect(new Set(depths)).toEqual(new Set([10]));
    depths.length = 0;
    await createKeywordFanout(["a", "b"]).search("text", async (_term, depth) => { depths.push(depth); return []; }, 20);
    expect(depths).toEqual([20, 20]);
  });

  it("strips NUL bytes from queries before they reach Postgres", async () => {
    const seen: string[] = [];
    await createKeywordFanout(["a\u0000b"]).search("text", async (term) => { seen.push(term); return []; }, 20);
    expect(seen).toEqual(["ab"]);
  });

  it("sums hits across the chunk and page-text legs", async () => {
    const fanout = createKeywordFanout(["x", "y"]);
    await fanout.search("text", async (term) => term === "x" ? [chunk("d1", 0)] : [], 20);
    await fanout.search("progressive", async (term) => term === "x" ? [chunk("d1", 1), chunk("d1", 2)] : [chunk("d2", 0)], 20);
    const response = { results: [result("d1", 2), result("d2", 0)] } as never as Parameters<typeof fanout.annotate>[0];
    fanout.annotate(response);
    expect(response.keywordQueries).toEqual([{ q: "x", hits: 3 }, { q: "y", hits: 1 }]);
    expect(response.results.map((item) => item.matchedQueries)).toEqual([[0], [1]]);
  });

  it("a failure in one leg stops every leg, and settle waits for queries still running in any of them", async () => {
    const fanout = createKeywordFanout(Array.from({ length: 100 }, (_, i) => `t${i}`));
    let pageStarted = 0;
    let pageRunning = 0;
    // The page-text leg is slow; the chunk leg fails at once.
    const page = fanout.search("progressive", async () => {
      pageStarted += 1; pageRunning += 1;
      try { await new Promise((resolve) => setTimeout(resolve, 15)); return []; } finally { pageRunning -= 1; }
    }, 20);
    void page.catch(() => undefined);
    const text = fanout.search("text", async () => { throw new Error("statement timeout"); }, 20);
    // What Promise.all in the retrieval stage sees: the search rejects while the page leg is still running.
    await expect(Promise.all([text, page])).rejects.toThrow("statement timeout");
    expect(pageRunning).toBeGreaterThan(0);
    await fanout.settle();
    expect(pageRunning).toBe(0);
    // The page leg started only its first wave: the other leg's failure stopped it.
    expect(pageStarted).toBe(16);
    await expect(page).rejects.toThrow("statement timeout");
  });
});
