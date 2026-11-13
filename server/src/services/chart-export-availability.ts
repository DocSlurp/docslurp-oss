import {
  CHART_EXPORT_ENV_FLAG,
  chartExportModelsAvailable,
  chartExportOverrideRefusal,
  chartExportSwitch,
  resolveChartExportConfig,
  type ChartExportTier,
  type PipelineFeatures,
  type RunOrigin,
} from "@docslurp/shared";

/**
 * The server's read of the chart export kill switch for the billed model steps (`DOCSLURP_CHART_EXPORT=on`). Anything
 * else (`free`, `off`, unset, unknown): chat never suggests the `models` tier, the ingest report never recommends it,
 * estimates price none, and the settings API and chat proposals refuse to turn it on (`ChartExportUnavailableError`).
 * The free tier needs no permission: it calls no model and costs nothing. The worker reads the same variable.
 */
export function chartExportEnabledOnServer(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return chartExportModelsAvailable(env);
}

export const CHART_EXPORT_UNAVAILABLE_MESSAGE = "Reading charts with AI is not available on this deployment yet.";

/** Turning the billed `models` tier on while the deployment kill switch is not `on`. */
export class ChartExportUnavailableError extends Error {
  readonly status = 400 as const;
  readonly code = "chart_export_unavailable" as const;
  constructor() { super(CHART_EXPORT_UNAVAILABLE_MESSAGE); }
}

type ChartExportHolder = { chartExport?: { tier?: unknown } | null } | null | undefined;

/** Throws when a change moves a project to the `models` tier while the kill switch is not `on`. */
export function assertChartExportChangeAllowed(
  before: ChartExportHolder,
  after: ChartExportHolder,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (after?.chartExport?.tier === "models" && before?.chartExport?.tier !== "models" && !chartExportEnabledOnServer(env)) {
    console.warn(`[chart-export] refused the models tier: ${CHART_EXPORT_ENV_FLAG} is not on`);
    throw new ChartExportUnavailableError();
  }
}

/**
 * Refuses a per-request `models` override while the deploy switch is not `on` (a validation error, never a silent
 * downgrade). Returns the user-facing message, or null when the override is allowed. Raw detail goes to telemetry.
 */
export function chartExportOverrideError(
  tier: ChartExportTier | null | undefined,
  context: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!tier || !chartExportOverrideRefusal(tier, env)) return null;
  console.warn(`[chart-export] refused per-request tier override tier=${tier} switch=${chartExportSwitch(env)} context=${context}`);
  return CHART_EXPORT_UNAVAILABLE_MESSAGE;
}

/**
 * The run's pipeline with its chart export tier resolved and stamped (request override and project tier already merged
 * into `pipeline.chartExport.tier`; else the origin default). Persisted on the run, so a retry or resume uses it.
 */
export function stampRunChartExport<T extends PipelineFeatures>(
  pipeline: T,
  origin: RunOrigin,
  env: Readonly<Record<string, string | undefined>> = process.env,
): T {
  return { ...pipeline, chartExport: resolveChartExportConfig({ project: pipeline.chartExport ?? null, origin, env }) };
}
