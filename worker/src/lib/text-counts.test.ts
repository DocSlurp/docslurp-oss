import { describe, it, expect } from "vitest";
import { countWhitespaceAndWords } from "./text-counts.js";

describe("allocation-free text counts", () => {
  const legacy = (text: string) => ({
    whitespaceCount: (text.match(/\s/g) ?? []).length,
    words: text.trim().split(/\s+/).filter(Boolean).length,
  });
  it("matches ECMAScript whitespace for every UTF-16 code unit", () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      const char = String.fromCharCode(code);
      for (const text of [char, `a${char}b`, `${char}a${char}`]) {
        expect(countWhitespaceAndWords(text)).toEqual(legacy(text));
      }
    }
  });
  it("matches empty, dense, multilingual and page-separated text", () => {
    for (const text of ["", " \t\n", "hello", "word ".repeat(100_000), "中文 日本語\fالعربية\u2028ไทย", "a\ud800b\udc00c"]) {
      expect(countWhitespaceAndWords(text)).toEqual(legacy(text));
    }
  });
});
