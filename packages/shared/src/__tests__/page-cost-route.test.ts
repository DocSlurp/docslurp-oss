import { describe, expect, it } from "vitest";
import { pageCostRoute, scanFillPageNumbers } from "../page-cost-route.js";

describe("page cost routes", () => {
  it("does not turn unknown drawings into blank pages", () => {
    expect(pageCostRoute({ words: 0, images: 0, vectorPaths: null, grids: [], gridCoverage: 0 })).toBe("unknown");
  });
  it("keeps OCR layers and distinguishes unavailable grid evidence", () => {
    expect(pageCostRoute({ words: 100, images: 1, vectorPaths: 0, grids: null, gridCoverage: null })).toBe("unknown");
    expect(pageCostRoute({ words: 100, images: 1, vectorPaths: 0, grids: [], gridCoverage: 0 })).toBe("text");
    expect(scanFillPageNumbers(["OCR layer words", "<!-- page 2 -->", "---", "42"])).toEqual([2, 3]);
    expect(scanFillPageNumbers(null)).toBeNull();
  });
});
