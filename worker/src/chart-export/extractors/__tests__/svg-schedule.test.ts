// The svg-geometry schedule across many SVGs in one input (index.ts): fair shares, cheapest first, approximate instead
// of refuse, defer instead of drop, stable output order. Work is asserted by pair-test count, not wall time.
import { describe, expect, it } from "vitest";

import { APPROXIMATE_MARKER_REASON, DEFERRED_SVG_REASON, extractDeterministicVisuals, markerBudget, type MarkerBudget } from "../index.js";
import { CHART_EXTRACT_LIMITS, ExtractLimitError } from "../limits.js";
import { withoutVertexMarkers } from "../svg-geometry.js";
import type { LinePrim, PointPrim } from "../svg-scene.js";
import { genericBar, matplotlibBar, matplotlibLine, matplotlibScatter, plotlyBar, rechartsLine, vegaBar } from "./fixtures.js";

const L = CHART_EXTRACT_LIMITS;

/**
 * The council's packed-cell scene: `vertices` polyline vertices (the two ends far apart, the rest packed into one
 * 3-unit cell) and `markers` markers (`<use>` copies of a 100-circle group) in the next cell, more than 1.5 from every
 * vertex, so the exact pass runs (vertices − 2) × markers pair tests and no marker short-circuits.
 */
function packedSvg(vertices: number, markers: number): string {
  const pts = ["10,90", ...Array.from({ length: vertices - 2 }, (_, i) => `${(30 + (i % 290) / 100).toFixed(2)},${(30 + (i % 97) / 34).toFixed(2)}`), "90,10"];
  const ticks = [[0, 90], [10, 50], [20, 10]].map(([v, y]) => `<text x="2" y="${y}">${v}</text>`).join("");
  const groups = Math.ceil(markers / 100);
  const per = Math.min(100, markers);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><polyline points="${pts.join(" ")}" stroke="#f00" fill="none"/>`
    + `<defs><g id="m">${'<circle cx="34.6" cy="34.6" r="1" fill="#00f"/>'.repeat(per)}</g></defs>${'<use href="#m"/>'.repeat(groups)}`
    + `${ticks}<text x="10" y="98">A</text><text x="50" y="98">B</text><text x="90" y="98">C</text></svg>`;
}
const html = (svgs: string[]) => `<html><body>${svgs.join("")}</body></html>`;
const budgetOf = (remaining: number, extra: Partial<MarkerBudget> = {}): MarkerBudget => ({ remaining, pairTests: 0, primitives: 0, inputsAfter: 0, ...extra });

describe("svg-geometry schedule: many SVGs in one input", () => {
  it("finishes 100 packed SVGs in one HTML input: every one exported (exact or approximate), none refused, work bounded", () => {
    // The council's 100-SVG input, scaled (2,500 vertices × 2,000 markers each, 5×10⁶ pair tests per SVG unbounded,
    // 5×10⁸ in all) with a 2×10⁷ budget so the test stays cheap; the production budget behaves the same, 10× larger.
    const svgs = Array.from({ length: 100 }, () => packedSvg(2500, 2000));
    const budget = budgetOf(20_000_000);
    const r = extractDeterministicVisuals({ kind: "html", text: html(svgs) }, { markerBudget: budget });
    expect(r.refusals).toEqual([]);
    expect(r.deferred).toBeUndefined();
    expect(r.visuals.map((v) => v.locator)).toEqual(svgs.map((_, k) => `svg[${k}]`));
    const approximate = r.visuals.filter((v) => v.reason === APPROXIMATE_MARKER_REASON);
    expect(approximate.length).toBeGreaterThan(0);
    for (const v of approximate) expect(v.confidence).toBeLessThanOrEqual(L.approximateMaxConfidence);
    expect(r.visuals.every((v) => v.spec !== null)).toBe(true);
    expect(budget.pairTests).toBeLessThanOrEqual(20_000_000);
  });

  it("exports every SVG of a 40-copy batch sharing one budget (council r3 I2: was 1 visual and 39 refusals)", () => {
    // The guest batch loop (scripts/chart-export-extract.mjs): one budget across the files, inputsAfter counting the rest.
    // Scaled like the 100-SVG test: 5×10⁶ pair tests per SVG unbounded, a 2×10⁷ budget for the batch.
    const svg = packedSvg(2500, 2000);
    const budget = budgetOf(20_000_000);
    const results = Array.from({ length: 40 }, (_, i) => {
      budget.inputsAfter = 40 - 1 - i;
      return extractDeterministicVisuals({ kind: "svg", text: svg }, { markerBudget: budget });
    });
    expect(results.flatMap((r) => r.refusals)).toEqual([]);
    expect(results.map((r) => r.visuals.length)).toEqual(Array(40).fill(1));
    expect(results.every((r) => r.deferred === undefined)).toBe(true);
    expect(budget.pairTests).toBeLessThanOrEqual(20_000_000);
    // Shares leave room for the inputs still to come: the last file got a share too (it is approximated, not refused).
    expect(results.at(-1)!.visuals[0]!.reason).toBe(APPROXIMATE_MARKER_REASON);
  });

  it("gives every SVG a fair share: one giant SVG first cannot starve 99 small ones after it", () => {
    const giant = packedSvg(2500, 2000); // 5×10⁶ pair tests unbounded
    const small = packedSvg(22, 100); // 2×10³ each
    const svgs = [giant, ...Array.from({ length: 99 }, () => small)];
    const budget = budgetOf(1_000_000);
    const r = extractDeterministicVisuals({ kind: "html", text: html(svgs) }, { markerBudget: budget });
    expect(r.refusals).toEqual([]);
    expect(r.visuals).toHaveLength(100);
    // Output order is document order even though the giant finished last.
    expect(r.visuals[0]!.locator).toBe("svg[0]");
    expect(r.visuals[0]!.reason).toBe(APPROXIMATE_MARKER_REASON);
    expect(r.visuals.slice(1).every((v) => v.reason !== APPROXIMATE_MARKER_REASON)).toBe(true);
    expect(budget.pairTests).toBeLessThanOrEqual(1_000_000);
    // First come would have spent the whole budget on the giant: 99 × 2,000 small tests all ran exactly.
    expect(budget.pairTests).toBeGreaterThanOrEqual(99 * 2_000);
  });

  it("is deterministic: the same input gives the same output and the same pair count", () => {
    const svgs = [packedSvg(2500, 2000), packedSvg(300, 400), packedSvg(1200, 1500), packedSvg(22, 100), packedSvg(2500, 1000)];
    const runs = [0, 1].map(() => {
      const budget = budgetOf(3_000_000);
      return { out: JSON.stringify(extractDeterministicVisuals({ kind: "html", text: html(svgs) }, { markerBudget: budget })), tests: budget.pairTests };
    });
    expect(runs[1]).toEqual(runs[0]);
  });

  it("sends an SVG over the vertex cap down the approximate path, not to a refusal", () => {
    // 7 polylines of 20k vertices: over maxMarkerVertices (131,072), so no typed grid is built for it.
    const line = (k: number) => `<polyline points="${Array.from({ length: 20_000 }, (_, i) => `${(10 + i * 0.004).toFixed(3)},${(20 + k * 5 + (i % 7)).toFixed(0)}`).join(" ")}" stroke="#f00" fill="none"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${Array.from({ length: 7 }, (_, k) => line(k)).join("")}`
      + `<circle cx="50" cy="80" r="1" fill="#00f"/><circle cx="60" cy="20" r="1" fill="#00f"/>`
      + `${[[0, 90], [10, 50], [20, 10]].map(([v, y]) => `<text x="2" y="${y}">${v}</text>`).join("")}<text x="10" y="98">A</text><text x="90" y="98">C</text></svg>`;
    const budget = markerBudget();
    const r = extractDeterministicVisuals({ kind: "svg", text: svg }, { markerBudget: budget });
    expect(r.refusals).toEqual([]);
    expect(r.visuals).toHaveLength(1);
    expect(r.visuals[0]!.reason).toBe(APPROXIMATE_MARKER_REASON);
    expect(budget.pairTests).toBe(0);
    // The exact pass itself refuses to build an index that large.
    const points: PointPrim[] = [{ kind: "point", x: 1, y: 1, size: 1, fill: "#000", stroke: null } as PointPrim];
    const lines = [{ kind: "line", points: Array.from({ length: L.maxMarkerVertices + 1 }, (_, i) => [i, i]), stroke: "#000", fill: null } as unknown as LinePrim];
    expect(() => withoutVertexMarkers(points, lines)).toThrow(ExtractLimitError);
  });

  it("defers SVGs past the input's scene ceiling, with a reason, and keeps everything finished before", () => {
    const svgs = [genericBar(["a", "b"], [1, 2], 4), genericBar(["c", "d"], [3, 1], 4), genericBar(["e", "f"], [2, 2], 4)];
    // The first SVG's scene crosses the ceiling; the two after it are deferred, not parsed and not refused.
    const budget = budgetOf(L.markerPairTestsBase, { primitives: L.maxSvgScenePrimitivesPerInput - 1 });
    const r = extractDeterministicVisuals({ kind: "html", text: html(svgs) }, { markerBudget: budget });
    expect(r.visuals.map((v) => v.locator)).toEqual(["svg[0]"]);
    expect(r.visuals[0]!.spec).not.toBeNull();
    expect(r.refusals).toEqual([]);
    expect(r.deferred).toEqual([{ locator: "svg[1]", reason: DEFERRED_SVG_REASON }, { locator: "svg[2]", reason: DEFERRED_SVG_REASON }]);
  });

  it("leaves ordinary charts exactly as an unlimited budget would (no approximation, same bytes)", () => {
    const xs = Array.from({ length: 60 }, (_, i) => i);
    const charts = [
      matplotlibBar({ categories: ["Q1", "Q2", "Q3"], series: [{ name: "R", values: [12, 15, 9], color: "#1f77b4" }] }, { vmax: 20 }),
      matplotlibLine(xs, [{ name: "a", values: xs.map((x) => Math.sin(x / 5) * 10 + 20), color: "#1f77b4", markers: true }, { name: "b", values: xs.map((x) => x / 3), color: "#ff7f0e", markers: true }], { vmin: 0, vmax: 35, xmin: 0, xmax: 60, legend: true }),
      matplotlibScatter(xs.map((x) => [x, (x * 7) % 30] as [number, number]), "#2ca02c", { vmin: 0, vmax: 30, xmin: 0, xmax: 60 }),
      plotlyBar({ categories: ["a", "b"], series: [{ name: "s", values: [3, 4], color: "#636efa" }] }, { vmax: 5 }),
      rechartsLine(["Mon", "Tue", "Wed"], [3, 5, 4], 6),
      vegaBar(["x", "y"], [1, 2], 3),
    ];
    const text = html(charts);
    const unlimited = budgetOf(Number.MAX_SAFE_INTEGER);
    const defaulted = extractDeterministicVisuals({ kind: "html", text });
    expect(JSON.stringify(defaulted)).toBe(JSON.stringify(extractDeterministicVisuals({ kind: "html", text }, { markerBudget: unlimited })));
    expect(defaulted.visuals.some((v) => v.reason === APPROXIMATE_MARKER_REASON)).toBe(false);
    expect(defaulted.deferred).toBeUndefined();
    for (const svg of charts) expect(JSON.stringify(extractDeterministicVisuals({ kind: "svg", text: svg }))).toBe(JSON.stringify(extractDeterministicVisuals({ kind: "svg", text: svg }, { markerBudget: budgetOf(Number.MAX_SAFE_INTEGER) })));
  });

  it("scales the budget with pages, up to the ceiling", () => {
    expect(markerBudget().remaining).toBe(L.markerPairTestsBase);
    expect(markerBudget(1).remaining).toBe(L.markerPairTestsBase);
    expect(markerBudget(4).remaining).toBe(4 * L.markerPairTestsPerPage);
    expect(markerBudget(10_000).remaining).toBe(L.maxMarkerPairTestsPerInput);
    expect(markerBudget(Number.NaN).remaining).toBe(L.markerPairTestsBase);
    // The ceiling at ~3 ns per pair test (measured on the parser VM) stays far inside the guest's 60 s timeout.
    expect(L.maxMarkerPairTestsPerInput * 3e-9).toBeLessThan(10);
  });
});
