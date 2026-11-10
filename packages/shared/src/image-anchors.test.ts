import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  imageAltForMarkdown, imageAnchorMarkdown, insertImageAnchors, markdownBlocks, mergeImageResult, parseImageAnchorLine, stripImageAnchors,
} from "./image-anchors.js";

const vectors = JSON.parse(readFileSync(new URL("../test-vectors/markdown-blocks.json", import.meta.url), "utf8")) as Array<{ name: string; page: string; blocks: Array<[number, number]> }>;
const ref = (id: string, page: number, occurrence: number, alt = "") => imageAnchorMarkdown({ artifactId: id, pageNumber: page, occurrence, alt });

describe("markdownBlocks", () => {
  for (const vector of vectors) {
    it(`counts blocks: ${vector.name}`, () => {
      expect(markdownBlocks(vector.page)).toEqual(vector.blocks);
    });
  }
});

describe("image reference syntax", () => {
  it("round-trips, percent-encodes unsafe ids and escapes alt text", () => {
    const line = imageAnchorMarkdown({ artifactId: "doc 1/é:sha.webp", pageNumber: 3, occurrence: 12, alt: "A [bracketed] \\ caption\nover two lines" });
    expect(line).toBe("![A \\[bracketed\\] \\\\ caption over two lines](docslurp-artifact:doc%201%2F%C3%A9:sha.webp#p3o12)");
    expect(parseImageAnchorLine(line)).toEqual({ alt: "A [bracketed] \\ caption over two lines", artifactId: "doc 1/é:sha.webp", anchor: "p3o12", pageNumber: 3, occurrence: 12 });
    expect(parseImageAnchorLine("![x](https://example.com/a.png)")).toBeNull();
    expect(parseImageAnchorLine("text ![](docslurp-artifact:a#p1o0)")).toBeNull();
  });

  it("drops generic file-like alt text and never invents a placeholder", () => {
    for (const generic of ["image001.png", "Picture 1", "IMG_0042.JPG", "figure", "", "   ", "logo", "untitled"]) expect(imageAltForMarkdown(generic)).toBe("");
    expect(imageAltForMarkdown("Quarterly revenue by region")).toBe("Quarterly revenue by region");
    expect(imageAltForMarkdown("x".repeat(500)).length).toBe(200);
    expect(imageAltForMarkdown("ctrl\u0000‮ chars")).toBe("ctrl chars");
  });

  it("a hostile alt cannot close the image or open a link", () => {
    const line = imageAnchorMarkdown({ artifactId: "d:a.webp", pageNumber: 1, occurrence: 0, alt: "](https://evil.example/x) [click" });
    expect(line.startsWith("![\\](https://evil.example/x) \\[click](docslurp-artifact:d:a.webp#p1o0)")).toBe(true);
    expect(parseImageAnchorLine(line)?.artifactId).toBe("d:a.webp");
  });
});

describe("insertImageAnchors", () => {
  const doc = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\fPage two text.";

  it("places a reference before the chosen block and leaves the rest byte for byte", () => {
    const out = insertImageAnchors(doc, [{ pageNumber: 1, block: 2, line: ref("d:a.webp", 1, 0, "A chart") }]);
    expect(out).toBe("# Title\n\nFirst paragraph.\n\n![A chart](docslurp-artifact:d:a.webp#p1o0)\n\nSecond paragraph.\fPage two text.");
  });

  it("appends after the last block and orders several references at one position as given", () => {
    const out = insertImageAnchors(doc, [
      { pageNumber: 2, block: 1, line: ref("d:a.webp", 2, 0) },
      { pageNumber: 2, block: 1, line: ref("d:b.webp", 2, 1) },
      { pageNumber: 1, block: 0, line: ref("d:c.webp", 1, 2) },
    ]);
    const [one, two] = out.split("\f");
    expect(one!.startsWith("![](docslurp-artifact:d:c.webp#p1o2)\n\n# Title")).toBe(true);
    expect(two).toBe("Page two text.\n\n![](docslurp-artifact:d:a.webp#p2o0)\n\n![](docslurp-artifact:d:b.webp#p2o1)");
    expect(stripImageAnchors(out).replace(/\n{3,}/g, "\n\n")).toContain("Page two text.");
  });

  it("references on a blank page stand alone, and out-of-range input throws instead of guessing", () => {
    expect(insertImageAnchors("a\f\fb", [{ pageNumber: 2, block: 0, line: ref("d:a.webp", 2, 0) }])).toBe("a\f![](docslurp-artifact:d:a.webp#p2o0)\fb");
    expect(() => insertImageAnchors(doc, [{ pageNumber: 3, block: 0, line: "x" }])).toThrow();
    expect(() => insertImageAnchors(doc, [{ pageNumber: 1, block: 9, line: "x" }])).toThrow();
    expect(() => insertImageAnchors(doc, [{ pageNumber: 0, block: 0, line: "x" }])).toThrow();
  });

  it("does not split a fenced code block or an HTML table", () => {
    const text = "intro\n\n```\ncode\n\nmore code\n```\n\n<table>\n<tr><td>1</td></tr>\n\n</table>";
    const out = insertImageAnchors(text, [{ pageNumber: 1, block: 2, line: "REF" }, { pageNumber: 1, block: 3, line: "REF2" }]);
    expect(out).toBe("intro\n\n```\ncode\n\nmore code\n```\n\nREF\n\n<table>\n<tr><td>1</td></tr>\n\n</table>\n\nREF2");
  });
});

describe("mergeImageResult", () => {
  const base = insertImageAnchors("Intro.\n\nOutro.\fNext page.", [{ pageNumber: 1, block: 1, line: ref("d:a.webp", 1, 0, "Scanned ledger page") }]);

  it("adds a labelled blockquote directly after the reference", () => {
    const merged = mergeImageResult(base, { pageNumber: 1, occurrence: 0 }, { kind: "ocr", text: "Line one\nLine two\n\nLine four" });
    expect(merged.merged).toBe(true);
    expect(merged.markdown).toBe("Intro.\n\n![Scanned ledger page](docslurp-artifact:d:a.webp#p1o0)\n\n> **Image text (OCR):** Line one\n> Line two\n>\n> Line four\n\nOutro.\fNext page.");
  });

  it("replaces an earlier merge rather than stacking, and only at the matching page and occurrence", () => {
    const once = mergeImageResult(base, { pageNumber: 1, occurrence: 0 }, { kind: "ocr", text: "old" }).markdown;
    const twice = mergeImageResult(once, { pageNumber: 1, occurrence: 0 }, { kind: "vision", text: "A bar chart of revenue." });
    expect(twice.markdown).toBe("Intro.\n\n![Scanned ledger page](docslurp-artifact:d:a.webp#p1o0)\n\n> **Figure description:** A bar chart of revenue.\n\nOutro.\fNext page.");
    expect(mergeImageResult(base, { pageNumber: 2, occurrence: 0 }, { kind: "ocr", text: "x" })).toMatchObject({ merged: false, reason: "anchor-not-found" });
    expect(mergeImageResult(base, { pageNumber: 1, occurrence: 1 }, { kind: "ocr", text: "x" })).toMatchObject({ merged: false });
    expect(mergeImageResult(base, { pageNumber: 1, occurrence: 0 }, { kind: "ocr", text: " \n " })).toMatchObject({ merged: false, reason: "empty-result" });
  });

  it("strips control characters and bounds the merged text", () => {
    const merged = mergeImageResult(base, { pageNumber: 1, occurrence: 0 }, { kind: "caption", text: `a\u0000b‮c${"z".repeat(100_000)}` });
    expect(merged.markdown.length).toBeLessThan(70_000 + base.length);
    expect(merged.markdown).not.toContain("\u0000");
  });
});
