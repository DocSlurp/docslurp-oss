import { describe, expect, it } from "vitest";
import { embeddingPageCompletions } from "./embed.js";

describe("embedding page completion", () => {
  it("waits for every chunk of a page, including overlap across windows", () => {
    expect(embeddingPageCompletions([
      { pageNumber: 1, pageNumbers: [1, 2] },
      { pageNumber: 2 },
      { pageNumbers: [2, 3] },
      { pageNumber: 4 },
    ], [{ chunkIndexes: [0, 1] }, { chunkIndexes: [2, 3] }])).toEqual([[1], [2, 3, 4]]);
  });
  it("does not invent physical pages for unanchored or invalid chunks", () => {
    expect(embeddingPageCompletions([
      { pageNumber: null }, { pageNumbers: [0, -1, 1.5, 8, 8] },
    ], [{ chunkIndexes: [0] }, { chunkIndexes: [1] }])).toEqual([[], [8]]);
  });
});
