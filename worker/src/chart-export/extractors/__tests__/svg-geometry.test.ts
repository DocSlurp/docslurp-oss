import { describe, expect, it } from "vitest";

import type { ChartSpec } from "@docslurp/shared";

import { extractDeterministicVisuals } from "../index.js";
import { genericBar, genericLogLine, highchartsColumn, matplotlibBar, matplotlibBarh, matplotlibLine, matplotlibScatter, plotlyBar, rechartsLine, vegaBar } from "./fixtures.js";

function svgChart(text: string) {
  const r = extractDeterministicVisuals({ kind: "svg", text });
  expect(r.refusals).toEqual([]);
  expect(r.visuals).toHaveLength(1);
  const v = r.visuals[0]!;
  expect(v.source).toBe("svg-geometry");
  return { v, spec: v.spec as ChartSpec };
}

const values = (spec: ChartSpec, k = 0) => spec.series[k]!.points.map((p) => p.y);
const xs = (spec: ChartSpec, k = 0) => spec.series[k]!.points.map((p) => p.x);
/** Max absolute error as a fraction of the axis range. */
function relErr(got: Array<number | null>, want: number[], range: number) {
  expect(got).toHaveLength(want.length);
  return Math.max(...want.map((w, k) => Math.abs((got[k] ?? Infinity) - w) / range));
}

describe("svg-geometry: matplotlib", () => {
  it("reads a single-series bar chart with title, axis labels and categories", () => {
    const svg = matplotlibBar({ categories: ["Q1", "Q2", "Q3", "Q4"], series: [{ name: "Revenue", values: [12, 15.5, 9, 21], color: "#1f77b4" }] }, { vmax: 25, title: "Quarterly revenue", xlabel: "Quarter", ylabel: "Revenue ($M)" });
    const { v, spec } = svgChart(svg);
    expect(v.generator).toBe("matplotlib");
    expect(spec.chartType).toBe("bar");
    expect(spec.title).toBe("Quarterly revenue");
    expect(spec.xAxis.label).toBe("Quarter");
    expect(spec.yAxis.label).toBe("Revenue ($M)");
    expect(xs(spec)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(relErr(values(spec), [12, 15.5, 9, 21], 25)).toBeLessThan(0.005);
    expect(v.confidence).toBeGreaterThan(0.85);
    expect(v.digest).toContain("Q2");
  });

  it("reads grouped bars and names series from the legend", () => {
    const svg = matplotlibBar({
      categories: ["North", "South", "East"],
      series: [{ name: "2025", values: [40, 55, 30], color: "#1f77b4" }, { name: "2026", values: [48, 61, 42], color: "#ff7f0e" }],
    }, { vmax: 70, legend: true });
    const { spec } = svgChart(svg);
    expect(spec.chartType).toBe("grouped-bar");
    expect(spec.series.map((s) => s.name).sort()).toEqual(["2025", "2026"]);
    const s25 = spec.series.find((s) => s.name === "2025")!;
    expect(s25.points.map((p) => p.x)).toEqual(["North", "South", "East"]);
    expect(relErr(s25.points.map((p) => p.y), [40, 55, 30], 70)).toBeLessThan(0.005);
  });

  it("reads stacked bars as segment values", () => {
    const svg = matplotlibBar({
      categories: ["Jan", "Feb"],
      series: [{ name: "Online", values: [10, 14], color: "#2ca02c" }, { name: "Stores", values: [5, 8], color: "#d62728" }],
    }, { vmax: 25, legend: true, stacked: true });
    const { spec } = svgChart(svg);
    expect(spec.chartType).toBe("stacked-bar");
    const stores = spec.series.find((s) => s.name === "Stores")!;
    expect(relErr(stores.points.map((p) => p.y), [5, 8], 25)).toBeLessThan(0.005);
  });

  it("reads line series on a numeric x axis, dropping vertex markers as duplicates", () => {
    const x = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const a = [2, 3.5, 5, 4.2, 6, 7.5, 7, 8.8, 9.6];
    const b = [1, 1.2, 2, 2.5, 3.1, 3, 4.2, 5, 5.5];
    const svg = matplotlibLine(x, [{ name: "Bookings", values: a, color: "#1f77b4", markers: true }, { name: "Renewals", values: b, color: "#ff7f0e" }], { vmin: 0, vmax: 10, xmin: 0, xmax: 8, legend: true, title: "Growth", ylabel: "Units (k)" });
    const { v, spec } = svgChart(svg);
    expect(spec.chartType).toBe("line");
    expect(spec.series).toHaveLength(2);
    const bookings = spec.series.find((s) => s.name === "Bookings")!;
    expect(bookings.points.map((p) => p.x)).toEqual(x);
    expect(relErr(bookings.points.map((p) => p.y), a, 10)).toBeLessThan(0.005);
    expect(spec.xAxis.scale).toBe("linear");
    expect(v.confidence).toBeGreaterThan(0.8);
  });

  it("reads a scatter plot", () => {
    const pts: Array<[number, number]> = [[1, 2], [2.5, 4], [4, 3.3], [6, 8], [7.5, 6.1], [9, 9.5]];
    const { spec } = svgChart(matplotlibScatter(pts, "#9467bd", { vmin: 0, vmax: 10, xmin: 0, xmax: 10 }));
    expect(spec.chartType).toBe("scatter");
    const got = [...spec.series[0]!.points].sort((p, q) => (p.x as number) - (q.x as number));
    expect(relErr(got.map((p) => p.x as number), pts.map((p) => p[0]), 10)).toBeLessThan(0.005);
    expect(relErr(got.map((p) => p.y), pts.map((p) => p[1]), 10)).toBeLessThan(0.005);
  });

  it("reads horizontal bars", () => {
    const { spec } = svgChart(matplotlibBarh(["Paris", "Tokyo", "Lima"], [30, 72, 51], "#17becf", 80));
    expect(spec.chartType).toBe("horizontal-bar");
    const byCat = Object.fromEntries(spec.series[0]!.points.map((p) => [p.x, p.y]));
    expect(Math.abs(byCat.Tokyo! - 72)).toBeLessThan(0.5);
    expect(Math.abs(byCat.Paris! - 30)).toBeLessThan(0.5);
    expect(Math.abs(byCat.Lima! - 51)).toBeLessThan(0.5);
  });
});

describe("svg-geometry: other generators", () => {
  it("Plotly grouped bars with legend and title", () => {
    const svg = plotlyBar({ categories: ["A", "B", "C"], series: [{ name: "Wins", values: [3, 7, 5], color: "rgb(99, 110, 250)" }, { name: "Deals", values: [4, 2, 6], color: "rgb(239, 85, 59)" }] }, { vmax: 10, title: "Pipeline" });
    const { v, spec } = svgChart(svg);
    expect(v.generator).toBe("plotly");
    expect(spec.chartType).toBe("grouped-bar");
    expect(spec.title).toBe("Pipeline");
    const wins = spec.series.find((s) => s.name === "Wins")!;
    expect(relErr(wins.points.map((p) => p.y), [3, 7, 5], 10)).toBeLessThan(0.005);
  });

  it("Plotly stacked bars", () => {
    const svg = plotlyBar({ categories: ["A", "B"], series: [{ name: "x", values: [3, 7], color: "#636efa" }, { name: "y", values: [4, 2], color: "#ef553b" }] }, { vmax: 10, stacked: true });
    const { spec } = svgChart(svg);
    expect(spec.chartType).toBe("stacked-bar");
    expect(relErr(spec.series.find((s) => s.name === "y")!.points.map((p) => p.y), [4, 2], 10)).toBeLessThan(0.005);
  });

  it("Recharts monotone line (curve end points are the data)", () => {
    const vals = [400, 300, 520, 610, 480];
    const { v, spec } = svgChart(rechartsLine(["Jan", "Feb", "Mar", "Apr", "May"], vals, 800));
    expect(v.generator).toBe("recharts");
    expect(spec.chartType).toBe("line");
    expect(xs(spec)).toEqual(["Jan", "Feb", "Mar", "Apr", "May"]);
    expect(relErr(values(spec), vals, 800)).toBeLessThan(0.01);
  });

  it("Highcharts column with a translated series group", () => {
    const vals = [5, 3, 4, 7];
    const { v, spec } = svgChart(highchartsColumn(["Apples", "Pears", "Plums", "Figs"], vals, 8, "Fruit sold"));
    expect(v.generator).toBe("highcharts");
    expect(spec.title).toBe("Fruit sold");
    expect(xs(spec)).toEqual(["Apples", "Pears", "Plums", "Figs"]);
    expect(relErr(values(spec), vals, 8)).toBeLessThan(0.01);
  });

  it("Vega bar chart", () => {
    const vals = [28, 55, 43, 91];
    const { v, spec } = svgChart(vegaBar(["A", "B", "C", "D"], vals, 100));
    expect(v.generator).toBe("vega");
    expect(xs(spec)).toEqual(["A", "B", "C", "D"]);
    expect(relErr(values(spec), vals, 100)).toBeLessThan(0.01);
  });

  it("generic SVG bars with thousands separators", () => {
    const vals = [1200, 3400, 2500];
    const { v, spec } = svgChart(genericBar(["East", "West", "Central"], vals, 4000));
    expect(v.generator).toBeNull();
    expect(spec.chartType).toBe("bar");
    expect(relErr(values(spec), vals, 4000)).toBeLessThan(0.005);
  });

  it("generic log-scale line", () => {
    const x = [2020, 2021, 2022, 2023, 2024];
    const y = [3, 40, 220, 1500, 9000];
    const { spec } = svgChart(genericLogLine(x, y));
    expect(spec.yAxis.scale).toBe("log");
    const got = values(spec);
    y.forEach((want, k) => expect(Math.abs(Math.log10(got[k]!) - Math.log10(want))).toBeLessThan(0.01));
    expect(spec.title).toBe("Users (log)");
  });

  it("returns nothing for an icon-like SVG without axes", () => {
    const r = extractDeterministicVisuals({ kind: "svg", text: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2L2 22h20z" fill="#000"/></svg>` });
    expect(r.visuals).toEqual([]);
    expect(r.refusals).toEqual([]);
  });

  it("returns a digest without a spec when axes resolve but marks do not", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">${[0, 10, 20, 30].map((v, k) => `<text x="40" y="${180 - k * 50}" text-anchor="end" dominant-baseline="middle">${v}</text>`).join("")}<path d="M50,180 A60,60 0 0 1 200,40" stroke="#333" fill="none"/></svg>`;
    const r = extractDeterministicVisuals({ kind: "svg", text: svg });
    expect(r.visuals).toHaveLength(1);
    expect(r.visuals[0]!.spec).toBeNull();
    expect(r.visuals[0]!.digest).toContain("y-scale: linear");
  });
});
