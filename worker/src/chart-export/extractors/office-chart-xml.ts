import { CHART_EXTRACT_LIMITS, ExtractLimitError, pastGuestDeadline, refusalReason } from "./limits.js";
import { openZipPackage, resolvePartPath, type ZipPackage } from "./safe-zip.js";
import { clamp01, finalizeChart, type DraftChart, type DraftSeries } from "./spec-utils.js";
import { cleanLabel, finiteOrNull } from "./text.js";
import { emptyVisual, type DeterministicRefusal, type DeterministicVisual } from "./types.js";
import { descendants, elementChildren, firstChild, parseXml, path, rootElement, textContent, type XmlElement } from "./xml.js";

/*
 * Rung 1 (`office-chart-xml`): DrawingML chart parts in DOCX (`word/charts/`), PPTX (`ppt/charts/`) and XLSX
 * (`xl/charts/`). The parts carry each series' cached values, so the result is exact. When a cache is missing, the series
 * formula is resolved against the workbook (XLSX itself, or the chart's embedded workbook in DOCX/PPTX); when that fails
 * the series is dropped and confidence lowered.
 */

type CellValue = string | number | null;
export type RefResolver = (formula: string) => CellValue[] | null;

const PLOT_KINDS = new Set([
  "barChart", "bar3DChart", "lineChart", "line3DChart", "stockChart", "areaChart", "area3DChart", "pieChart", "pie3DChart",
  "ofPieChart", "doughnutChart", "scatterChart", "bubbleChart", "radarChart",
]);
const CHART_PART = /^(word|ppt|xl)\/charts\/chart[0-9]{1,6}\.xml$/;

interface AxisInfo { id: string; kind: string; title: string | null; pos: string | null; log: boolean; min: number | null; max: number | null; deleted: boolean; formatCode: string | null }
interface DataRead { values: CellValue[]; formatCode: string | null; resolved: boolean; missing: boolean }

const val = (el: XmlElement | null): string | null => (el ? el.attrs.val ?? null : null);

function richText(el: XmlElement | null): string | null {
  if (!el) return null;
  const tx = firstChild(el, "tx");
  const rich = firstChild(tx, "rich");
  if (rich) {
    const paras = descendants(rich, "p").map((p) => descendants(p, "t").map((t) => textContent(t)).join("")).filter((s) => s.trim() !== "");
    const s = cleanLabel(paras.join(" "));
    return s || null;
  }
  const cache = path(tx, "strRef", "strCache");
  if (cache) {
    const s = cleanLabel(elementChildren(cache, "pt").map((pt) => textContent(firstChild(pt, "v"))).join(" "));
    return s || null;
  }
  return null;
}

function readCache(cache: XmlElement, numeric: boolean): CellValue[] {
  const declared = Number(val(firstChild(cache, "ptCount")) ?? "0");
  const pts = elementChildren(cache, "pt");
  let maxIdx = -1;
  for (const pt of pts) { const idx = Number(pt.attrs.idx); if (Number.isSafeInteger(idx) && idx >= 0) maxIdx = Math.max(maxIdx, idx); }
  const count = Math.min(Math.max(Number.isSafeInteger(declared) && declared > 0 ? declared : 0, maxIdx + 1), CHART_EXTRACT_LIMITS.maxPathVertices);
  const out: CellValue[] = new Array(count).fill(null);
  for (const pt of pts) {
    const idx = Number(pt.attrs.idx);
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= count) continue;
    const raw = textContent(firstChild(pt, "v"));
    out[idx] = numeric ? finiteOrNull(raw) ?? raw : raw; // non-finite text kept so the caller can count it
  }
  return out;
}

function readData(el: XmlElement | null, resolve: RefResolver | null): DataRead | null {
  if (!el) return null;
  for (const ref of elementChildren(el)) {
    const numeric = ref.local === "numRef" || ref.local === "numLit";
    if (ref.local === "numLit" || ref.local === "strLit") {
      return { values: readCache(ref, numeric), formatCode: textContent(firstChild(ref, "formatCode")) || null, resolved: false, missing: false };
    }
    if (ref.local === "numRef" || ref.local === "strRef" || ref.local === "multiLvlStrRef") {
      const cache = firstChild(ref, ref.local === "numRef" ? "numCache" : ref.local === "strRef" ? "strCache" : "multiLvlStrCache");
      if (cache) {
        // multi-level categories: the first level is the innermost (leaf) label.
        const source = ref.local === "multiLvlStrRef" ? firstChild(cache, "lvl") : cache;
        if (source) {
          const values = readCache(source, numeric);
          if (ref.local === "multiLvlStrRef") values.length = Math.max(values.length, Number(val(firstChild(cache, "ptCount")) ?? 0) || 0);
          return { values, formatCode: textContent(firstChild(cache, "formatCode")) || null, resolved: false, missing: false };
        }
      }
      const formula = textContent(firstChild(ref, "f")).trim();
      const resolved = formula && resolve ? resolve(formula) : null;
      if (resolved) return { values: numeric ? resolved.map((v) => finiteOrNull(typeof v === "number" ? v : v ?? "")) : resolved, formatCode: null, resolved: true, missing: false };
      return { values: [], formatCode: null, resolved: false, missing: true };
    }
  }
  const direct = firstChild(el, "v");
  if (direct) return { values: [textContent(direct)], formatCode: null, resolved: false, missing: false };
  return null;
}

function unitFromFormat(code: string | null): { unit: string | null; percent: boolean } {
  if (!code) return { unit: null, percent: false };
  const stripped = code.replace(/"[^"]*"|\\./g, "");
  if (/%/.test(stripped)) return { unit: "%", percent: true };
  const cur = /[$€£¥₹]/.exec(code);
  return { unit: cur ? cur[0] : null, percent: false };
}

function isDateFormat(code: string | null): boolean {
  return !!code && /(^|[^"\\])[dmy]{1,4}/i.test(code.replace(/"[^"]*"/g, "")) && !/0\.0/.test(code);
}

function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

function readAxes(plotArea: XmlElement): Map<string, AxisInfo> {
  const axes = new Map<string, AxisInfo>();
  for (const el of elementChildren(plotArea)) {
    if (!["catAx", "valAx", "dateAx", "serAx"].includes(el.local)) continue;
    const id = val(firstChild(el, "axId"));
    if (!id) continue;
    const scaling = firstChild(el, "scaling");
    axes.set(id, {
      id,
      kind: el.local,
      title: richText(firstChild(el, "title")),
      pos: val(firstChild(el, "axPos")),
      log: !!firstChild(scaling, "logBase"),
      min: finiteOrNull(val(firstChild(scaling, "min")) ?? ""),
      max: finiteOrNull(val(firstChild(scaling, "max")) ?? ""),
      deleted: val(firstChild(el, "delete")) === "1",
      formatCode: firstChild(el, "numFmt")?.attrs.formatCode ?? null,
    });
  }
  return axes;
}

interface PlotRead { local: string; mark: DraftSeries["mark"]; series: DraftSeries[]; valAxis: AxisInfo | null; catAxis: AxisInfo | null; grouping: string | null; barDir: string | null; holeOrStyle: string | null }

export interface ChartXmlResult { spec: DraftChart | null; confidence: number; reason: string | null }

/** Parse one chart part. `resolve` looks up `Sheet!$A$1:$A$5` formulas when a series has no cached values. */
export function parseChartXml(xml: string, resolve: RefResolver | null = null): ChartXmlResult {
  const root = rootElement(parseXml(xml));
  if (!root || root.local !== "chartSpace") return { spec: null, confidence: 0, reason: "not-a-chart-part" };
  const chart = firstChild(root, "chart");
  const plotArea = firstChild(chart, "plotArea");
  if (!chart || !plotArea) return { spec: null, confidence: 0, reason: "no-plot-area" };
  const axes = readAxes(plotArea);
  const plotEls = elementChildren(plotArea).filter((el) => PLOT_KINDS.has(el.local));
  if (!plotEls.length) return { spec: null, confidence: 0, reason: elementChildren(plotArea).some((el) => /Chart$/.test(el.local)) ? "unsupported-plot-type" : "no-plot" };

  let penalty = 0;
  let resolvedAny = false;
  let missingSeries = 0;
  let totalSeries = 0;
  let nonFinite = 0;
  let totalPoints = 0;
  let mismatched = false;
  const plots: PlotRead[] = [];
  let firstFormat: string | null = null;

  for (const plotEl of plotEls) {
    const axIds = elementChildren(plotEl, "axId").map((a) => val(a)).filter((v): v is string => !!v);
    const plotAxes = axIds.map((id) => axes.get(id)).filter((a): a is AxisInfo => !!a);
    const xyPlot = plotEl.local === "scatterChart" || plotEl.local === "bubbleChart";
    let catAxis = plotAxes.find((a) => a.kind === "catAx" || a.kind === "dateAx") ?? null;
    let valAxis = plotAxes.find((a) => a.kind === "valAx") ?? null;
    if (xyPlot) {
      const vals = plotAxes.filter((a) => a.kind === "valAx");
      catAxis = vals.find((a) => a.pos === "b" || a.pos === "t") ?? vals[0] ?? null;
      valAxis = vals.find((a) => a !== catAxis) ?? null;
    }
    const mark: DraftSeries["mark"] = /^bar/.test(plotEl.local) ? "bar" : /^(line|stock)/.test(plotEl.local) ? "line" : /^area/.test(plotEl.local) ? "area" : xyPlot ? "point" : null;
    const read: PlotRead = {
      local: plotEl.local, mark, series: [], valAxis, catAxis,
      grouping: val(firstChild(plotEl, "grouping")), barDir: val(firstChild(plotEl, "barDir")),
      holeOrStyle: val(firstChild(plotEl, "holeSize")),
    };
    for (const ser of elementChildren(plotEl, "ser")) {
      if (++totalSeries > 64) { penalty += 0.1; break; }
      const name = (() => {
        const tx = readData(firstChild(ser, "tx"), resolve);
        const s = tx?.values.map((v) => (v === null ? "" : String(v))).join(" ") ?? "";
        return cleanLabel(s) || `Series ${totalSeries}`;
      })();
      const cats = readData(firstChild(ser, xyPlot ? "xVal" : "cat"), resolve);
      const vals = readData(firstChild(ser, xyPlot ? "yVal" : "val"), resolve);
      const sizes = plotEl.local === "bubbleChart" ? readData(firstChild(ser, "bubbleSize"), resolve) : null;
      if (!vals || vals.missing || !vals.values.length) { missingSeries++; continue; }
      if (vals.resolved || cats?.resolved) resolvedAny = true;
      firstFormat ??= vals.formatCode;
      const { percent } = unitFromFormat(vals.formatCode);
      const catValues = cats && !cats.missing ? cats.values : [];
      if (catValues.length && catValues.length !== vals.values.length) mismatched = true;
      const dateCats = catAxis?.kind === "dateAx" || isDateFormat(cats?.formatCode ?? null);
      const n = Math.max(vals.values.length, catValues.length);
      const points: DraftSeries["points"] = [];
      for (let k = 0; k < n; k++) {
        const rawY = vals.values[k];
        totalPoints++;
        let y = typeof rawY === "number" ? rawY : rawY === null || rawY === undefined ? null : finiteOrNull(rawY);
        if (rawY !== null && rawY !== undefined && y === null) nonFinite++;
        if (y !== null && percent) y = Number((y * 100).toPrecision(12));
        const rawX = catValues[k];
        let x: string | number;
        if (rawX === null || rawX === undefined || rawX === "") x = xyPlot ? k + 1 : String(k + 1);
        else if (typeof rawX === "number") x = dateCats && !xyPlot ? excelSerialToDate(rawX) ?? rawX : xyPlot ? rawX : String(rawX);
        else x = xyPlot ? finiteOrNull(rawX) ?? cleanLabel(rawX) : cleanLabel(rawX);
        if (!xyPlot && typeof x === "number") x = String(x);
        const point: DraftSeries["points"][number] = { x, y };
        if (sizes) point.z = typeof sizes.values[k] === "number" ? (sizes.values[k] as number) : finiteOrNull(String(sizes.values[k] ?? ""));
        points.push(point);
      }
      read.series.push({ name, mark, points });
    }
    plots.push(read);
  }

  const allSeries = plots.flatMap((p) => p.series);
  if (!allSeries.length) return { spec: null, confidence: 0, reason: missingSeries ? "series-cache-missing" : "no-series" };

  const primary = plots.find((p) => p.series.length) ?? plots[0]!;
  const primaryValId = primary.valAxis?.id ?? null;
  const combo = plots.filter((p) => p.series.length).length > 1;
  let y2: AxisInfo | null = null;
  for (const p of plots) {
    if (p.valAxis && primaryValId && p.valAxis.id !== primaryValId) {
      y2 = p.valAxis;
      for (const s of p.series) s.axis = "y2";
    }
  }
  const chartType = ((): DraftChart["chartType"] => {
    if (combo) return "combo";
    const p = primary;
    switch (p.local) {
      case "barChart": case "bar3DChart":
        if (p.barDir === "bar") return "horizontal-bar";
        if (p.grouping === "stacked" || p.grouping === "percentStacked") return "stacked-bar";
        return p.series.length > 1 ? "grouped-bar" : "bar";
      case "areaChart": case "area3DChart":
        return p.grouping === "stacked" || p.grouping === "percentStacked" ? "stacked-area" : "area";
      case "pieChart": case "pie3DChart": case "ofPieChart": return "pie";
      case "doughnutChart": return "donut";
      case "scatterChart": return "scatter";
      case "bubbleChart": return "bubble";
      case "radarChart": return "radar";
      default: return "line";
    }
  })();
  if (!combo) for (const s of allSeries) s.mark = null;

  const autoTitleDeleted = val(firstChild(chart, "autoTitleDeleted")) === "1";
  const titleEl = firstChild(chart, "title");
  let title = richText(titleEl);
  if (!title && !autoTitleDeleted && allSeries.length === 1 && (titleEl || ["pie", "donut"].includes(chartType))) title = allSeries[0]!.name;

  const unit = unitFromFormat(firstFormat ?? primary.valAxis?.formatCode ?? null).unit;
  const xyPlot = chartType === "scatter" || chartType === "bubble";
  const draft: DraftChart = {
    chartType,
    title,
    xAxis: {
      label: primary.catAxis?.title ?? null,
      scale: xyPlot ? (primary.catAxis?.log ? "log" : "linear") : primary.catAxis?.kind === "dateAx" ? "time" : "band",
      min: xyPlot ? primary.catAxis?.min ?? null : null,
      max: xyPlot ? primary.catAxis?.max ?? null : null,
    },
    yAxis: { label: primary.valAxis?.title ?? null, unit, scale: primary.valAxis?.log ? "log" : "linear", min: primary.valAxis?.min ?? null, max: primary.valAxis?.max ?? null },
    y2Axis: y2 ? { label: y2.title, scale: y2.log ? "log" : "linear", min: y2.min, max: y2.max } : null,
    series: allSeries,
  };

  if (resolvedAny) penalty += 0.04;
  if (mismatched) penalty += 0.08;
  if (missingSeries) penalty += 0.3 * (missingSeries / Math.max(1, totalSeries));
  if (totalPoints) penalty += 0.4 * (nonFinite / totalPoints);
  return { spec: draft, confidence: clamp01(0.98 - penalty), reason: missingSeries ? "series-cache-missing" : mismatched ? "series-length-mismatch" : nonFinite ? "non-finite-values" : null };
}

// ---- Workbook formula resolution ----------------------------------------------------------------------------------

function colIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function relsMap(pkg: ZipPackage, relsPath: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  if (!pkg.names.includes(relsPath)) return out;
  const root = rootElement(parseXml(pkg.readText(relsPath)));
  for (const r of root ? elementChildren(root, "Relationship") : []) {
    if (r.attrs.Id && r.attrs.Target && r.attrs.TargetMode !== "External") out.set(r.attrs.Id, { target: r.attrs.Target, type: r.attrs.Type ?? "" });
  }
  return out;
}

function relsPathFor(part: string): string {
  const dir = part.split("/").slice(0, -1).join("/");
  return `${dir ? `${dir}/` : ""}_rels/${part.split("/").pop()}.rels`;
}

/** A resolver over a workbook package's sheets. Caches parsed sheets; single row/column ranges only. */
export function workbookResolver(pkg: ZipPackage): RefResolver | null {
  if (!pkg.names.includes("xl/workbook.xml")) return null;
  const wb = rootElement(parseXml(pkg.readText("xl/workbook.xml")));
  if (!wb) return null;
  const rels = relsMap(pkg, "xl/_rels/workbook.xml.rels");
  const sheets = new Map<string, string>();
  for (const s of descendants(wb, "sheet")) {
    const rid = Object.entries(s.attrs).find(([k]) => k === "r:id" || k.endsWith(":id"))?.[1];
    const target = rid ? rels.get(rid)?.target : undefined;
    const part = target ? resolvePartPath("xl/workbook.xml", target) : null;
    if (s.attrs.name && part) sheets.set(s.attrs.name, part);
  }
  let shared: string[] | null = null;
  const sharedStrings = () => {
    if (shared) return shared;
    shared = [];
    if (pkg.names.includes("xl/sharedStrings.xml")) {
      const root = rootElement(parseXml(pkg.readText("xl/sharedStrings.xml")));
      for (const si of root ? elementChildren(root, "si") : []) shared.push(descendants(si, "t").map((t) => textContent(t)).join(""));
    }
    return shared;
  };
  const cache = new Map<string, Map<string, CellValue>>();
  const sheetCells = (part: string) => {
    let cells = cache.get(part);
    if (cells) return cells;
    cells = new Map();
    const root = rootElement(parseXml(pkg.readText(part)));
    for (const c of root ? descendants(root, "c") : []) {
      const ref = c.attrs.r;
      if (!ref) continue;
      const t = c.attrs.t;
      const v = textContent(firstChild(c, "v"));
      let value: CellValue = null;
      if (t === "s") value = sharedStrings()[Number(v)] ?? null;
      else if (t === "inlineStr") value = descendants(c, "t").map((x) => textContent(x)).join("");
      else if (t === "str" || t === "e") value = t === "e" ? null : v;
      else if (t === "b") value = v;
      else value = finiteOrNull(v);
      cells.set(ref, value);
    }
    cache.set(part, cells);
    return cells;
  };
  return (formula: string) => {
    const m = /^(?:'((?:[^']|'')+)'|([^!'()]+))!\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?$/.exec(formula.trim());
    if (!m) return null;
    const sheetName = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]!;
    const part = sheets.get(sheetName);
    if (!part || !pkg.names.includes(part)) return null;
    const c1 = colIndex(m[3]!), r1 = Number(m[4]);
    const c2 = m[5] ? colIndex(m[5]) : c1, r2 = m[6] ? Number(m[6]) : r1;
    if (c1 !== c2 && r1 !== r2) return null;
    const count = Math.abs(c2 - c1) + Math.abs(r2 - r1) + 1;
    if (count > 2000) return null;
    let cells: Map<string, CellValue>;
    try { cells = sheetCells(part); } catch { return null; }
    const out: CellValue[] = [];
    for (let k = 0; k < count; k++) {
      const col = c1 === c2 ? c1 : Math.min(c1, c2) + k;
      const row = r1 === r2 ? r1 : Math.min(r1, r2) + k;
      let name = "";
      for (let x = col; x > 0; x = Math.floor((x - 1) / 26)) name = String.fromCharCode(65 + ((x - 1) % 26)) + name;
      out.push(cells.get(`${name}${row}`) ?? null);
    }
    return out;
  };
}

// ---- Package entry --------------------------------------------------------------------------------------------------

function slideOfChart(pkg: ZipPackage): Map<string, number> {
  const out = new Map<string, number>();
  for (const name of pkg.names) {
    const m = /^ppt\/slides\/_rels\/slide([0-9]{1,6})\.xml\.rels$/.exec(name);
    if (!m) continue;
    try {
      for (const { target } of relsMap(pkg, name).values()) {
        const part = resolvePartPath(`ppt/slides/slide${m[1]}.xml`, target);
        if (part && CHART_PART.test(part) && !out.has(part)) out.set(part, Number(m[1]));
      }
    } catch { /* a broken rels file only loses the slide number */ }
  }
  return out;
}

function sheetOfChart(pkg: ZipPackage): Map<string, string> {
  const out = new Map<string, string>();
  try {
    if (!pkg.names.includes("xl/workbook.xml")) return out;
    const wb = rootElement(parseXml(pkg.readText("xl/workbook.xml")));
    const rels = relsMap(pkg, "xl/_rels/workbook.xml.rels");
    for (const s of wb ? descendants(wb, "sheet") : []) {
      const rid = Object.entries(s.attrs).find(([k]) => k.endsWith(":id"))?.[1];
      const sheetPart = rid && rels.get(rid) ? resolvePartPath("xl/workbook.xml", rels.get(rid)!.target) : null;
      if (!sheetPart || !s.attrs.name) continue;
      for (const { target } of relsMap(pkg, relsPathFor(sheetPart)).values()) {
        const drawing = resolvePartPath(sheetPart, target);
        if (!drawing || !/^xl\/drawings\/drawing[0-9]+\.xml$/.test(drawing)) continue;
        for (const r of relsMap(pkg, relsPathFor(drawing)).values()) {
          const chart = resolvePartPath(drawing, r.target);
          if (chart && CHART_PART.test(chart) && !out.has(chart)) out.set(chart, cleanLabel(s.attrs.name));
        }
      }
    }
  } catch { /* sheet names are informational */ }
  return out;
}

/** Chart parts of an OOXML package (DOCX/PPTX/XLSX bytes). Nested embedded workbooks are opened one level deep. */
export function extractOfficeCharts(bytes: Uint8Array): { visuals: DeterministicVisual[]; refusals: DeterministicRefusal[]; pkg: ZipPackage; partsDropped: number; deadlineParts: number } {
  const pkg = openZipPackage(bytes);
  const parts = pkg.names.filter((n) => CHART_PART.test(n)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const visuals: DeterministicVisual[] = [];
  const refusals: DeterministicRefusal[] = [];
  if (!parts.length) return { visuals, refusals, pkg, partsDropped: 0, deadlineParts: 0 };
  // Chart parts past the package cap are counted by the caller (package-part-limit), never silently skipped.
  const partsDropped = Math.max(0, parts.length - CHART_EXTRACT_LIMITS.maxPartsPerPackage);
  let deadlineParts = 0;
  const slides = slideOfChart(pkg);
  const sheets = sheetOfChart(pkg);
  let ownResolver: RefResolver | null | undefined;
  const kept = parts.slice(0, CHART_EXTRACT_LIMITS.maxPartsPerPackage);
  for (const [p, part] of kept.entries()) {
    if (pastGuestDeadline()) { deadlineParts = kept.length - p; break; }
    try {
      const resolver: RefResolver = (formula) => {
        if (ownResolver === undefined) { try { ownResolver = workbookResolver(pkg); } catch { ownResolver = null; } }
        const own = ownResolver?.(formula);
        if (own) return own;
        return embeddedWorkbookResolver(pkg, part)?.(formula) ?? null;
      };
      const result = parseChartXml(pkg.readText(part), resolver);
      const v = emptyVisual("office-chart-xml", part);
      v.generator = part.startsWith("xl/") ? "excel" : part.startsWith("ppt/") ? "powerpoint" : "word";
      v.slide = slides.get(part) ?? null;
      v.sheet = sheets.get(part) ?? null;
      v.reason = result.reason;
      if (result.spec) {
        const fin = finalizeChart(result.spec);
        v.spec = fin.spec;
        v.confidence = fin.spec ? clamp01(result.confidence - (fin.truncated ? 0.1 : 0)) : 0;
        v.reason = fin.reason ?? (fin.truncated ? "truncated" : result.reason);
      }
      visuals.push(v);
    } catch (error) {
      refusals.push({ locator: part, reason: refusalReason(error) });
    }
  }
  if (parts.length > CHART_EXTRACT_LIMITS.maxPartsPerPackage) refusals.push({ locator: "package", reason: "chart-part-limit" });
  return { visuals, refusals, pkg, partsDropped, deadlineParts };
}

const embeddedCache = new WeakMap<ZipPackage, Map<string, RefResolver | null>>();
function embeddedWorkbookResolver(pkg: ZipPackage, chartPart: string): RefResolver | null {
  let byPart = embeddedCache.get(pkg);
  if (!byPart) { byPart = new Map(); embeddedCache.set(pkg, byPart); }
  if (byPart.has(chartPart)) return byPart.get(chartPart)!;
  let resolver: RefResolver | null = null;
  try {
    const root = rootElement(parseXml(pkg.readText(chartPart)));
    const ext = root ? firstChild(root, "externalData") : null;
    const rid = ext ? Object.entries(ext.attrs).find(([k]) => k.endsWith(":id"))?.[1] : undefined;
    const target = rid ? relsMap(pkg, relsPathFor(chartPart)).get(rid)?.target : undefined;
    const embedded = target ? resolvePartPath(chartPart, target) : null;
    if (embedded && /\.xlsx$/i.test(embedded) && pkg.names.includes(embedded)) {
      resolver = workbookResolver(openZipPackage(pkg.read(embedded)));
    }
  } catch (error) {
    if (!(error instanceof ExtractLimitError)) resolver = null;
  }
  byPart.set(chartPart, resolver);
  return resolver;
}
