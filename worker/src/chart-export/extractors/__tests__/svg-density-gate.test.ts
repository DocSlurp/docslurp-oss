// The SVG density gate (limits.ts; handleSvg + buildScene): pathological SVGs are skipped early with a closed reason,
// legitimate charts pass untouched, and the rest of the input carries on. Asserted by counts, not wall time.
import { describe, expect, it } from "vitest";

import { APPROXIMATE_MARKER_REASON, DEFERRED_SVG_REASON, extractDeterministicVisuals } from "../index.js";
import { CHART_EXTRACT_LIMITS } from "../limits.js";
import { columnStacked, nearestTick } from "../svg-geometry.js";
import type { RectPrim } from "../svg-scene.js";
import { genericBar, matplotlibBar, matplotlibLine, matplotlibScatter, plotlyBar, rechartsLine, vegaBar, zip } from "./fixtures.js";

const L = CHART_EXTRACT_LIMITS;
const html = (svgs: string[]) => `<html><body>${svgs.join("")}</body></html>`;
const reasons = (r: { refusals: Array<{ reason: string }> }) => r.refusals.map((x) => x.reason);
const ticks = [[0, 90], [10, 50], [20, 10]].map(([v, y]) => `<text x="2" y="${y}">${v}</text>`).join("") + '<text x="10" y="98">A</text><text x="50" y="98">B</text><text x="90" y="98">C</text>';

/** The council's near-cap packed SVG (rounds 2–4): 2,500 packed vertices and 19,900 markers from 199 `<use>` of 100 circles. */
function packedSvg(vertices = 2500, markers = 19_900): string {
  const pts = ["10,90", ...Array.from({ length: vertices - 2 }, (_, i) => `${(30 + (i % 290) / 100).toFixed(2)},${(30 + (i % 97) / 34).toFixed(2)}`), "90,10"];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><polyline points="${pts.join(" ")}" stroke="#f00" fill="none"/>`
    + `<defs><g id="m">${'<circle cx="34.6" cy="34.6" r="1" fill="#00f"/>'.repeat(100)}</g></defs>${'<use href="#m"/>'.repeat(Math.ceil(markers / 100))}${ticks}</svg>`;
}

/** Council round-4 H1 input: per SVG ~1,010 markers near 1,000 packed vertices plus 3,900 `<use>` of a 100-rect group. */
function heldSceneSvg(i: number): string {
  const t = [0, 25, 50, 75, 100].map((v, k) => `<text x="20" y="${400 - k * 80}">${v}</text>`).join("");
  const markers = Array.from({ length: 1010 }, (_, k) => `<circle cx="${200 + (k % 3) * 0.3 + 2}" cy="202" r="1" fill="#f00"/>`).join("");
  const pts = Array.from({ length: 1000 }, (_, k) => `${200 + (k % 2) * 0.1},${200 + (k % 2) * 0.1}`).join(" ");
  const g = `<defs><g id="g${i}">${Array.from({ length: 100 }, (_, k) => `<rect x="${100 + k * 2}" y="${150 + (k % 50)}" width="1" height="1" fill="#0a0"/>`).join("")}</g></defs>`;
  const uses = Array.from({ length: 3900 }, (_, u) => `<use href="#g${i}" x="${(u % 60) * 210}" y="${Math.floor(u / 60) * 0.001}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500">${g}${t}${markers}<polyline stroke="#00f" fill="none" points="${pts} 400,50"/>${uses}</svg>`;
}

describe("SVG density gate", () => {
  it("sits at or above every measured legitimate maximum (551 chart SVGs: p99 / max)", () => {
    expect(L.maxSvgBytes).toBeGreaterThanOrEqual(415_226); // p99 313,332
    expect(L.maxSvgUseExpansions).toBeGreaterThanOrEqual(483); // p99 372
    expect(L.maxSvgPrimitives).toBeGreaterThanOrEqual(2_113); // p99 1,782
    expect(L.maxSvgPathSegments).toBeGreaterThanOrEqual(32_880); // p99 23,966 (every parsed path vertex, glyphs included)
    expect(L.maxMarkerPairTests).toBeGreaterThanOrEqual(466); // p99 18
  });

  it("lets ordinary charts through untouched: no skip, no approximation", () => {
    const xs = Array.from({ length: 200 }, (_, i) => i);
    const charts = [
      matplotlibBar({ categories: ["Q1", "Q2", "Q3"], series: [{ name: "R", values: [12, 15, 9], color: "#1f77b4" }] }, { vmax: 20 }),
      matplotlibLine(xs, [{ name: "a", values: xs.map((x) => Math.sin(x / 9) * 10 + 20), color: "#1f77b4", markers: true }], { vmin: 0, vmax: 35, xmin: 0, xmax: 200 }),
      matplotlibScatter(xs.map((x) => [x, (x * 7) % 30] as [number, number]), "#2ca02c", { vmin: 0, vmax: 30, xmin: 0, xmax: 200 }),
      plotlyBar({ categories: ["a", "b"], series: [{ name: "s", values: [3, 4], color: "#636efa" }] }, { vmax: 5 }),
      rechartsLine(["Mon", "Tue", "Wed"], [3, 5, 4], 6),
      vegaBar(["x", "y"], [1, 2], 3),
    ];
    const r = extractDeterministicVisuals({ kind: "html", text: html(charts) });
    expect(r.refusals).toEqual([]);
    expect(r.deferred).toBeUndefined();
    expect(r.visuals).toHaveLength(charts.length);
    expect(r.visuals.some((v) => v.reason === APPROXIMATE_MARKER_REASON)).toBe(false);
  });

  it("skips the council's 100-SVG page as too dense, each at the primitive cap, with nothing held", () => {
    const svg = packedSvg();
    expect(svg.length).toBeLessThan(L.maxSvgBytes); // the byte gate passes it; the primitive gate stops it
    const r = extractDeterministicVisuals({ kind: "html", text: html(Array.from({ length: 100 }, () => svg)) });
    expect(r.visuals).toEqual([]);
    expect(reasons(r)).toEqual(Array(100).fill("svg-too-dense"));
    expect(r.refusals.map((x) => x.locator)).toEqual(Array.from({ length: 100 }, (_, k) => `svg[${k}]`));
  });

  it("skips each SVG of the 40-copy batch on its own; a legitimate figure in the same batch still exports", () => {
    const results = [...Array.from({ length: 40 }, () => packedSvg()), genericBar(["a", "b"], [1, 2], 4)].map((text) => extractDeterministicVisuals({ kind: "svg", text }));
    expect(results.slice(0, 40).map((r) => reasons(r)[0])).toEqual(Array(40).fill("svg-too-dense"));
    expect(results[40]!.refusals).toEqual([]);
    expect(results[40]!.visuals).toHaveLength(1);
  });

  it("stops the round-4 held-scene input at the density gate: 17 × 390k rects never built (council H1)", () => {
    const svgs = Array.from({ length: 17 }, (_, i) => heldSceneSvg(i));
    const text = html(svgs);
    expect(text.length).toBeLessThan(L.maxTextBytes);
    for (const svg of svgs) expect(svg.length).toBeLessThan(L.maxSvgBytes);
    const r = extractDeterministicVisuals({ kind: "html", text });
    // Each SVG stops after about 40 of its 3,900 <use> copies: the 4,000-primitive gate trips before the 1,000-expansion
    // budget does, so at most ~4,000 rects are ever built per SVG. Nothing is held between SVGs.
    expect(reasons(r)).toEqual(Array(17).fill("svg-too-dense"));
    expect(r.visuals).toEqual([]);
  });

  it("stops a <use> bomb of cheap references at the expansion budget", () => {
    // 1,500 references to an empty group: no primitives, so only the <use> budget can stop it.
    const bomb = `<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="e"/></defs>${'<use href="#e"/>'.repeat(1500)}</svg>`;
    expect(reasons(extractDeterministicVisuals({ kind: "svg", text: bomb }))).toEqual(["svg-use-bomb"]);
  });

  it("skips an SVG over the byte cap before parsing it", () => {
    const big = `<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(L.maxSvgBytes / 4)}</svg>`;
    expect(reasons(extractDeterministicVisuals({ kind: "svg", text: big }))).toEqual(["svg-too-large"]);
  });

  it("skips a giant SVG and keeps the 99 charts after it (no starvation, document order kept)", () => {
    const small = genericBar(["a", "b"], [1, 2], 4);
    const r = extractDeterministicVisuals({ kind: "html", text: html([packedSvg(), ...Array.from({ length: 99 }, () => small)]) });
    expect(reasons(r)).toEqual(["svg-too-dense"]);
    expect(r.visuals.map((v) => v.locator)).toEqual(Array.from({ length: 99 }, (_, k) => `svg[${k + 1}]`));
  });

  it("is deterministic", () => {
    const text = html([packedSvg(1000, 1000), genericBar(["a", "b"], [1, 2], 4), packedSvg()]);
    expect(JSON.stringify(extractDeterministicVisuals({ kind: "html", text }))).toBe(JSON.stringify(extractDeterministicVisuals({ kind: "html", text })));
  });

  it("defers SVGs past maxSvgsPerInput by ordinal and closed reason, never by name, without parsing them", () => {
    // An EPUB with 3 chapters of 150 inline SVGs: 450 SVGs, over the 400 analysed per input.
    const tiny = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    const chapter = `<html><body>${tiny.repeat(150)}</body></html>`;
    const epub = zip({ "mimetype": "application/epub+zip", "OEBPS/a.xhtml": chapter, "OEBPS/b.xhtml": chapter, "OEBPS/c-customer-name.xhtml": chapter });
    const r = extractDeterministicVisuals({ kind: "epub", bytes: epub });
    expect(r.deferred).toEqual(Array.from({ length: 50 }, (_, k) => ({ svgIndex: 400 + k, reason: DEFERRED_SVG_REASON })));
    expect(JSON.stringify(r.deferred)).not.toContain("customer-name");
  });
});

describe("stacked-column check and nearest category (council r4 M2)", () => {
  const rect = (x0: number, y0: number, x1: number, y1: number) => ({ kind: "rect", x0, y0, x1, y1, fill: "#000", stroke: null }) as unknown as RectPrim;
  const pairwise = (col: RectPrim[]) => col.length > 1 && col.some((a) => col.some((b) => a !== b && (Math.abs(a.y0 - b.y1) < 0.6 || Math.abs(a.x1 - b.x0) < 0.6)));

  it("checks a 4,000-rect column in O(n log n) steps", () => {
    // The council's column: 4,000 bars at one x, none touching (2.0 apart, height 1): the pairwise test's worst case.
    const col = Array.from({ length: 4000 }, (_, k) => rect(100, 100 + k * 2, 130, 101 + k * 2));
    const work = { steps: 0 };
    expect(columnStacked(col, work)).toBe(false);
    // Two sorts and two binary searches per bar per edge pair: ~2 × 4,000 × 2 × 13 + sorting, vs 1.6×10⁷ pairs.
    expect(work.steps).toBeLessThan(4000 * 80);
    expect(pairwise(col)).toBe(false);
  });

  it("matches the pairwise test exactly (seeded, edges near 0.6 and non-finite values)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const special = [NaN, Infinity, -Infinity, 0.6, -0.6, 0.6000000000000001, 0.5999999999999999];
    const pick = (base: number) => (rnd() < 0.1 ? special[Math.floor(rnd() * special.length)]! + base * (rnd() < 0.5 ? 0 : 1) : base + Math.round(rnd() * 8) * 0.3);
    for (let n = 0; n < 2000; n++) {
      const col = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => { const y = pick(100); const x = pick(50); return rect(x, y, pick(x), pick(y)); });
      expect(columnStacked(col)).toBe(pairwise(col));
    }
  });

  it("finds the nearest tick like the linear scan (earliest of equal distances), in log time", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const scan = <T extends { pos: number }>(sorted: T[], target: number) => { let best: T | null = null; for (const c of sorted) if (!best || Math.abs(c.pos - target) < Math.abs(best.pos - target)) best = c; return best; };
    for (let n = 0; n < 3000; n++) {
      const sorted = Array.from({ length: Math.floor(rnd() * 10) }, () => ({ pos: Math.round(rnd() * 20) / 2 })).sort((a, b) => a.pos - b.pos);
      const target = rnd() < 0.3 ? Math.round(rnd() * 40) / 4 : rnd() * 12 - 1;
      expect(nearestTick(sorted, target)).toBe(scan(sorted, target));
    }
    expect(nearestTick([{ pos: 1 }, { pos: NaN }], 1)).toEqual({ pos: 1 });
  });
});
