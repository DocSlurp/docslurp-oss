import { describe, expect, it } from "vitest";

import { countMarkdownTables, normalizeExtractedMarkdown, sanitizeExtractedMarkdown } from "../lib/extracted-markdown.js";
import { stripLeadingFrontmatter } from "../lib/markdown-structure.js";
import { stripTrailingPageBreak } from "../lib/page-equivalents.js";
import { splitProcessedPdfPages } from "../lib/pdf-page-count.js";

// Council I audit: every scan over extracted (customer) Markdown is linear; each of these took seconds to minutes before.
// 1 MB inputs, bounded at 250 ms so the suite stays stable under parallel load; quadratic scans took seconds to minutes.
/** Best of three runs after a warm-up: the bound is about growth (quadratic took seconds), not JIT noise. */
const elapsed = (fn: () => unknown) => { fn(); let best = Infinity; for (let i = 0; i < 3; i++) { const start = performance.now(); fn(); best = Math.min(best, performance.now() - start); } return best; };
const MB = 1024 * 1024;

describe("linear scans over hostile extracted Markdown", () => {
  it("data: URI stripping on 1 MB of `data:` runs", () => {
    const text = "data:".repeat(MB / 5);
    expect(elapsed(() => sanitizeExtractedMarkdown(text))).toBeLessThan(250); // the regex took about 6 minutes
    expect(sanitizeExtractedMarkdown("a data:image/png;base64,AAAA b DATA:x;BASE64,QQ== c").markdown)
      .toBe("a artifact://externalized-data-uri b artifact://externalized-data-uri c");
  });

  it("pipe-table blocks on 1 MB of pipe lines with no blank line after", () => {
    const scan = (text: string) => () => { countMarkdownTables(text); normalizeExtractedMarkdown({ markdown: text, preserveTables: true }); };
    // The regex this replaced took about 35 s at 1 MB; a line split and join of 1 MB stays well under this.
    expect(elapsed(scan(`${"|a|\n".repeat(MB / 4)}x`))).toBeLessThan(250);
    expect(countMarkdownTables("|a|b|\n|---|---|\n|1|2|\n\nafter")).toBe(1);
  });

  it("a trailing page break on 1 MB of form feeds and whitespace", () => {
    const text = `${"\f \n".repeat(MB / 3)}x`;
    expect(elapsed(() => { splitProcessedPdfPages(text, "poppler-text"); stripTrailingPageBreak(text); stripTrailingPageBreak(`${"\f".repeat(MB)}x`); })).toBeLessThan(250);
    expect(stripTrailingPageBreak("a\fb\f \n\f\n")).toBe("a\fb");
    expect(stripTrailingPageBreak("a\fb \n")).toBe("a\fb \n");
  });

  it("frontmatter stripping never removes a form feed", () => {
    expect(stripLeadingFrontmatter("\n\f\n---\ntitle: x\n---\nbody").strippedLines).toBe(0);
    expect(stripLeadingFrontmatter("---\ntitle: x\n---\n\n\fpage 2").markdown).toBe("\fpage 2");
    expect(stripLeadingFrontmatter("---\ntitle: x\n---\n\n\nbody").markdown).toBe("body");
  });
});

describe("table normalization is one forward pass over many small tables (council K #1)", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n";
  const tables = (mb: number) => table.repeat(Math.floor((mb * MB) / table.length));
  const convert = (text: string) => () => normalizeExtractedMarkdown({ markdown: text, preserveTables: true });

  it("converts every table, and 1 MB of small pipe tables in under 250 ms", () => {
    const text = tables(1);
    expect(convert(text)().split("<table").length - 1).toBe(Math.floor(MB / table.length));
    expect(elapsed(convert(text))).toBeLessThan(250);
  });

  it("4 MB is linear in 1 MB (a splice per table took 110 s at 4 MB)", () => {
    const one = elapsed(convert(tables(1)));
    const four = elapsed(convert(tables(4)));
    expect(four).toBeLessThan(Math.max(6 * one, 50));
    expect(four).toBeLessThan(1_000);
  });

  it("a row holding a form feed is never a table row, so the page break survives (council K #7)", () => {
    const text = "| a | b |\n| --- | --- |\n| 1 |\f2 |\n\n";
    const out = normalizeExtractedMarkdown({ markdown: text, preserveTables: true });
    expect(out.split("\f")).toHaveLength(2);
  });
});
