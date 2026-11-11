import { describe, expect, it } from "vitest";

import type { ChartSpec } from "@docslurp/shared";

import { extractDeterministicVisuals } from "../index.js";
import { parseChartXml } from "../office-chart-xml.js";
import { finalizeChart } from "../spec-utils.js";
import { barPlot, catValAxes, chartXml, docx, linePlot, pptx, simplePlot, xlsx } from "./fixtures.js";

const Q = ["Q1", "Q2", "Q3", "Q4"];

function office(bytes: Uint8Array) {
  const r = extractDeterministicVisuals({ kind: "office", bytes });
  expect(r.refusals).toEqual([]);
  return r.visuals;
}
const spec = (v: { spec: unknown }) => v.spec as ChartSpec;

describe("office-chart-xml", () => {
  it("reads a clustered column chart from DOCX with titles and cached values", () => {
    const xml = chartXml({ title: "Revenue by quarter", plots: [barPlot([{ name: "2025", cats: Q, vals: [10, 12.5, 9, 14] }, { name: "2026", cats: Q, vals: [11, 13, 15, 18] }])] });
    const [v] = office(docx([xml]));
    expect(v!.source).toBe("office-chart-xml");
    expect(v!.locator).toBe("word/charts/chart1.xml");
    expect(v!.generator).toBe("word");
    const s = spec(v!);
    expect(s.chartType).toBe("grouped-bar");
    expect(s.title).toBe("Revenue by quarter");
    expect(s.xAxis.label).toBe("Quarter");
    expect(s.yAxis.label).toBe("Revenue ($M)");
    expect(s.series.map((x) => x.name)).toEqual(["2025", "2026"]);
    expect(s.series[1]!.points).toEqual([{ x: "Q1", y: 11 }, { x: "Q2", y: 13 }, { x: "Q3", y: 15 }, { x: "Q4", y: 18 }]);
    expect(v!.confidence).toBeGreaterThan(0.95);
  });

  it("maps bar direction and grouping", () => {
    const one = [{ name: "Units", cats: Q, vals: [1, 2, 3, 4] }];
    expect(spec(office(docx([chartXml({ plots: [barPlot(one, { barDir: "bar" })] })]))[0]!).chartType).toBe("horizontal-bar");
    expect(spec(office(docx([chartXml({ plots: [barPlot([...one, { name: "B", cats: Q, vals: [4, 3, 2, 1] }], { grouping: "stacked" })] })]))[0]!).chartType).toBe("stacked-bar");
    expect(spec(office(docx([chartXml({ plots: [barPlot(one)] })]))[0]!).chartType).toBe("bar");
  });

  it("reads a combo bar + line chart with a secondary axis from PPTX and maps the slide", () => {
    const axes = catValAxes("10", "20", "Month", "Orders") + `<c:valAx><c:axId val="30"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="r"/><c:crossAx val="10"/></c:valAx>`;
    const xml = chartXml({
      title: "Orders and margin",
      plots: [barPlot([{ name: "Orders", cats: ["Jan", "Feb", "Mar"], vals: [120, 150, 170] }]), linePlot([{ name: "Margin", cats: ["Jan", "Feb", "Mar"], vals: [0.21, 0.24, 0.26], formatCode: "0%" }], ["10", "30"], 1)],
      axes,
    });
    const [v] = office(pptx([[3, xml]]));
    expect(v!.slide).toBe(3);
    expect(v!.generator).toBe("powerpoint");
    const s = spec(v!);
    expect(s.chartType).toBe("combo");
    expect(s.series.map((x) => [x.name, x.mark, x.axis])).toEqual([["Orders", "bar", "y"], ["Margin", "line", "y2"]]);
    expect(s.series[1]!.points.map((p) => p.y)).toEqual([21, 24, 26]);
    expect(s.y2Axis).not.toBeNull();
  });

  it("reads pie, doughnut, scatter, bubble, area and radar charts", () => {
    const pie = spec(office(docx([chartXml({ plots: [simplePlot("pieChart", [{ name: "Share", cats: ["A", "B", "C"], vals: [50, 30, 20] }], "<c:varyColors val=\"1\"/>", false, null)], axes: "" })]))[0]!);
    expect(pie.chartType).toBe("pie");
    expect(pie.title).toBeNull(); // autoTitleDeleted=1
    expect(spec(office(docx([chartXml({ plots: [simplePlot("doughnutChart", [{ name: "Mix", cats: ["A", "B"], vals: [1, 3] }], "", false, null)], axes: "" })]))[0]!).chartType).toBe("donut");
    const scatterAxes = `<c:valAx><c:axId val="10"/><c:scaling/><c:axPos val="b"/><c:crossAx val="20"/></c:valAx><c:valAx><c:axId val="20"/><c:scaling><c:logBase val="10"/></c:scaling><c:axPos val="l"/><c:crossAx val="10"/></c:valAx>`;
    const sc = spec(office(docx([chartXml({ plots: [simplePlot("scatterChart", [{ name: "Trials", xNums: [1, 2, 4], vals: [10, 100, 1000] }], "<c:scatterStyle val=\"lineMarker\"/>", true)], axes: scatterAxes })]))[0]!);
    expect(sc.chartType).toBe("scatter");
    expect(sc.series[0]!.points).toEqual([{ x: 1, y: 10 }, { x: 2, y: 100 }, { x: 4, y: 1000 }]);
    expect(sc.yAxis.scale).toBe("log");
    const bub = spec(office(docx([chartXml({ plots: [simplePlot("bubbleChart", [{ name: "Markets", xNums: [1, 2], vals: [3, 4], sizes: [10, 20] }], "", true)], axes: scatterAxes })]))[0]!);
    expect(bub.chartType).toBe("bubble");
    expect(bub.series[0]!.points[1]).toEqual({ x: 2, y: 4, z: 20 });
    expect(spec(office(docx([chartXml({ plots: [simplePlot("areaChart", [{ name: "A", cats: Q, vals: [1, 2, 3, 4] }], "<c:grouping val=\"standard\"/>")] })]))[0]!).chartType).toBe("area");
    expect(spec(office(docx([chartXml({ plots: [simplePlot("radarChart", [{ name: "Skills", cats: ["x", "y", "z"], vals: [3, 4, 5] }], "<c:radarStyle val=\"marker\"/>")] })]))[0]!).chartType).toBe("radar");
  });

  it("resolves series without caches from the XLSX sheet and names the sheet", () => {
    const xml = chartXml({ title: "Visitors", plots: [linePlot([{ name: "Visitors", cats: [], vals: [], noCache: true, catRef: "'Web stats'!$A$2:$A$4", valRef: "'Web stats'!$B$2:$B$4" }])] });
    const bytes = xlsx("Web stats", [["Day", "Visitors"], ["Mon", 120], ["Tue", 135], ["Wed", 160]], xml);
    const [v] = office(bytes);
    expect(v!.sheet).toBe("Web stats");
    expect(v!.generator).toBe("excel");
    const s = spec(v!);
    expect(s.series[0]!.points).toEqual([{ x: "Mon", y: 120 }, { x: "Tue", y: 135 }, { x: "Wed", y: 160 }]);
    expect(v!.confidence).toBeGreaterThan(0.9);
    expect(v!.confidence).toBeLessThan(0.98);
  });

  it("drops a series whose cache is missing and cannot be resolved, lowering confidence", () => {
    const xml = chartXml({ plots: [barPlot([{ name: "Known", cats: Q, vals: [1, 2, 3, 4] }, { name: "Lost", cats: Q, vals: [], noCache: true, valRef: "Elsewhere!$C$2:$C$5" }])] });
    const [v] = office(docx([xml]));
    expect(spec(v!).series.map((s) => s.name)).toEqual(["Known"]);
    expect(v!.reason).toBe("series-cache-missing");
    expect(v!.confidence).toBeLessThan(0.9);
    const none = parseChartXml(chartXml({ plots: [barPlot([{ name: "Lost", cats: Q, vals: [], noCache: true }])] }));
    expect(none.spec).toBeNull();
  });

  it("turns NaN / Infinity / garbage values into gaps and flags them", () => {
    const xml = chartXml({ plots: [barPlot([{ name: "Odd", cats: ["a", "b", "c", "d", "e"], vals: ["NaN", "INF", "1e999", "abc", 5] }])] });
    const [v] = office(docx([xml]));
    expect(spec(v!).series[0]!.points.map((p) => p.y)).toEqual([null, null, null, null, 5]);
    expect(v!.reason).toBe("non-finite-values");
    expect(v!.confidence).toBeLessThan(0.7);
  });

  it("pads mismatched category / value lengths with gaps", () => {
    const xml = chartXml({ plots: [linePlot([{ name: "Short", cats: ["a", "b", "c", "d"], vals: [1, 2] }])] });
    const [v] = office(docx([xml]));
    expect(spec(v!).series[0]!.points).toEqual([{ x: "a", y: 1 }, { x: "b", y: 2 }, { x: "c", y: null }, { x: "d", y: null }]);
    expect(v!.reason).toBe("series-length-mismatch");
  });

  it("keeps malicious labels as plain, length-capped strings", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const xml = chartXml({ title: `${evil}‮]]>`, plots: [barPlot([{ name: "__proto__", cats: [evil, "x".repeat(5000), "constructor"], vals: [1, 2, 3] }])] });
    const [v] = office(docx([xml]));
    const s = spec(v!);
    expect(s.title).toBe(`${evil}]]>`);
    expect(s.series[0]!.name).toBe("__proto__");
    expect(s.series[0]!.points[0]!.x).toBe(evil);
    expect((s.series[0]!.points[1]!.x as string).length).toBe(200);
    expect(Object.getPrototypeOf(s.series[0])).toBe(Object.prototype);
  });

  it("caps hostile point counts and series counts", () => {
    const many = Array.from({ length: 40 }, (_, k) => ({ name: `S${k}`, cats: ["a"], vals: [k] }));
    const [v] = office(docx([chartXml({ plots: [barPlot(many)] })]));
    expect(spec(v!).series).toHaveLength(32);
    expect(v!.reason).toBe("truncated");
    const hugePtCount = chartXml({ plots: [barPlot([{ name: "x", cats: ["a"], vals: [1] }])] }).replace(/<c:ptCount val="1"\/>/g, "<c:ptCount val=\"999999999\"/>");
    const parsed = parseChartXml(hugePtCount);
    expect(parsed.spec!.series[0]!.points.length).toBeLessThanOrEqual(20_000);
    expect(finalizeChart(parsed.spec!).spec!.series[0]!.points.length).toBe(2000);
  });

  it("returns nothing for a package without chart parts", () => {
    expect(office(docx([]))).toEqual([]);
  });
});
