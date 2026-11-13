import { z } from "zod";

/**
 * Chart & diagram export: shared contract.
 *
 * A detected chart or diagram is re-expressed as one or more text formats. Every extraction path (native chart data in
 * Office files, embedded chart specs, SVG geometry, image + geometry digest, image only) produces a `VisualSpec` when
 * it can; deterministic renderers then derive each requested format from that spec. A model may also emit a format
 * directly (`outputs` without a spec) when the evaluation shows that is better for that format.
 */

export const CHART_EXPORT_FORMATS = ["description", "mermaid", "vega-lite", "matplotlib", "csv"] as const;
export const chartExportFormatSchema = z.enum(CHART_EXPORT_FORMATS);
export type ChartExportFormat = z.infer<typeof chartExportFormatSchema>;

/**
 * Deployment kill switch for chart & diagram export: `DOCSLURP_CHART_EXPORT=on` (or `1`, `true`, `yes`; any case)
 * makes the project option effective; anything else (unset, `off`, a typo) keeps it off everywhere. The worker never exports, estimates price nothing,
 * chat and the ingest report never suggest it, and the settings API refuses to turn it on. A project that already
 * has it on keeps the stored value; it simply has no effect while the switch is off.
 */
export const CHART_EXPORT_ENV_FLAG = "DOCSLURP_CHART_EXPORT";

/** Values of `DOCSLURP_CHART_EXPORT` that turn the switch on (compared trimmed and lower-cased). */
export const CHART_EXPORT_ENV_ON_VALUES: readonly string[] = ["on", "1", "true", "yes"];

/**
 * Whether this deployment allows chart export: the one parser of the kill switch, used by the worker, estimates and
 * the server alike. `env` is explicit so browsers and tests never read `process`.
 */
export function chartExportAvailable(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[CHART_EXPORT_ENV_FLAG]?.trim().toLowerCase();
  return value !== undefined && CHART_EXPORT_ENV_ON_VALUES.includes(value);
}

/** Per-project option (`pipeline.features.chartExport`). Off by default; turning it on recommends a reindex. */
export const chartExportConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    formats: z.array(chartExportFormatSchema).min(1).max(CHART_EXPORT_FORMATS.length).default(["description", "mermaid"]),
    /** Also export diagrams (flowcharts, org charts, sequence/state diagrams) as Mermaid + description. */
    diagrams: z.boolean().default(true),
    /** Optional generator override (`llm://provider/model`). Admitted through the routing-target catalog like any target. */
    generatorModel: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();
export type ChartExportConfig = z.infer<typeof chartExportConfigSchema>;
export const defaultChartExportConfig: ChartExportConfig = {
  enabled: false,
  formats: ["description", "mermaid"],
  diagrams: true,
  generatorModel: null,
};

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

// ---- Results ----------------------------------------------------------------------------------------------------

/** Cheapest first. Deterministic sources never call a model. */
export const VISUAL_SOURCES = [
  "office-chart-xml", // DOCX/PPTX/XLSX chart parts carry the series values
  "embedded-spec", // Vega/Vega-Lite/Plotly JSON embedded in HTML/SVG
  "svg-geometry", // SVG marks inverted through axis tick labels
  "svg-assisted", // image + compact geometry digest; model names series, numbers come from geometry
  "vision", // image only
] as const;
export const visualSourceSchema = z.enum(VISUAL_SOURCES);
export type VisualSource = z.infer<typeof visualSourceSchema>;

export const exportedVisualSchema = z.object({
  id: z.string().min(1),
  /**
   * Page the visual sits on; null when the document has no known pages (DOCX, XLSX, or slides whose mapping to pages is
   * not reliable): the visual is then appended to the document as an unpaged block, like the document's own text.
   */
  pageNumber: z.number().int().positive().nullable(),
  /** Image index within the page (matches `**Chart data (image N)**` anchors), when the visual came from an image. */
  imageIndex: z.number().int().nonnegative().nullable().default(null),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null),
  kind: z.enum(["chart", "diagram"]),
  source: visualSourceSchema,
  /** 0..1. Deterministic paths report how well axes/marks resolved; model paths report calibrated confidence. */
  confidence: z.number().min(0).max(1),
  spec: visualSpecSchema.nullable().default(null),
  outputs: z.partialRecord(chartExportFormatSchema, z.string()).default({}),
  /** Generator model id when a model was called (`null` for deterministic sources). */
  model: z.string().nullable().default(null),
  /** Formats requested but not produced, with a short machine reason (never raw provider error text). */
  skipped: z.array(z.object({ format: chartExportFormatSchema, reason: z.string().max(120) })).default([]),
});
export type ExportedVisual = z.infer<typeof exportedVisualSchema>;

/**
 * Per-document visual stats, recorded at ingest even when chart export is off (free signals only), so chat suggestions
 * and the ingest report can say "this project has N charts that were not exported".
 */
/**
 * A visual the free (deterministic) extractor deferred instead of finishing in the document's run, for a later
 * low-priority pass. `input` says what to re-read: the document's own source file, or one of its Doppler figure files
 * (`figureId`, the figure's own id; its slot is `doppler-figure:<figureId>`). `svgIndex` is the first deferred SVG's
 * ordinal within that input (document / package order), `count` how many from there, and `reason` a closed slug:
 * nothing from the input's names or content is stored.
 */
export const DEFERRED_VISUAL_REASONS = ["svg-document-limit"] as const;
export const deferredVisualSchema = z.strictObject({
  input: z.enum(["source", "doppler-figure"]),
  svgIndex: z.number().int().nonnegative().max(1_000_000),
  /** How many consecutive SVGs from `svgIndex` on were deferred. */
  count: z.number().int().positive().max(1_000_000),
  reason: z.enum(DEFERRED_VISUAL_REASONS),
  pageNumber: z.number().int().positive().nullable(),
  figureId: z.string().max(200).nullable(),
});
export type DeferredVisual = z.infer<typeof deferredVisualSchema>;

export const visualCandidateStatsSchema = z.object({
  charts: z.number().int().nonnegative().default(0),
  diagrams: z.number().int().nonnegative().default(0),
  /** Pages where a chart/diagram became an image placeholder or a table guess with no structured data. */
  pagesWithUnexportedVisuals: z.array(z.number().int().positive()).max(5000).default([]),
  exported: z.number().int().nonnegative().default(0),
  bySource: z.partialRecord(visualSourceSchema, z.number().int().nonnegative()).default({}),
  /** Visuals deferred to a later pass (present only when some were): never dropped, picked up by the deferred pass. */
  deferred: z.array(deferredVisualSchema).max(1000).optional(),
});
export type VisualCandidateStats = z.infer<typeof visualCandidateStatsSchema>;

/**
 * The deferred visuals recorded in a stage's stats (`stats[VISUAL_CANDIDATE_STATS_KEY].deferred`): what a later pass
 * reads to find work. Tolerant of missing or malformed stats (returns []); every entry is validated.
 */
export function deferredVisualsOf(stageStats: unknown): DeferredVisual[] {
  const stats = stageStats && typeof stageStats === "object" ? (stageStats as Record<string, unknown>)[VISUAL_CANDIDATE_STATS_KEY] : null;
  const list = stats && typeof stats === "object" ? (stats as Record<string, unknown>).deferred : null;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 1000).flatMap((entry) => { const parsed = deferredVisualSchema.safeParse(entry); return parsed.success ? [parsed.data] : []; });
}

/** Key under document metadata / stage stats where `VisualCandidateStats` is stored. */
export const VISUAL_CANDIDATE_STATS_KEY = "visualCandidates" as const;
