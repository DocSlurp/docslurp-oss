import { describe, expect, it } from "vitest";

import { normalizePageNumber, normalizePageNumbers, splitTextIntoPages } from "../index.js";

describe("normalizePageNumber", () => {
  it("keeps positive 1-based integers and rejects zero/negative values", () => {
    expect(normalizePageNumber(1)).toBe(1);
    expect(normalizePageNumber(3.9)).toBe(3);
    expect(normalizePageNumber(0)).toBeNull();
    expect(normalizePageNumber(-2)).toBeNull();
  });
});

describe("normalizePageNumbers", () => {
  it("deduplicates, sorts, and drops invalid page numbers", () => {
    expect(normalizePageNumbers([3, 1, 3, 0, -4, 2.9])).toEqual([1, 2, 3]);
  });
});

describe("splitTextIntoPages", () => {
  it("prefers explicit form-feed boundaries", () => {
    expect(splitTextIntoPages("alpha\fbravo", 2)).toEqual(["alpha", "bravo"]);
  });

  it("keeps empty pages in place when form feeds describe every page", () => {
    // Pages 2 and 4 have no text layer (a scan, a blank page); page 3 must stay page 3.
    expect(splitTextIntoPages("alpha\f\fcharlie\f", 4)).toEqual(["alpha", "", "charlie", ""]);
    expect(splitTextIntoPages("\fbravo", 2)).toEqual(["", "bravo"]);
    // A trailing form feed after the last page does not add a page.
    expect(splitTextIntoPages("alpha\fbravo\f", 2)).toEqual(["alpha", "bravo"]);
  });

  it("drops empty sections when form feeds do not match the page count", () => {
    expect(splitTextIntoPages("alpha\f\fbravo", 5)).toEqual(["alpha", "bravo"]);
    expect(splitTextIntoPages("alpha\f\fbravo")).toEqual(["alpha", "bravo"]);
  });

  it("accepts horizontal-rule boundaries when they match the requested page count", () => {
    expect(splitTextIntoPages("alpha\n---\nbravo", 2)).toEqual(["alpha", "bravo"]);
  });

  it("falls back to deterministic page slices when no explicit boundaries exist", () => {
    const pages = splitTextIntoPages("abcdefghij", 3);
    expect(pages).toHaveLength(3);
    expect(pages.join("")).toBe("abcdefghij");
  });
});
