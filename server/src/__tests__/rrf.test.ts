import { describe, expect, it } from "vitest";

import { reciprocalRankFusion } from "../search/rrf.js";

interface Item {
  id: string;
  label: string;
}

function items(...ids: string[]): Item[] {
  return ids.map((id) => ({ id, label: `item-${id}` }));
}

describe("reciprocalRankFusion", () => {
  it("returns an empty array when given no lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it("returns an empty array when all lists are empty", () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it("returns the single list unchanged when only one list is provided", () => {
    const list = items("a", "b", "c");
    const result = reciprocalRankFusion([list]);
    expect(result.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("deduplicates items that appear in multiple lists", () => {
    const l1 = items("a", "b", "c");
    const l2 = items("b", "c", "d");
    const result = reciprocalRankFusion([l1, l2]);
    const ids = result.map((r) => r.id);
    // No duplicates
    expect(new Set(ids).size).toBe(ids.length);
    // All unique items present
    expect(new Set(ids)).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("ranks items that appear in multiple lists higher than single-list items", () => {
    const l1 = items("shared", "only-l1");
    const l2 = items("shared", "only-l2");
    const result = reciprocalRankFusion([l1, l2]);
    const ids = result.map((r) => r.id);
    expect(ids[0]).toBe("shared");
  });

  it("items at rank 0 (top) score higher than items at rank 1", () => {
    // With k=60: rank-0 score = 1/61, rank-1 score = 1/62
    // So "a" in list1 at rank-0 AND list2 at rank-0 should beat "b" at rank-1 in both lists
    const l1 = items("a", "b");
    const l2 = items("a", "b");
    const result = reciprocalRankFusion([l1, l2]);
    expect(result[0]!.id).toBe("a");
    expect(result[1]!.id).toBe("b");
  });

  it("uses the full item object from the first occurrence", () => {
    const l1 = [{ id: "x", label: "from-list-1" }];
    const l2 = [{ id: "x", label: "from-list-2" }];
    const result = reciprocalRankFusion([l1, l2]);
    // id "x" appears in both; the stored object should be the first one seen
    expect(result[0]!.label).toBe("from-list-1");
  });

  it("handles lists of different lengths", () => {
    const l1 = items("a");
    const l2 = items("b", "c", "d", "e");
    const result = reciprocalRankFusion([l1, l2]);
    expect(result).toHaveLength(5);
  });

  it("respects a custom k value", () => {
    // With a very large k, rank differences matter less → scores are very close
    // With k=0, rank 0 score = 1/1=1, rank 1 score = 1/2 → bigger difference
    const l1 = items("a", "b");
    const resultK0 = reciprocalRankFusion([l1], 0);
    const resultK60 = reciprocalRankFusion([l1], 60);
    // Both should preserve order
    expect(resultK0.map((r) => r.id)).toEqual(["a", "b"]);
    expect(resultK60.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("correctly fuses three ranked lists", () => {
    const l1 = items("c", "a", "b");
    const l2 = items("a", "b", "c");
    const l3 = items("a", "c", "b");
    const result = reciprocalRankFusion([l1, l2, l3]);
    // "a" appears at ranks 1, 0, 0 → consistently high
    // "c" appears at ranks 0, 2, 1
    // "b" appears at ranks 2, 1, 2
    expect(result[0]!.id).toBe("a");
  });
});
