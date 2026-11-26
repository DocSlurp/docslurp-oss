import { describe, expect, it } from "vitest";

import {
  filterPiiWithheldHits,
  isPageWithheld,
  isPiiWithheldPlaceholder,
  markdownSections,
  pageOffsets,
  pagesOfMatch,
  PII_WITHHELD_SECTION_TEXT,
  piiWithheldPageText,
  piiWithheldSummary,
  piiWithholding,
  withheldPageOfSlot,
  withheldPages,
  withholdTextPages,
  withholdTextSections,
  type PiiWithholding,
} from "../pii-withholding.js";

const pages = (list: number[]): PiiWithholding => ({ scope: "pages", pages: new Set(list) });

describe("piiWithholding (fail closed)", () => {
  it("reads page, section and document scopes", () => {
    expect(piiWithholding({ status: "completed", metadata: { pii: { scope: "pages", withheldPages: [3, 7] } } }))
      .toEqual({ scope: "pages", pages: new Set([3, 7]) });
    expect(piiWithholding({ status: "completed", metadata: { pii: { scope: "sections", withheldSectionCount: 2 } } }))
      .toEqual({ scope: "sections", sectionCount: 2 });
    expect(piiWithholding({ status: "pii_blocked", metadata: {} }).scope).toBe("document");
    expect(piiWithholding({ status: "completed", metadata: null }).scope).toBe("none");
    expect(piiWithholding({ status: "completed", metadata: { pii: { action: "flag_for_review", matchCount: 2 } } }).scope).toBe("none");
  });

  it("withholds the whole document on malformed or unknown outcomes", () => {
    for (const metadata of [
      { pii: { scope: "pages", withheldPages: [] } },
      { pii: { scope: "pages", withheldPages: ["3"] } },
      { pii: { scope: "pages", withheldPages: [0] } },
      { pii: { scope: "pages", withheldPages: [1.5] } },
      { pii: { scope: "pages" } },
      { pii: { scope: "pages-v2", withheldPages: [1] } },
      { pii: { withheldPages: [1] } },
      { pii: { blocked: true, scope: "pages", withheldPages: [1] } },
      { pii: "pages" },
      { pii: [1] },
      "metadata",
    ]) {
      expect(piiWithholding({ status: "completed", metadata }).scope, JSON.stringify(metadata)).toBe("document");
    }
  });
});

describe("isPageWithheld", () => {
  it("withholds only the listed pages; a span is withheld when any page of it is", () => {
    const w = pages([7]);
    expect(isPageWithheld(w, 6)).toBe(false);
    expect(isPageWithheld(w, 7)).toBe(true);
    expect(isPageWithheld(w, [6, 7])).toBe(true);
    expect(isPageWithheld(w, [5, 6])).toBe(false);
  });
  it("a hit without a page on a page-scoped document is withheld", () => {
    expect(isPageWithheld(pages([2]), null)).toBe(true);
    expect(isPageWithheld(pages([2]), undefined)).toBe(true);
    expect(isPageWithheld(pages([2]), [])).toBe(true);
    expect(isPageWithheld(pages([2]), [1, null])).toBe(true);
    expect(isPageWithheld({ scope: "none" }, null)).toBe(false);
  });
  it("document scope withholds everything", () => {
    expect(isPageWithheld({ scope: "document", reason: "x" }, 1)).toBe(true);
    expect(withheldPages({ scope: "document", reason: "x" })).toBe("all");
  });
});

describe("slot pages", () => {
  it("names the page of page images, renders and figures, and nothing else", () => {
    expect(withheldPageOfSlot("page-4")).toBe(4);
    expect(withheldPageOfSlot("doc-1:page-12")).toBe(12);
    expect(withheldPageOfSlot("raster-v3-reader-120dpi-page-9")).toBe(9);
    expect(withheldPageOfSlot("raster-v2-reader-page-2")).toBe(2);
    expect(withheldPageOfSlot("doppler-figure:p7.2")).toBe(7);
    expect(withheldPageOfSlot("doc-1:doppler-figure:p11.g0")).toBe(11);
    for (const slot of ["markdown", "canonical-document", "doppler-figures", "images", "doppler-figure:bogus", "page-0", "pages-3", "doppler-markdown"]) {
      expect(withheldPageOfSlot(slot), slot).toBeNull();
    }
  });
});

describe("page attribution", () => {
  const text = "page one\fpage two 123-45-6789\fpage three";
  it("places offsets on pages and a match spanning a break on both", () => {
    const offsets = pageOffsets(text, 3);
    expect(offsets).not.toBeNull();
    const at = text.indexOf("123");
    expect(pagesOfMatch(offsets, at, 11)).toEqual([2]);
    const spanning = text.indexOf("two");
    expect(pagesOfMatch(offsets, spanning, text.indexOf("three") - spanning + 2)).toEqual([2, 3]);
  });
  it("unknown when page breaks do not match the page count", () => {
    expect(pageOffsets("no breaks here", 3)).toBeNull();
    expect(pagesOfMatch(pageOffsets("a\fb", 5), 0, 1)).toBeNull();
    expect(pageOffsets("a\fb\f\f", 2)).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }]);
  });
  it("replaces withheld pages with a placeholder and leaves the rest", () => {
    const out = withholdTextPages(text, new Set([2]));
    expect(out.split("\f")).toEqual(["page one", piiWithheldPageText(2), "page three"]);
    expect(out).not.toContain("123-45-6789");
    expect(isPiiWithheldPlaceholder(piiWithheldPageText(2))).toBe(true);
    expect(isPiiWithheldPlaceholder(` ${PII_WITHHELD_SECTION_TEXT}\n`)).toBe(true);
    expect(isPiiWithheldPlaceholder("page one")).toBe(false);
  });
});

describe("sections (unpaged)", () => {
  it("withholds the heading section holding the match", () => {
    const text = "# Intro\nHello.\n\n# Payroll\nSSN 123-45-6789 here.\n\n# Outro\nBye.\n";
    const at = text.indexOf("123");
    const result = withholdTextSections(text, [{ charOffset: at, length: 11 }]);
    expect(result.withheldSectionCount).toBe(1);
    expect(result.text).toContain("# Intro\nHello.");
    expect(result.text).toContain("# Outro\nBye.");
    expect(result.text).toContain(PII_WITHHELD_SECTION_TEXT);
    expect(result.text).not.toContain("Payroll");
    expect(result.text).not.toContain("123-45-6789");
  });
  it("falls back to paragraphs without headings", () => {
    const text = "First para.\n\nSecond 123-45-6789 para.\n\nThird para.";
    expect(markdownSections(text)).toHaveLength(3);
    const result = withholdTextSections(text, [{ charOffset: text.indexOf("123"), length: 11 }]);
    expect(result.text).toContain("First para.");
    expect(result.text).toContain("Third para.");
    expect(result.text).not.toContain("123-45-6789");
  });
  it("a match it cannot locate withholds everything", () => {
    const result = withholdTextSections("short", [{ charOffset: 500, length: 3 }]);
    expect(result.text).toBe(PII_WITHHELD_SECTION_TEXT);
  });
});

describe("filterPiiWithheldHits", () => {
  const hit = (documentId: string, pageNumber: number | null, pageNumbers: number[] = [], source = "document") =>
    ({ citation: { source, documentId, pageNumber, pageNumbers } });
  const withholdings = new Map<string, PiiWithholding>([
    ["doc-a", pages([7])],
    ["doc-b", { scope: "none" }],
    ["doc-c", { scope: "document", reason: "pii-blocked" }],
  ]);
  it("drops withheld pages, page-less hits of page-scoped documents and blocked documents; keeps the rest", () => {
    const hits = [
      hit("doc-a", 6), hit("doc-a", 7), hit("doc-a", null, [6, 7]), hit("doc-a", null), hit("doc-a", 8),
      hit("doc-b", null), hit("doc-c", 1), hit("doc-unknown", 1), hit("doc-c", null, [], "community_summary"),
    ];
    const { kept, dropped } = filterPiiWithheldHits(hits, withholdings);
    expect(kept).toEqual([hit("doc-a", 6), hit("doc-a", 8), hit("doc-b", null), hit("doc-c", null, [], "community_summary")]);
    expect(dropped).toBe(5);
  });
});

describe("piiWithheldSummary", () => {
  it("says how many pages and which, never content", () => {
    expect(piiWithheldSummary(pages([7, 3])).message).toBe("2 pages withheld for privacy (pages 3, 7)");
    expect(piiWithheldSummary(pages([3])).withheldPages).toEqual([3]);
    expect(piiWithheldSummary({ scope: "document", reason: "x" }, 3).withheldPages).toEqual([1, 2, 3]);
    expect(piiWithheldSummary({ scope: "none" }).message).toBeNull();
  });
});
