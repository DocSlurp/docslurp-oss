import { describe, expect, it } from "vitest";

import { acquisitionDepth } from "../search/retrieval-controls.js";
import { mmrSelect, mmrSelectWithDiagnostics, type VectorizedChunk } from "../search/mmr.js";

function chunk(
  id: string,
  score: number,
  vector?: number[]
): VectorizedChunk {
  return { id, text: `text-${id}`, score, vector };
}

// Orthogonal unit vectors for testing diversity
const V_A = [1, 0, 0];
const V_B = [0, 1, 0];
const V_C = [0, 0, 1];
// Near-duplicate of A
const V_A2 = [0.99, 0.1, 0];

describe("mmrSelect", () => {
  it("returns empty array for empty input", () => {
    expect(mmrSelect([], 5)).toEqual([]);
  });

  it("returns all candidates when topK >= candidates length", () => {
    const candidates = [chunk("a", 0.9, V_A), chunk("b", 0.8, V_B)];
    const result = mmrSelect(candidates, 10);
    expect(result).toHaveLength(2);
  });

  it("returns exactly topK results", () => {
    const candidates = [
      chunk("a", 0.9, V_A),
      chunk("b", 0.8, V_B),
      chunk("c", 0.7, V_C),
    ];
    const result = mmrSelect(candidates, 2);
    expect(result).toHaveLength(2);
  });

  it("starts with the highest-relevance candidate", () => {
    const candidates = [
      chunk("low", 0.3, V_B),
      chunk("high", 0.9, V_A),
      chunk("mid", 0.6, V_C),
    ];
    const result = mmrSelect(candidates, 2, 1.0); // lambda=1 → pure relevance
    expect(result[0]!.id).toBe("high");
  });

  it("at lambda=1 (pure relevance) selects in descending score order", () => {
    const candidates = [
      chunk("a", 0.9, V_A),
      chunk("b", 0.8, V_B),
      chunk("c", 0.7, V_C),
    ];
    const result = mmrSelect(candidates, 3, 1.0);
    expect(result.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("at lambda=0 (pure diversity) avoids near-duplicate of first pick", () => {
    // A and A2 are very similar. With lambda=0, after picking A the algorithm
    // should prefer diverse B over the near-duplicate A2.
    const candidates = [
      chunk("a", 0.9, V_A),
      chunk("a2", 0.85, V_A2), // near-duplicate of A
      chunk("b", 0.6, V_B),    // orthogonal → diverse
    ];
    const result = mmrSelect(candidates, 2, 0.0);
    expect(result[0]!.id).toBe("a"); // highest relevance always first
    expect(result[1]!.id).toBe("b"); // diverse pick preferred over near-duplicate
  });

  it.each([false, true])("diversifies by wording when vectors are incomplete (partial=%s)", (partial) => {
    const failover = "The backup region takes traffic after fifteen minutes of checkout errors.";
    const candidates = [
      { id: "plan", text: failover, score: 0.9, vector: partial ? V_A : undefined },
      { id: "copy", text: `Copy: ${failover}`, score: 0.85 },
      { id: "sla", text: "The vendor SLA credits ten percent of fees for each hour of downtime.", score: 0.8 },
    ];
    const result = mmrSelectWithDiagnostics(candidates, 2, 0.5);
    expect(result.similarity).toBe("lexical");
    expect(result.selected.map((c) => c.id)).toEqual(["plan", "sla"]);
    // Pure relevance still keeps the near-duplicate.
    expect(mmrSelect(candidates, 2, 1).map((c) => c.id)).toEqual(["plan", "copy"]);
  });

  it("reports embedding similarity when every candidate has a vector", () => {
    const result = mmrSelectWithDiagnostics([chunk("a", 0.9, V_A), chunk("b", 0.8, V_B), chunk("c", 0.7, V_C)], 2);
    expect(result.similarity).toBe("embedding");
  });

  it("compares narrow-band fused scores fairly against similarity", () => {
    // RRF-scale scores (about 0.016 to 0.033). Unnormalized, any similarity
    // would dominate and the weakest unrelated passage would win at lambda 0.7.
    const candidates = [
      chunk("a", 0.0328, V_A),
      chunk("a2", 0.0323, [0.6, 0.8, 0]),
      chunk("weak", 0.0164, V_C),
    ];
    expect(mmrSelect(candidates, 2, 0.7).map((c) => c.id)).toEqual(["a", "a2"]);
    expect(mmrSelect(candidates, 2, 0.3).map((c) => c.id)).toEqual(["a", "weak"]);
  });

  it("returns a copy, not the same array reference", () => {
    const candidates = [chunk("a", 0.9, V_A), chunk("b", 0.8, V_B)];
    const result = mmrSelect(candidates, 2);
    expect(result).not.toBe(candidates);
  });

  it("does not mutate the input candidates array", () => {
    const candidates = [
      chunk("a", 0.9, V_A),
      chunk("b", 0.8, V_B),
      chunk("c", 0.7, V_C),
    ];
    const originalIds = candidates.map((c) => c.id);
    mmrSelect(candidates, 2);
    expect(candidates.map((c) => c.id)).toEqual(originalIds);
  });

  it("acquires extra candidates so MMR has alternatives", () => {
    expect(acquisitionDepth({}, 10)).toBe(10);
    expect(acquisitionDepth({ useMmr: true }, 10)).toBe(20);
    expect(acquisitionDepth({ useMmr: true, candidateDepth: 15 }, 10)).toBe(15);
  });
});
