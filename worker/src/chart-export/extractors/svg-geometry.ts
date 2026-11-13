import { CHART_EXTRACT_LIMITS, ExtractLimitError } from "./limits.js";
import { buildScene, type LinePrim, type PointPrim, type RectPrim, type Scene, type TextPrim } from "./svg-scene.js";
import { clamp01, type DraftChart, type DraftSeries } from "./spec-utils.js";
import { parseTickNumber } from "./text.js";
import type { XmlElement } from "./xml.js";

/*
 * Rung 3 (`svg-geometry`): recover chart data from SVG marks. Numeric tick labels aligned on a common x (y axis) or y
 * (x axis) give a linear or log pixel→value scale (least squares with a residual check); bars (rects sharing a
 * baseline), polylines and point markers are inverted through it; text labels under bars give categories and legend
 * swatches give series names by colour. Generator adapters (matplotlib, Plotly, Vega, Highcharts, Recharts) only tag
 * axis / legend groups and read exact tick positions where the markup carries them; the inversion is shared.
 */

export type SvgGenerator = "matplotlib" | "plotly" | "vega" | "highcharts" | "recharts" | "echarts" | null;

export interface SvgChartAnalysis {
  spec: DraftChart | null;
  confidence: number;
  digest: string | null;
  generator: SvgGenerator;
  reason: string | null;
}

interface Tick { pos: number; label: string; value: number | null }
interface Scale { kind: "linear" | "log"; a: number; b: number; residual: number; n: number; step: number; unit: string | null; min: number; max: number; inv(px: number): number }

const AXIS_TOKEN = /^(?:[xy]tick(?:_\d+)?|matplotlib\.axis_\d+|[xy]?axis(?:-\S*)?|\S*axislayer\S*|gridlayer|zerolinelayer|role-axis\S*|mark-\S*role-axis|highcharts-(?:axis|grid|plot-band|tick)\S*|recharts-cartesian-(?:axis|grid)\S*|tick|ticks|grid|gridline|domain|xlines-\S*|ylines-\S*|crisp)$/i;
const LEGEND_TOKEN = /legend/i;
const TITLE_TOKEN = /(?:^|-)(?:g?title)\b/i;

const tokens = (groups: string) => groups.split(/\s+/).filter(Boolean);
const inAxis = (p: { groups: string }) => tokens(p.groups).some((t) => AXIS_TOKEN.test(t));
const inLegend = (p: { groups: string }) => tokens(p.groups).some((t) => LEGEND_TOKEN.test(t));
const inTitle = (p: { groups: string }) => tokens(p.groups).some((t) => TITLE_TOKEN.test(t));

export function detectGenerator(scene: Scene): SvgGenerator {
  const sig = scene.signatures;
  const allGroups = [...scene.texts, ...scene.rects, ...scene.lines, ...scene.points].slice(0, 2000).map((p) => p.groups).join(" ");
  if (/matplotlib/i.test(sig)) return "matplotlib";
  if (/\bmain-svg\b|\bscatterlayer\b|\bbarlayer\b|\bplotly\b/i.test(allGroups) || /plotly/i.test(sig)) return "plotly";
  if (/\bhighcharts-/i.test(allGroups) || /highcharts/i.test(sig)) return "highcharts";
  if (/\brecharts-/i.test(allGroups)) return "recharts";
  if (/\brole-(?:axis|mark|legend)\b/i.test(allGroups)) return "vega";
  if (/echarts|zrender/i.test(sig) || /\bzr\d*\b|\bec-/i.test(allGroups)) return "echarts";
  return null;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

function lsq(xs: number[], ys: number[]): { a: number; b: number } | null {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0;
  for (let k = 0; k < n; k++) { sxx += (xs[k]! - mx) ** 2; sxy += (xs[k]! - mx) * (ys[k]! - my); }
  if (sxx === 0) return null;
  const a = sxy / sxx;
  return { a, b: my - a * mx };
}

export function fitScale(ticks: Tick[]): Scale | null {
  const pts = ticks.filter((t) => t.value !== null && Number.isFinite(t.pos)) as Array<Tick & { value: number }>;
  // Dedupe by position.
  const uniq = pts.filter((t, k) => pts.findIndex((u) => Math.abs(u.pos - t.pos) < 0.5) === k);
  if (uniq.length < 2) return null;
  const xs = uniq.map((t) => t.pos), vs = uniq.map((t) => t.value);
  const range = Math.max(...vs) - Math.min(...vs);
  if (!(range > 0)) return null;
  const lin = lsq(xs, vs);
  const units = uniq.map((t) => parseTickNumber(t.label)?.unit ?? null).filter(Boolean);
  const unit = units.length ? units[0]! : null;
  const sortedVals = [...vs].sort((a, b) => a - b);
  const step = median(sortedVals.slice(1).map((v, k) => v - sortedVals[k]!));
  let best: Scale | null = null;
  if (lin) {
    const residual = Math.max(...uniq.map((t) => Math.abs(lin.a * t.pos + lin.b - t.value))) / range;
    best = { kind: "linear", a: lin.a, b: lin.b, residual, n: uniq.length, step, unit, min: sortedVals[0]!, max: sortedVals[sortedVals.length - 1]!, inv: (px) => lin.a * px + lin.b };
  }
  if (vs.every((v) => v > 0) && uniq.length >= 3) {
    const lv = vs.map((v) => Math.log10(v));
    const log = lsq(xs, lv);
    const lrange = Math.max(...lv) - Math.min(...lv);
    if (log && lrange > 0) {
      const residual = Math.max(...uniq.map((t, k) => Math.abs(log.a * t.pos + log.b - lv[k]!))) / lrange;
      if (!best || residual < best.residual * 0.5) best = { kind: "log", a: log.a, b: log.b, residual, n: uniq.length, step, unit, min: sortedVals[0]!, max: sortedVals[sortedVals.length - 1]!, inv: (px) => 10 ** (log.a * px + log.b) };
    }
  }
  return best && best.residual <= 0.05 ? best : null;
}

function cluster<T>(items: T[], key: (t: T) => number, tol: number): T[][] {
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  const out: T[][] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(key(it) - key(last[last.length - 1]!)) <= tol) last.push(it);
    else out.push([it]);
  }
  return out;
}

function monotonic(ticks: Tick[]): boolean {
  const s = [...ticks].sort((a, b) => a.pos - b.pos);
  const vals = s.map((t) => t.value!);
  const inc = vals.every((v, k) => k === 0 || v > vals[k - 1]!);
  const dec = vals.every((v, k) => k === 0 || v < vals[k - 1]!);
  return inc || dec;
}

function textWidth(t: TextPrim): number { return t.text.length * t.fontSize * 0.55; }
function textLeft(t: TextPrim): number { return t.anchor === "start" ? t.x : t.anchor === "middle" ? t.x - textWidth(t) / 2 : t.x - textWidth(t); }

/** matplotlib: `xtick_N` / `ytick_N` groups carry the tick mark (exact position) and its label. */
function matplotlibTicks(scene: Scene, axis: "x" | "y"): Tick[] {
  const re = new RegExp(`(?:^|\\s)(${axis}tick_\\d+)(?:\\s|$)`);
  const byGroup = new Map<string, { label: string | null; pos: number | null }>();
  for (const t of scene.texts) {
    const m = re.exec(t.groups);
    if (!m) continue;
    const g = byGroup.get(m[1]!) ?? { label: null, pos: null };
    g.label ??= t.text;
    byGroup.set(m[1]!, g);
  }
  for (const l of scene.lines) {
    const m = re.exec(l.groups);
    if (!m) continue;
    const g = byGroup.get(m[1]!) ?? { label: null, pos: null };
    g.pos ??= axis === "x" ? l.points[0]![0] : l.points[0]![1];
    byGroup.set(m[1]!, g);
  }
  return [...byGroup.values()].filter((g) => g.label !== null && g.pos !== null).map((g) => ({ pos: g.pos!, label: g.label!, value: parseTickNumber(g.label!)?.value ?? null }));
}

/** Snap text-derived tick positions to tick marks / gridlines when a consistent offset exists. */
function snapTicks(ticks: Tick[], lines: LinePrim[], axis: "x" | "y", tol: number): Tick[] {
  const guides = lines.filter((l) => l.points.length === 2 && (axis === "y" ? Math.abs(l.points[0]![1] - l.points[1]![1]) < 0.5 : Math.abs(l.points[0]![0] - l.points[1]![0]) < 0.5))
    .map((l) => (axis === "y" ? l.points[0]![1] : l.points[0]![0]));
  if (!guides.length) return ticks;
  const offsets: number[] = [];
  for (const t of ticks) {
    let best = Infinity;
    for (const g of guides) if (Math.abs(g - t.pos) < Math.abs(best)) best = g - t.pos;
    if (Math.abs(best) <= tol) offsets.push(best);
  }
  if (offsets.length < Math.max(2, Math.ceil(ticks.length * 0.6))) return ticks;
  const off = median(offsets);
  if (offsets.some((o) => Math.abs(o - off) > 1)) return ticks;
  return ticks.map((t) => ({ ...t, pos: t.pos + off }));
}

function genericNumericTicks(texts: TextPrim[], axis: "x" | "y"): { ticks: Tick[]; used: Set<TextPrim> } {
  const numeric = texts.filter((t) => !t.rotated && parseTickNumber(t.text) !== null);
  const groups = cluster(numeric, (t) => (axis === "y" ? (t.anchor === "start" ? textLeft(t) : t.anchor === "end" ? t.x : t.x) : t.y), axis === "y" ? 3 : 2);
  let best: TextPrim[] | null = null;
  for (const g of groups) {
    if (g.length < 2) continue;
    const ticks = g.map((t) => ({ pos: axis === "y" ? t.y : t.x, label: t.text, value: parseTickNumber(t.text)!.value }));
    const positions = new Set(ticks.map((t) => Math.round(t.pos)));
    if (positions.size < g.length || !monotonic(ticks)) continue;
    // y axis: values grow upward (pixel y decreases), the usual case; accept either and let the fit decide.
    if (!best || g.length > best.length || (g.length === best.length && (axis === "y" ? g[0]!.x < best[0]!.x : g[0]!.y > best[0]!.y))) best = g;
  }
  if (!best) return { ticks: [], used: new Set() };
  return { ticks: best.map((t) => ({ pos: axis === "y" ? t.y : t.x, label: t.text, value: parseTickNumber(t.text)!.value })), used: new Set(best) };
}

function roundTo(v: number, scale: Scale): number {
  if (scale.kind === "log") return Number(v.toPrecision(4));
  const step = Number.isFinite(scale.step) && scale.step > 0 ? scale.step : Math.abs(scale.max - scale.min) || 1;
  const decimals = Math.max(0, Math.min(10, Math.ceil(-Math.log10(step / 100))));
  return Number(v.toFixed(decimals));
}

interface LegendEntry { name: string; color: string; swatch: object }

function findLegend(texts: TextPrim[], scene: Scene, exclude: Set<TextPrim>): LegendEntry[] {
  const out: LegendEntry[] = [];
  const swatches: Array<{ prim: object; x1: number; cy: number; color: string | null }> = [
    ...scene.rects.filter((r) => r.x1 - r.x0 <= 24 && r.y1 - r.y0 <= 24).map((r) => ({ prim: r, x1: r.x1, cy: (r.y0 + r.y1) / 2, color: r.fill })),
    ...scene.lines.filter((l) => l.points.length <= 3 && Math.abs(l.points[0]![1] - l.points[l.points.length - 1]![1]) < 0.5 && Math.abs(l.points[l.points.length - 1]![0] - l.points[0]![0]) <= 50 && Math.abs(l.points[l.points.length - 1]![0] - l.points[0]![0]) > 2)
      .map((l) => ({ prim: l, x1: Math.max(l.points[0]![0], l.points[l.points.length - 1]![0]), cy: l.points[0]![1], color: l.stroke })),
    ...scene.points.map((p) => ({ prim: p, x1: p.x + p.size / 2, cy: p.y, color: p.fill })),
  ];
  for (const t of texts) {
    if (exclude.has(t) || t.rotated || (parseTickNumber(t.text) !== null && !inLegend(t))) continue;
    const left = textLeft(t);
    let best: (typeof swatches)[number] | null = null;
    let bestD = Infinity;
    for (const s of swatches) {
      if (!s.color) continue;
      const dx = left - s.x1;
      if (dx < -4 || dx > 45 || Math.abs(s.cy - t.y) > Math.max(6, 0.8 * t.fontSize)) continue;
      if (dx < bestD) { bestD = dx; best = s; }
    }
    if (best && best.color && !out.some((e) => e.color === best!.color)) out.push({ name: t.text, color: best.color, swatch: best.prim });
  }
  return out;
}

/**
 * Points that do not sit on a line vertex (|dx| < 1.5 and |dy| < 1.5). Vertices are bucketed in 3-unit cells, so one
 * point tests only the vertices in its own and the 8 neighbouring cells; the exact test still decides each pair, and a
 * non-finite coordinate never passes it, so such points and vertices are skipped. For vertices spread over the plot this
 * is close to linear in points + vertices. Vertices packed into a few cells (a hostile SVG) still cost points × packed
 * vertices, so every pair test counts against `maxMarkerPairTests` and the SVG is refused (`svg-marker-limit`) past it.
 * `work` reports the pair tests run; `budget` is overridable only so tests can count the cap without running 5×10⁷ tests.
 */
export function withoutVertexMarkers(points: PointPrim[], lines: LinePrim[], work: { pairTests: number } = { pairTests: 0 }, budget: number = CHART_EXTRACT_LIMITS.maxMarkerPairTests): PointPrim[] {
  if (!points.length || !lines.length) return points;
  const CELL = 3;
  const grid = new Map<string, Array<[number, number]>>();
  for (const l of lines) {
    for (const v of l.points) {
      if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) continue;
      const key = `${Math.floor(v[0] / CELL)},${Math.floor(v[1] / CELL)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(v); else grid.set(key, [v]);
    }
  }
  const nearVertex = (bucket: Array<[number, number]> | undefined, px: number, py: number): boolean => {
    if (!bucket) return false;
    for (const [x, y] of bucket) {
      if (++work.pairTests > budget) throw new ExtractLimitError("svg-marker-limit");
      if (Math.abs(x - px) < 1.5 && Math.abs(y - py) < 1.5) return true;
    }
    return false;
  };
  return points.filter((p) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return true;
    const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
    // Own cell first: a marker drawn on a vertex usually matches there.
    if (nearVertex(grid.get(`${cx},${cy}`), p.x, p.y)) return false;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if ((dx || dy) && nearVertex(grid.get(`${cx + dx},${cy + dy}`), p.x, p.y)) return false;
      }
    }
    return true;
  });
}

export function analyzeSvgChart(root: XmlElement, extraTexts: readonly TextPrim[] = []): SvgChartAnalysis {
  const scene = buildScene(root);
  // Text placed beside the SVG (a PDF figure's words): read exactly like the SVG's own <text>.
  if (extraTexts.length) scene.texts.push(...extraTexts);
  const generator = detectGenerator(scene);
  const texts = scene.texts.filter((t) => t.text.length > 0);

  // ---- Ticks / scales --------------------------------------------------------------------------------------------
  let xTicks: Tick[] = [], yTicks: Tick[] = [];
  const usedTexts = new Set<TextPrim>();
  if (generator === "matplotlib") {
    xTicks = matplotlibTicks(scene, "x");
    yTicks = matplotlibTicks(scene, "y");
    for (const t of texts) if (/(?:^|\s)[xy]tick_\d+/.test(t.groups)) usedTexts.add(t);
  }
  if (!yTicks.length) {
    const g = genericNumericTicks(texts.filter((t) => !usedTexts.has(t) && !inLegend(t)), "y");
    yTicks = snapTicks(g.ticks, scene.lines, "y", Math.max(4, (g.ticks.length ? 6 : 0)));
    g.used.forEach((t) => usedTexts.add(t));
  }
  if (!xTicks.length) {
    const g = genericNumericTicks(texts.filter((t) => !usedTexts.has(t) && !inLegend(t)), "x");
    xTicks = snapTicks(g.ticks, scene.lines, "x", 4);
    g.used.forEach((t) => usedTexts.add(t));
  }
  const yScale = fitScale(yTicks);
  let xScale = fitScale(xTicks);

  // ---- Categories ---------------------------------------------------------------------------------------------------
  let xCats: Tick[] = xScale ? [] : xTicks.filter((t) => t.value === null);
  let yCats: Tick[] = [];
  const free = () => texts.filter((t) => !usedTexts.has(t) && !inLegend(t) && !inTitle(t) && parseTickNumber(t.text) === null);
  const plotBottom = yScale ? Math.max(...yTicks.filter((t) => t.value !== null).map((t) => t.pos)) : null;
  const plotTop = yScale ? Math.min(...yTicks.filter((t) => t.value !== null).map((t) => t.pos)) : null;
  if (!xCats.length && !xScale && yScale && plotBottom !== null) {
    const below = free().filter((t) => t.y > plotBottom - 2 && t.y < plotBottom + 80);
    const rows = cluster(below, (t) => t.y, 4).filter((r) => r.length >= 1).sort((a, b) => b.length - a.length || a[0]!.y - b[0]!.y);
    if (rows[0]) { xCats = rows[0].map((t) => ({ pos: t.x, label: t.text, value: null })); rows[0].forEach((t) => usedTexts.add(t)); }
  }
  if (generator === "matplotlib" && !yScale && yTicks.length && yTicks.every((t) => t.value === null)) yCats = yTicks;
  if (!yScale && xScale && !yCats.length) {
    const left = Math.min(...xTicks.map((t) => t.pos));
    const cand = free().filter((t) => !t.rotated && t.x <= left + 2);
    const cols = cluster(cand, (t) => (t.anchor === "end" ? t.x : textLeft(t) + textWidth(t)), 6).sort((a, b) => b.length - a.length);
    if (cols[0] && cols[0].length >= 1) { yCats = cols[0].map((t) => ({ pos: t.y, label: t.text, value: null })); cols[0].forEach((t) => usedTexts.add(t)); }
  }

  // ---- Legend / title / axis labels ----------------------------------------------------------------------------------
  const legend = findLegend(texts, scene, usedTexts);
  const legendSwatches = new Set(legend.map((e) => e.swatch));
  legend.forEach((e) => { const t = texts.find((x) => x.text === e.name && !usedTexts.has(x)); if (t) usedTexts.add(t); });
  const rest = texts.filter((t) => !usedTexts.has(t) && parseTickNumber(t.text) === null);
  const yTickX = yTicks.length ? Math.min(...texts.filter((t) => yTicks.some((y) => y.label === t.text)).map((t) => textLeft(t)), Infinity) : null;
  const yLabel = rest.find((t) => t.rotated && (yTickX === null || t.x < yTickX + 2)) ?? null;
  const catRowY = xCats.length ? Math.max(...xCats.map((c) => texts.find((t) => t.text === c.label)?.y ?? 0)) : xTicks.length ? Math.max(...texts.filter((t) => xTicks.some((x) => x.label === t.text)).map((t) => t.y), 0) : null;
  const xLabel = rest.find((t) => !t.rotated && catRowY !== null && t.y > catRowY + 2) ?? null;
  const titleCands = rest.filter((t) => t !== yLabel && t !== xLabel && !t.rotated && (plotTop === null || t.y < plotTop));
  const title = titleCands.sort((a, b) => b.fontSize - a.fontSize || a.y - b.y)[0] ?? rest.find((t) => inTitle(t)) ?? null;

  // ---- Marks ----------------------------------------------------------------------------------------------------------
  const width = scene.width ?? 0, height = scene.height ?? 0;
  const sceneArea = width * height || Infinity;
  const yRange = yScale ? [Math.min(...yTicks.map((t) => t.pos)), Math.max(...yTicks.map((t) => t.pos))] : null;
  const xPositions = [...xTicks.map((t) => t.pos), ...xCats.map((t) => t.pos)];
  const xRange = xPositions.length ? [Math.min(...xPositions), Math.max(...xPositions)] : null;
  const plotArea = yRange && xRange ? (yRange[1]! - yRange[0]! + 1) * (xRange[1]! - xRange[0]! + 1) : sceneArea;
  const rects = scene.rects.filter((r) => !inAxis(r) && !inLegend(r) && !legendSwatches.has(r) && r.fill && !inTitle(r))
    .filter((r) => { const a = (r.x1 - r.x0) * (r.y1 - r.y0); return a < 0.6 * Math.max(plotArea, 1) && a < 0.5 * sceneArea && !(r.fill === "#ffffff" && a > 400); });
  const lines = scene.lines.filter((l) => !inAxis(l) && !inLegend(l) && !legendSwatches.has(l) && l.stroke && !l.fill && l.points.length >= 2)
    .filter((l) => {
      if (l.points.length === 2) {
        const [p, q] = l.points as [[number, number], [number, number]];
        if (Math.abs(p[0] - q[0]) < 0.5 || Math.abs(p[1] - q[1]) < 0.5) return false; // gridline / spine / tick
      }
      const xs = l.points.map((p) => p[0]);
      const span = Math.max(...xs) - Math.min(...xs);
      return !xRange || span >= 0.15 * Math.max(1, xRange[1]! - xRange[0]!);
    });
  let points = scene.points.filter((p) => !inAxis(p) && !inLegend(p) && !legendSwatches.has(p) && (p.fill || p.stroke));
  // Markers drawn on a polyline's vertices duplicate it.
  points = withoutVertexMarkers(points, lines);

  const colorName = new Map(legend.map((e) => [e.color, e.name]));
  const series = new Map<string, DraftSeries & { color: string | null }>();
  const getSeries = (key: string, color: string | null, mark: DraftSeries["mark"]) => {
    let s = series.get(key);
    if (!s) { s = { name: (color && colorName.get(color)) ?? "", mark, color, points: [] }; series.set(key, s); }
    return s;
  };
  const nearestCat = (cats: Tick[], pos: number): Tick | null => {
    if (!cats.length) return null;
    const sorted = [...cats].sort((a, b) => a.pos - b.pos);
    const pitch = sorted.length > 1 ? median(sorted.slice(1).map((c, k) => c.pos - sorted[k]!.pos)) : Infinity;
    let best: Tick | null = null;
    for (const c of sorted) if (!best || Math.abs(c.pos - pos) < Math.abs(best.pos - pos)) best = c;
    return best && Math.abs(best.pos - pos) <= Math.max(pitch / 2, 2) ? best : null;
  };

  let candidates = 0, mapped = 0, curved = 0, outOfRange = 0;
  let stacked = false;
  let horizontal = false;
  const inRange = (v: number, s: Scale) => { const span = s.max - s.min; return v >= s.min - span * 0.25 && v <= s.max + span * 0.25; };

  // Bars.
  if (rects.length) {
    horizontal = !yScale && !!xScale;
    const vScale = horizontal ? xScale : yScale;
    let cats = horizontal ? yCats : xCats;
    let pScale = horizontal ? yScale : xScale;
    // Bars centred on numeric ticks (years, ids) are categories, not a histogram.
    const posTicks = horizontal ? yTicks : xTicks;
    const centerOf = (r: RectPrim) => (horizontal ? (r.y0 + r.y1) / 2 : (r.x0 + r.x1) / 2);
    if (!cats.length && pScale && posTicks.length >= 2 && rects.every((r) => posTicks.some((t) => Math.abs(t.pos - centerOf(r)) < 1.5)) && new Set(rects.map((r) => r.fill)).size === 1) {
      cats = posTicks;
      pScale = null;
      if (horizontal) yCats = posTicks; else { xCats = posTicks; xScale = null; }
    }
    if (vScale) {
      const nearCount = new Map<number, number>();
      for (const r of rects) for (const e of horizontal ? [r.x0, r.x1] : [r.y0, r.y1]) nearCount.set(Math.round(e), (nearCount.get(Math.round(e)) ?? 0) + 1);
      const baseline = [...nearCount.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      const center = (r: RectPrim) => (horizontal ? (r.y0 + r.y1) / 2 : (r.x0 + r.x1) / 2);
      const columns = cluster(rects, center, 1);
      for (const col of columns) {
        const colStacked = col.length > 1 && col.some((a) => col.some((b) => a !== b && (Math.abs(a.y0 - b.y1) < 0.6 || Math.abs(a.x1 - b.x0) < 0.6)));
        if (colStacked) stacked = true;
        for (const r of col) {
          candidates++;
          const c = center(r);
          const cat = nearestCat(cats, c);
          const x: string | number | null = cat ? cat.label : pScale ? roundTo(pScale.inv(c), pScale) : null;
          if (x === null) continue;
          let value: number;
          if (colStacked) value = horizontal ? vScale.inv(r.x1) - vScale.inv(r.x0) : vScale.inv(r.y0) - vScale.inv(r.y1);
          else {
            const edges = horizontal ? [r.x0, r.x1] : [r.y0, r.y1];
            const farEdge = Math.abs(edges[0]! - baseline) > Math.abs(edges[1]! - baseline) ? edges[0]! : edges[1]!;
            value = vScale.inv(farEdge);
          }
          if (!Number.isFinite(value)) continue;
          if (!colStacked && !inRange(value, vScale)) { outOfRange++; continue; }
          mapped++;
          getSeries(`bar:${r.fill}`, r.fill, "bar").points.push({ x, y: roundTo(value, vScale) });
        }
      }
    }
  }

  // Lines.
  if (yScale) {
    for (const l of lines) {
      candidates++;
      if (l.curves) curved++;
      const s = getSeries(`line:${l.stroke}:${l.order}`, l.stroke, "line");
      let ok = 0;
      for (const [px, py] of l.points) {
        const cat = xScale ? null : nearestCat(xCats, px);
        const x = xScale ? roundTo(xScale.inv(px), xScale) : cat ? cat.label : null;
        if (x === null) continue;
        const y = yScale.inv(py);
        if (!Number.isFinite(y)) continue;
        s.points.push({ x, y: roundTo(y, yScale) });
        ok++;
      }
      if (ok >= 2 && ok >= l.points.length * 0.8) mapped++;
      else series.delete(`line:${l.stroke}:${l.order}`);
    }
    // Merge line series of the same colour (dashed lines split into many paths).
    const byColor = new Map<string, DraftSeries & { color: string | null }>();
    for (const [k, s] of [...series.entries()]) {
      if (!k.startsWith("line:")) continue;
      const prev = byColor.get(s.color ?? k);
      if (prev) { prev.points.push(...s.points); series.delete(k); } else byColor.set(s.color ?? k, s);
    }
  }

  // Scatter points.
  if (yScale && points.length) {
    for (const p of points) {
      candidates++;
      const cat = xScale ? null : nearestCat(xCats, p.x);
      const x = xScale ? roundTo(xScale.inv(p.x), xScale) : cat ? cat.label : null;
      const y = yScale.inv(p.y);
      if (x === null || !Number.isFinite(y) || !inRange(y, yScale)) continue;
      mapped++;
      getSeries(`point:${p.fill ?? p.stroke}`, p.fill ?? p.stroke, "point").points.push({ x, y: roundTo(y, yScale) });
    }
  }

  const all = [...series.values()].filter((s) => s.points.length);
  const digest = buildDigest({ generator, title, xLabel, yLabel, xScale, yScale, xCats, yCats, legend, all, rects: rects.length, lines: lines.length, points: points.length, texts: rest });

  if (!yScale && !xScale) return { spec: null, confidence: 0, digest, generator, reason: texts.length ? "no-numeric-axis" : "no-text" };
  if (!all.length) return { spec: null, confidence: 0, digest, generator, reason: candidates ? "marks-not-invertible" : "no-marks" };

  // Order points: categories by axis position; numeric by x.
  const catOrder = new Map([...(horizontal ? yCats : xCats)].sort((a, b) => (horizontal ? b.pos - a.pos : a.pos - b.pos)).map((c, k) => [c.label, k]));
  for (const s of all) s.points.sort((a, b) => (typeof a.x === "number" && typeof b.x === "number" ? a.x - b.x : (catOrder.get(String(a.x)) ?? 0) - (catOrder.get(String(b.x)) ?? 0)));

  const marks = new Set(all.map((s) => s.mark));
  let chartType: DraftChart["chartType"];
  if (marks.size > 1) chartType = "combo";
  else if (marks.has("bar")) chartType = horizontal ? "horizontal-bar" : stacked ? "stacked-bar" : all.length > 1 ? "grouped-bar" : xScale ? "histogram" : "bar";
  else if (marks.has("line")) chartType = "line";
  else chartType = "scatter";
  if (chartType === "histogram" && !rects.length) chartType = "bar";

  let unnamed = 0;
  all.forEach((s) => { if (!s.name) { unnamed++; s.name = all.length === 1 ? yLabel?.text ?? title?.text ?? "Series 1" : `Series ${unnamed}`; } });
  const vScale = horizontal ? xScale : yScale;
  const draft: DraftChart = {
    chartType,
    title: title?.text ?? null,
    xAxis: { label: horizontal ? yLabel?.text ?? null : xLabel?.text ?? null, scale: horizontal ? "band" : xScale ? xScale.kind : "band", min: !horizontal && xScale ? xScale.min : null, max: !horizontal && xScale ? xScale.max : null },
    yAxis: { label: horizontal ? xLabel?.text ?? null : yLabel?.text ?? null, unit: vScale?.unit ?? null, scale: vScale?.kind ?? "linear", min: vScale?.min ?? null, max: vScale?.max ?? null },
    series: all.map(({ color: _c, ...s }) => ({ ...s, mark: chartType === "combo" ? s.mark : null })),
  };

  const fit = vScale ? 1 - Math.min(1, vScale.residual / 0.02) : 0;
  const tickScore = vScale ? Math.min(1, (vScale.n - 1) / 4) : 0;
  const coverage = candidates ? mapped / candidates : 0;
  const naming = all.length === 1 || all.every((s) => colorName.size && [...colorName.values()].includes(s.name)) ? 1 : 0.4;
  let confidence = 0.1 + 0.3 * fit + 0.15 * tickScore + 0.3 * coverage + 0.1 * naming + (generator ? 0.05 : 0);
  if (curved) confidence -= 0.05;
  if (outOfRange) confidence -= 0.1;
  confidence = Math.min(0.95, clamp01(confidence));
  return { spec: draft, confidence, digest, generator, reason: coverage < 1 ? "partial-mark-coverage" : null };
}

function fmt(v: number): string { return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(5))); }

function buildDigest(d: {
  generator: SvgGenerator; title: TextPrim | null; xLabel: TextPrim | null; yLabel: TextPrim | null; xScale: Scale | null; yScale: Scale | null;
  xCats: Tick[]; yCats: Tick[]; legend: LegendEntry[]; all: Array<DraftSeries & { color: string | null }>; rects: number; lines: number; points: number; texts: TextPrim[];
}): string | null {
  const out: string[] = [];
  const max = CHART_EXTRACT_LIMITS.maxDigestChars;
  const q = (s: string) => JSON.stringify(s.slice(0, 80));
  if (d.generator) out.push(`generator: ${d.generator}`);
  if (d.title) out.push(`title: ${q(d.title.text)}`);
  const scale = (name: string, s: Scale | null) => s && out.push(`${name}: ${s.kind} ticks ${fmt(s.min)}..${fmt(s.max)} (n=${s.n}, fit residual ${(s.residual * 100).toFixed(2)}%)${s.unit ? ` unit ${s.unit}` : ""}`);
  scale("x-scale", d.xScale);
  scale("y-scale", d.yScale);
  if (d.xCats.length) out.push(`x-categories: ${d.xCats.slice(0, 40).map((c) => q(c.label)).join(", ")}`);
  if (d.yCats.length) out.push(`y-categories: ${d.yCats.slice(0, 40).map((c) => q(c.label)).join(", ")}`);
  if (d.xLabel) out.push(`x-label: ${q(d.xLabel.text)}`);
  if (d.yLabel) out.push(`y-label: ${q(d.yLabel.text)}`);
  if (d.legend.length) out.push(`legend: ${d.legend.map((e) => `${e.color}=${q(e.name)}`).join("; ")}`);
  out.push(`marks: ${d.rects} rects, ${d.lines} polylines, ${d.points} points`);
  for (const s of d.all.slice(0, 12)) {
    const pts = s.points.slice(0, 40).map((p) => `${typeof p.x === "number" ? fmt(p.x) : q(String(p.x))}=${p.y === null ? "null" : fmt(p.y)}`).join(", ");
    out.push(`series ${q(s.name || "?")} (${s.mark}, ${s.color ?? "?"}): ${pts}${s.points.length > 40 ? ` … (${s.points.length} points)` : ""}`);
  }
  const other = d.texts.filter((t) => t !== d.title && t !== d.xLabel && t !== d.yLabel).slice(0, 30).map((t) => q(t.text));
  if (other.length) out.push(`other text: ${other.join(", ")}`);
  if (out.length <= 1) return null;
  let s = out.join("\n");
  if (s.length > max) s = `${s.slice(0, max - 2)} …`;
  return s;
}
