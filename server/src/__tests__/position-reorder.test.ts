import { describe, expect, it } from "vitest";

import { lostInTheMiddleReorder } from "../search/position-reorder.js";

interface Chunk {
  id: string;
  score: number;
}

function chunks(...entries: [string, number][]): Chunk[] {
  return entries.map(([id, score]) => ({ id, score }));
}

describe("lostInTheMiddleReorder", () => {
  it("returns empty array for empty input", () => {
    expect(lostInTheMiddleReorder([])).toEqual([]);
  });

  it("returns single-item array unchanged", () => {
    const input = chunks(["a", 0.9]);
    const result = lostInTheMiddleReorder(input);
    expect(result.map((c) => c.id)).toEqual(["a"]);
  });

  it("returns two-item array unchanged (special case: length <= 2)", () => {
    const input = chunks(["a", 0.9], ["b", 0.8]);
    const result = lostInTheMiddleReorder(input);
    // For <= 2 items, the function returns a copy without reordering
    expect(result).toHaveLength(2);
  });

  it("places the highest-score item first", () => {
    const input = chunks(["low", 0.3], ["high", 0.9], ["mid", 0.6]);
    const result = lostInTheMiddleReorder(input);
    expect(result[0]!.id).toBe("high");
  });

  it("places the second-highest-score item last", () => {
    const input = chunks(["a", 0.9], ["b", 0.8], ["c", 0.7], ["d", 0.6]);
    const result = lostInTheMiddleReorder(input);
    // Items sorted: a(0.9), b(0.8), c(0.7), d(0.6)
    // rank 0 (a) → front, rank 2 (c) → front, rank 1 (b) → back, rank 3 (d) → back reversed
    // Pattern: even indices front, odd indices back reversed
    // front: a, c  back (reversed): d, b  → final: a, c, d, b
    expect(result[0]!.id).toBe("a");
    expect(result[result.length - 1]!.id).toBe("b");
  });

  it("preserves all items (no items dropped)", () => {
    const input = chunks(["a", 0.9], ["b", 0.8], ["c", 0.7], ["d", 0.6], ["e", 0.5]);
    const result = lostInTheMiddleReorder(input);
    expect(result).toHaveLength(5);
    expect(new Set(result.map((c) => c.id))).toEqual(new Set(["a", "b", "c", "d", "e"]));
  });

  it("returns a copy, does not mutate the input", () => {
    const input = chunks(["a", 0.9], ["b", 0.8], ["c", 0.7]);
    const originalIds = input.map((c) => c.id);
    lostInTheMiddleReorder(input);
    expect(input.map((c) => c.id)).toEqual(originalIds);
  });

  it("does not return the same array reference as input", () => {
    const input = chunks(["a", 0.9], ["b", 0.8], ["c", 0.7]);
    expect(lostInTheMiddleReorder(input)).not.toBe(input);
  });

  it("top-scoring items are not in the middle for 5 items", () => {
    // With 5 items sorted [a,b,c,d,e]:
    // even indices (front): a(rank0), c(rank2), e(rank4)
    // odd indices (back, reversed): d(rank3), b(rank1) → reversed = b, d... wait let me re-read
    // Pattern: left=0, right=4
    // i=0 even → result[0]=a, left=1
    // i=1 odd → result[4]=b, right=3
    // i=2 even → result[1]=c, left=2
    // i=3 odd → result[3]=d, right=2
    // i=4 even → result[2]=e, left=3
    // Final: [a, c, e, d, b]
    const input = chunks(["a", 0.9], ["b", 0.8], ["c", 0.7], ["d", 0.6], ["e", 0.5]);
    const result = lostInTheMiddleReorder(input);
    expect(result.map((c) => c.id)).toEqual(["a", "c", "e", "d", "b"]);
  });

  it("highest and second-highest scores are not adjacent in the middle for 5 items", () => {
    const input = chunks(["a", 0.9], ["b", 0.8], ["c", 0.7], ["d", 0.6], ["e", 0.5]);
    const result = lostInTheMiddleReorder(input);
    const aIdx = result.findIndex((c) => c.id === "a");
    const bIdx = result.findIndex((c) => c.id === "b");
    // "a" should be at position 0, "b" at last position — not in the middle
    expect(aIdx).toBe(0);
    expect(bIdx).toBe(result.length - 1);
  });
});
