// Council r7 H1 and its sweep: every scan of raw input text is linear. Each new scanner is checked against the regex
// it replaced on seeded random inputs (exact equivalence), and on the hostile shapes by step count (characters its
// searches covered), not by wall time.
import { describe, expect, it } from "vitest";

import { findEmbeddedSpecs, scanBlocks, unwrapCdata } from "../embedded-spec.js";
import { buildSignatures, extractDeterministicVisuals, inlineSvgs, stripInlineSvgs } from "../index.js";
import { CHART_EXTRACT_LIMITS, setGuestDeadline } from "../limits.js";
import { workbookResolver } from "../office-chart-xml.js";
import { openZipPackage } from "../safe-zip.js";
import { finiteOrNull } from "../text.js";
import type { ScanWork } from "../scan.js";
import { transformParts } from "../svg-path.js";
import { barPlot, chartXml, docx, genericBar, xlsx, zip } from "./fixtures.js";

/** mulberry32. */
function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const randomText = (random: () => number, tokens: string[], n: number) => Array.from({ length: n }, () => tokens[Math.floor(random() * tokens.length)]).join("");

// The implementations replaced in round 7, verbatim, as the reference.
const oldBlocks = (text: string) => [...text.matchAll(/<(script|metadata)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)].map((m) => ({ name: m[1]!.toLowerCase(), attrs: m[2] ?? "", body: m[3] ?? "" }));
const oldCdata = (body: string) => /^\s*(?:\/\/\s*)?<!\[CDATA\[([\s\S]*?)(?:\/\/\s*)?\]\]>\s*$/.exec(body)?.[1] ?? null;
const oldStrip = (html: string) => html.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, "");
function oldInline(html: string, max = 200): string[] {
  const out: string[] = [];
  let depth = 0, start = -1;
  for (const m of html.matchAll(/<(\/?)svg\b[^>]*?(\/?)>/gi)) {
    if (m[1]) { if (depth > 0 && --depth === 0 && start >= 0) { out.push(html.slice(start, m.index! + m[0].length)); start = -1; if (out.length >= max) break; } }
    else if (!m[2]) { if (depth++ === 0) start = m.index!; }
  }
  return out;
}
const oldTransform = (raw: string) => [...raw.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)].map((m) => ({ name: m[1]!, args: m[2]!, length: m[0].length }));
function oldSignatures(text: string): string {
  const out: string[] = [];
  for (const m of text.slice(0, 64 * 1024).matchAll(/<!--([\s\S]{0,300}?)-->/g)) { out.push(m[1]!); if (out.length > 20) break; }
  return out.join("\n");
}

describe("linear raw-text scanners: exactly the old regexes", () => {
  it("script / metadata blocks, CDATA, the HTML <svg> strip and inline SVGs (5,000 seeded random documents)", () => {
    const random = rng(7);
    const tokens = ["<script", "<SCRIPT", "<scripts", "<metadata", " type=\"application/json\"", " src=x", ">", "</script>", "</script >", "</SCRIPT\t>", "</scriptx>", "</metadata>",
      "<svg", "<svgx", "<SVG", "</svg>", "</svg  >", "</svgx>", "/>", "<![CDATA[", "]]>", "//", " ", "\n", "{\"mark\":\"bar\"}", "a", "<!--", "-->", "<g/>", "x",
      // Length-changing and non-ASCII case folds (council r8 M1): "İ".toLowerCase() is two code units; ſ and the Kelvin
      // sign fold to ASCII under Unicode rules but not under the non-u /i the old regexes used.
      "İ", "İ<svg", "ſ", "\u212a", "é", "\u{1F600}", "<ſcript", "<\u212aript"];
    for (let n = 0; n < 5000; n++) {
      const text = randomText(random, tokens, 1 + Math.floor(random() * 40));
      expect(scanBlocks(text, Number.MAX_SAFE_INTEGER, { overflow: 0 })).toEqual(oldBlocks(text));
      expect(stripInlineSvgs(text)).toBe(oldStrip(text));
      expect(inlineSvgs(text)).toEqual(oldInline(text));
      expect(buildSignatures(text)).toBe(oldSignatures(text));
      const body = randomText(random, [" ", "//", "<![CDATA[", "]]>", "a", "\n", "/"], 1 + Math.floor(random() * 12));
      expect(unwrapCdata(body)).toBe(oldCdata(body));
    }
  });

  it("transform lists (5,000 seeded random values)", () => {
    const random = rng(11);
    const tokens = ["translate", "rotate", "x", "(", ")", "1", " ", ",", "-2.5", "scale", "\t", "matrix"];
    for (let n = 0; n < 5000; n++) {
      const raw = randomText(random, tokens, 1 + Math.floor(random() * 20));
      expect(transformParts(raw)).toEqual(oldTransform(raw));
    }
  });
});

describe("Turkish capital I before a chart (council r8 M1)", () => {
  it("keeps every index right: the inline SVG and the embedded spec both export", () => {
    const vl = JSON.stringify({ $schema: "https://vega.github.io/schema/vega-lite/v5.json", data: { values: [{ a: "x", b: 1 }, { a: "y", b: 2 }] }, mark: "bar", encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } } });
    const page = (city: string) => `<html><body><p>${city}</p>${genericBar(["a", "b"], [1, 2], 4)}<script type="application/json">${vl}</script></body></html>`;
    const turkish = extractDeterministicVisuals({ kind: "html", text: page("İstanbul İzmir İSTATİSTİK") });
    const ascii = extractDeterministicVisuals({ kind: "html", text: page("Istanbul Izmir ISTATISTIK") });
    expect(turkish.refusals).toEqual([]);
    expect(turkish.visuals.map((v) => [v.source, v.spec?.kind])).toEqual(ascii.visuals.map((v) => [v.source, v.spec?.kind]));
    expect(turkish.visuals).toHaveLength(2);
    expect(stripInlineSvgs("İİİ<svg>x</svg>KEEP")).toBe("İİİKEEP");
  });
});

describe("linear raw-text scanners: hostile shapes by step count (council r7 H1)", () => {
  const linear = (work: ScanWork, n: number) => expect(work.steps).toBeLessThanOrEqual(6 * n + 64);

  it("unclosed <script starts (the SVG-comment shape, 0.66 MB): O(n) steps, and an SVG reads only its parsed elements", () => {
    const text = `<!--${"<script ".repeat(82_000)}-->`;
    const work = { steps: 0 };
    expect(scanBlocks(text, Number.MAX_SAFE_INTEGER, { overflow: 0 }, work)).toEqual([]);
    linear(work, text.length);
    // In an SVG the comment is never scanned: no block, no refusal (the 0.66 MB SVG took 20.5 s before).
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><!--${"<script ".repeat(75_000)}--><rect width="1" height="1"/></svg>`;
    expect(svg.length).toBeLessThanOrEqual(CHART_EXTRACT_LIMITS.maxSvgBytes);
    expect(extractDeterministicVisuals({ kind: "svg", text: svg }).refusals).toEqual([]);
  });

  it("unclosed <svg and <script> in HTML (1–2 MB): O(n) steps for every scan", () => {
    for (const text of ["<svg ".repeat(200_000), "<script>".repeat(125_000), `<script type="application/json">{}</script>${"<svg ".repeat(400_000)}`, "</svg".repeat(200_000) + "<svg>"]) {
      const a = { steps: 0 }, b = { steps: 0 }, c = { steps: 0 };
      scanBlocks(text, Number.MAX_SAFE_INTEGER, { overflow: 0 }, a);
      stripInlineSvgs(text, b);
      inlineSvgs(text, 200, { count: 0 }, c);
      linear(a, text.length); linear(b, text.length); linear(c, text.length);
    }
    // End to end: the 2 MB HTML (killed at 60 s before) completes with its one embedded block examined.
    const html = `<script type="application/json">{}</script>${"<svg ".repeat(400_000)}`;
    expect(extractDeterministicVisuals({ kind: "html", text: html }).refusals).toEqual([]);
  });

  it("transform values with no ) after long letter runs are linear", () => {
    expect(transformParts(`${"a".repeat(4000)}(`)).toEqual([]);
    expect(transformParts(`${"ab ".repeat(1300)}(`)).toEqual([]);
  });
});

describe("deadline per unit and counted losses (council r7 H1, L1)", () => {
  it("past the deadline, EPUB parts, Office chart parts and HTML embedded blocks are counted, not scanned", () => {
    const chapter = `<html><body><script type="application/json">{"mark":"bar"}</script>${genericBar(["a"], [1], 2)}</body></html>`;
    const epub = zip({ "mimetype": "application/epub+zip", "OEBPS/a.xhtml": chapter, "OEBPS/b.xhtml": chapter, "OEBPS/c.xhtml": chapter });
    const chart = chartXml({ plots: [barPlot([{ name: "A", cats: ["x"], vals: [1] }])] });
    try {
      setGuestDeadline(Date.now() - 1);
      expect(extractDeterministicVisuals({ kind: "epub", bytes: epub }).deferred).toEqual([{ svgIndex: 0, count: 3, reason: "guest-deadline-part" }]);
      expect(extractDeterministicVisuals({ kind: "office", bytes: docx([chart, chart]) }).deferred).toEqual([{ svgIndex: 0, count: 2, reason: "guest-deadline-part" }]);
      const r = extractDeterministicVisuals({ kind: "html", text: chapter });
      expect(r.overflow).toBe(1);
      expect(r.deferred).toEqual([{ svgIndex: 0, count: 1, reason: "guest-deadline" }]);
    } finally {
      setGuestDeadline(Infinity);
    }
  });

  it("counts Office chart parts past 200, script blocks past 200 and refusals past 1,000", () => {
    const chart = chartXml({ plots: [barPlot([{ name: "A", cats: ["x"], vals: [1] }])] });
    const office = extractDeterministicVisuals({ kind: "office", bytes: docx(Array(205).fill(chart)) });
    expect(office.deferred).toEqual([{ svgIndex: 0, count: 5, reason: "package-part-limit" }]);
    const blocks = `<html><body>${'<script type="application/json">{"a":1}</script>'.repeat(210)}</body></html>`;
    const stats = { overflow: 0 };
    findEmbeddedSpecs(blocks, stats);
    expect(stats.overflow).toBe(10);
    expect(extractDeterministicVisuals({ kind: "html", text: blocks }).overflow).toBe(10);
  });
});

describe("Office and number hot paths (council r8 H1)", () => {
  it("finiteOrNull: the unambiguous pattern accepts exactly what the old one did, and long inputs are refused before any regex", () => {
    const old = (t: string) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t);
    const random = rng(29);
    for (let n = 0; n < 20_000; n++) {
      const t = randomText(random, ["1", "0", ".", "-", "+", "e", "E", "x", " "], 1 + Math.floor(random() * 14)).trim();
      if (t === "") continue;
      const v = Number(t);
      expect(finiteOrNull(t)).toBe(old(t) && Number.isFinite(v) ? v : null);
    }
    // The council's 300k-digit value: refused by length, never handed to a regex.
    expect(finiteOrNull(`${"1".repeat(300_000)}x`)).toBeNull();
    expect(finiteOrNull("1".repeat(513))).toBeNull();
  });

  it("clamps a declared multi-level category count (ptCount 2^32 − 1) to maxPathVertices", () => {
    const chart = chartXml({ plots: [barPlot([{ name: "A", cats: ["x", "y"], vals: [1, 2] }])] })
      .replace(/<c:cat>[\s\S]*?<\/c:cat>/, '<c:cat><c:multiLvlStrRef><c:f>S!$A$1:$A$2</c:f><c:multiLvlStrCache><c:ptCount val="4294967295"/><c:lvl><c:pt idx="0"><c:v>x</c:v></c:pt><c:pt idx="1"><c:v>y</c:v></c:pt></c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>');
    const r = extractDeterministicVisuals({ kind: "office", bytes: docx([chart]) });
    expect(r.visuals).toHaveLength(1);
    const points = (r.visuals[0]!.spec as { series?: Array<{ points: unknown[] }> } | null)?.series?.[0]?.points.length ?? 0;
    expect(points).toBeLessThanOrEqual(CHART_EXTRACT_LIMITS.maxPathVertices);
  });

  it("charges workbook cells to one per-input budget (workbook-too-large past it)", () => {
    const rows: Array<Array<string | number>> = [["q", "v"], ...Array.from({ length: 50 }, (_, i) => [`r${i}`, i])];
    const resolve = workbookResolver(openZipPackage(xlsx("S", rows, chartXml({ plots: [barPlot([{ name: "A", cats: ["x"], vals: [1] }])] }))), { cells: CHART_EXTRACT_LIMITS.maxWorkbookCells - 10 })!;
    expect(() => resolve("S!$B$1:$B$50")).toThrow(/workbook-too-large/);
  });
});
