import { describe, expect, it } from "vitest";

import { estimateTextTokens } from "../search/token-estimate.js";

describe("estimateTextTokens", () => {
  it("keeps the English rule of four characters per token", () => {
    expect(estimateTextTokens("a".repeat(400))).toBe(100);
    expect(estimateTextTokens("")).toBe(0);
  });
  it("does not undercount CJK, kana, Hangul or Cyrillic by the English rule", () => {
    const japanese = "東京は日本の首都です".repeat(10);
    expect(estimateTextTokens(japanese)).toBe(japanese.length);
    expect(Math.ceil(japanese.length / 4)).toBeLessThan(estimateTextTokens(japanese) / 3);
    const russian = "налоговая декларация ".repeat(10);
    expect(estimateTextTokens(russian)).toBeGreaterThan(Math.ceil(russian.length / 4) * 1.5);
  });
});
