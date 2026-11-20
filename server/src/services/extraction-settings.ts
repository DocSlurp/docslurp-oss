import { HTTPException } from "hono/http-exception";
import {
  apiError,
  stampRunModelMode,
  chartTierForVisuals,
  extractionPolicyFromEnv,
  pipelineFieldsForQuality,
  migrateLegacyQualitySettings,
  qualityLevelOfPipeline,
  resolveExtractionSettings,
  runEffectiveExtraction,
  upgradeStoredChartExport,
  visualsLevelForRun,
  visualsLevelFromLegacy,
  type ChartExportTier,
  type ExtractionResolutionError,
  type PipelineFeatures,
  type QualityLevel,
  type RunEffectiveExtraction,
  type RunOrigin,
  type VisualsLevel,
} from "@docslurp/shared";

/**
 * Server adapter for the one extraction resolution function (packages/shared/src/extraction-config.ts,
 * `resolveExtractionSettings`). Every run-creation path (upload, URL ingest, extract, MCP, reprocess, bulk reprocess,
 * retry-as-new, materialize) resolves `quality` and `visuals` here, after the chart tier is stamped
 * (chart-export-availability.ts), and stamps the result on the run as `pipeline.effective`. R0 keeps writing the legacy
 * fields (quality fast/auto/good, figures, chartExport.tier); the stamp is additive, so an older release ignores it.
 */

const MESSAGES: Record<ExtractionResolutionError["code"], string> = {
  quality_unavailable: "That quality is not available for this project on this deployment.",
  visuals_unavailable: "That visuals setting is not available for this project on this deployment.",
  quality_smart_forbidden: "This project's quality is set below smart. A project editor can change it, or use an API key with the pipeline:billed-features scope.",
  chart_export_models_forbidden: "This project's visuals are set below reading charts with AI. A project editor can change it, or use an API key with the pipeline:billed-features scope.",
};

/** A resolution refusal: 400 for a constraint or switch, 403 for a raise without billed authority. Reasons only, no backend names. */
export class ExtractionSettingsError extends HTTPException {
  readonly code: ExtractionResolutionError["code"];
  readonly field: ExtractionResolutionError["field"];
  readonly reason: ExtractionResolutionError["reason"];
  constructor(error: ExtractionResolutionError) {
    const message = MESSAGES[error.code];
    super(error.status, {
      message,
      res: Response.json(apiError(error.code, message, { field: error.field, reason: error.reason }), { status: error.status }),
    });
    this.name = "ExtractionSettingsError";
    this.code = error.code;
    this.field = error.field;
    this.reason = error.reason;
  }
}

type LegacyHolder = { quality?: unknown; ladder?: unknown; figures?: unknown; chartExport?: unknown; privacyMode?: unknown; vision?: unknown } | null | undefined;

function tierOf(chartExport: unknown): ChartExportTier | undefined {
  const upgraded = upgradeStoredChartExport(chartExport) as { tier?: unknown } | null | undefined;
  const tier = upgraded?.tier;
  return tier === "off" || tier === "free" || tier === "models" ? tier : undefined;
}

function storedQuality(pipeline: LegacyHolder): QualityLevel {
  // Legacy keys first (parserPlaybook, vision.forceAllPages), as every other reader does (design 3.2).
  // The level of an `auto` pipeline lives in its ladder's highest rung (qualityLevelOfPipeline).
  return qualityLevelOfPipeline(migrateLegacyQualitySettings(pipeline ?? null) as LegacyHolder).quality;
}

export type RunExtractionArgs<T extends PipelineFeatures> = {
  /** The run pipeline after merge, managed models and the chart tier stamp (legacy shape). */
  pipeline: T;
  /** The project's stored pipeline (legacy shape, or new shape read on the way). */
  project: LegacyHolder;
  origin: RunOrigin;
  /**
   * A replay of a source run (reprocess, bulk reprocess): the snapshot's quality is inherited, so it is capped at the
   * project's quality now unless `requestedQuality` asks for a value explicitly (which then passes the raise check).
   */
  replay?: { requestedQuality?: QualityLevel | null } | null;
  canEdit: boolean;
  apiKeyId?: string | null;
  apiKeyScopes?: (apiKeyId: string) => Promise<readonly string[] | null>;
  context: string;
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Resolves the run's `quality`/`visuals` and returns its pipeline (legacy fields lowered where a cap applied) with
 * `effective` stamped. Throws `ExtractionSettingsError` for an explicit value the caller may not have (403) or the
 * deployment or project constraints forbid (400). Fails closed: a key whose scopes cannot be read cannot raise.
 */
export async function resolveRunExtraction<T extends PipelineFeatures>(args: RunExtractionArgs<T>): Promise<T & { effective: RunEffectiveExtraction }> {
  const env = args.env ?? process.env;
  const policy = extractionPolicyFromEnv(env);
  const pipeline = args.pipeline;
  const projectQuality = storedQuality(args.project);
  const runQuality = storedQuality(pipeline);
  const runTier: ChartExportTier = tierOf(pipeline.chartExport) ?? "off";
  const runVisuals = visualsLevelForRun(pipeline.figures !== false, runTier);
  const projectVisuals = visualsLevelFromLegacy({ figures: args.project?.figures, tier: tierOf(args.project?.chartExport) }, { explicitFreeAllowed: true });

  // A quality that differs from the project's is the caller's own choice (request override); on a replay it is the
  // snapshot's, inherited, unless the replay request names one.
  const replay = args.replay ?? null;
  const requestedQuality: QualityLevel | undefined = replay
    ? replay.requestedQuality ?? undefined
    : runQuality !== projectQuality ? runQuality : undefined;
  // AI chart reads the project does not hold are the caller's choice: compared by the stored chart tier (a project saved
  // on `models` with figures off still holds them, as #363's ceiling has it). The chart tier code resolved the other rungs.
  const visualsRequested = runTier === "models" && tierOf(args.project?.chartExport) !== "models";

  const apiKeyId = args.apiKeyId ?? null;
  const scopes = apiKeyId ? (args.apiKeyScopes ? await args.apiKeyScopes(apiKeyId).catch(() => null) : null) : undefined;
  const result = resolveExtractionSettings({
    request: { ...(requestedQuality ? { quality: requestedQuality } : {}), ...(visualsRequested ? { visuals: runVisuals } : {}) },
    project: { quality: projectQuality, visuals: visualsRequested ? projectVisuals : runVisuals },
    replay: replay ? { quality: runQuality, visuals: runVisuals } : null,
    origin: args.origin,
    caller: { canEdit: args.canEdit, apiKey: apiKeyId ? { scopes: scopes ?? null } : null },
    constraints: { privacyMode: pipeline.privacyMode, vision: pipeline.vision },
    // The run's tier is already resolved against origin defaults and the explicit-free rule (stampRunChartExport).
    policy: { ...policy, explicitChartsAllowed: true },
  });
  if (!result.ok) {
    console.warn(`[extraction] refused ${result.error.field} code=${result.error.code} reason=${result.error.reason} context=${args.context} apiKey=${apiKeyId ? "yes" : "no"} editor=${args.canEdit}`);
    throw new ExtractionSettingsError(result.error);
  }
  for (const cap of result.capsApplied) {
    console.log(`[extraction] capped ${cap.field} from=${cap.from} to=${cap.to} reason=${cap.reason} context=${args.context}`);
  }
  let next: T = pipeline;
  if (result.quality !== runQuality) {
    // Lowered from Smartest to the OCR rung while keeping the ladder share caps.
    const fields = pipelineFieldsForQuality(result.quality, { readScans: true, ladder: next.ladder });
    next = { ...next, quality: fields.quality, ladder: fields.ladder as T["ladder"], ...(fields.visionFallback ? { visionFallback: true } : {}) };
  }
  if (result.visuals !== runVisuals) next = lowerVisuals(next, result.visuals);
  return { ...next, effective: runEffectiveExtraction(next, result.capsApplied) };
}

/** A pipeline lowered to `visuals`: the chart tier follows it; figures only ever turn off (a cap never turns them on). */
function lowerVisuals<T extends PipelineFeatures>(pipeline: T, visuals: VisualsLevel): T {
  return {
    ...pipeline,
    figures: pipeline.figures !== false && visuals !== "none",
    chartExport: { ...(pipeline.chartExport ?? {}), tier: chartTierForVisuals(visuals) },
  };
}

/**
 * The `effective` stamp for a run inserted outside run creation (config-change reindex, full index, mode switch, deferred
 * materialize): those runs take the project's current pipeline, so nothing is raised and only the values are stamped.
 */
export function withRunEffective<T extends PipelineFeatures>(pipeline: T, env: Readonly<Record<string, string | undefined>> = process.env): T & { effective: RunEffectiveExtraction } {
  // No caller choice here, so nothing is refused or rewritten: the stored fields stay as the run's source had them (the
  // worker applies switches and privacy at run time, as before), and the stamp records what privacy, locality and the
  // switches cap them to.
  const quality = qualityLevelOfPipeline(pipeline).quality;
  const visuals = visualsLevelForRun(pipeline.figures !== false, tierOf(pipeline.chartExport) ?? "off");
  const result = resolveExtractionSettings({
    project: { quality, visuals },
    origin: "machine",
    caller: { canEdit: false },
    constraints: { privacyMode: pipeline.privacyMode, vision: pipeline.vision },
    policy: { ...extractionPolicyFromEnv(env), explicitChartsAllowed: true },
  });
  // A run created in private model mode is stamped so: the worker then treats it as private whatever its own env says.
  if (!result.ok) return stampRunModelMode({ ...pipeline, effective: runEffectiveExtraction(pipeline) }, env);
  const effective = runEffectiveExtraction(pipeline, result.capsApplied);
  return stampRunModelMode({ ...pipeline, effective: { ...effective, quality: result.quality, visuals: result.visuals, readsPages: effective.readsPages && result.quality !== "fastest" } }, env);
}

export type { QualityLevel, VisualsLevel };
