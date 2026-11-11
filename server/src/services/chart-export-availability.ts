import { CHART_EXPORT_ENV_FLAG, chartExportAvailable } from "@docslurp/shared";

/**
 * The server's read of the chart export kill switch (`DOCSLURP_CHART_EXPORT=on`; default off). Off: chat never
 * suggests chart export, the ingest report never recommends it, estimates price none, and the settings API and chat
 * proposals refuse to turn it on (`ChartExportUnavailableError`). The worker reads the same variable.
 */
export function chartExportEnabledOnServer(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return chartExportAvailable(env);
}

export const CHART_EXPORT_UNAVAILABLE_MESSAGE = "Chart and diagram export is not available on this deployment yet.";

/** Turning chart export on while the deployment kill switch is off. */
export class ChartExportUnavailableError extends Error {
  readonly status = 400 as const;
  readonly code = "chart_export_unavailable" as const;
  constructor() { super(CHART_EXPORT_UNAVAILABLE_MESSAGE); }
}

/** Throws when a change turns chart export on (off before, on after) while the kill switch is off. */
export function assertChartExportChangeAllowed(
  before: { chartExport?: { enabled?: unknown } | null } | null | undefined,
  after: { chartExport?: { enabled?: unknown } | null } | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (after?.chartExport?.enabled === true && before?.chartExport?.enabled !== true && !chartExportEnabledOnServer(env)) {
    console.warn(`[chart-export] refused enabling chart export: ${CHART_EXPORT_ENV_FLAG} is off`);
    throw new ChartExportUnavailableError();
  }
}
