import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));

const { createKeywordFanout } = await import("../services/search.js");
type Chunk = Parameters<Parameters<ReturnType<typeof createKeywordFanout>["search"]>[0]> extends never ? never : any;

function chunk(documentId: string, chunkIndex: number): Chunk {
  return { id: `${documentId}:${chunkIndex}`, documentId, chunkIndex, runId: "run", text: "", headingPath: [], pageNumber: 1,
    tokenEstimate: 1, score: 0, filename: "f.pdf", pageNumbers: [1], blockIds: [], blockTypes: [], evidenceType: null, canonicalDocumentUri: null };
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
    const fanout = createKeywordFanout(["alpha", "beta", "alpha", "gamma"], true);
    const run = vi.fn(async (term: string) => lists[term]!);
    const fused = await fanout.search(run, 20);
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
    const fanout = createKeywordFanout(["a", "b"], true);
    const fused = await fanout.search(async (term) => Array.from({ length: 10 }, (_, i) => chunk(term, i)), 5);
    expect(fused).toHaveLength(5);
  });

  it("bounds parallel queries: 16 natively, 4 on the Postgres path", async () => {
    for (const [native, expected] of [[true, 16], [false, 4]] as const) {
      let active = 0;
      let peak = 0;
      const fanout = createKeywordFanout(Array.from({ length: 40 }, (_, i) => `t${i}`), native);
      await fanout.search(async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return [];
      }, 20);
      expect(peak).toBe(expected);
    }
  });
});
