import { describe, expect, it } from "vitest";

import type { ChartSpec } from "@docslurp/shared";

import { jsonRegions } from "../embedded-spec.js";
import { extractDeterministicVisuals } from "../index.js";
import { zip } from "./fixtures.js";

const VL = "https://vega.github.io/schema/vega-lite/v5.json";
const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="vis"></div>${body}</body></html>`;
function one(text: string, kind: "html" | "json" | "svg" = "html") {
  const r = extractDeterministicVisuals({ kind, text });
  expect(r.refusals).toEqual([]);
  expect(r.visuals.length).toBeGreaterThanOrEqual(1);
  return { v: r.visuals[0]!, spec: r.visuals[0]!.spec as ChartSpec, all: r.visuals };
}

describe("embedded-spec: Vega-Lite", () => {
  it("reads an inline-values bar spec passed to vegaEmbed", () => {
    const spec = { $schema: VL, title: "Sales by region", data: { values: [{ region: "North", sales: 28 }, { region: "South", sales: 55 }, { region: "East", sales: 43 }] }, mark: "bar", encoding: { x: { field: "region", type: "nominal", title: "Region" }, y: { field: "sales", type: "quantitative", title: "Sales ($k)" } } };
    const { v, spec: s } = one(html(`<script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script><script type="text/javascript">var spec = ${JSON.stringify(spec)};\nvegaEmbed('#vis', spec);</script>`));
    expect(v.source).toBe("embedded-spec");
    expect(v.generator).toBe("vega-lite");
    expect(s.chartType).toBe("bar");
    expect(s.title).toBe("Sales by region");
    expect(s.xAxis.label).toBe("Region");
    expect(s.yAxis.label).toBe("Sales ($k)");
    expect(s.series[0]!.points).toEqual([{ x: "North", y: 28 }, { x: "South", y: 55 }, { x: "East", y: 43 }]);
    expect(v.confidence).toBeGreaterThan(0.9);
  });

  it("reads Altair-style named datasets with a colour series and stacking", () => {
    const spec = { $schema: VL, data: { name: "data-1a2b" }, mark: { type: "bar" }, encoding: { x: { field: "q", type: "ordinal" }, y: { field: "v", type: "quantitative", aggregate: "sum" }, color: { field: "team", type: "nominal" } }, datasets: { "data-1a2b": [{ q: "Q1", v: 3, team: "A" }, { q: "Q1", v: 2, team: "A" }, { q: "Q1", v: 4, team: "B" }, { q: "Q2", v: 6, team: "A" }, { q: "Q2", v: 1, team: "B" }] } };
    const { spec: s } = one(html(`<script type="application/json" id="spec">${JSON.stringify(spec)}</script>`));
    expect(s.chartType).toBe("stacked-bar");
    const a = s.series.find((x) => x.name === "A")!;
    expect(a.points).toEqual([{ x: "Q1", y: 5 }, { x: "Q2", y: 6 }]);
  });

  it("reads a layered line + point spec, arcs (pie/donut) and horizontal bars from standalone JSON", () => {
    const layered = { $schema: VL, data: { values: [{ t: 1, y: 2 }, { t: 2, y: 4 }] }, encoding: { x: { field: "t", type: "quantitative" }, y: { field: "y", type: "quantitative" } }, layer: [{ mark: "line" }, { mark: "point" }] };
    const l = one(JSON.stringify(layered), "json").spec;
    expect(l.chartType).toBe("combo");
    expect(l.series[0]!.points).toEqual([{ x: 1, y: 2 }, { x: 2, y: 4 }]);
    const pie = one(JSON.stringify({ $schema: VL, data: { values: [{ k: "a", n: 1 }, { k: "b", n: 3 }] }, mark: { type: "arc", innerRadius: 40 }, encoding: { theta: { field: "n", type: "quantitative" }, color: { field: "k", type: "nominal" } } }), "json").spec;
    expect(pie.chartType).toBe("donut");
    const hbar = one(JSON.stringify({ $schema: VL, data: { values: [{ c: "x", n: 1 }] }, mark: "bar", encoding: { y: { field: "c", type: "nominal" }, x: { field: "n", type: "quantitative" } } }), "json").spec;
    expect(hbar.chartType).toBe("horizontal-bar");
    expect(hbar.series[0]!.points).toEqual([{ x: "x", y: 1 }]);
  });

  it("returns null for a spec with only a data URL (nothing is fetched) and for full Vega", () => {
    const r1 = one(JSON.stringify({ $schema: VL, data: { url: "https://example.com/data.csv" }, mark: "bar", encoding: { x: { field: "a" }, y: { field: "b" } } }), "json");
    expect(r1.v.spec).toBeNull();
    expect(r1.v.reason).toBe("vega-lite-no-inline-data");
    const r2 = one(JSON.stringify({ $schema: "https://vega.github.io/schema/vega/v5.json", data: [{ name: "t", values: [1] }], marks: [] }), "json");
    expect(r2.v.generator).toBe("vega");
    expect(r2.v.spec).toBeNull();
  });
});

describe("embedded-spec: Plotly", () => {
  it("reads Plotly.newPlot(data, layout) arguments without executing script", () => {
    const data = [{ type: "bar", name: "Online", x: ["Jan", "Feb"], y: [10, 14] }, { type: "bar", name: "Stores", x: ["Jan", "Feb"], y: [5, 8] }];
    const layout = { title: { text: "Channel mix" }, barmode: "stack", yaxis: { title: { text: "Orders" } } };
    const { v, spec: s } = one(html(`<script>window.PLOTLYENV=window.PLOTLYENV || {};\nif (document.getElementById("x")) { Plotly.newPlot("x", ${JSON.stringify(data)}, ${JSON.stringify(layout)}, {"responsive": true}) };</script>`));
    expect(v.generator).toBe("plotly");
    expect(s.chartType).toBe("stacked-bar");
    expect(s.title).toBe("Channel mix");
    expect(s.yAxis.label).toBe("Orders");
    expect(s.series[1]!.points).toEqual([{ x: "Jan", y: 5 }, { x: "Feb", y: 8 }]);
  });

  it("decodes plotly.py typed arrays and maps pie / scatter / secondary axis", () => {
    const f8 = Buffer.alloc(24);
    [1.5, 2.5, 4].forEach((v, k) => f8.writeDoubleLE(v, k * 8));
    const data = [{ type: "scatter", mode: "lines", name: "Price", x: [1, 2, 3], y: { dtype: "f8", bdata: f8.toString("base64") } }, { type: "bar", name: "Volume", x: [1, 2, 3], y: [100, 120, 90], yaxis: "y2" }];
    const { spec: s } = one(html(`<script type="application/json" data-plotly="x">${JSON.stringify({ data, layout: { yaxis2: { title: { text: "Volume" } } } })}</script>`));
    expect(s.chartType).toBe("combo");
    expect(s.series[0]!.points.map((p) => p.y)).toEqual([1.5, 2.5, 4]);
    expect(s.series[1]!.axis).toBe("y2");
    expect(s.y2Axis?.label).toBe("Volume");
    const pie = one(html(`<script>Plotly.newPlot('p', [{"type":"pie","labels":["a","b"],"values":[2,3],"hole":0.4}], {})</script>`)).spec;
    expect(pie.chartType).toBe("donut");
  });

  it("reports non-JSON Plotly data (NaN, functions) instead of evaluating it", () => {
    const r = one(html(`<script>Plotly.newPlot('p', [{"type":"bar","x":["a"],"y":[NaN]}], {})</script>`));
    expect(r.v.spec).toBeNull();
    expect(r.v.reason).toBe("plotly-data-not-json");
  });
});

describe("embedded-spec: containers", () => {
  it("finds specs in SVG <metadata> and EPUB chapters", () => {
    const spec = { $schema: VL, data: { values: [{ a: "x", b: 1 }, { a: "y", b: 2 }] }, mark: "line", encoding: { x: { field: "a", type: "ordinal" }, y: { field: "b", type: "quantitative" } } };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><metadata>${JSON.stringify(spec).replace(/</g, "&lt;")}</metadata><rect width="10" height="10"/></svg>`;
    const sv = one(svg, "svg");
    expect(sv.v.source).toBe("embedded-spec");
    expect(sv.spec.chartType).toBe("line");
    const epub = zip({ mimetype: "application/epub+zip", "OEBPS/ch1.xhtml": `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><script type="application/json">${JSON.stringify(spec)}</script></body></html>` });
    const r = extractDeterministicVisuals({ kind: "epub", bytes: epub });
    expect(r.visuals).toHaveLength(1);
    expect(r.visuals[0]!.locator).toBe("OEBPS/ch1.xhtml#script[0]");
  });

  it("keeps malicious field values as plain strings and drops non-finite numbers", () => {
    const evil = "</script><script>alert(1)</script>";
    const spec = { $schema: VL, data: { values: [{ a: evil, b: "Infinity" }, { a: "__proto__", b: 2 }, { a: "ok", b: 1e308 * 10 }] }, mark: "bar", encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } } };
    const { spec: s } = one(JSON.stringify(spec).replace("1e+309", "1e999"), "json");
    expect(s.series[0]!.points).toEqual([{ x: evil, y: null }, { x: "__proto__", y: 2 }, { x: "ok", y: null }]);
  });

  it("bounds the bracket scanner on hostile nesting", () => {
    expect(jsonRegions("[".repeat(100_000))).toEqual([]);
    const r = extractDeterministicVisuals({ kind: "html", text: html(`<script>${"[".repeat(200_000)}</script>`) });
    expect(r.visuals).toEqual([]);
  });
});
