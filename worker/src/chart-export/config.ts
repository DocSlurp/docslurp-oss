/**
 * Chart export configuration: the project option accessor, per-format generation mode and the ladder thresholds.
 */
import {
  CHART_EXPORT_DOCUMENT_CAPS,
  chartExportConfigSchema,
  chartExportModelsAllowed,
  chartExportRuns,
  chartExportSwitch,
  chartExportSwitchWarning,
  chartExportDefaultsWarnings,
  upgradeStoredChartExport,
  defaultChartExportConfig,
  effectiveChartExportConfig,
  resolveChartExportConfig,
  type ChartExportConfig,
  type ResolvedChartExportConfig,
  type ChartExportFormat,
  type ChartExportSwitch,
} from "@docslurp/shared";

/**
 * The deployment kill switch (`DOCSLURP_CHART_EXPORT=off|free|on`, unset and unknown values are `off`), read here and
 * nowhere else in the worker; parsed by the shared `chartExportSwitch`, the same function estimates and the server use.
 */
export function chartExportSwitchOf(env: Readonly<Record<string, string | undefined>> = process.env): ChartExportSwitch {
  return chartExportSwitch(env);
}

let switchWarned = false;
/** Logs once per process when the switch holds an unknown value (it is treated as `off`). Called at worker startup. */
export function warnChartExportSwitch(env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (switchWarned) return;
  const warnings = [chartExportSwitchWarning(env), ...chartExportDefaultsWarnings(env)].filter((w): w is string => Boolean(w));
  if (warnings.length > 0) {
    switchWarned = true;
    for (const warning of warnings) console.warn(warning);
  }
}

/**
 * The run's `pipeline.chartExport` as it runs on this deployment. The server stamps the resolved tier on every run at
 * creation (request override, project tier, origin default); the kill switch then caps it (`off` -> off, `free` -> at
 * most free). A run without a stamped tier, or with a malformed config, resolves as a machine-origin run (`off` unless
 * `DOCSLURP_CHART_EXPORT_API_DEFAULT=free`): it fails closed and never reaches the billed `models` tier.
 */
export function chartExportConfigOf(pipeline: unknown, env: Readonly<Record<string, string | undefined>> = process.env): ResolvedChartExportConfig {
  const raw = pipeline && typeof pipeline === "object" ? (pipeline as { chartExport?: unknown }).chartExport : undefined;
  // Runs written before migration 0145 or by an older API during a deploy carry `enabled`/`generatorModel`: mapped on
  // read (`enabled: true` -> `models`), so a skew-window run keeps the tier it was created with.
  const parsed = raw === undefined || raw === null ? null : chartExportConfigSchema.safeParse(upgradeStoredChartExport(raw));
  const project = parsed?.success ? parsed.data : defaultChartExportConfig;
  // A stamped tier is already resolved (the server applied overrides, project tier, origin default and the explicit-free
  // gate at run creation): it is used as is, only capped by the switch. Unstamped resolves as a machine run.
  const resolved: ResolvedChartExportConfig = project.tier
    ? { ...project, tier: project.tier }
    : resolveChartExportConfig({ project, origin: "machine", env });
  return effectiveChartExportConfig(resolved, env);
}

/** Whether chart export runs for this run's pipeline (any tier but off, kill switch not off). */
export function chartExportActive(pipeline: unknown, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return chartExportRuns(chartExportConfigOf(pipeline, env), env);
}

/** Whether the billed model steps may run for this run's pipeline (tier `models`, kill switch `on`). */
export function chartExportModelsActive(pipeline: unknown, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return chartExportModelsAllowed(chartExportConfigOf(pipeline, env), env);
}

/**
 * How a model produces each format. `derived`: one call returns a `VisualSpec` and code renders every derived format;
 * `direct`: one call per format returns that format. Deterministic sources always use derived. All derived until the
 * evaluation (S4) reports a per-format winner by score per dollar.
 */
export const FORMAT_MODE: Record<ChartExportFormat, "derived" | "direct"> = {
  description: "derived",
  mermaid: "derived",
  "vega-lite": "derived",
  matplotlib: "derived",
  csv: "derived",
};

/** A deterministic spec at or above this confidence is used as is: no model call. */
export const DETERMINISTIC_HIGH_CONFIDENCE = 0.85;
/** A deterministic partial at or above this (and below high) with a digest goes `svg-assisted`. */
export const DETERMINISTIC_ASSISTED_MIN_CONFIDENCE = 0.4;
/** A deterministic spec with no image to fall back on is still exported at or above this confidence. */
export const DETERMINISTIC_STANDALONE_MIN_CONFIDENCE = 0.6;

/** Calibrated confidence reported for model paths until the evaluation fits them. */
export const MODEL_CONFIDENCE = { "svg-assisted": 0.75, vision: 0.6, repairPenalty: 0.8 } as const;

/** Visuals a model reads per document, each charged (shared with estimates, which clamp billable visuals to it). */
export const MAX_MODEL_READS_PER_DOCUMENT = CHART_EXPORT_DOCUMENT_CAPS.maxModelReadsPerDocument;
/** Exported visuals per document, free ones included: an output-size bound. */
export const MAX_VISUALS_PER_DOCUMENT = CHART_EXPORT_DOCUMENT_CAPS.maxVisualsPerDocument;
/** Generator calls per document, whatever their outcome (failed and `none` answers count). */
export const MAX_GENERATOR_CALLS_PER_DOCUMENT = CHART_EXPORT_DOCUMENT_CAPS.maxGeneratorCallsPerDocument;
/** Whole-page rasters sent to the generator per document (no router crop: the expensive path). */
export const MAX_LEGACY_PAGE_EXPORTS_PER_DOCUMENT = CHART_EXPORT_DOCUMENT_CAPS.maxLegacyPageExportsPerDocument;
/**
 * Generator calls per run across its documents, within one worker process (a backstop on top of the cost cap; estimates
 * price visuals, already bounded per document, so they do not need it).
 */
export const MAX_GENERATOR_CALLS_PER_RUN = 20_000;

/** Bounds on what one document may spend on export. */
export const CHART_EXPORT_LIMITS = {
  maxModelReadsPerDocument: MAX_MODEL_READS_PER_DOCUMENT,
  maxVisualsPerDocument: MAX_VISUALS_PER_DOCUMENT,
  maxGeneratorCallsPerDocument: MAX_GENERATOR_CALLS_PER_DOCUMENT,
  /** Legacy pages sent whole (no router crop): the expensive path, so capped separately. */
  maxLegacyPagesPerDocument: MAX_LEGACY_PAGE_EXPORTS_PER_DOCUMENT,
  maxDigestChars: 4000,
  /** Model output kept per format before validation (longer is refused). */
  maxOutputChars: 60_000,
  /**
   * Output token cap of a spec, repair or direct call (`max_tokens`, never above the model's own cap): above the longest
   * spec and repair answers measured on real documents, with headroom, and it bounds what a hostile page can make one
   * call write (the shared vision cap is 8-16k).
   */
  maxOutputTokensPerCall: 2_048,
  /**
   * Cap of the one retry after a spec answer was cut off at `maxOutputTokensPerCall` (lowest cap first, then more
   * tokens). The retry replaces the repair, so a read makes at most two calls before its direct formats.
   */
  maxExpandedOutputTokens: 3_072,
  /**
   * A repair re-emits about the same spec: its cap is the first answer's output plus this slack (at least
   * `minRepairOutputTokens`, at most `maxOutputTokensPerCall`).
   */
  repairOutputSlackTokens: 512,
  minRepairOutputTokens: 512,
  /** Characters of the invalid first answer echoed into the repair prompt (bounds the repair's input). */
  maxRepairEchoChars: 4_000,
  /**
   * Largest image a chart call sends, in the generator's own image tokens at the image's size (a letter page at 200 DPI
   * is about 9,200 on a patch-priced model). A larger image, or one of unknown size, gets no model read: the visual
   * keeps its deterministic or description fallback, and the page's own transcription is unaffected.
   */
  maxImageTokensPerCall: 10_240,
} as const;

/**
 * Runtime options for one chart-export model call: its own output cap, the image limit, and exactly one billed request
 * (no stream retry or streaming fallback; a cut-off answer comes back with `finishReason: "length"` so the generator
 * can retry once at the larger cap). Used by the chart model client in `stages/vision-extract.ts`.
 */
export function chartCallRuntimeOptions(request: { maxOutputTokens?: number }): { maxOutputTokens: number; maxImageTokens: number; singleAttempt: true } {
  return {
    maxOutputTokens: request.maxOutputTokens ?? CHART_EXPORT_LIMITS.maxOutputTokensPerCall,
    maxImageTokens: CHART_EXPORT_LIMITS.maxImageTokensPerCall,
    singleAttempt: true,
  };
}

/** Output cap of the repair after a first answer of `firstOutputTokens` (see `CHART_EXPORT_LIMITS`). */
export function repairOutputTokenCap(firstOutputTokens: number): number {
  const first = Number.isFinite(firstOutputTokens) ? Math.max(0, Math.trunc(firstOutputTokens)) : CHART_EXPORT_LIMITS.maxOutputTokensPerCall;
  return Math.min(
    CHART_EXPORT_LIMITS.maxOutputTokensPerCall,
    Math.max(CHART_EXPORT_LIMITS.minRepairOutputTokens, first + CHART_EXPORT_LIMITS.repairOutputSlackTokens),
  );
}

/** Whether a call's answer was cut off at its output cap (provider `length`, or the whole cap used). */
export function answerHitOutputCap(response: { finishReason?: string | null; outputTokens: number }, cap: number): boolean {
  const reason = response.finishReason?.toLowerCase();
  return reason === "length" || reason === "max_tokens" || response.outputTokens >= cap;
}

/** Formats the generator should produce for a visual of `kind` (diagrams carry no data series). */
export function formatsFor(config: ChartExportConfig, kind: "chart" | "diagram" | null): ChartExportFormat[] {
  const unique = [...new Set(config.formats)];
  if (kind !== "diagram") return unique;
  // A diagram has nodes and edges, not data: description and Mermaid only.
  return unique.filter((format) => format === "description" || format === "mermaid");
}

export function modeFor(format: ChartExportFormat, modes: Record<ChartExportFormat, "derived" | "direct"> = FORMAT_MODE): "derived" | "direct" {
  return modes[format];
}
