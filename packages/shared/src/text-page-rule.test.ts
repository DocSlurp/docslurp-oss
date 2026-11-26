import { describe, expect, it } from "vitest";

import { decodeTextBytes } from "./file-sniff.js";
import { measuredTextPages, stripHtmlMarkup, TEXT_PAGE_CJK_WEIGHT, TEXT_PAGE_CHARS, TEXT_PAGE_LINES } from "./text-page-rule.js";

/** The rule as it was written before it counted by scanning (split into lines): the reference the scan must equal. */
function splitReference(text: string, options: { markup?: boolean } = {}): number {
  const visible = options.markup ? stripHtmlMarkup(text) : text;
  const lines = options.markup ? visible.split(/\r?\n/).filter((line) => line.trim() !== "").length : visible.split(/\r?\n/).length;
  const trimmed = visible.trim();
  let chars = trimmed.length;
  const cjk = (code: number) => (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff66 && code <= 0xff9f) || (code >= 0x20000 && code <= 0x2fa1f);
  for (const char of trimmed) if (cjk(char.codePointAt(0)!)) chars += TEXT_PAGE_CJK_WEIGHT - 1;
  return Math.max(1, Math.ceil(lines / TEXT_PAGE_LINES), Math.ceil(chars / TEXT_PAGE_CHARS));
}

describe("the text page rule", () => {
  it("counts by lines or characters, whichever is more", () => {
    expect(measuredTextPages(Array.from({ length: 180 }, (_, index) => `line ${index + 1}`).join("\n"))).toBe(3);
    expect(measuredTextPages("x".repeat(TEXT_PAGE_CHARS * 2 + 1))).toBe(3);
    expect(measuredTextPages("")).toBe(1);
  });

  it("counts a UTF-16LE CSV by its characters, not its bytes", () => {
    const rows = Array.from({ length: 100 }, (_, index) => `row${index},value${index}`).join("\r\n");
    const utf16 = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows, "utf16le")]));
    expect(measuredTextPages(decodeTextBytes(utf16, "utf-16le"))).toBe(measuredTextPages(decodeTextBytes(new TextEncoder().encode(rows), "utf-8")));
  });

  it("counts East Asian text at its information density, and HTML without its markup", () => {
    expect(measuredTextPages("日本語".repeat(500))).toBe(2); // 1,500 characters, 4,500 weighted
    expect(measuredTextPages("𠀀".repeat(1200))).toBe(2); // astral East Asian: two code units and weight three each
    const markup = `<html><head><style>${"a{color:red}".repeat(2000)}</style><script>${"var x=1;".repeat(2000)}</script></head><body><p>Short page.</p></body></html>`;
    expect(measuredTextPages(markup, { markup: true })).toBe(1);
    expect(measuredTextPages(markup)).toBeGreaterThan(1);
  });

  it("matches the split-based rule exactly on varied and hostile text", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const alphabet = ["a", " ", "\n", "\r\n", "\r", "\t", "<p>", "</p>", "<script>", "</script>", "<!--", "-->", "日", "　", " ", "﻿", " ", "𠀀", "\ud800", "<", ">", "x".repeat(40)];
    for (let sample = 0; sample < 300; sample++) {
      const parts: string[] = [];
      const length = Math.floor(random() * 4000);
      for (let index = 0; index < length; index++) parts.push(alphabet[Math.floor(random() * alphabet.length)]!);
      const text = parts.join("");
      for (const markup of [false, true]) expect([sample, markup, measuredTextPages(text, { markup })]).toEqual([sample, markup, splitReference(text, { markup })]);
    }
  });

  it("counts a file of newlines without building a line array", () => {
    const text = "\n".repeat(20_000_000);
    const before = process.memoryUsage().heapUsed;
    expect(measuredTextPages(text)).toBe(Math.ceil(20_000_001 / TEXT_PAGE_LINES));
    // Splitting would allocate twenty million strings (hundreds of MB); the scan allocates nothing proportional.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
  });
});
