// The SVG density gate (limits.ts; handleSvg + buildScene): pathological SVGs are skipped early with a closed reason,
// legitimate charts pass untouched, and the rest of the input carries on. Asserted by counts, not wall time.
import { describe, expect, it } from "vitest";

import { APPROXIMATE_MARKER_REASON, DEFERRED_SVG_REASON, extractDeterministicVisuals } from "../index.js";
import { CHART_EXTRACT_LIMITS } from "../limits.js";
import { columnStacked, nearestTick } from "../svg-geometry.js";
import type { RectPrim } from "../svg-scene.js";
import { genericBar, matplotlibBar, matplotlibLine, matplotlibScatter, MERMAID_FLOWCHART, plotlyBar, rechartsLine, vegaBar, zip } from "./fixtures.js";

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
  it("is pinned at about 2× the p99 of 551 legitimate chart SVGs (raising one must be a deliberate, re-measured change)", () => {
    // svg-density-stats.mjs, measured p99 / max: bytes 313,332 / 415,226; <use> 372 / 483; primitives 1,782 / 2,113;
    // segments 23,966 / 32,880; walked frames 1,357 / 1,753; elements 1,447 / 2,043; marker pair tests 18 / 466.
    expect({
      maxSvgBytes: L.maxSvgBytes, maxSvgUseExpansions: L.maxSvgUseExpansions, maxSvgPrimitives: L.maxSvgPrimitives,
      maxSvgPathSegments: L.maxSvgPathSegments, maxSvgWalkedElements: L.maxSvgWalkedElements, maxSvgElements: L.maxSvgElements,
      maxMarkerPairTests: L.maxMarkerPairTests, maxSvgsPerInput: L.maxSvgsPerInput,
    }).toEqual({
      maxSvgBytes: 655_360, maxSvgUseExpansions: 1_000, maxSvgPrimitives: 4_000, maxSvgPathSegments: 50_000,
      maxSvgWalkedElements: 3_000, maxSvgElements: 3_000, maxMarkerPairTests: 100_000, maxSvgsPerInput: 400,
    });
  });

  describe("passes at each limit and skips at limit + 1", () => {
    const one = (text: string) => reasons(extractDeterministicVisuals({ kind: "svg", text }));
    const SVG = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
    it("bytes", () => {
      const sized = (n: number) => { const shell = SVG("<!---->"); return SVG(`<!--${"x".repeat(n - shell.length)}-->`); };
      expect(sized(L.maxSvgBytes).length).toBe(L.maxSvgBytes);
      expect(one(sized(L.maxSvgBytes))).toEqual([]);
      expect(one(sized(L.maxSvgBytes + 1))).toEqual(["svg-too-large"]);
    });
    it("<use> expansions", () => {
      const uses = (n: number) => SVG(`<defs><g id="e"/></defs>${'<use href="#e"/>'.repeat(n)}`);
      expect(one(uses(L.maxSvgUseExpansions))).toEqual([]);
      expect(one(uses(L.maxSvgUseExpansions + 1))).toEqual(["svg-use-bomb"]);
    });
    it("expanded primitives (one path of many subpaths: few elements, many lines)", () => {
      const subpaths = (n: number) => SVG(`<path stroke="#000" fill="none" d="${Array.from({ length: n }, (_, k) => `M${k} 0L${k + 1} 1`).join("")}"/>`);
      expect(one(subpaths(L.maxSvgPrimitives))).toEqual([]);
      expect(one(subpaths(L.maxSvgPrimitives + 1))).toEqual(["svg-too-dense"]);
    });
    it("path segments", () => {
      // Paths of at most maxPathVertices vertices each, adding up to exactly n.
      const segs = (n: number) => { const out: string[] = []; for (let left = n; left > 0; left -= L.maxPathVertices) { const k = Math.min(left, L.maxPathVertices); out.push(`<path stroke="#000" fill="none" d="M0 0${" L1 1".repeat(k - 1)}"/>`); } return SVG(out.join("")); };
      expect(one(segs(L.maxSvgPathSegments))).toEqual([]);
      expect(one(segs(L.maxSvgPathSegments + 1))).toEqual(["svg-too-dense"]);
    });
    it("walked frames (hidden children re-walked by <use>: few elements, many frames)", () => {
      // Frames: svg + defs + 2 × (use + target g + n hidden children) = 6 + 2n; elements 5 + n. n = 1,497 is 3,000 frames.
      // The extra frame comes first in document order, so the frame past the limit is inside the second <use>.
      const walk = (n: number, extra = "") => SVG(`${extra}<defs><g id="g">${'<g display="none"/>'.repeat(n)}</g></defs><use href="#g"/><use href="#g"/>`);
      expect(one(walk(1497))).toEqual([]);
      expect(one(walk(1497, "<desc/>"))).toEqual(["svg-use-bomb"]);
    });
    it("parsed elements", () => {
      const els = (n: number) => SVG("<desc/>".repeat(n - 1)); // + the <svg> itself
      expect(one(els(L.maxSvgElements))).toEqual([]);
      expect(one(els(L.maxSvgElements + 1))).toEqual(["svg-too-dense"]);
    });
  });

  it("bounds <use> re-walks of children no other counter sees (council r5 H1): skipped, hidden, ill-transformed, nested", () => {
    // 640 KiB SVGs whose <use> target holds tens of thousands of children that the walk drops before counting
    // primitives: before the walk gate, 999 references walked ~34 million frames with every other gate passing.
    const bypass = (child: string) => { const n = Math.floor((L.maxSvgBytes - 300 - 999 * 16) / child.length); return `<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="g">${child.repeat(n)}</g></defs>${'<use href="#g"/>'.repeat(999)}</svg>`; };
    for (const child of ["<desc/>", '<g display="none"/>', '<g transform="x"/>']) {
      const svg = bypass(child);
      expect(svg.length).toBeLessThanOrEqual(L.maxSvgBytes);
      // The <use> target's children exceed the element gate on their own; the walk gate would stop it at frame 3,001.
      expect(reasons(extractDeterministicVisuals({ kind: "svg", text: svg }))).toEqual(["svg-too-dense"]);
    }
    // 3 KB, few elements: 1 → 30 → 30 nested references over 450 empty groups, 405,000 frames unbounded.
    const nested = `<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="a0">${"<g/>".repeat(450)}</g><g id="a1">${'<use href="#a0"/>'.repeat(30)}</g><g id="a2">${'<use href="#a1"/>'.repeat(30)}</g></defs><use href="#a2"/></svg>`;
    expect(nested.length).toBeLessThan(4000);
    expect(reasons(extractDeterministicVisuals({ kind: "svg", text: nested }))).toEqual(["svg-use-bomb"]);
    // The same shape with few hidden children per group but many references: under the element gate, stopped by the walk.
    const reWalk = `<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="g">${'<g display="none"/>'.repeat(1000)}</g></defs>${'<use href="#g"/>'.repeat(999)}</svg>`;
    expect(reasons(extractDeterministicVisuals({ kind: "svg", text: reWalk }))).toEqual(["svg-use-bomb"]);
  });

  it("puts the Mermaid / Graphviz diagram path under the same gate, with linear id handling (council r5 M1)", () => {
    const mermaid = (n: number, e: number, p: number) => `<svg xmlns="http://www.w3.org/2000/svg" id="mermaid-1">${Array.from({ length: n }, (_, k) => `<g class="node" id="flowchart-a${k}-0"/>`).join("")}${Array.from({ length: e }, (_, k) => `<path class="flowchart-link" data-id="L${"_b".repeat(p)}_${k}"/>`).join("")}</svg>`;
    // The council's 0.47 MB shape: 7,600 nodes, 80 edges with 1,000-part ids. Over the element gate: skipped first.
    expect(reasons(extractDeterministicVisuals({ kind: "svg", text: mermaid(7600, 80, 1000) }))).toEqual(["svg-too-dense"]);
    // Under the gate, the same hostile ids: edge ids over 64 parts are not split at all, so the diagram path stays linear.
    const r = extractDeterministicVisuals({ kind: "svg", text: mermaid(2900, 80, 1000) });
    expect(r.refusals).toEqual([]);
    // A real flowchart still resolves its edges.
    const ok = extractDeterministicVisuals({ kind: "svg", text: MERMAID_FLOWCHART });
    expect(ok.visuals[0]!.kind).toBe("diagram");
    expect(ok.visuals[0]!.spec).not.toBeNull();
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

  it("skips the council's 100-SVG page (each SVG's 199 <use> copies stop at the walk gate), with nothing held", () => {
    const svg = packedSvg();
    expect(svg.length).toBeLessThan(L.maxSvgBytes); // the byte gate passes it; the walk gate stops it inside a <use>
    const r = extractDeterministicVisuals({ kind: "html", text: html(Array.from({ length: 100 }, () => svg)) });
    expect(r.visuals).toEqual([]);
    expect(reasons(r)).toEqual(Array(100).fill("svg-use-bomb"));
    expect(r.refusals.map((x) => x.locator)).toEqual(Array.from({ length: 100 }, (_, k) => `svg[${k}]`));
  });

  it("skips each SVG of the 40-copy batch on its own; a legitimate figure in the same batch still exports", () => {
    const results = [...Array.from({ length: 40 }, () => packedSvg()), genericBar(["a", "b"], [1, 2], 4)].map((text) => extractDeterministicVisuals({ kind: "svg", text }));
    expect(results.slice(0, 40).map((r) => reasons(r)[0])).toEqual(Array(40).fill("svg-use-bomb"));
    expect(results[40]!.refusals).toEqual([]);
    expect(results[40]!.visuals).toHaveLength(1);
  });

  it("stops the round-4 held-scene input at the density gate: 17 × 390k rects never built (council H1)", () => {
    const svgs = Array.from({ length: 17 }, (_, i) => heldSceneSvg(i));
    const text = html(svgs);
    expect(text.length).toBeLessThan(L.maxTextBytes);
    for (const svg of svgs) expect(svg.length).toBeLessThan(L.maxSvgBytes);
    const r = extractDeterministicVisuals({ kind: "html", text });
    // Each SVG has over 5,000 elements (1,010 markers, 3,900 <use>), so the element gate skips it right after parsing:
    // none of its 390k rects is ever built. Nothing is held between SVGs.
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
    expect(reasons(r)).toEqual(["svg-use-bomb"]);
    expect(r.visuals.map((v) => v.locator)).toEqual(Array.from({ length: 99 }, (_, k) => `svg[${k + 1}]`));
  });

  it("is deterministic", () => {
    const text = html([packedSvg(1000, 1000), genericBar(["a", "b"], [1, 2], 4), packedSvg()]);
    expect(JSON.stringify(extractDeterministicVisuals({ kind: "html", text }))).toBe(JSON.stringify(extractDeterministicVisuals({ kind: "html", text })));
  });

  it("defers SVGs past maxSvgsPerInput as one counted ordinal range, never by name, without parsing them", () => {
    // An EPUB with 3 chapters of 150 inline SVGs: 450 SVGs, over the 400 analysed per input.
    const tiny = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    const chapter = `<html><body>${tiny.repeat(150)}</body></html>`;
    const epub = zip({ "mimetype": "application/epub+zip", "OEBPS/a.xhtml": chapter, "OEBPS/b.xhtml": chapter, "OEBPS/c-customer-name.xhtml": chapter });
    const r = extractDeterministicVisuals({ kind: "epub", bytes: epub });
    // One entry covers every deferred SVG, however many (an EPUB can hold 200 × 200): none is dropped (council r5 L3).
    expect(r.deferred).toEqual([{ svgIndex: 400, count: 50, reason: DEFERRED_SVG_REASON }]);
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
