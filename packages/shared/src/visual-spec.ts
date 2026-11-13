import { z } from "zod";

/*
 * Chart and diagram spec schemas: what every exported visual carries, whoever produced it. A separate module (subpath
 * `@docslurp/shared/visual-spec`) so the parser-VM chart guest, a fresh process per command, constructs only these at
 * start-up. `chart-export.ts` re-exports everything here.
 */

// ---- Specs ------------------------------------------------------------------------------------------------------

/** Limits applied to every spec, whatever produced it (model output and parsed files are both untrusted). */
export const VISUAL_SPEC_LIMITS = {
  maxSeries: 32,
  maxPointsPerSeries: 2000,
  maxNodes: 300,
  maxEdges: 600,
  maxLabelChars: 200,
  maxSummaryChars: 2000,
} as const;

const label = z.string().max(VISUAL_SPEC_LIMITS.maxLabelChars);

export const CHART_TYPES = [
  "bar", "grouped-bar", "stacked-bar", "horizontal-bar", "line", "area", "stacked-area", "scatter", "bubble", "pie",
  "donut", "histogram", "box", "heatmap", "radar", "waterfall", "combo", "other",
] as const;
export const chartTypeSchema = z.enum(CHART_TYPES);

export const chartAxisSchema = z.object({
  label: label.nullable().default(null),
  unit: label.nullable().default(null),
  scale: z.enum(["linear", "log", "band", "time"]).default("linear"),
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
});
export type ChartAxis = z.infer<typeof chartAxisSchema>;

export const chartPointSchema = z.object({
  x: z.union([z.string().max(VISUAL_SPEC_LIMITS.maxLabelChars), z.number()]),
  /** null = gap / not present for this category. */
  y: z.number().nullable(),
  /** Optional third value (bubble size, heatmap intensity, box-plot detail is out of scope). */
  z: z.number().nullable().optional(),
});
export type ChartPoint = z.infer<typeof chartPointSchema>;

export const chartSeriesSchema = z.object({
  name: label,
  /** Combo charts: how this series is drawn. Defaults to the chart type. */
  mark: z.enum(["bar", "line", "area", "point"]).nullable().default(null),
  /** Which y axis (combo charts with a secondary axis). */
  axis: z.enum(["y", "y2"]).default("y"),
  points: z.array(chartPointSchema).max(VISUAL_SPEC_LIMITS.maxPointsPerSeries),
});
export type ChartSeries = z.infer<typeof chartSeriesSchema>;

export const chartSpecSchema = z.object({
  kind: z.literal("chart"),
  chartType: chartTypeSchema,
  title: label.nullable().default(null),
  xAxis: chartAxisSchema.default({ label: null, unit: null, scale: "band", min: null, max: null }),
  yAxis: chartAxisSchema.default({ label: null, unit: null, scale: "linear", min: null, max: null }),
  y2Axis: chartAxisSchema.nullable().default(null),
  series: z.array(chartSeriesSchema).min(1).max(VISUAL_SPEC_LIMITS.maxSeries),
  /** Source/footnote text printed on the chart, if any. */
  source: label.nullable().default(null),
  summary: z.string().max(VISUAL_SPEC_LIMITS.maxSummaryChars).default(""),
});
export type ChartSpec = z.infer<typeof chartSpecSchema>;

export const DIAGRAM_TYPES = ["flowchart", "sequence", "org-chart", "state", "er", "mindmap", "timeline", "other"] as const;
export const diagramTypeSchema = z.enum(DIAGRAM_TYPES);

export const diagramNodeSchema = z.object({
  id: z.string().min(1).max(64),
  label,
  shape: z.enum(["box", "rounded", "diamond", "circle", "stadium", "cylinder", "actor", "other"]).default("box"),
  /** Optional containing group (swimlane / subgraph) id. */
  group: z.string().max(64).nullable().default(null),
});
export const diagramEdgeSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  label: label.nullable().default(null),
  style: z.enum(["solid", "dashed", "thick"]).default("solid"),
  directed: z.boolean().default(true),
});
export const diagramGroupSchema = z.object({ id: z.string().min(1).max(64), label });

export const diagramSpecSchema = z.object({
  kind: z.literal("diagram"),
  diagramType: diagramTypeSchema,
  title: label.nullable().default(null),
  direction: z.enum(["TB", "LR", "BT", "RL"]).default("TB"),
  nodes: z.array(diagramNodeSchema).max(VISUAL_SPEC_LIMITS.maxNodes),
  edges: z.array(diagramEdgeSchema).max(VISUAL_SPEC_LIMITS.maxEdges),
  groups: z.array(diagramGroupSchema).max(64).default([]),
  summary: z.string().max(VISUAL_SPEC_LIMITS.maxSummaryChars).default(""),
});
export type DiagramSpec = z.infer<typeof diagramSpecSchema>;

export const visualSpecSchema = z.discriminatedUnion("kind", [chartSpecSchema, diagramSpecSchema]);
export type VisualSpec = z.infer<typeof visualSpecSchema>;

/**
 * Turn off zod's eval-compiled parsers (built with the Function constructor) for this process. The parser-VM chart
 * guest calls it at start, so no code is generated at run time. The CPU cost is nil: a fresh guest parses a few
 * schemas once (measured 134 vs 141 ms per run, performance/chart-export-free-rungs). Process-wide, so only for
 * single-purpose processes.
 */
export function disableSchemaJit(): void {
  z.config({ jitless: true });
}
