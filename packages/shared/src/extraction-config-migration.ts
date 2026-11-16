import {
  EXTRACTION_CONFIG_VERSION,
  isLegacyQualityMode,
  isQualityLevel,
  legacyFieldsForVisuals,
  legacyQualityModeFor,
  mapLegacyExtractionSettings,
  qualityLevelFromLegacy,
  visualsLevelForRun,
  type QualityLevel,
  type VisualsLevel,
} from "./extraction-config.js";
import { upgradeStoredPipelineChartExport } from "./chart-export.js";
import { migrateLegacyQualitySettings } from "./quality.js";

/*
 * Release R1 (design: app docs/design/extraction-config-simplification.md, sections 3.2, 3.5 and 8): stored project
 * pipelines move to the new shape, and new runs stamp it once every worker understands it.
 *
 * `migrateProjectPipelineToConfigV1` is the TypeScript twin of the SQL function `docslurp_extraction_config_v1`
 * (server/db/migrations/0183_extraction_config_v1_projects.sql); a database test runs both over the same fixtures and
 * requires identical output. Change them together.
 */

/** Rows the owner reviews before the production migration (design 10: Q1, Q3, Q11 and refused combinations). */
export type ExtractionConfigV1Flags = {
  /** `visionFallback: false` with `auto` (or no quality): becomes `balanced`, which turns rescue reads on (Q1, a raise). */
  q1: boolean;
  /** `figureResume: off` or `manual`: existing resumable figure levels are blocked; new runs resume within visuals (Q3). */
  q3: boolean;
  /** `figures: false` with a chart tier (`free`/`models`): becomes `visuals: none`, dropping their charts (Q11, a lowering). */
  q11: boolean;
  /** `good` under a restricted privacy mode with no local vision reader: lowered to `balanced`. */
  loweredQuality: boolean;
  /** Chart tier `models` under a restricted privacy mode: lowered to `charts`. */
  loweredVisuals: boolean;
  /** A `configVersion` this release does not know: the row is left unchanged and reported. */
  unsupportedVersion: boolean;
};

export type ExtractionConfigV1Migration = {
  /** The new-shape pipeline: `quality` and `visuals` (absent = unset) with `configVersion: 1`. */
  pipeline: Record<string, unknown>;
  quality: QualityLevel;
  visuals: VisualsLevel | null;
  flags: ExtractionConfigV1Flags;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True when a stored pipeline is already in the new shape (written by R1 or by this migration). */
export function isConfigV1Pipeline(pipeline: unknown): boolean {
  return isRecord(pipeline) && pipeline.configVersion === EXTRACTION_CONFIG_VERSION;
}

/**
 * A stored project pipeline in the new shape. The legacy upgrades run first (`parserPlaybook`, `vision.forceAllPages`,
 * then `chartExport.enabled`/`generatorModel`), then the mapping table (`mapLegacyExtractionSettings`) with explicit
 * free allowed: a stored `charts` the deployment refuses counts as unset at run time, exactly as a stored explicit `free`
 * does today, so mapping `free` to `charts` never changes what a run does. Retired keys are removed: `visionFallback`,
 * `figures`, `figureResume`, `chartExport.tier`; `chartExport.formats`/`.diagrams` stay (Q4). Everything else is kept.
 *
 * Never raises effective quality or visuals except Q1 (`visionFallback: false` + `auto` -> `balanced`, owner-approved).
 */
export function migrateProjectPipelineToConfigV1(stored: unknown): ExtractionConfigV1Migration {
  const source: Record<string, unknown> = isRecord(stored) ? stored : {};
  const noFlags: ExtractionConfigV1Flags = { q1: false, q3: false, q11: false, loweredQuality: false, loweredVisuals: false, unsupportedVersion: false };
  // A row that already names a semantics version is never rewritten: v1 is done, and an unknown version (a newer
  // release's row) is left for that release rather than reinterpreted under v1 (fail closed, as runConfigSemantics).
  if ("configVersion" in source && source.configVersion !== null && source.configVersion !== undefined) {
    const mapped = mapLegacyExtractionSettings(source, { explicitFreeAllowed: true });
    return { pipeline: source, quality: mapped.quality, visuals: mapped.visuals, flags: { ...noFlags, unsupportedVersion: source.configVersion !== EXTRACTION_CONFIG_VERSION } };
  }
  const upgraded = upgradeStoredPipelineChartExport(migrateLegacyQualitySettings(source)) as Record<string, unknown>;
  // Every shape the figure readers treat as off (`false`, `"off"`, `{ enabled: false }`; projectFiguresOff) is off here.
  const figures = upgraded.figures;
  const figuresOff = figures === false || figures === "off" || (isRecord(figures) && figures.enabled === false);
  const mapped = mapLegacyExtractionSettings({ ...upgraded, figures: figuresOff ? false : figures }, { explicitFreeAllowed: true });
  const chartExport = isRecord(upgraded.chartExport) ? upgraded.chartExport : null;
  const tier = chartExport?.tier;
  // The quality the row ran before any privacy lowering: Q1 is a balanced row whose rescue reads were off.
  const rawQuality = upgraded.quality;
  const legacyLevel = isQualityLevel(rawQuality) ? rawQuality : qualityLevelFromLegacy(isLegacyQualityMode(rawQuality) ? rawQuality : null);
  const fallbackOff = upgraded.visionFallback === false;
  const flags: ExtractionConfigV1Flags = {
    q1: legacyLevel === "balanced" && fallbackOff,
    q3: upgraded.figureResume === "off" || upgraded.figureResume === "manual",
    q11: figuresOff && (tier === "free" || tier === "models"),
    loweredQuality: mapped.lowered.some((cap) => cap.field === "quality"),
    loweredVisuals: mapped.lowered.some((cap) => cap.field === "visuals"),
    unsupportedVersion: false,
  };
  const next: Record<string, unknown> = { ...upgraded };
  for (const key of ["visionFallback", "figures", "figureResume", "visuals", "configVersion"]) delete next[key];
  if (chartExport) {
    const { tier: _tier, ...rest } = chartExport;
    next.chartExport = rest;
  }
  next.quality = mapped.quality;
  // Fastest never reads pages, but `visionFallback` also gates page rasters and estimates: a fastest row keeps an
  // explicit `false`, so reading it back (where the default is true) changes nothing.
  if (mapped.quality === "fastest" && fallbackOff) next.visionFallback = false;
  if (mapped.visuals !== null) next.visuals = mapped.visuals;
  next.configVersion = EXTRACTION_CONFIG_VERSION;
  return { pipeline: next, quality: mapped.quality, visuals: mapped.visuals, flags };
}

/**
 * A resolved run pipeline (legacy shape, after `resolveRunExtraction`) in the new shape, or null when the new shape
 * cannot say exactly what the legacy one does. The worker turns `quality`/`visuals` back into the legacy fields
 * (`convertExtractionConfigInput`), so the stamp is used only when that round trip gives back the same `quality`,
 * `visionFallback`, `figures` and chart tier: a snapshot is never widened by being stamped (design 3.5, ADV-4). A run
 * that cannot round-trip (an `auto` run with rescue reads off, figures off with a chart tier) keeps the legacy shape,
 * which every release reads.
 */
export function runPipelineToConfigV1<T extends Record<string, unknown>>(pipeline: T): (T & { configVersion: 1 }) | null {
  if (pipeline.configVersion !== undefined) return null;
  const legacyQuality = pipeline.quality;
  if (legacyQuality !== "fast" && legacyQuality !== "auto" && legacyQuality !== "good") return null;
  const chartExport = isRecord(pipeline.chartExport) ? pipeline.chartExport : null;
  const tier = chartExport?.tier;
  if (tier !== "off" && tier !== "free" && tier !== "models") return null;
  const figures = pipeline.figures !== false;
  const quality = qualityLevelFromLegacy(legacyQuality);
  const visuals = visualsLevelForRun(figures, tier);
  // Round trip: balanced sets visionFallback true when absent; visuals writes figures and the tier.
  // The stored default for visionFallback is true, so a run with it off (any quality) keeps the legacy shape.
  if (pipeline.visionFallback === false) return null;
  const back = legacyFieldsForVisuals(visuals);
  if (back.figures !== figures || back.tier !== tier || legacyQualityModeFor(quality) !== legacyQuality) return null;
  const next: Record<string, unknown> = { ...pipeline };
  delete next.visionFallback;
  delete next.figures;
  const { tier: _tier, ...restChart } = chartExport!;
  next.chartExport = restChart;
  next.quality = quality;
  next.visuals = visuals;
  next.configVersion = EXTRACTION_CONFIG_VERSION;
  return next as T & { configVersion: 1 };
}
