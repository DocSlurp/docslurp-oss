import { CHART_EXTRACT_LIMITS } from "./limits.js";
import { clamp01, finalizeChart, type DraftChart, type DraftSeries } from "./spec-utils.js";
import { cleanLabel, finiteOrNull } from "./text.js";
import { decodeEntities } from "./xml.js";

/*
 * Rung 2 (`embedded-spec`): Vega-Lite / Vega / Plotly JSON embedded in HTML, XHTML (EPUB) or SVG. Only JSON is read:
 * candidate `{...}` / `[...]` regions are cut out of script bodies with a string-aware bracket scanner and handed to
 * `JSON.parse`. No script is evaluated, no URL (data.url, src) is fetched. A spec with no inline data yields null.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export interface EmbeddedSpecHit {
  locator: string;
  generator: "vega-lite" | "vega" | "plotly";
  spec: DraftChart | null;
  confidence: number;
  reason: string | null;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const own = (o: Obj, k: string): Json | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function depthOk(value: Json): boolean {
  const stack: Array<[Json, number]> = [[value, 0]];
  let visited = 0;
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (d > CHART_EXTRACT_LIMITS.maxJsonDepth || ++visited > 2_000_000) return false;
    if (Array.isArray(v)) for (const c of v) stack.push([c, d + 1]);
    else if (isObj(v)) for (const k of Object.keys(v)) stack.push([v[k]!, d + 1]);
  }
  return true;
}

export function safeJsonParse(text: string): Json | undefined {
  if (text.length > CHART_EXTRACT_LIMITS.maxJsonBytes) return undefined;
  try {
    const v = JSON.parse(text) as Json;
    return depthOk(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Top-level `{...}` and `[...]` regions in a script body (string- and comment-aware), in order. */
export function jsonRegions(body: string, max: number = CHART_EXTRACT_LIMITS.maxJsonCandidates): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  let depth = 0;
  let start = -1;
  let quote = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && body[i + 1] === "/" && depth === 0) { const e = body.indexOf("\n", i); i = e < 0 ? body.length : e; continue; }
    if (c === "/" && body[i + 1] === "*") { const e = body.indexOf("*/", i + 2); i = e < 0 ? body.length : e + 1; continue; }
    if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
      if (depth > CHART_EXTRACT_LIMITS.maxJsonDepth * 4) return out;
    } else if (c === "}" || c === "]") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        if (i + 1 - start <= CHART_EXTRACT_LIMITS.maxJsonBytes) out.push({ start, text: body.slice(start, i + 1) });
        start = -1;
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

// ---- Vega-Lite ----------------------------------------------------------------------------------------------------

function isVegaSchema(o: Obj, kind: "vega-lite" | "vega"): boolean {
  const s = str(own(o, "$schema")) ?? "";
  return kind === "vega-lite" ? /vega\.github\.io\/schema\/vega-lite\//.test(s) : /vega\.github\.io\/schema\/vega\/v/.test(s);
}

function looksVegaLite(o: Obj): boolean {
  return isVegaSchema(o, "vega-lite") || ((own(o, "mark") !== undefined || Array.isArray(own(o, "layer"))) && (isObj(own(o, "encoding")) || Array.isArray(own(o, "layer"))) && own(o, "data") !== undefined);
}

function titleText(t: Json | undefined): string | null {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.filter((x) => typeof x === "string").join(" ");
  if (isObj(t)) return titleText(own(t, "text"));
  return null;
}

interface Channel { field: string; type: string | null; title: string | null; aggregate: string | null; scaleType: string | null; stack: Json | undefined }
function channel(enc: Obj | null, name: string): Channel | null {
  const c = enc ? own(enc, name) : undefined;
  if (!isObj(c)) return null;
  const field = str(own(c, "field"));
  const aggregate = str(own(c, "aggregate"));
  if (!field && aggregate !== "count") return null;
  const axis = own(c, "axis");
  const scale = own(c, "scale");
  return {
    field: field ?? "__count",
    type: str(own(c, "type")),
    title: titleText(own(c, "title")) ?? (isObj(axis) ? titleText(own(axis, "title")) : null) ?? field,
    aggregate,
    scaleType: isObj(scale) ? str(own(scale, "type")) : null,
    stack: own(c, "stack"),
  };
}

function vlValues(spec: Obj, root: Obj): Obj[] | null {
  const data = own(spec, "data") ?? own(root, "data");
  if (!isObj(data)) return null;
  const values = own(data, "values");
  if (Array.isArray(values)) return values.filter(isObj);
  const name = str(own(data, "name"));
  const datasets = own(root, "datasets");
  if (name && isObj(datasets)) {
    const set = own(datasets, name);
    if (Array.isArray(set)) return set.filter(isObj);
  }
  return null;
}

function markType(m: Json | undefined): { type: string | null; innerRadius: boolean } {
  if (typeof m === "string") return { type: m, innerRadius: false };
  if (isObj(m)) return { type: str(own(m, "type")), innerRadius: (finiteOrNull(own(m, "innerRadius") as number) ?? 0) > 0 };
  return { type: null, innerRadius: false };
}

function cellKey(v: Json | undefined): string | number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  return null;
}

function aggregate(rows: Obj[], xField: string | null, yField: string, seriesField: string | null, agg: string | null) {
  const groups = new Map<string, { x: string | number; series: string; values: number[]; count: number }>();
  for (const row of rows) {
    const x = xField ? cellKey(own(row, xField)) : "";
    if (x === null) continue;
    const series = seriesField ? String(cellKey(own(row, seriesField)) ?? "") : "";
    const key = JSON.stringify([x, series]);
    let g = groups.get(key);
    if (!g) { g = { x, series, values: [], count: 0 }; groups.set(key, g); }
    g.count++;
    const y = finiteOrNull(own(row, yField) as number | string);
    if (y !== null) g.values.push(y);
  }
  return [...groups.values()].map((g) => {
    let y: number | null;
    switch (agg) {
      case null: case undefined: y = g.values.length ? g.values[g.values.length - 1]! : null; break;
      case "sum": y = g.values.reduce((a, b) => a + b, 0); break;
      case "mean": case "average": y = g.values.length ? g.values.reduce((a, b) => a + b, 0) / g.values.length : null; break;
      case "count": y = g.count; break;
      case "min": y = g.values.length ? Math.min(...g.values) : null; break;
      case "max": y = g.values.length ? Math.max(...g.values) : null; break;
      case "median": { const s = [...g.values].sort((a, b) => a - b); y = s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : null; break; }
      default: y = null;
    }
    return { x: g.x, series: g.series, y };
  });
}

interface LayerResult { series: DraftSeries[]; chartType: DraftChart["chartType"]; xTitle: string | null; yTitle: string | null; xScale: "band" | "linear" | "log" | "time"; yScale: "linear" | "log"; dropped: number; aggregated: boolean; duplicates: boolean }

function vegaLiteLayer(spec: Obj, root: Obj, inheritedEnc: Obj | null): LayerResult | null {
  const rows = vlValues(spec, root);
  if (!rows || !rows.length) return null;
  const encOwn = own(spec, "encoding");
  const enc: Obj = { ...(inheritedEnc ?? {}), ...(isObj(encOwn) ? encOwn : {}) };
  const { type, innerRadius } = markType(own(spec, "mark"));
  if (!type) return null;
  if (type === "arc") {
    const theta = channel(enc, "theta");
    const color = channel(enc, "color");
    if (!theta || !color) return null;
    const agg = aggregate(rows, color.field, theta.field, null, theta.aggregate);
    return {
      series: [{ name: theta.title ?? theta.field, points: agg.map((a) => ({ x: String(a.x), y: a.y })) }],
      chartType: innerRadius ? "donut" : "pie", xTitle: color.title, yTitle: theta.title, xScale: "band", yScale: "linear", dropped: 0, aggregated: !!theta.aggregate, duplicates: false,
    };
  }
  let x = channel(enc, "x");
  let y = channel(enc, "y");
  if (!x || !y) return null;
  const quant = (c: Channel) => c.type === "quantitative" || (!!c.aggregate && c.type !== "nominal" && c.type !== "ordinal");
  let horizontal = false;
  if (type === "bar" && quant(x) && !quant(y)) { horizontal = true; [x, y] = [y, x]; }
  const color = channel(enc, "color") ?? channel(enc, "detail") ?? channel(enc, "strokeDash");
  const offset = channel(enc, "xOffset") ?? channel(enc, "yOffset");
  const seriesField = color && color.field !== x.field ? color.field : null;
  const agg = aggregate(rows, x.field, y.field, seriesField, y.aggregate);
  const duplicates = !y.aggregate && agg.length < rows.length;
  const bySeries = new Map<string, DraftSeries>();
  const xNumeric = x.type === "quantitative";
  const xTemporal = x.type === "temporal";
  for (const a of agg) {
    let s = bySeries.get(a.series);
    if (!s) { s = { name: a.series || y.title || y.field, points: [] }; bySeries.set(a.series, s); }
    s.points.push({ x: xNumeric && typeof a.x === "number" ? a.x : String(a.x), y: a.y });
  }
  const mark = type;
  let chartType: DraftChart["chartType"];
  if (mark === "bar") chartType = horizontal ? "horizontal-bar" : seriesField ? (offset || y.stack === null || y.stack === false ? "grouped-bar" : "stacked-bar") : "bar";
  else if (mark === "line" || mark === "trail") chartType = "line";
  else if (mark === "area") chartType = seriesField && y.stack !== null && y.stack !== false ? "stacked-area" : "area";
  else if (mark === "point" || mark === "circle" || mark === "square" || mark === "tick") chartType = channel(enc, "size") ? "bubble" : "scatter";
  else if (mark === "rect") chartType = "heatmap";
  else return null;
  if (chartType === "bubble") {
    const size = channel(enc, "size")!;
    const s: DraftSeries = { name: y.title ?? y.field, points: [] };
    for (const row of rows) {
      const xv = cellKey(own(row, x.field));
      if (xv === null) continue;
      s.points.push({ x: xv, y: finiteOrNull(own(row, y.field) as number), z: finiteOrNull(own(row, size.field) as number) });
    }
    bySeries.clear();
    bySeries.set("", s);
  }
  if (chartType === "heatmap") {
    const c = channel(enc, "color");
    if (!c) return null;
    const series = new Map<string, DraftSeries>();
    for (const row of rows) {
      const rowKey = String(cellKey(own(row, y.field)) ?? "");
      let s = series.get(rowKey);
      if (!s) { s = { name: rowKey, points: [] }; series.set(rowKey, s); }
      s.points.push({ x: String(cellKey(own(row, x.field)) ?? ""), y: finiteOrNull(own(row, c.field) as number) });
    }
    return { series: [...series.values()], chartType, xTitle: x.title, yTitle: y.title, xScale: "band", yScale: "linear", dropped: 0, aggregated: false, duplicates: false };
  }
  return {
    series: [...bySeries.values()].map((s) => ({ ...s, mark: mark === "bar" ? "bar" : mark === "line" || mark === "trail" ? "line" : mark === "area" ? "area" : "point" })),
    chartType,
    xTitle: x.title,
    yTitle: y.title,
    xScale: xTemporal ? "time" : xNumeric ? (x.scaleType === "log" ? "log" : "linear") : "band",
    yScale: y.scaleType === "log" ? "log" : "linear",
    dropped: 0,
    aggregated: !!y.aggregate,
    duplicates,
  };
}

export function vegaLiteToChart(root: Obj): { spec: DraftChart | null; confidence: number; reason: string | null } {
  for (const k of ["facet", "repeat", "hconcat", "vconcat", "concat"]) if (own(root, k) !== undefined) return { spec: null, confidence: 0, reason: "vega-lite-composition-unsupported" };
  const rootEnc = isObj(own(root, "encoding")) ? (own(root, "encoding") as Obj) : null;
  const layers = Array.isArray(own(root, "layer")) ? (own(root, "layer") as Json[]).filter(isObj) : [root];
  const results: LayerResult[] = [];
  for (const layer of layers.slice(0, 16)) {
    const r = vegaLiteLayer(layer, root, layer === root ? null : rootEnc);
    if (r) results.push(r);
  }
  if (!results.length) return { spec: null, confidence: 0, reason: vlValues(root, root) ? "vega-lite-unmapped" : "vega-lite-no-inline-data" };
  // Text/rule layers (labels, reference lines) are dropped; a layer that only repeats another layer's data is merged.
  const distinctTypes = new Set(results.map((r) => r.chartType));
  const combo = results.length > 1 && distinctTypes.size > 1;
  const first = results[0]!;
  const series = results.length > 1 ? (combo ? results.flatMap((r) => r.series) : first.series) : first.series;
  const draft: DraftChart = {
    chartType: combo ? "combo" : first.chartType,
    title: titleText(own(root, "title")),
    xAxis: { label: first.xTitle, scale: first.xScale },
    yAxis: { label: first.yTitle, scale: first.yScale },
    series: combo ? series : series.map((s) => ({ ...s, mark: null })),
    summary: str(own(root, "description")) ?? "",
  };
  let confidence = 0.97;
  if (first.duplicates) confidence -= 0.15;
  if (results.length < layers.length) confidence -= 0.05;
  return { spec: draft, confidence: clamp01(confidence), reason: first.duplicates ? "duplicate-x-values" : null };
}

// ---- Plotly -------------------------------------------------------------------------------------------------------

const DTYPES: Record<string, [number, (b: Buffer, o: number) => number]> = {
  f8: [8, (b, o) => b.readDoubleLE(o)], f4: [4, (b, o) => b.readFloatLE(o)],
  i1: [1, (b, o) => b.readInt8(o)], u1: [1, (b, o) => b.readUInt8(o)], u1c: [1, (b, o) => b.readUInt8(o)],
  i2: [2, (b, o) => b.readInt16LE(o)], u2: [2, (b, o) => b.readUInt16LE(o)],
  i4: [4, (b, o) => b.readInt32LE(o)], u4: [4, (b, o) => b.readUInt32LE(o)],
};

/** Plotly array: a plain array or a plotly.py typed-array (`{dtype, bdata}` base64). */
export function plotlyArray(v: Json | undefined): Array<string | number | null> | null {
  if (Array.isArray(v)) return v.slice(0, 20_000).map((x) => (typeof x === "number" ? (Number.isFinite(x) ? x : null) : typeof x === "string" ? x : null));
  if (isObj(v)) {
    const dtype = str(own(v, "dtype"));
    const bdata = str(own(v, "bdata"));
    const spec = dtype ? DTYPES[dtype] : undefined;
    if (!spec || !bdata || bdata.length > CHART_EXTRACT_LIMITS.maxJsonBytes) return null;
    const buf = Buffer.from(bdata, "base64");
    const [size, read] = spec;
    const n = Math.min(Math.floor(buf.length / size), 20_000);
    const out: Array<number | null> = [];
    for (let k = 0; k < n; k++) { const x = read(buf, k * size); out.push(Number.isFinite(x) ? x : null); }
    return out;
  }
  return null;
}

export function plotlyToChart(data: Json, layout: Json | undefined): { spec: DraftChart | null; confidence: number; reason: string | null } {
  const traces = (Array.isArray(data) ? data : []).filter(isObj).slice(0, 64);
  if (!traces.length) return { spec: null, confidence: 0, reason: "plotly-no-traces" };
  const lay = isObj(layout) ? layout : {};
  const series: DraftSeries[] = [];
  const kinds = new Set<string>();
  let skipped = 0;
  let pie: DraftChart["chartType"] | null = null;
  let horizontal = false;
  let y2 = false;
  let nonFinite = 0;
  let mismatch = false;
  for (const [i, t] of traces.entries()) {
    const type = str(own(t, "type")) ?? "scatter";
    const name = cleanLabel(str(own(t, "name")) ?? "") || `trace ${i}`;
    if (type === "pie") {
      const labels = plotlyArray(own(t, "labels")) ?? [];
      const values = plotlyArray(own(t, "values")) ?? [];
      if (!values.length) { skipped++; continue; }
      pie = (finiteOrNull(own(t, "hole") as number) ?? 0) > 0 ? "donut" : "pie";
      series.push({ name, points: values.map((v, k) => ({ x: String(labels[k] ?? k + 1), y: typeof v === "number" ? v : finiteOrNull(v ?? "") })) });
      kinds.add("pie");
      continue;
    }
    if (!["bar", "scatter", "scattergl"].includes(type)) { skipped++; continue; }
    let xs = plotlyArray(own(t, "x"));
    let ys = plotlyArray(own(t, "y"));
    const h = type === "bar" && str(own(t, "orientation")) === "h";
    if (h) { horizontal = true; [xs, ys] = [ys, xs]; }
    if (!ys) { skipped++; continue; }
    if (xs && xs.length !== ys.length) mismatch = true;
    const mode = str(own(t, "mode")) ?? (ys.length > 20 ? "lines" : "lines+markers");
    const fill = str(own(t, "fill"));
    const mark: DraftSeries["mark"] = type === "bar" ? "bar" : fill && fill !== "none" ? "area" : mode.includes("lines") ? "line" : "point";
    kinds.add(mark!);
    const sizeArr = isObj(own(t, "marker")) ? plotlyArray(own(own(t, "marker") as Obj, "size")) : null;
    const points = ys.map((yv, k) => {
      const y = typeof yv === "number" ? yv : yv === null ? null : finiteOrNull(yv);
      if (yv !== null && y === null) nonFinite++;
      const xv = xs ? xs[k] ?? null : k;
      const p: DraftSeries["points"][number] = { x: xv === null ? String(k) : xv, y };
      if (sizeArr && Array.isArray(sizeArr) && typeof sizeArr[k] === "number") p.z = sizeArr[k] as number;
      return p;
    });
    if (str(own(t, "yaxis")) === "y2") y2 = true;
    series.push({ name, mark, axis: str(own(t, "yaxis")) === "y2" ? "y2" : "y", points });
  }
  if (!series.length) return { spec: null, confidence: 0, reason: "plotly-unsupported-traces" };
  const barmode = str(own(lay, "barmode"));
  let chartType: DraftChart["chartType"];
  if (pie) chartType = pie;
  else if (kinds.size > 1) chartType = "combo";
  else if (kinds.has("bar")) chartType = horizontal ? "horizontal-bar" : barmode === "stack" || barmode === "relative" ? "stacked-bar" : series.length > 1 ? "grouped-bar" : "bar";
  else if (kinds.has("area")) chartType = series.length > 1 ? "stacked-area" : "area";
  else if (kinds.has("point")) chartType = series.some((s) => s.points.some((p) => p.z !== undefined)) ? "bubble" : "scatter";
  else chartType = "line";
  const axisTitle = (name: string) => { const a = own(lay, name); return isObj(a) ? titleText(own(a, "title")) : null; };
  const axisType = (name: string) => { const a = own(lay, name); return isObj(a) ? str(own(a, "type")) : null; };
  const xNumeric = series.every((s) => s.points.every((p) => typeof p.x === "number"));
  const xType = axisType("xaxis");
  const draft: DraftChart = {
    chartType,
    title: titleText(own(lay, "title")),
    xAxis: { label: axisTitle(horizontal ? "yaxis" : "xaxis"), scale: xType === "log" ? "log" : xType === "date" ? "time" : xNumeric && chartType !== "bar" && chartType !== "grouped-bar" && chartType !== "stacked-bar" ? "linear" : "band" },
    yAxis: { label: axisTitle(horizontal ? "xaxis" : "yaxis"), scale: axisType(horizontal ? "xaxis" : "yaxis") === "log" ? "log" : "linear" },
    y2Axis: y2 ? { label: axisTitle("yaxis2") } : null,
    series: chartType === "combo" ? series : series.map((s) => ({ ...s, mark: null })),
  };
  if (["bar", "grouped-bar", "stacked-bar", "horizontal-bar", "pie", "donut"].includes(chartType)) for (const s of draft.series) for (const p of s.points) if (typeof p.x === "number") p.x = String(p.x);
  const total = series.reduce((n, s) => n + s.points.length, 0);
  const confidence = 0.96 - (skipped ? 0.15 * (skipped / traces.length) : 0) - (mismatch ? 0.08 : 0) - (total ? 0.4 * (nonFinite / total) : 0);
  return { spec: draft, confidence: clamp01(confidence), reason: skipped ? "plotly-traces-skipped" : mismatch ? "series-length-mismatch" : nonFinite ? "non-finite-values" : null };
}

// ---- Scanning -----------------------------------------------------------------------------------------------------

function classify(value: Json, locator: string, hits: EmbeddedSpecHit[], seen: Set<string>) {
  if (!isObj(value)) {
    // A bare array of Plotly traces (as in a JSON blob) is handled by the caller with its layout.
    return;
  }
  if (looksVegaLite(value)) {
    const r = vegaLiteToChart(value);
    hits.push({ locator, generator: "vega-lite", ...r });
  } else if (isVegaSchema(value, "vega")) {
    hits.push({ locator, generator: "vega", spec: null, confidence: 0, reason: "vega-full-spec-unsupported" });
  } else if (Array.isArray(own(value, "data")) && ((own(value, "data") as Json[]).some((t) => isObj(t) && (own(t, "type") !== undefined || own(t, "y") !== undefined || own(t, "values") !== undefined)))) {
    const key = JSON.stringify(own(value, "data")).slice(0, 4096);
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ locator, generator: "plotly", ...plotlyToChart(own(value, "data")!, own(value, "layout")) });
  }
}

const PLOTLY_CALL = /\bPlotly\.(newPlot|react|plot)\s*\(/g;

/** Find embedded chart specs in an HTML / XHTML / SVG / JSON text. */
export function findEmbeddedSpecs(text: string): EmbeddedSpecHit[] {
  const hits: EmbeddedSpecHit[] = [];
  const seen = new Set<string>();
  if (text.length > CHART_EXTRACT_LIMITS.maxTextBytes) return hits;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    const v = safeJsonParse(trimmed);
    if (v !== undefined) { classify(v, "json", hits, seen); return hits; }
  }
  const blocks: Array<{ locator: string; type: string; body: string }> = [];
  let k = 0;
  for (const m of text.matchAll(/<(script|metadata)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    if (blocks.length >= CHART_EXTRACT_LIMITS.maxJsonCandidates) break;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[2] ?? "")?.[1]?.toLowerCase() ?? "";
    if (/\bsrc\s*=/i.test(m[2] ?? "")) continue;
    let body = m[3] ?? "";
    const cdata = /^\s*(?:\/\/\s*)?<!\[CDATA\[([\s\S]*?)(?:\/\/\s*)?\]\]>\s*$/.exec(body);
    if (cdata) body = cdata[1]!;
    else if (m[1]!.toLowerCase() === "metadata" || /\+xml|xhtml/.test(type)) body = decodeEntities(body);
    blocks.push({ locator: `${m[1]!.toLowerCase()}[${k++}]`, type, body });
  }
  let candidates = 0;
  for (const block of blocks) {
    const isJsonType = /json/.test(block.type);
    if (isJsonType) {
      const v = safeJsonParse(block.body.trim());
      if (v !== undefined) {
        if (Array.isArray(v) && /plotly/.test(block.type)) hits.push({ locator: block.locator, generator: "plotly", ...plotlyToChart(v, undefined) });
        else classify(v, block.locator, hits, seen);
        continue;
      }
    }
    // Plotly.newPlot(el, data, layout): the first array region after the call is the trace list, the next object the layout.
    const regions = jsonRegions(block.body);
    let calls = 0;
    for (const call of block.body.matchAll(PLOTLY_CALL)) {
      if (++calls > 50) break;
      // Scan from inside the call's parentheses so a call nested in a block is still found.
      const after = jsonRegions(block.body.slice(call.index! + call[0].length), 4);
      const dataRegion = after.find((r) => r.text.startsWith("["));
      if (!dataRegion) continue;
      const data = safeJsonParse(dataRegion.text);
      if (!Array.isArray(data)) { hits.push({ locator: block.locator, generator: "plotly", spec: null, confidence: 0, reason: "plotly-data-not-json" }); continue; }
      const layoutRegion = after.find((r) => r.start > dataRegion.start && r.text.startsWith("{"));
      const layout = layoutRegion ? safeJsonParse(layoutRegion.text) : undefined;
      const key = JSON.stringify(data).slice(0, 4096);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ locator: block.locator, generator: "plotly", ...plotlyToChart(data, layout) });
    }
    for (const region of regions) {
      if (++candidates > CHART_EXTRACT_LIMITS.maxJsonCandidates) break;
      if (!region.text.startsWith("{") || !/"\$schema"|"mark"|"data"/.test(region.text)) continue;
      const v = safeJsonParse(region.text);
      if (v !== undefined && isObj(v) && (looksVegaLite(v) || isVegaSchema(v, "vega"))) classify(v, block.locator, hits, seen);
    }
  }
  return hits;
}
