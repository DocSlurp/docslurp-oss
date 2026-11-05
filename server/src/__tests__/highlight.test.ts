import { describe, expect, it } from "vitest";

import { highlightMatches } from "../search/highlight.js";
import { stableFetchLimit } from "../routes/algolia-compat.js";

describe("highlightMatches", () => {
  const mark = (text: string, query: string) => highlightMatches(text, query, "[", "]");

  it("wraps whole words and reports partial matches", () => {
    expect(mark("Refund policy for enterprise plans", "refund plan")).toMatchObject({
      value: "[Refund] policy for enterprise plans",
      matchLevel: "partial",
      matchedWords: ["refund"],
    });
    expect(mark("nothing here", "refund")).toMatchObject({ value: "nothing here", matchLevel: "none", matchedWords: [] });
  });

  it("does not mark a word that merely contains a query word", () => {
    expect(mark("taxi and taxes", "tax").value).toBe("taxi and taxes");
  });

  it("ignores case and accents and keeps the original letters", () => {
    expect(mark("Die MÜLLER GmbH und die Gebühren", "muller gebuhren").value).toBe("Die [MÜLLER] GmbH und die [Gebühren]");
    expect(mark("Налоговая декларация", "налоговая").value).toBe("[Налоговая] декларация");
  });

  it("marks CJK character runs, which have no word boundaries", () => {
    expect(mark("東京は日本の首都です", "日本の首都")).toMatchObject({ value: "東京は[日本の首都]です", matchLevel: "full" });
  });

  it("returns the whole text unchanged, including markup, apart from the tags", () => {
    expect(mark("<b>fee</b> & tax", "fee").value).toBe("<b>[fee]</b> & tax");
  });
});

describe("stableFetchLimit", () => {
  it("gives neighbouring pages the same fetch size so they share one search", () => {
    expect([11, 21, 31, 41, 50].map(stableFetchLimit)).toEqual([50, 50, 50, 50, 50]);
    expect([51, 101, 201].map(stableFetchLimit)).toEqual([100, 200, 400]);
    expect(stableFetchLimit(2_000)).toBe(1000);
  });
});
