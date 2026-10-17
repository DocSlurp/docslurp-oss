import { describe, expect, it } from "vitest";

import { mmrSelect, type VectorizedChunk } from "../search/mmr.js";

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

  it("preserves relevance when no vectors are present", () => {
    const candidates = [
      chunk("a", 0.9),
      chunk("b", 0.8),
      chunk("c", 0.7),
      chunk("d", 0.6),
    ];
    const result = mmrSelect(candidates, 2);
    expect(result.map(item => item.id)).toEqual(["a", "b"]);
  });

  it("preserves relevance when only some candidates have vectors", () => {
    const candidates = [
      chunk("a", 0.9, V_A),
      chunk("b", 0.8),         // no vector
    ];
    const result = mmrSelect(candidates, 2);
    expect(result).toHaveLength(2);
  });

  it("relevance fallback returns highest-score item first", () => {
    const candidates = [
      chunk("low", 0.2),
      chunk("high", 0.9),
      chunk("mid", 0.6),
    ];
    const result = mmrSelect(candidates, 2);
    expect(result[0]!.id).toBe("high");
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
});

describe("MMR relevance contract", () => {
  it("honors lambda=1 without vectors or with more requested slots than candidates", () => {
    const candidates = [chunk("low", 0.1), chunk("high", 0.9), chunk("mid", 0.5)];
    expect(mmrSelect(candidates, 2, 1).map(item => item.id)).toEqual(["high", "mid"]);
    expect(mmrSelect(candidates, 9, 1).map(item => item.id)).toEqual(["high", "mid", "low"]);
  });
  it.each([
    [[1, 0], [1]],
    [[1, 0], [Number.NaN, 0]],
    [[1, 0], [0, 0]],
  ])("falls back to relevance for incomparable vectors", (first, second) => {
    const candidates = [chunk("low", 0.1, first), chunk("high", 0.9, second), chunk("mid", 0.5, first)];
    expect(mmrSelect(candidates, 2, 0).map(item => item.id)).toEqual(["high", "mid"]);
  });
  it("returns no results when zero are requested", () => {
    expect(mmrSelect([chunk("a", 1, V_A)], 0)).toEqual([]);
  });
});
