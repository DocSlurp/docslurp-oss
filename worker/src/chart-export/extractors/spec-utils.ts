import { VISUAL_SPEC_LIMITS, visualSpecSchema, type ChartSpec, type DiagramSpec, type VisualSpec } from "@docslurp/shared/chart-export";

import { CHART_EXTRACT_LIMITS } from "./limits.js";
import { cleanLabel, cleanLabelOrNull } from "./text.js";

/** UTF-8 bytes of a string (as `Buffer.byteLength` counts), without allocating. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** Serialized bytes charged per point besides its label: `{"x":…,"y":…,"z":…},` with numbers. */
const POINT_OVERHEAD_BYTES = 64;

type ChartType = ChartSpec["chartType"];
type Axis = ChartSpec["xAxis"];

export interface DraftSeries {
  name: string;
  mark?: "bar" | "line" | "area" | "point" | null;
  axis?: "y" | "y2";
  points: Array<{ x: string | number; y: number | null; z?: number | null }>;
}

export interface DraftChart {
  chartType: ChartType;
  title?: string | null;
  xAxis?: Partial<Axis>;
  yAxis?: Partial<Axis>;
  y2Axis?: Partial<Axis> | null;
  series: DraftSeries[];
  source?: string | null;
  summary?: string;
}

export interface FinalizedChart { spec: ChartSpec | null; truncated: boolean; reason: string | null }

function axis(partial: Partial<Axis> | undefined, scale: Axis["scale"]): Axis {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    label: cleanLabelOrNull(partial?.label ?? null),
    unit: cleanLabelOrNull(partial?.unit ?? null),
    scale: partial?.scale ?? scale,
    min: num(partial?.min),
    max: num(partial?.max),
  };
}

/** Clamp a draft into the contract's limits and validate it; never throws. */
export function finalizeChart(draft: DraftChart): FinalizedChart {
  let truncated = draft.series.length > VISUAL_SPEC_LIMITS.maxSeries;
  // One budget per chart, in series order: points kept and their serialized size (council r9 H1). Past it the rest is
  // cut, the chart kept and marked truncated; ordinary charts are far under it and unchanged.
  let points = 0, bytes = 0;
  const series = draft.series.slice(0, VISUAL_SPEC_LIMITS.maxSeries).map((s, i) => {
    if (s.points.length > VISUAL_SPEC_LIMITS.maxPointsPerSeries) truncated = true;
    const name = cleanLabel(s.name) || `Series ${i + 1}`;
    bytes += utf8Bytes(name) + POINT_OVERHEAD_BYTES;
    const kept: Array<{ x: string | number; y: number | null; z?: number | null }> = [];
    for (const p of s.points.slice(0, VISUAL_SPEC_LIMITS.maxPointsPerSeries)) {
      const point: { x: string | number; y: number | null; z?: number | null } = {
        x: typeof p.x === "number" ? (Number.isFinite(p.x) ? p.x : cleanLabel(String(p.x))) : cleanLabel(p.x),
        y: typeof p.y === "number" && Number.isFinite(p.y) ? p.y : null,
      };
      if (p.z !== undefined) point.z = typeof p.z === "number" && Number.isFinite(p.z) ? p.z : null;
      const cost = (typeof point.x === "string" ? utf8Bytes(point.x) : 0) + POINT_OVERHEAD_BYTES;
      if (points + 1 > CHART_EXTRACT_LIMITS.maxChartPoints || bytes + cost > CHART_EXTRACT_LIMITS.maxChartBytes) { truncated = true; break; }
      points++;
      bytes += cost;
      kept.push(point);
    }
    return { name, mark: s.mark ?? null, axis: s.axis ?? "y", points: kept };
  }).filter((s) => s.points.length > 0);
  if (!series.length) return { spec: null, truncated, reason: "no-series" };
  const candidate = {
    kind: "chart" as const,
    chartType: draft.chartType,
    title: cleanLabelOrNull(draft.title ?? null),
    xAxis: axis(draft.xAxis, "band"),
    yAxis: axis(draft.yAxis, "linear"),
    y2Axis: draft.y2Axis ? axis(draft.y2Axis, "linear") : null,
    series,
    source: cleanLabelOrNull(draft.source ?? null),
    summary: cleanLabel(draft.summary ?? "", VISUAL_SPEC_LIMITS.maxSummaryChars),
  };
  const parsed = visualSpecSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.kind !== "chart") return { spec: null, truncated, reason: "spec-invalid" };
  return { spec: parsed.data, truncated, reason: null };
}

export function finalizeDiagram(draft: Omit<DiagramSpec, "kind" | "summary" | "groups"> & { groups?: DiagramSpec["groups"]; summary?: string }): DiagramSpec | null {
  const nodes = draft.nodes.slice(0, VISUAL_SPEC_LIMITS.maxNodes).map((n) => ({ ...n, id: n.id.slice(0, 64), label: cleanLabel(n.label), group: n.group ? n.group.slice(0, 64) : null }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = draft.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).slice(0, VISUAL_SPEC_LIMITS.maxEdges)
    .map((e) => ({ ...e, label: cleanLabelOrNull(e.label) }));
  const parsed = visualSpecSchema.safeParse({
    kind: "diagram",
    diagramType: draft.diagramType,
    title: cleanLabelOrNull(draft.title),
    direction: draft.direction,
    nodes,
    edges,
    groups: (draft.groups ?? []).slice(0, 64).map((g) => ({ id: g.id.slice(0, 64), label: cleanLabel(g.label) })),
    summary: cleanLabel(draft.summary ?? "", VISUAL_SPEC_LIMITS.maxSummaryChars),
  });
  return parsed.success && parsed.data.kind === "diagram" ? parsed.data : null;
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

export type { VisualSpec };
