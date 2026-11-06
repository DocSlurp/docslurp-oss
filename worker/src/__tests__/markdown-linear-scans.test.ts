import { describe, expect, it } from "vitest";

import { countMarkdownTables, normalizeExtractedMarkdown, sanitizeExtractedMarkdown, scoreMarkdownCandidate } from "../lib/extracted-markdown.js";
import { HEADING_MAX_LINE_CHARS, parseAtxHeading, plainHeadingText, stripLeadingFrontmatter } from "../lib/markdown-structure.js";
import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { chunkText } from "../pipeline/chunking.js";
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

  it("4 MB of small pipe tables converts in under 2 s (a splice per table took 110 s; about 190 ms unloaded)", () => {
    expect(elapsed(convert(tables(4)))).toBeLessThan(2_000);
  });

  it("a row holding a form feed is never a table row, so the page break survives (council K #7)", () => {
    const text = "| a | b |\n| --- | --- |\n| 1 |\f2 |\n\n";
    const out = normalizeExtractedMarkdown({ markdown: text, preserveTables: true });
    expect(out.split("\f")).toHaveLength(2);
  });
});

describe("heading detection and cleanup are linear on hostile heading lines (council K #3)", () => {
  // Each shape at the 8 KB heading line cap: whitespace and NBSP runs, unclosed image/link/tag/autolink openers,
  // backtick runs and unclosed bold, underscore-bold and strikethrough. Each took 30-100 ms per 8 KB line before.
  const shapes: Record<string, (n: number) => string> = {
    whitespace: (n) => `a${" ".repeat(n)}x`, nbsp: (n) => `a${" ".repeat(n)}x`, image: (n) => "![".repeat(n / 2), link: (n) => "[".repeat(n),
    tag: (n) => "<a".repeat(n / 2), autolink: (n) => "<http:".repeat(n / 6), target: (n) => "[a](".repeat(n / 4), backticks: (n) => `${"`".repeat(n)}a`,
    bold: (n) => "**a ".repeat(n / 4), underscoreBold: (n) => "__a ".repeat(n / 4), strike: (n) => "~~a ".repeat(n / 4), closingHashes: (n) => `a${" #".repeat(n / 2)} x`,
  };

  it.each(Object.keys(shapes))("an 8 KB %s heading parses and cleans in under 20 ms", (shape) => {
    const text = shapes[shape]!(HEADING_MAX_LINE_CHARS - 16);
    expect(elapsed(() => { plainHeadingText(text); parseAtxHeading(`# ${text}`); })).toBeLessThan(20);
  });

  // About 13 s per MB before; the bound leaves room for a loaded CI runner.
  it.each(Object.keys(shapes))("1 MB of 8 KB %s headings goes through the canonical builder and the chunker in under 1 s", (shape) => {
    const line = `# ${shapes[shape]!(HEADING_MAX_LINE_CHARS - 16)}`;
    const text = `${line}\n`.repeat(Math.floor(MB / (line.length + 1)));
    expect(elapsed(() => { buildCanonicalDocumentFromMarkdown({ documentId: "d", text, pageCount: 1 } as never); [...chunkText(text, 1800)]; })).toBeLessThan(1_000);
  });

  it("keeps ordinary headings as before; longer lines are body text", () => {
    expect(parseAtxHeading("## Title ##")).toEqual({ level: 2, text: "Title ##" });
    expect(plainHeadingText("Title ##")).toBe("Title");
    expect(plainHeadingText("![logo](x.png) **Revenue** [notes](#n) <b>Q1</b> ~~old~~ `code`")).toBe("logo Revenue notes Q1 old code");
    expect(parseAtxHeading("####### seven")).toBeNull();
    expect(parseAtxHeading("#nospace")).toBeNull();
    expect(parseAtxHeading(`# ${"a".repeat(HEADING_MAX_LINE_CHARS)}`)).toBeNull();
  });
});

describe("the remaining host regexes the audit found superlinear are linear (council K #3 audit)", () => {
  it("TOC leader lines: 1 MB of hostile 1 KB lines in under 250 ms, and real entries still match", async () => {
    const { isLeaderTocLine, buildExtractionContract } = await import("../lib/extraction-contract.js");
    for (const entry of ["Introduction ........ 12", "Methods … 7", "Results ··· 103", "Appendix A      2048", "Intro.....  3"]) expect(isLeaderTocLine(entry), entry).toBe(true);
    for (const other of ["... 12", "    12", "Chapter 12345", "Total 12", "text"]) expect(isLeaderTocLine(other), other).toBe(false);
    const hostile = [`<table>${" ".repeat(1000)}`, `a${" ".repeat(1000)}`, `a${".".repeat(1000)}`, `a${" ".repeat(1000)}1x`];
    for (const line of hostile) {
      const text = `${line}\n`.repeat(Math.floor(MB / (line.length + 1)));
      expect(elapsed(() => buildExtractionContract({ documentId: "d", markdown: text, extractor: "x", strategy: "s", extractionTimeMs: 1, pageCount: 1 }))).toBeLessThan(1_000);
    }
  });

  it("candidate scoring counts links and list markers in linear time on unclosed and blank-line runs", () => {
    for (const text of ["![[".repeat(MB / 3), "\n".repeat(MB), "[a](".repeat(MB / 4)]) {
      expect(elapsed(() => scoreMarkdownCandidate({ markdown: text }))).toBeLessThan(1_000);
    }
    expect(scoreMarkdownCandidate({ markdown: "- a\n- b\n\n[x](y)\n" })).toBeTruthy();
  });

  it("table cell typing refuses the percentage regex on long cells", async () => {
    const { typeColumn } = await import("../lib/table-typing.js");
    expect(elapsed(() => typeColumn([`1${" ".repeat(8 * 1024)}x%`, "12%"]))).toBeLessThan(50);
    expect(typeColumn(["12 %", "3.5%"]).columnType).toBe("percentage");
  });
});

describe("links with one level of parentheses in the target still parse (council M #6)", () => {
  it("cleans Wikipedia-style targets out of headings and counts them in the scorer, linearly", () => {
    expect(plainHeadingText("[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) and ![img](a_(b).png)")).toBe("Foo and img");
    const scored = (markdown: string) => scoreMarkdownCandidate({ markdown }).formattingScore;
    expect(scored("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))\n")).toBe(scored("[Foo](https://example.com/foo)\n"));
    for (const unit of ["[a](", "[a](x(", "[a]((((", "[a](x(y)"]) {
      const text = unit.repeat(Math.floor(MB / unit.length));
      expect(elapsed(() => { plainHeadingText(text.slice(0, HEADING_MAX_LINE_CHARS)); scoreMarkdownCandidate({ markdown: text }); })).toBeLessThan(1_000);
    }
  });

  it("the extraction contract lists a Wikipedia-style link with its full target", async () => {
    const { buildExtractionContract } = await import("../lib/extraction-contract.js");
    const contract = buildExtractionContract({ documentId: "d", markdown: "See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)).", extractor: "x", strategy: "s", extractionTimeMs: 1, pageCount: 1 });
    expect(JSON.stringify(contract)).toContain("https://en.wikipedia.org/wiki/Foo_(bar)");
  });
});

describe("CRLF headings (council M #7)", () => {
  it("a heading line ending in \\r is a heading for the canonical builder and the chunker, its text without the \\r", () => {
    expect(parseAtxHeading("## Results\r")).toEqual({ level: 2, text: "Results" });
    const text = "# Title\r\n\r\nBody text of the first section.\r\n\r\n## Results\r\n\r\nMore text.\r\n";
    const doc = buildCanonicalDocumentFromMarkdown({ documentId: "d", text, pageCount: 1 } as never);
    expect(JSON.stringify(doc)).toContain("Results");
    expect(JSON.stringify(doc)).not.toContain("Results\\r");
  });
});
