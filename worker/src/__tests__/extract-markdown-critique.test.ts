import { describe, expect, it } from "vitest";

import { budgetCritiquePages, mergeCritiquedPages, selectCritiquePages } from "../stages/extract-markdown.js";
import { scoreExtractionPlausibility } from "../lib/extracted-markdown.js";

describe("budgetCritiquePages", () => {
  it("never launches more paid pages than the preflight ceiling permits", () => {
    expect(budgetCritiquePages([2, 3, 4], 5, 2)).toEqual([2, 3]);
    expect(budgetCritiquePages([2, 3], 1, 2)).toEqual([]);
  });
});

describe("selectCritiquePages", () => {
  it("picks the lowest-plausibility pages first", () => {
    const pages = selectCritiquePages([
      { pageNumber: 1, plausibilityScore: 0.6, strategy: "base", charCount: 800, tokenEstimate: 200 },
      { pageNumber: 2, plausibilityScore: 0.21, strategy: "base", charCount: 40, tokenEstimate: 10 },
      { pageNumber: 3, plausibilityScore: 0.31, strategy: "base", charCount: 90, tokenEstimate: 22 },
      { pageNumber: 4, plausibilityScore: 0.5, strategy: "base", charCount: 600, tokenEstimate: 160 }
    ]);

    expect(pages).toEqual([2, 3]);
  });
});

describe("mergeCritiquedPages", () => {
  it("replaces only the corrected page slices", () => {
    const merged = mergeCritiquedPages(
      "first page\fsecond page\fthird page",
      3,
      [{ pageNumber: 2, text: "second page corrected" }]
    );

    expect(merged).toBe("first page\fsecond page corrected\fthird page");
  });
});

describe("scoreExtractionPlausibility", () => {
  it("rewards fuller corrected markdown", () => {
    const original = "Name: ___";
    const corrected = "Name: Jane Example\nAddress: 123 Market Street\nSignature: Jane Example";

    expect(
      scoreExtractionPlausibility(corrected, 1).plausibilityScore,
    ).toBeGreaterThan(
      scoreExtractionPlausibility(original, 1).plausibilityScore,
    );
  });
});
