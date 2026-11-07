import { describe, expect, it } from "vitest";
import { fuseWithRerank, rerankBM25 } from "../search/rerank.js";

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

describe("fusing a reranker with the hybrid order", () => {
  const chunk = (id: string, text: string, score = 0) => ({ id, text, score });
  it("does not let a lone stray word outrank the hybrid answer", () => {
    const hybrid = [
      chunk("answer", "To terminate your plan, open Billing and choose End membership."),
      chunk("related", "Plans renew monthly unless ended from the Billing page."),
      chunk("cook", "I do not know how to cook."),
    ];
    const reranked = rerankBM25("how do I cancel my subscription", hybrid);
    expect(reranked[0]?.id).toBe("cook");
    expect(fuseWithRerank(hybrid, reranked).map(c => c.id)[0]).toBe("answer");
  });
  it("promotes a candidate the reranker likes when the hybrid order only mildly prefers others", () => {
    const hybrid = Array.from({ length: 8 }, (_, i) => chunk(`c${i}`, i === 3 ? "cobalt pump calibration interval" : `filler ${i}`));
    const reranked = rerankBM25("cobalt pump calibration interval", hybrid);
    const fused = fuseWithRerank(hybrid, reranked).map(c => c.id);
    expect(fused.indexOf("c3")).toBeLessThan(3);
    expect(fused.sort()).toEqual(hybrid.map(c => c.id).sort());
  });
  it("keeps raw reranker scores separate from the fused score and ties keep hybrid order", () => {
    const hybrid = [chunk("a", "x"), chunk("b", "y")];
    const fused = fuseWithRerank(hybrid, [{ ...hybrid[1]!, crossScore: 9 }, { ...hybrid[0]!, crossScore: 1 }]);
    expect(fused.map(c => c.id)).toEqual(["a", "b"]);
    expect(fused[1]).toMatchObject({ rerankScore: 9 });
    expect(fused[0]!.score).toBe(fused[0]!.crossScore);
  });
});
