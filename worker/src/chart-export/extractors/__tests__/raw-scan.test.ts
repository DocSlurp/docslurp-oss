// Council r7 H1 and its sweep: every scan of raw input text is linear. Each new scanner is checked against the regex
// it replaced on seeded random inputs (exact equivalence), and on the hostile shapes by step count (characters its
// searches covered), not by wall time.
import { describe, expect, it } from "vitest";

import { findEmbeddedSpecs, scanBlocks, unwrapCdata } from "../embedded-spec.js";
import { buildSignatures, extractDeterministicVisuals, inlineSvgs, stripInlineSvgs } from "../index.js";
import { CHART_EXTRACT_LIMITS, setGuestDeadline } from "../limits.js";
import type { ScanWork } from "../scan.js";
import { transformParts } from "../svg-path.js";
import { barPlot, chartXml, docx, genericBar, zip } from "./fixtures.js";

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
      "<svg", "<svgx", "<SVG", "</svg>", "</svg  >", "</svgx>", "/>", "<![CDATA[", "]]>", "//", " ", "\n", "{\"mark\":\"bar\"}", "a", "<!--", "-->", "<g/>", "x"];
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
