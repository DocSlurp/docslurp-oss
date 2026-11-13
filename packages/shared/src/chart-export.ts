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
 * Deployment kill switch for chart & diagram export: `DOCSLURP_CHART_EXPORT`, three values (trimmed, any case).
 *
 * - `off` (or unset): nothing runs, whatever projects say. Estimates price nothing; chat and the ingest report never
 *   suggest it; the settings API refuses to turn on the `models` tier.
 * - `free`: only the free deterministic steps run (Office chart parts, embedded chart specs, SVG geometry), whatever
 *   projects say. No model is ever called and nothing is billed, so a project on `models` behaves as `free`.
 * - `on` (also `1`, `true`, `yes`): the free steps, plus each project's opted-in model steps (tier `models`, billed).
 *
 * An unknown value is `off` (fail closed); `chartExportSwitchWarning` names it so processes can warn at startup. A project
 * keeps its stored tier whatever the switch says; the switch only caps what runs.
 */
export const CHART_EXPORT_ENV_FLAG = "DOCSLURP_CHART_EXPORT";

export const CHART_EXPORT_SWITCH_VALUES = ["off", "free", "on"] as const;
export type ChartExportSwitch = (typeof CHART_EXPORT_SWITCH_VALUES)[number];

/** Values of `DOCSLURP_CHART_EXPORT` that mean `on` (compared trimmed and lower-cased). */
export const CHART_EXPORT_ENV_ON_VALUES: readonly string[] = ["on", "1", "true", "yes"];
/** Values that mean `free`. */
export const CHART_EXPORT_ENV_FREE_VALUES: readonly string[] = ["free"];
/** Values that mean `off` without a warning. */
export const CHART_EXPORT_ENV_OFF_VALUES: readonly string[] = ["", "off", "0", "false", "no"];

/**
 * The one parser of the kill switch, used by the worker, estimates and the server alike. `env` is explicit so browsers
 * and tests never read `process`. Unset and unknown values are `off`.
 */
export function chartExportSwitch(env: Readonly<Record<string, string | undefined>>): ChartExportSwitch {
  const value = env[CHART_EXPORT_ENV_FLAG]?.trim().toLowerCase();
  if (value === undefined) return "off";
  if (CHART_EXPORT_ENV_ON_VALUES.includes(value)) return "on";
  if (CHART_EXPORT_ENV_FREE_VALUES.includes(value)) return "free";
  return "off";
}

/** A startup warning when `DOCSLURP_CHART_EXPORT` holds a value the parser does not know (it is treated as `off`). */
export function chartExportSwitchWarning(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env[CHART_EXPORT_ENV_FLAG];
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (CHART_EXPORT_ENV_ON_VALUES.includes(value) || CHART_EXPORT_ENV_FREE_VALUES.includes(value) || CHART_EXPORT_ENV_OFF_VALUES.includes(value)) return null;
  return `[chart-export] ${CHART_EXPORT_ENV_FLAG} has an unknown value; chart export is off (expected off, free or on)`;
}

/** Whether this deployment allows the billed model steps (`DOCSLURP_CHART_EXPORT=on`). */
export function chartExportModelsAvailable(env: Readonly<Record<string, string | undefined>>): boolean {
  return chartExportSwitch(env) === "on";
}

/**
 * Chart export tier. `off`: nothing. `free`: the deterministic steps only (`office-chart-xml`, `embedded-spec`,
 * `svg-geometry`); no model client is built and nothing is billed. `models`: the free steps plus the model steps
 * (`svg-assisted`, `vision`), billed per visual a model reads.
 */
export const CHART_EXPORT_TIERS = ["off", "free", "models"] as const;
export const chartExportTierSchema = z.enum(CHART_EXPORT_TIERS);
export type ChartExportTier = z.infer<typeof chartExportTierSchema>;

/**
 * Per-project option (`pipeline.features.chartExport`). `tier` unset means "the default for the run's origin"
 * (`resolveChartExportTier`): stored config never pins a concrete default, so one project serves the app (free steps on)
 * and machine callers (off unless asked) alike.
 */
export const chartExportConfigSchema = z
  .object({
    tier: chartExportTierSchema.optional(),
    formats: z.array(chartExportFormatSchema).min(1).max(CHART_EXPORT_FORMATS.length).default(["description", "mermaid"]),
    /** Also export diagrams (flowcharts, org charts, sequence/state diagrams) as Mermaid + description. */
    diagrams: z.boolean().default(true),
    // No model field: callers choose a tier, never a backend model. The generator is chosen internally from managed
    // settings (the routing catalog); `strict()` refuses a `generatorModel` key with a validation error.
  })
  .strict();
export type ChartExportConfig = z.infer<typeof chartExportConfigSchema>;
/** A config whose tier was resolved for one run (`resolveChartExportTier`); what the worker reads. */
export type ResolvedChartExportConfig = ChartExportConfig & { tier: ChartExportTier };
export const defaultChartExportConfig: ChartExportConfig = {
  formats: ["description", "mermaid"],
  diagrams: true,
};

/**
 * Where a run comes from, decided server-side from the authenticated principal (never from a request field):
 * `app` is a first-party browser session (upload UI, chat); `machine` is an API key, MCP token, SDK, CLI, connector or
 * any other programmatic caller.
 */
export const RUN_ORIGINS = ["app", "machine"] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

/**
 * Deploy-wide default tier for machine-origin runs on projects with no explicit tier: `off` (default) or `free`.
 * Flipped without a code change once the free steps cost and run close enough to having them off.
 */
export const CHART_EXPORT_API_DEFAULT_ENV_FLAG = "DOCSLURP_CHART_EXPORT_API_DEFAULT";

export function chartExportMachineDefault(env: Readonly<Record<string, string | undefined>>): "off" | "free" {
  return env[CHART_EXPORT_API_DEFAULT_ENV_FLAG]?.trim().toLowerCase() === "free" ? "free" : "off";
}

/**
 * Deploy-wide default tier for app-origin runs on projects with no explicit tier: `free` (default) or `off`. Lets a
 * deployment hold the app default off until the free steps pass their cost gate, without a code change.
 */
export const CHART_EXPORT_APP_DEFAULT_ENV_FLAG = "DOCSLURP_CHART_EXPORT_APP_DEFAULT";

export function chartExportAppDefault(env: Readonly<Record<string, string | undefined>>): "off" | "free" {
  return env[CHART_EXPORT_APP_DEFAULT_ENV_FLAG]?.trim().toLowerCase() === "off" ? "off" : "free";
}

/** The default tier for a run of `origin` on a project with no explicit tier: the app default (free) or the machine default (off). */
export function defaultChartExportTier(origin: RunOrigin, env: Readonly<Record<string, string | undefined>>): ChartExportTier {
  return origin === "app" ? chartExportAppDefault(env) : chartExportMachineDefault(env);
}

/**
 * The tier one run uses, before the deploy ceiling: a per-request override, else the project's explicit tier, else the
 * origin default. The deploy kill switch (`effectiveChartExportConfig`) then caps it; it is never raised by this.
 */
export function resolveChartExportTier(args: {
  requested?: ChartExportTier | null | undefined;
  project?: Pick<ChartExportConfig, "tier"> | null | undefined;
  origin: RunOrigin;
  env: Readonly<Record<string, string | undefined>>;
}): ChartExportTier {
  return args.requested ?? args.project?.tier ?? defaultChartExportTier(args.origin, args.env);
}

/** The project's chart export config with its tier resolved for one run (see `resolveChartExportTier`). */
export function resolveChartExportConfig(args: {
  requested?: ChartExportTier | null | undefined;
  project?: ChartExportConfig | null | undefined;
  origin: RunOrigin;
  env: Readonly<Record<string, string | undefined>>;
}): ResolvedChartExportConfig {
  return { ...(args.project ?? defaultChartExportConfig), tier: resolveChartExportTier(args) };
}

/**
 * Whether chart export runs at all for a resolved config on this deployment: its tier is not `off` and the kill switch
 * is not `off`. With the switch on `free`, only the deterministic steps run.
 */
export function chartExportRuns(config: Pick<ResolvedChartExportConfig, "tier">, env: Readonly<Record<string, string | undefined>>): boolean {
  return config.tier !== "off" && chartExportSwitch(env) !== "off";
}

/** Whether the billed model steps may run: the resolved tier is `models` and the kill switch is `on`. */
export function chartExportModelsAllowed(config: Pick<ResolvedChartExportConfig, "tier">, env: Readonly<Record<string, string | undefined>>): boolean {
  return config.tier === "models" && chartExportSwitch(env) === "on";
}

/**
 * The tier that actually runs: the resolved tier capped by the kill switch (`off` -> off, `free` -> at most free).
 */
export function effectiveChartExportConfig(config: ResolvedChartExportConfig, env: Readonly<Record<string, string | undefined>>): ResolvedChartExportConfig {
  const tier: ChartExportTier = !chartExportRuns(config, env) ? "off" : chartExportModelsAllowed(config, env) ? "models" : "free";
  return tier === config.tier ? config : { ...config, tier };
}

/** Why a per-request tier override is refused on this deployment, or null when it is allowed. */
export function chartExportOverrideRefusal(
  tier: ChartExportTier,
  env: Readonly<Record<string, string | undefined>>,
): "chart_export_models_unavailable" | null {
  return tier === "models" && chartExportSwitch(env) !== "on" ? "chart_export_models_unavailable" : null;
}

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
export const visualCandidateStatsSchema = z.object({
  charts: z.number().int().nonnegative().default(0),
  diagrams: z.number().int().nonnegative().default(0),
  /** Pages where a chart/diagram became an image placeholder or a table guess with no structured data. */
  pagesWithUnexportedVisuals: z.array(z.number().int().positive()).max(5000).default([]),
  exported: z.number().int().nonnegative().default(0),
  bySource: z.partialRecord(visualSourceSchema, z.number().int().nonnegative()).default({}),
});
export type VisualCandidateStats = z.infer<typeof visualCandidateStatsSchema>;

/** Key under document metadata / stage stats where `VisualCandidateStats` is stored. */
export const VISUAL_CANDIDATE_STATS_KEY = "visualCandidates" as const;
