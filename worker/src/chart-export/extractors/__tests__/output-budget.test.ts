// Output bounds (council r9 H1): one chart is bounded in points and serialized bytes (cut, kept, `truncated`), and one
// input's visuals are bounded in bytes (later visuals counted as `output-limit`, never thrown).
import { describe, expect, it } from "vitest";

import { extractDeterministicVisuals } from "../index.js";
import { CHART_EXTRACT_LIMITS } from "../limits.js";
import { finalizeChart, utf8Bytes } from "../spec-utils.js";
import { barPlot, chartXml, sheetXml, zip } from "./fixtures.js";

const L = CHART_EXTRACT_LIMITS;

/** The council's amplification XLSX: `parts` chart parts, each with 32 series over one shared N-row label range. */
export function ampXlsx(parts: number, labels: "cjk" | "ascii" | "date", rows: number): Uint8Array {
  const label = (i: number) => labels === "cjk"
    ? Array.from({ length: 200 }, (_, k) => String.fromCharCode(0x4e00 + ((i * 7919 + k * 104729) % 20000))).join("")
    : labels === "date" ? new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
    : (`L${i}-` + "abcdefghij".repeat(20)).slice(0, 200);
  const sheetRows: Array<Array<string | number | null>> = [["Cat", "Val"], ...Array.from({ length: rows }, (_, i) => [label(i), i])];
  const series = Array.from({ length: 32 }, (_, i) => ({ name: `S${i}`, cats: [], vals: [], noCache: true, catRef: `Sheet1!$A$2:$A$${rows + 1}`, valRef: `Sheet1!$B$2:$B$${rows + 1}` }));
  const chart = chartXml({ title: "amp", plots: [barPlot(series)] });
  const shared: string[] = [];
  const files: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "xl/workbook.xml": '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": sheetXml(sheetRows, shared),
  };
  files["xl/sharedStrings.xml"] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
  for (let p = 1; p <= parts; p++) files[`xl/charts/chart${p}.xml`] = chart;
  return zip(files);
}

describe("per-chart output bound", () => {
  it("cuts a chart past maxChartPoints / maxChartBytes, keeps it, and marks it truncated", () => {
    const label = (i: number) => "图".repeat(199) + String(i % 10);
    const draft = { chartType: "bar" as const, series: Array.from({ length: 32 }, (_, s) => ({ name: `S${s}`, points: Array.from({ length: 2000 }, (_, i) => ({ x: label(i), y: i })) })) };
    const fin = finalizeChart(draft);
    expect(fin.truncated).toBe(true);
    expect(fin.spec).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(fin.spec))).toBeLessThanOrEqual(L.maxChartBytes);
    // Unbounded this was 64,000 points of 600 UTF-8 bytes each: 39 MB.
    const points = fin.spec!.series.reduce((n, s) => n + s.points.length, 0);
    expect(points).toBeLessThanOrEqual(L.maxChartPoints);
    expect(points).toBeGreaterThan(0);
  });

  it("leaves ordinary charts unchanged", () => {
    const draft = { chartType: "line" as const, series: [{ name: "Revenue", points: Array.from({ length: 365 }, (_, i) => ({ x: `2026-01-${i}`, y: i })) }] };
    const fin = finalizeChart(draft);
    expect(fin.truncated).toBe(false);
    expect(fin.spec!.series[0]!.points).toHaveLength(365);
  });

  it("counts UTF-8 bytes like Buffer.byteLength", () => {
    for (const s of ["", "abc", "é", "图", "😀", "\ud800", "a\udc00b", "图😀é a"]) expect(utf8Bytes(s)).toBe(Buffer.byteLength(s));
  });
});

describe("per-input output bound", () => {
  it("one amplification chart (the council's 85 KB CJK XLSX) becomes one bounded, truncated chart", () => {
    const r = extractDeterministicVisuals({ kind: "office", bytes: ampXlsx(1, "cjk", 2000) });
    expect(r.visuals).toHaveLength(1);
    expect(r.visuals[0]!.reason).toBe("truncated");
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(L.maxChartBytes + 64 * 1024);
  });

  it("past the input's output budget, later charts are counted as output-limit and the result stays bounded", () => {
    // 4 truncated amplification charts (~0.5 MB each) against a 1.2 MB budget: 2 kept, 2 counted.
    const r = extractDeterministicVisuals({ kind: "office", bytes: ampXlsx(4, "ascii", 2000) }, { outputBudget: 1.2 * 1024 * 1024 });
    expect(r.visuals.length).toBe(2);
    expect(r.deferred).toEqual([{ svgIndex: 0, count: 2, reason: "output-limit" }]);
    const visualBytes = r.visuals.reduce((n, v) => n + Buffer.byteLength(JSON.stringify(v)), 0);
    expect(visualBytes).toBeLessThanOrEqual(1.2 * 1024 * 1024);
  });
});
