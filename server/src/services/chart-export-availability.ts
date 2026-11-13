import { HTTPException } from "hono/http-exception";
import {
  apiError,
  CHART_EXPORT_ENV_FLAG,
  CHART_EXPORT_FREE_EXPLICIT_ENV_FLAG,
  CHART_EXPORT_TIER_UNAVAILABLE_CODE,
  defaultChartExportConfig,
  minChartExportTier,
  upgradeStoredChartExport,
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

export const CHART_EXPORT_UNAVAILABLE_MESSAGE = "That chart export tier is not available on this deployment.";

/**
 * A tier the deployment does not offer, chosen explicitly (a request override or a project change): `models` while the
 * kill switch is not `on`, or `free` while `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT` is not `on`. One code and status on
 * every surface: 400 `chart_export_tier_unavailable`.
 */
export class ChartExportUnavailableError extends Error {
  readonly status = 400 as const;
  readonly code = CHART_EXPORT_TIER_UNAVAILABLE_CODE;
  constructor() { super(CHART_EXPORT_UNAVAILABLE_MESSAGE); }
}

type ChartExportHolder = { chartExport?: { tier?: unknown } | null } | null | undefined;

/** Throws when a change moves a project to a tier (`models`, or an explicit `free`) the deployment does not offer. */
export function assertChartExportChangeAllowed(
  before: ChartExportHolder,
  after: ChartExportHolder,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const next = after?.chartExport?.tier;
  if ((next !== "models" && next !== "free") || before?.chartExport?.tier === next) return;
  if (chartExportOverrideRefusal(next, env)) {
    console.warn(`[chart-export] refused a project change to tier=${next} switch=${chartExportSwitch(env)} (${CHART_EXPORT_ENV_FLAG}, ${CHART_EXPORT_FREE_EXPLICIT_ENV_FLAG})`);
    throw new ChartExportUnavailableError();
  }
}

/**
 * Refuses a per-request tier override the deployment does not offer (a validation error, never a silent downgrade).
 * Returns the user-facing message, or null when the override is allowed. Raw detail goes to telemetry.
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

/** The API-key scope that lets a key choose `models` above a project's own `off` or `free` tier (besides `projects:manage`). */
export const BILLED_FEATURES_SCOPE = "pipeline:billed-features";
export const CHART_EXPORT_MODELS_FORBIDDEN_MESSAGE = "This project's chart export tier is set below reading charts with AI. A project editor can change it, or use an API key with the pipeline:billed-features scope.";

/** A `models` run above the project's explicit `off`/`free` tier, by a caller without editor rights or the billed scope. */
export class ChartExportModelsForbiddenError extends HTTPException {
  readonly code = "chart_export_models_forbidden" as const;
  constructor() {
    super(403, { message: CHART_EXPORT_MODELS_FORBIDDEN_MESSAGE, res: Response.json(apiError("chart_export_models_forbidden", CHART_EXPORT_MODELS_FORBIDDEN_MESSAGE, { field: "chartExport.tier" }), { status: 403 }) });
    this.name = "ChartExportModelsForbiddenError";
  }
}

/**
 * A project's explicit tier is a ceiling for per-run choices: a run that would use `models` on a project whose stored
 * tier is `off` or `free` needs a caller who may edit the project (sessions) or, for an API key, the key's user's editor
 * rights plus the `pipeline:billed-features` (or `projects:manage`) scope. An ingest-only key or a contributor is
 * refused. Projects with no tier or with `models` keep the existing rules (spend admission). Fails closed: an API key id
 * whose scopes cannot be read is refused.
 */
export async function assertChartExportModelsCeiling(args: {
  runTier: ChartExportTier | null | undefined;
  projectTier: unknown;
  canEdit: boolean;
  apiKeyId?: string | null;
  apiKeyScopes?: (apiKeyId: string) => Promise<readonly string[] | null>;
  context: string;
}): Promise<void> {
  if (args.runTier !== "models" || (args.projectTier !== "off" && args.projectTier !== "free")) return;
  let allowed = args.canEdit;
  if (allowed && args.apiKeyId) {
    const scopes = args.apiKeyScopes ? await args.apiKeyScopes(args.apiKeyId).catch(() => null) : null;
    allowed = !!scopes && (scopes.includes(BILLED_FEATURES_SCOPE) || scopes.includes("projects:manage"));
  }
  if (!allowed) {
    console.warn(`[chart-export] refused models above the project's tier=${String(args.projectTier)} context=${args.context} apiKey=${args.apiKeyId ? "yes" : "no"} editor=${args.canEdit}`);
    throw new ChartExportModelsForbiddenError();
  }
}

/**
 * The run's pipeline with its chart export tier resolved and stamped (request override and project tier already merged
 * into `pipeline.chartExport.tier`; else the origin default), persisted on the run so a retry or resume uses it.
 * `stamped`: the pipeline comes from a run that already resolved its tier (reprocess, reindex, materialize); a present
 * tier is kept as is (the explicit-free gate applied when that run was created), only legacy keys are mapped.
 */
export function stampRunChartExport<T extends PipelineFeatures>(
  pipeline: T,
  origin: RunOrigin,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { stamped?: boolean } = {},
): T {
  const chartExport = upgradeStoredChartExport(pipeline.chartExport ?? null) as PipelineFeatures["chartExport"] | null;
  if (options.stamped && chartExport?.tier) return { ...pipeline, chartExport: { ...defaultChartExportConfig, ...chartExport, tier: chartExport.tier } };
  return { ...pipeline, chartExport: resolveChartExportConfig({ project: chartExport, origin, env }) };
}

/**
 * Project-maintenance runs (config-change reindex, full index, mode switch) on a project with no chart tier keep each
 * document's own tier: the tier its source run stamped, as reprocess does, not the tier of whoever clicked. Documents
 * whose run has no stamped tier fall back to `fallback` (the caller's origin default). Returns document id -> tier.
 * Reads only runs of the given documents, scoped to the project and organization.
 */
export async function sourceRunChartTiers(
  client: { <T extends readonly unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> },
  scope: { orgId: string; projectId: string },
  documentIds: readonly string[],
): Promise<Map<string, ChartExportTier>> {
  const out = new Map<string, ChartExportTier>();
  if (documentIds.length === 0) return out;
  const rows = await client<Array<{ id: string; tier: string | null }>>`
    select d.id, r.pipeline -> 'chartExport' ->> 'tier' as tier
    from documents d join project_runs r on r.id = d.run_id
    where d.id = any(${[...documentIds]}) and d.project_id = ${scope.projectId} and d.org_id = ${scope.orgId}
      and r.project_id = ${scope.projectId} and r.org_id = ${scope.orgId}
  `;
  for (const row of rows) {
    if (row.tier === "off" || row.tier === "free" || row.tier === "models") out.set(row.id, row.tier);
  }
  return out;
}

/**
 * Groups `docs` by the tier each keeps (`sourceRunChartTiers`), `fallback` for those with none, each capped at `cap`
 * (what the project resolves to now, `projectChartExportTierCap`): inheritance only ever lowers a tier, so a document
 * stamped `models` before the project was turned off or unset never replays billed reads. Order kept.
 */
export function groupByChartTier<T extends { id: string }>(docs: readonly T[], tiers: ReadonlyMap<string, ChartExportTier>, fallback: ChartExportTier, cap: ChartExportTier = "models"): Map<ChartExportTier, T[]> {
  const groups = new Map<ChartExportTier, T[]>();
  for (const doc of docs) {
    const tier = minChartExportTier(tiers.get(doc.id) ?? fallback, cap);
    groups.set(tier, [...(groups.get(tier) ?? []), doc]);
  }
  return groups;
}
