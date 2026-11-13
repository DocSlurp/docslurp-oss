// The PDF-figure seam: a figure SVG whose text was drawn elsewhere (Doppler keeps a figure's words in the Markdown)
// plus those words as boxes gives the same chart as the SVG with its own <text>. Words are bounded like any input.
import { describe, expect, it } from "vitest";

import { extractDeterministicVisuals, wordsAsTexts, type SvgWord } from "../index.js";
import { buildScene } from "../svg-scene.js";
import { parseXml } from "../xml.js";
import { genericBar } from "./fixtures.js";

/** Each <text> of the SVG as the box a PDF text layer would report for it (y down), and the SVG without any <text>. */
function split(svg: string): { bare: string; words: SvgWord[] } {
  const doc = parseXml(svg, { keepComments: true });
  const root = doc.children.find((c) => c.type === "element" && c.local === "svg") as never;
  const words = buildScene(root).texts.map((t) => {
    const width = t.text.length * t.fontSize * 0.55;
    const left = t.anchor === "start" ? t.x : t.anchor === "middle" ? t.x - width / 2 : t.x - width;
    return t.rotated
      ? { text: t.text, x0: t.x - t.fontSize / 2, x1: t.x + t.fontSize / 2, y0: t.y - width / 2, y1: t.y + width / 2, rotated: true }
      : { text: t.text, x0: left, x1: left + width, y0: t.y - t.fontSize / 2, y1: t.y + t.fontSize / 2 };
  });
  return { bare: svg.replace(/<text\b[\s\S]*?<\/text>/g, ""), words };
}

const CHARTS: Array<[string, string]> = [
  ["three-bar", genericBar(["London", "Tokyo", "Austin"], [4, 6, 9], 10)],
  ["four-bar", genericBar(["North", "South", "East", "West"], [12, 18, 9, 22], 30)],
  ["two-bar", genericBar(["Q1", "Q2"], [120, 150], 200)],
];

describe("SVG figure + words (the PDF-figure seam)", () => {
  for (const [name, svg] of CHARTS) {
    it(`${name}: same chart as the SVG with its own text`, () => {
      const own = extractDeterministicVisuals({ kind: "svg", text: svg });
      const { bare, words } = split(svg);
      expect(words.length).toBeGreaterThan(3);
      // Without the words the text-free figure yields nothing: today's Doppler figures.
      expect(extractDeterministicVisuals({ kind: "svg", text: bare }).visuals).toEqual([]);
      const placed = extractDeterministicVisuals({ kind: "svg", text: bare, words });
      expect(own.visuals).toHaveLength(1);
      expect(placed.visuals).toHaveLength(1);
      expect(placed.visuals[0]!.spec).toEqual(own.visuals[0]!.spec);
    });
  }

  it("bounds the words: too many is a refusal, malformed boxes are dropped", () => {
    const { bare } = split(CHARTS[0]![1]);
    const many = Array.from({ length: 4001 }, (_, i) => ({ text: `w${i}`, x0: 0, y0: 0, x1: 1, y1: 1 }));
    const refused = extractDeterministicVisuals({ kind: "svg", text: bare, words: many });
    expect(refused.visuals).toEqual([]);
    expect(refused.refusals).toEqual([{ locator: "svg", reason: "svg-words-limit" }]);
    expect(wordsAsTexts([
      { text: "ok", x0: 0, y0: 0, x1: 4, y1: 2 },
      { text: "inverted", x0: 4, y0: 0, x1: 0, y1: 2 },
      { text: "nan", x0: Number.NaN, y0: 0, x1: 1, y1: 2 },
      { text: "   ", x0: 0, y0: 0, x1: 1, y1: 2 },
      { text: "x".repeat(10_000), x0: 0, y0: 0, x1: 1, y1: 2 },
      { text: 5 as never, x0: 0, y0: 0, x1: 1, y1: 2 },
    ]).map((t) => t.text.length)).toEqual([2, 200]);
  });
});

describe("word labels are cut on code points (council #369/#510 r4 L2)", () => {
  it("an astral character at the cut is dropped whole, never left as a lone surrogate", () => {
    for (const pad of [199, 198, 999]) {
      const text = "x".repeat(pad) + "𝑥".repeat(4);
      const [prim] = wordsAsTexts([{ text, x0: 0, y0: 0, x1: 10, y1: 10 }]);
      const label = (prim as { text: string }).text;
      expect(label.length).toBeLessThanOrEqual(200);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(label)).toBe(false);
      expect(() => new TextEncoder().encode(label)).not.toThrow();
      expect(Buffer.from(label, "utf8").toString("utf8")).toBe(label);
    }
  });
});
