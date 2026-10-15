import { describe, expect, it } from "vitest";
import { rerankBM25 } from "../search/rerank.js";

describe("BM25 candidate reranking", () => {
  it("uses rare subject terms rather than repeated conversational words", () => {
    const chunks = [
      { id: "target", text: "Aster coolant pressure operating specification", score: 0.1 },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `generic-${i}`, text: "What is the operating pressure specification for the system? The pressure specification is the operating specification.", score: 1 })),
    ];
    expect(rerankBM25("What is the Aster operating pressure specification?", chunks)[0]?.id).toBe("target");
  });
  it("keeps stable ordering and finite scores for empty or stop-word-only text", () => {
    const chunks = [{ id: "a", text: "the and", score: 1 }, { id: "b", text: "", score: 0.5 }];
    expect(rerankBM25("what is the", chunks).map(row => [row.id, row.crossScore])).toEqual([["a", 0], ["b", 0]]);
  });
});
