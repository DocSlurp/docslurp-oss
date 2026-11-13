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

/**
 * Deploy-wide default tier for app-origin runs on projects with no explicit tier: `free` (code default) or `off`. Lets a
 * deployment hold the app default off until the free steps pass their cost gate, without a code change.
 */
export const CHART_EXPORT_APP_DEFAULT_ENV_FLAG = "DOCSLURP_CHART_EXPORT_APP_DEFAULT";

/**
 * Whether a caller may choose `free` explicitly (a request override or a project's stored tier):
 * `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT`, `on` or `off` (default). Off, an explicit `free` is refused on requests and
 * project changes, and a stored `free` counts as unset (the origin default). Each free run boots an unbilled parser VM,
 * so only the deployment's own defaults may turn it on until extraction folds into a VM the document already boots.
 */
export const CHART_EXPORT_FREE_EXPLICIT_ENV_FLAG = "DOCSLURP_CHART_EXPORT_FREE_EXPLICIT";

type Env = Readonly<Record<string, string | undefined>>;

/** Free-tier chart-export parser-VM runs one organization may start per clock hour, across every worker. */
export const CHART_EXPORT_FREE_VM_CAP_ENV_FLAG = "DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR";
export const DEFAULT_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR = 200;

/** A cap value as a non-negative integer, or null when it is not one. */
export function parseChartExportFreeVmCap(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * The cap from `DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR`. Unset or empty: the default, which bounds the unbilled
 * parser-VM time one organization can cause per hour. Anything that is not a non-negative integer is 0 (no
 * free VM runs), failing toward lower cost like every other chart-export setting, and is named at startup by
 * `chartExportDefaultsWarnings`.
 */
export function chartExportFreeVmCap(env: Env): number {
  const raw = env[CHART_EXPORT_FREE_VM_CAP_ENV_FLAG];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR;
  return parseChartExportFreeVmCap(raw) ?? 0;
}

/**
 * Strict reader of an `off|free` default: unset gives `fallback`; the switch's off words (`off`, `0`, `false`, `no`,
 * empty) give `off`; `free` gives `free`; anything else is `off` (fail toward lower cost) and is named by
 * `chartExportDefaultsWarning`.
 */
function offOrFree(env: Env, flag: string, fallback: "off" | "free"): "off" | "free" {
  const raw = env[flag];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  return CHART_EXPORT_ENV_FREE_VALUES.includes(value) ? "free" : "off";
}

export function chartExportMachineDefault(env: Env): "off" | "free" {
  return offOrFree(env, CHART_EXPORT_API_DEFAULT_ENV_FLAG, "off");
}

export function chartExportAppDefault(env: Env): "off" | "free" {
  return offOrFree(env, CHART_EXPORT_APP_DEFAULT_ENV_FLAG, "free");
}

/** Whether an explicit `free` (request or project) is allowed: `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT=on` only. */
export function chartExportFreeExplicitAllowed(env: Env): boolean {
  return CHART_EXPORT_ENV_ON_VALUES.includes(env[CHART_EXPORT_FREE_EXPLICIT_ENV_FLAG]?.trim().toLowerCase() ?? "");
}

/**
 * Startup warnings for chart export defaults holding a value the parser does not know (each is treated as `off`).
 * Processes log them next to `chartExportSwitchWarning`.
 */
export function chartExportDefaultsWarnings(env: Env): string[] {
  const known = (value: string, extra: readonly string[]) => CHART_EXPORT_ENV_OFF_VALUES.includes(value) || extra.includes(value);
  const out: string[] = [];
  for (const flag of [CHART_EXPORT_API_DEFAULT_ENV_FLAG, CHART_EXPORT_APP_DEFAULT_ENV_FLAG]) {
    const raw = env[flag];
    if (raw !== undefined && !known(raw.trim().toLowerCase(), CHART_EXPORT_ENV_FREE_VALUES)) {
      out.push(`[chart-export] ${flag} has an unknown value; the default is off (expected off or free)`);
    }
  }
  const cap = env[CHART_EXPORT_FREE_VM_CAP_ENV_FLAG];
  if (cap !== undefined && cap.trim() !== "" && parseChartExportFreeVmCap(cap) === null) {
    out.push(`[chart-export] ${CHART_EXPORT_FREE_VM_CAP_ENV_FLAG} is not a non-negative integer; free VM runs are stopped (cap 0)`);
  }
  const explicit = env[CHART_EXPORT_FREE_EXPLICIT_ENV_FLAG];
  if (explicit !== undefined && !known(explicit.trim().toLowerCase(), CHART_EXPORT_ENV_ON_VALUES)) {
    out.push(`[chart-export] ${CHART_EXPORT_FREE_EXPLICIT_ENV_FLAG} has an unknown value; an explicit free tier is refused (expected off or on)`);
  }
  return out;
}

/** The default tier for a run of `origin` on a project with no explicit tier: the app default (free) or the machine default (off). */
export function defaultChartExportTier(origin: RunOrigin, env: Env): ChartExportTier {
  return origin === "app" ? chartExportAppDefault(env) : chartExportMachineDefault(env);
}

/**
 * The defaults a deployment reports to clients (`project.chartExportDefaults`): the tier each origin runs on a project
 * with no tier (after the kill switch), whether `models` may be chosen, and whether `free` may be chosen explicitly.
 * Clients classify settings changes and label the "default" option from this, never from a code default.
 */
export type ChartExportDefaults = {
  app: ChartExportTier;
  machine: ChartExportTier;
  modelsAvailable: boolean;
  freeAvailable: boolean;
  /** The kill switch (`DOCSLURP_CHART_EXPORT`): the most any tier runs as. */
  ceiling: ChartExportSwitch;
};

export function chartExportDefaults(env: Env): ChartExportDefaults {
  const capped = (tier: ChartExportTier) => effectiveChartExportConfig({ ...defaultChartExportConfig, tier }, env).tier;
  return {
    app: capped(defaultChartExportTier("app", env)),
    machine: capped(defaultChartExportTier("machine", env)),
    modelsAvailable: chartExportModelsAvailable(env),
    freeAvailable: chartExportFreeExplicitAllowed(env) && chartExportSwitch(env) !== "off",
    ceiling: chartExportSwitch(env),
  };
}

/**
 * The tier that runs for a project's stored tier on a deployment described by `defaults` (what a server reports), for
 * clients that classify settings changes without the server's environment: an explicit `free` the deployment does not
 * allow counts as unset, unset is the origin default, and the ceiling caps the result.
 */
export function effectiveTierFromDefaults(stored: ChartExportTier | null | undefined, origin: RunOrigin, defaults: ChartExportDefaults): ChartExportTier {
  const explicit = stored === "free" && !defaults.freeAvailable ? undefined : stored ?? undefined;
  const tier = explicit ?? (origin === "app" ? defaults.app : defaults.machine);
  if (defaults.ceiling === "off" || tier === "off") return "off";
  if (tier === "models" && (defaults.ceiling !== "on" || !defaults.modelsAvailable)) return "free";
  return tier;
}

/** The most conservative defaults, for a client whose server reports none (an older server): nothing runs. */
export const CONSERVATIVE_CHART_EXPORT_DEFAULTS: ChartExportDefaults = { app: "off", machine: "off", modelsAvailable: false, freeAvailable: false, ceiling: "off" };

/**
 * The tier one run uses, before the deploy ceiling: a per-request override, else the project's explicit tier, else the
 * origin default. An explicit `free` counts only while `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT=on`; otherwise it is the
 * origin default (requests that ask for it are refused earlier, `chartExportOverrideRefusal`). The deploy kill switch
 * (`effectiveChartExportConfig`) then caps it; it is never raised by this.
 */
export function resolveChartExportTier(args: {
  requested?: ChartExportTier | null | undefined;
  project?: Pick<ChartExportConfig, "tier"> | null | undefined;
  origin: RunOrigin;
  env: Env;
}): ChartExportTier {
  const usable = (tier: ChartExportTier | null | undefined) => explicitProjectChartTier({ tier: tier ?? undefined }, args.env);
  return usable(args.requested) ?? usable(args.project?.tier) ?? defaultChartExportTier(args.origin, args.env);
}

/** off < free < models. */
export const CHART_EXPORT_TIER_RANK: Readonly<Record<ChartExportTier, number>> = { off: 0, free: 1, models: 2 };

/** The lower of two tiers. */
export function minChartExportTier(a: ChartExportTier, b: ChartExportTier): ChartExportTier {
  return CHART_EXPORT_TIER_RANK[a] <= CHART_EXPORT_TIER_RANK[b] ? a : b;
}

/**
 * A project's explicit chart tier as the deployment honours it: its stored tier, except a `free` while explicit free is
 * not allowed (`DOCSLURP_CHART_EXPORT_FREE_EXPLICIT`), which counts as unset. Undefined when the project has none. The
 * one rule for "is this project's tier explicit" (run resolution, reindex, full index).
 */
export function explicitProjectChartTier(project: Pick<ChartExportConfig, "tier"> | null | undefined, env: Env): ChartExportTier | undefined {
  const tier = project?.tier;
  return tier === "free" && !chartExportFreeExplicitAllowed(env) ? undefined : tier ?? undefined;
}

/**
 * The most a replayed or inherited tier may run at in a project now (reprocess, bulk reprocess, reindex, full index):
 * the project's explicit tier, else the higher of the two origin defaults (an unset project never resolves to `models`).
 * A replay never raises a run above this; only an explicit request override can, through the editor/scope ceiling.
 */
export function projectChartExportTierCap(project: Pick<ChartExportConfig, "tier"> | null | undefined, env: Env): ChartExportTier {
  const explicit = explicitProjectChartTier(project, env);
  if (explicit) return explicit;
  const app = defaultChartExportTier("app", env);
  const machine = defaultChartExportTier("machine", env);
  return CHART_EXPORT_TIER_RANK[app] >= CHART_EXPORT_TIER_RANK[machine] ? app : machine;
}

/** The project's chart export config with its tier resolved for one run (see `resolveChartExportTier`). */
export function resolveChartExportConfig(args: {
  requested?: ChartExportTier | null | undefined;
  project?: ChartExportConfig | null | undefined;
  origin: RunOrigin;
  env: Env;
}): ResolvedChartExportConfig {
  return { ...(args.project ?? defaultChartExportConfig), tier: resolveChartExportTier(args) };
}

/**
 * Whether chart export runs at all for a resolved config on this deployment: its tier is not `off` and the kill switch
 * is not `off`. With the switch on `free`, only the deterministic steps run.
 */
export function chartExportRuns(config: Pick<ResolvedChartExportConfig, "tier">, env: Env): boolean {
  return config.tier !== "off" && chartExportSwitch(env) !== "off";
}

/** Whether the billed model steps may run: the resolved tier is `models` and the kill switch is `on`. */
export function chartExportModelsAllowed(config: Pick<ResolvedChartExportConfig, "tier">, env: Env): boolean {
  return config.tier === "models" && chartExportSwitch(env) === "on";
}

/**
 * The tier that actually runs: the resolved tier capped by the kill switch (`off` -> off, `free` -> at most free).
 */
export function effectiveChartExportConfig(config: ResolvedChartExportConfig, env: Env): ResolvedChartExportConfig {
  const tier: ChartExportTier = !chartExportRuns(config, env) ? "off" : chartExportModelsAllowed(config, env) ? "models" : "free";
  return tier === config.tier ? config : { ...config, tier };
}

/**
 * The one public code for a tier a caller may not choose on this deployment, with status 400, on every surface
 * (uploads, URL ingest, direct sessions, extracts, web crawl, reprocess, estimates, project changes, chat proposals).
 */
export const CHART_EXPORT_TIER_UNAVAILABLE_CODE = "chart_export_tier_unavailable" as const;

/**
 * Why an explicitly chosen tier (request override or project change) is refused on this deployment, or null when it is
 * allowed: `models` while the switch is not `on`; `free` while `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT` is not `on` or the
 * switch is `off`. `off` is always allowed.
 */
export function chartExportOverrideRefusal(tier: ChartExportTier, env: Env): typeof CHART_EXPORT_TIER_UNAVAILABLE_CODE | null {
  if (tier === "models") return chartExportSwitch(env) === "on" ? null : CHART_EXPORT_TIER_UNAVAILABLE_CODE;
  if (tier === "free") return chartExportFreeExplicitAllowed(env) && chartExportSwitch(env) !== "off" ? null : CHART_EXPORT_TIER_UNAVAILABLE_CODE;
  return null;
}

/**
 * Stored chart export config (projects, runs, upload sessions, settings snapshots in the audit log, saved chat proposals
 * and ingest-report patches) as the current schema reads it. Rows written before migration 0145, or by an older API
 * during a deploy, carry `enabled` and `generatorModel`: `enabled: true` with no `tier` becomes `tier: "models"`, and
 * both legacy keys are dropped. Applied on read, so a row the migration missed still parses. Request schemas stay
 * strict and never call this. Anything that is not an object is returned unchanged (strict parsing then rejects it).
 */
export function upgradeStoredChartExport(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (!("enabled" in record) && !("generatorModel" in record)) return raw;
  const { enabled, generatorModel: _generatorModel, ...rest } = record;
  return enabled === true && rest.tier === undefined ? { ...rest, tier: "models" } : rest;
}

/** A stored pipeline (or pipeline patch) with its `chartExport` upgraded (`upgradeStoredChartExport`); other keys untouched. */
export function upgradeStoredPipelineChartExport<T>(pipeline: T): T {
  if (!pipeline || typeof pipeline !== "object" || Array.isArray(pipeline)) return pipeline;
  const record = pipeline as Record<string, unknown>;
  if (!("chartExport" in record)) return pipeline;
  const upgraded = upgradeStoredChartExport(record.chartExport);
  return upgraded === record.chartExport ? pipeline : ({ ...record, chartExport: upgraded } as T);
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
/**
 * A visual the free (deterministic) extractor deferred instead of finishing in the document's run, for a later
 * low-priority pass. `input` says what to re-read: the document's own source file, or one of its Doppler figure files
 * (`figureId`, the figure's own id; its slot is `doppler-figure:<figureId>`). `svgIndex` is the SVG's ordinal within that
 * input (document / package order), and `reason` a closed slug: nothing from the input's names or content is stored.
 */
export const DEFERRED_VISUAL_REASONS = ["svg-document-limit"] as const;
export const deferredVisualSchema = z.strictObject({
  input: z.enum(["source", "doppler-figure"]),
  svgIndex: z.number().int().nonnegative().max(1_000_000),
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
