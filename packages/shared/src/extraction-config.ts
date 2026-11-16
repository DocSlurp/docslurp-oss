import { z } from "zod";
import {
  upgradeStoredPipelineChartExport,
  chartExportFreeExplicitAllowed,
  chartExportSwitch,
  defaultChartExportTier,
  type ChartExportTier,
  type RunOrigin,
} from "./chart-export.js";
import { migrateLegacyQualitySettings, type QualityMode } from "./quality.js";

/**
 * Extraction configuration, release R0 of the simplification (docs/extraction/quality-and-visuals.md):
 *
 * - `quality`: `fastest` | `balanced` | `smart` (default `balanced`), the one tier vocabulary.
 * - `visuals`: `none` | `figures` | `charts` | `charts-ai`, an ordered ladder over the PDF figure pass and chart export;
 *   unset means the run origin's default.
 *
 * R0 reads both shapes and accepts both on input, but **writes and stamps the legacy shape** (`quality: fast|auto|good`,
 * `visionFallback`, `figures`, `chartExport.tier`), so a rollback to the previous release still reads every row this
 * release writes. The new names are a view over the legacy fields plus a run's stamped `pipeline.effective`.
 *
 * Nothing here names a model, vendor, host or reader: rungs and reasons only.
 */

type Env = Readonly<Record<string, string | undefined>>;

export const QUALITY_LEVELS = ["fastest", "balanced", "smart"] as const;
export const qualityLevelSchema = z.enum(QUALITY_LEVELS);
export type QualityLevel = z.infer<typeof qualityLevelSchema>;
export const DEFAULT_QUALITY_LEVEL: QualityLevel = "balanced";
export const QUALITY_LEVEL_RANK: Readonly<Record<QualityLevel, number>> = { fastest: 0, balanced: 1, smart: 2 };

export const VISUALS_LEVELS = ["none", "figures", "charts", "charts-ai"] as const;
export const visualsLevelSchema = z.enum(VISUALS_LEVELS);
export type VisualsLevel = z.infer<typeof visualsLevelSchema>;
export const VISUALS_LEVEL_RANK: Readonly<Record<VisualsLevel, number>> = { none: 0, figures: 1, charts: 2, "charts-ai": 3 };

/**
 * Semantics version of a run snapshot (`pipeline.configVersion`). Absent: legacy semantics (every run stamped before R1),
 * kept until the run completes, retries and resumes included. R0 reads it and refuses a version it does not know; R1
 * starts stamping it.
 */
export const EXTRACTION_CONFIG_VERSION = 1 as const;
export const SUPPORTED_EXTRACTION_CONFIG_VERSIONS: readonly number[] = [EXTRACTION_CONFIG_VERSION];

export const QUALITY_UNAVAILABLE_CODE = "quality_unavailable" as const;
export const VISUALS_UNAVAILABLE_CODE = "visuals_unavailable" as const;
export const QUALITY_RAISE_FORBIDDEN_CODE = "quality_smart_forbidden" as const;
/** The API-key scope that lets a key raise a run above its project to a billed rung (`smart`, `charts-ai`). */
export const BILLED_FEATURES_SCOPE = "pipeline:billed-features";

/** Why a value was lowered: a deployment switch, the project's privacy mode, or the vision profile's locality. */
export type ExtractionCapReason = "switch" | "privacy" | "profile" | "replay";
export type ExtractionCap =
  | { field: "quality"; from: QualityLevel; to: QualityLevel; reason: ExtractionCapReason }
  | { field: "visuals"; from: VisualsLevel; to: VisualsLevel; reason: ExtractionCapReason };

// ---- Vocabulary mapping (design section 3.2) ---------------------------------------------------------------------

const LEGACY_TO_QUALITY: Readonly<Record<QualityMode, QualityLevel>> = { fast: "fastest", auto: "balanced", good: "smart" };
const QUALITY_TO_LEGACY: Readonly<Record<QualityLevel, QualityMode>> = { fastest: "fast", balanced: "auto", smart: "good" };

export function isQualityLevel(value: unknown): value is QualityLevel {
  return typeof value === "string" && (QUALITY_LEVELS as readonly string[]).includes(value);
}
export function isVisualsLevel(value: unknown): value is VisualsLevel {
  return typeof value === "string" && (VISUALS_LEVELS as readonly string[]).includes(value);
}
export function isLegacyQualityMode(value: unknown): value is QualityMode {
  return value === "fast" || value === "auto" || value === "good";
}

/** `fast`/`auto`/`good` -> `fastest`/`balanced`/`smart`. `auto` maps to `balanced` whatever `visionFallback` says (Q1). */
export function qualityLevelFromLegacy(mode: QualityMode | null | undefined): QualityLevel {
  return mode ? LEGACY_TO_QUALITY[mode] : DEFAULT_QUALITY_LEVEL;
}

export function legacyQualityModeFor(level: QualityLevel): QualityMode {
  return QUALITY_TO_LEGACY[level];
}

/** The chart tier a visuals rung runs: `none`/`figures` -> `off`, `charts` -> `free`, `charts-ai` -> `models`. */
export function chartTierForVisuals(visuals: VisualsLevel): ChartExportTier {
  return visuals === "charts-ai" ? "models" : visuals === "charts" ? "free" : "off";
}

/** The legacy fields one visuals rung writes in R0. `null` (unset) keeps figures on and leaves the tier unset. */
export function legacyFieldsForVisuals(visuals: VisualsLevel | null): { figures: boolean; tier: ChartExportTier | undefined } {
  if (visuals === null) return { figures: true, tier: undefined };
  return { figures: visuals !== "none", tier: chartTierForVisuals(visuals) };
}

/**
 * The visuals rung legacy fields say, or null for unset (the origin default). `figures: false` is `none` whatever the
 * tier (a lowering, never a raise; Q11). An explicit `free` counts as unset while the deployment refuses explicit free
 * (`charts.explicitFree`), matching today's rule.
 */
export function visualsLevelFromLegacy(
  legacy: { figures?: unknown; tier?: ChartExportTier | null | undefined },
  options: { explicitFreeAllowed: boolean },
): VisualsLevel | null {
  if (legacy.figures === false) return "none";
  switch (legacy.tier) {
    case "off": return "figures";
    case "free": return options.explicitFreeAllowed ? "charts" : null;
    case "models": return "charts-ai";
    default: return null;
  }
}

/** The visuals rung a resolved run tier and figures flag run. */
export function visualsLevelForRun(figures: boolean, tier: ChartExportTier): VisualsLevel {
  if (tier === "models") return "charts-ai";
  if (tier === "free") return "charts";
  return figures ? "figures" : "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True when the project's vision reader is local by its profile or target (the `*-local` profiles, a private route). */
export function visionReaderIsLocal(vision: unknown): boolean {
  if (!isRecord(vision)) return false;
  if (vision.target === "hosted") return false;
  if (vision.target === "local" || vision.target === "private") return true;
  return typeof vision.profile === "string" && vision.profile.endsWith("-local");
}

function privacyRestricts(privacyMode: unknown): boolean {
  return typeof privacyMode === "string" && privacyMode !== "standard";
}

export type LegacyExtractionMapping = {
  quality: QualityLevel;
  visuals: VisualsLevel | null;
  /** Combinations the new validators refuse, lowered deterministically (never raised, never refused). */
  lowered: ExtractionCap[];
};

/**
 * The mapping table (design 3.2) over a stored legacy pipeline (after `migrateLegacyQualitySettings` and
 * `upgradeStoredPipelineChartExport`): `quality`, `visuals`, plus the lowering of combinations the new model refuses:
 * `good` under a non-standard privacy mode with no local vision reader -> `balanced`; tier `models` under a non-standard
 * privacy mode -> `charts`. Never raises.
 */
export function mapLegacyExtractionSettings(
  pipeline: unknown,
  options: { explicitFreeAllowed: boolean },
): LegacyExtractionMapping {
  // Legacy upgrades run first (design 3.2): parserPlaybook / vision.forceAllPages, then chartExport.enabled.
  const migrated = upgradeStoredPipelineChartExport(migrateLegacyQualitySettings(pipeline));
  const record = isRecord(migrated) ? migrated : {};
  const lowered: ExtractionCap[] = [];
  const rawQuality = record.quality;
  let quality: QualityLevel = isQualityLevel(rawQuality) ? rawQuality : qualityLevelFromLegacy(isLegacyQualityMode(rawQuality) ? rawQuality : null);
  const restricted = privacyRestricts(record.privacyMode);
  if (quality === "smart" && restricted && !visionReaderIsLocal(record.vision)) {
    lowered.push({ field: "quality", from: "smart", to: "balanced", reason: "privacy" });
    quality = "balanced";
  }
  const chartExport = isRecord(record.chartExport) ? record.chartExport : {};
  const rawTier = chartExport.tier;
  const tier = rawTier === "off" || rawTier === "free" || rawTier === "models" ? rawTier : undefined;
  let visuals: VisualsLevel | null = isVisualsLevel(record.visuals)
    ? record.visuals
    : visualsLevelFromLegacy({ figures: record.figures, tier }, options);
  if (visuals === "charts-ai" && restricted) {
    lowered.push({ field: "visuals", from: "charts-ai", to: "charts", reason: "privacy" });
    visuals = "charts";
  }
  return { quality, visuals, lowered };
}

// ---- Input conversion: new names onto the legacy shape (R0 writes legacy) ----------------------------------------

/** Legacy request fields still accepted during the window, each with its replacement (Deprecation header + warning). */
export type DeprecatedFieldWarning = { code: "deprecated_field"; field: string; replacement: string; message: string };

const deprecation = (field: string, replacement: string): DeprecatedFieldWarning => ({
  code: "deprecated_field",
  field,
  replacement,
  message: `'${field}' is deprecated; use '${replacement}'.`,
});

/**
 * Deprecated extraction fields a request pipeline (or settings patch) uses, for the `Deprecation` header and the
 * response `warnings[]`. Read before conversion. `prefix` names where the pipeline sits in the request (`pipeline.`).
 */
export function deprecatedExtractionFields(input: unknown, prefix = ""): DeprecatedFieldWarning[] {
  if (!isRecord(input)) return [];
  const out: DeprecatedFieldWarning[] = [];
  if (isLegacyQualityMode(input.quality)) out.push(deprecation(`${prefix}quality: "${input.quality}"`, `${prefix}quality: "${qualityLevelFromLegacy(input.quality)}"`));
  if ("visionFallback" in input) out.push(deprecation(`${prefix}visionFallback`, `${prefix}quality`));
  if ("parserPlaybook" in input) out.push(deprecation(`${prefix}parserPlaybook`, `${prefix}quality`));
  if (isRecord(input.vision) && "forceAllPages" in input.vision) out.push(deprecation(`${prefix}vision.forceAllPages`, `${prefix}quality`));
  if ("figures" in input) out.push(deprecation(`${prefix}figures`, `${prefix}visuals`));
  if (isRecord(input.chartExport) && ("tier" in input.chartExport || "enabled" in input.chartExport)) {
    out.push(deprecation(`${prefix}chartExport.tier`, `${prefix}visuals`));
  }
  return out;
}

export class ExtractionConfigConflictError extends Error {
  readonly code = "extraction_config_conflict" as const;
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "ExtractionConfigConflictError";
  }
}

/**
 * Rewrites a pipeline (request override, settings patch, or a stored row written in the new shape) onto the legacy
 * shape R0 stores: a new-vocabulary `quality` becomes `fast`/`auto`/`good` (`balanced` also sets `visionFallback: true`
 * unless the input says otherwise; Q1), and `visuals` becomes `figures` plus `chartExport.tier` (formats and diagrams
 * kept). `visuals: null` unsets the tier (origin default) and keeps figures on; `tierUnset` reports it so a caller that
 * replaces the stored config can drop the stored tier. `configVersion` is consumed (see `assertSupportedConfigVersion`).
 *
 * Both names for one setting must agree: `visuals` with a different `figures` or `chartExport.tier` throws
 * `ExtractionConfigConflictError`, never a silent pick. Returns the input itself when it holds no new name.
 */
export function applyExtractionConfigInput<T>(source: T): T {
  return convertExtractionConfigInput(source).value;
}

/**
 * `preferNew`: the caller sends a whole pipeline it read back (project create/PATCH replace the stored pipeline), so the
 * legacy `figures` / `chartExport.tier` it carries are the stored values: `visuals` wins over them instead of conflicting.
 */
export function convertExtractionConfigInput<T>(source: T, options: { preferNew?: boolean } = {}): { value: T; tierUnset: boolean } {
  if (!isRecord(source)) return { value: source, tierUnset: false };
  const hasNewQuality = isQualityLevel(source.quality);
  const hasVisuals = "visuals" in source;
  const hasVersion = "configVersion" in source;
  if (!hasNewQuality && !hasVisuals && !hasVersion) return { value: source, tierUnset: false };
  // Fail closed on a semantics version this release does not know.
  if (hasVersion) assertSupportedConfigVersion(source);
  const next: Record<string, unknown> = { ...source };
  delete next.configVersion;
  if (hasNewQuality) {
    const level = source.quality as QualityLevel;
    next.quality = legacyQualityModeFor(level);
    if (level === "balanced" && !("visionFallback" in source)) next.visionFallback = true;
  }
  let tierUnset = false;
  if (hasVisuals) {
    const visuals = source.visuals;
    delete next.visuals;
    if (visuals !== null && visuals !== undefined && !isVisualsLevel(visuals)) {
      // Left for the schema to reject with its own message.
      next.visuals = visuals;
      return { value: next as T, tierUnset };
    }
    if (visuals !== undefined) {
      const level = (visuals ?? null) as VisualsLevel | null;
      const legacy = legacyFieldsForVisuals(level);
      if (!options.preferNew && "figures" in source && source.figures !== legacy.figures) {
        throw new ExtractionConfigConflictError("visuals", `visuals '${level ?? "default"}' conflicts with figures=${String(source.figures)}; send one of them`);
      }
      const chartExport = isRecord(source.chartExport) ? { ...source.chartExport } : {};
      if (!options.preferNew && "tier" in chartExport && chartExport.tier !== undefined && chartExport.tier !== legacy.tier) {
        throw new ExtractionConfigConflictError("visuals", `visuals '${level ?? "default"}' conflicts with chartExport.tier=${String(chartExport.tier)}; send one of them`);
      }
      next.figures = legacy.figures;
      if (legacy.tier) chartExport.tier = legacy.tier;
      else { delete chartExport.tier; tierUnset = true; }
      if (legacy.tier || Object.keys(chartExport).length > 0 || isRecord(source.chartExport)) next.chartExport = chartExport;
    }
  }
  return { value: next as T, tierUnset };
}

export class UnsupportedConfigVersionError extends Error {
  readonly code = "unsupported_config_version" as const;
  constructor(readonly version: unknown) {
    super(`Pipeline configVersion ${String(version)} is not supported by this release`);
    this.name = "UnsupportedConfigVersionError";
  }
}

/**
 * The semantics a run snapshot executes under: `legacy` when it has no `configVersion` (every run stamped before R1,
 * until it completes), or the version it names. An unknown version refuses (fail closed): a newer release's run is
 * never executed under rules that might widen it.
 */
export function runConfigSemantics(snapshot: unknown): "legacy" | typeof EXTRACTION_CONFIG_VERSION {
  if (!isRecord(snapshot) || snapshot.configVersion === undefined || snapshot.configVersion === null) return "legacy";
  if (snapshot.configVersion === EXTRACTION_CONFIG_VERSION) return EXTRACTION_CONFIG_VERSION;
  throw new UnsupportedConfigVersionError(snapshot.configVersion);
}

export function assertSupportedConfigVersion(snapshot: unknown): void {
  runConfigSemantics(snapshot);
}

// ---- Operator policy (R0 reads today's env; phase 3 moves it to the operator config file) ------------------------

/** Kill-switch tokens (`DOCSLURP_DISABLE`, phase 2) the resolution honours. R0 derives the chart ones from today's env. */
export type ExtractionSwitch = "ai" | "charts" | "charts-ai" | "figures";

export type ExtractionPolicy = {
  /** `charts.originDefaults`: the visuals a run of each origin gets on a project with none. */
  originDefaults: Readonly<Record<RunOrigin, VisualsLevel>>;
  /** `charts.explicitFree` as evaluated now: may a caller or project choose `charts` explicitly. */
  explicitChartsAllowed: boolean;
  /** Switches that are off on this deployment. */
  disabled: ReadonlySet<ExtractionSwitch>;
};

/**
 * Explicit `charts` policy (`charts.explicitFree`): `auto` (default) allows it while free chart steps run inline in the
 * quarantine VM; `on` / `off` force it. R0 reads `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT` (unset or empty = `auto`).
 */
export function chartsExplicitFreeSetting(env: Env): "auto" | "on" | "off" {
  const raw = env.DOCSLURP_CHART_EXPORT_FREE_EXPLICIT;
  if (raw === undefined || raw.trim() === "") return "auto";
  return chartExportFreeExplicitAllowed(env) ? "on" : "off";
}

/** The extraction policy this deployment runs under, from today's env (`DOCSLURP_CHART_EXPORT*`). */
export function extractionPolicyFromEnv(env: Env): ExtractionPolicy {
  const disabled = new Set<ExtractionSwitch>();
  const chartSwitch = chartExportSwitch(env);
  if (chartSwitch === "off") disabled.add("charts");
  if (chartSwitch !== "on") disabled.add("charts-ai");
  const originDefault = (origin: RunOrigin): VisualsLevel => (defaultChartExportTier(origin, env) === "free" ? "charts" : "figures");
  return {
    originDefaults: { app: originDefault("app"), machine: originDefault("machine") },
    explicitChartsAllowed: chartExportFreeExplicitAllowed(env),
    disabled,
  };
}

/** What a deployment reports to clients as `visualsDefaults` (project record, MCP `getProjectSettings`). */
export type VisualsDefaults = {
  app: VisualsLevel;
  machine: VisualsLevel;
  /** Rungs a caller may choose explicitly on this deployment (after switches; privacy is per project). */
  available: VisualsLevel[];
};

export function visualsDefaults(policy: ExtractionPolicy): VisualsDefaults {
  const capped = (level: VisualsLevel) => capVisualsBySwitches(level, policy.disabled).level;
  return {
    app: capped(policy.originDefaults.app),
    machine: capped(policy.originDefaults.machine),
    available: VISUALS_LEVELS.filter((level) => visualsBlockedBy(level, policy, "standard") === null),
  };
}

function capVisualsBySwitches(level: VisualsLevel, disabled: ReadonlySet<ExtractionSwitch>): { level: VisualsLevel; capped: boolean } {
  let next = level;
  if (next === "charts-ai" && (disabled.has("charts-ai") || disabled.has("ai") || disabled.has("charts"))) next = "charts";
  if (next === "charts" && disabled.has("charts")) next = "figures";
  if (next === "figures" && disabled.has("figures")) next = "none";
  return { level: next, capped: next !== level };
}

function visualsBlockedBy(level: VisualsLevel, policy: ExtractionPolicy, privacyMode: unknown): ExtractionCapReason | null {
  if (level === "charts-ai") {
    if (policy.disabled.has("charts-ai") || policy.disabled.has("ai") || policy.disabled.has("charts")) return "switch";
    if (privacyRestricts(privacyMode)) return "privacy";
  }
  if (level === "charts" && (policy.disabled.has("charts") || !policy.explicitChartsAllowed)) return "switch";
  if (level === "figures" && policy.disabled.has("figures")) return "switch";
  return null;
}

function qualityBlockedBy(level: QualityLevel, policy: ExtractionPolicy, privacyMode: unknown, vision: unknown): ExtractionCapReason | null {
  if (level !== "smart") return null;
  if (policy.disabled.has("ai")) return "switch";
  if (privacyRestricts(privacyMode) && !visionReaderIsLocal(vision)) return "privacy";
  return null;
}

// ---- The one resolution function (design section 6) ---------------------------------------------------------------

/** Who asks. `apiKeyScopes`: the key's stored scopes, `null` when the key is unknown or revoked (fails closed). */
export type ExtractionCaller = {
  canEdit: boolean;
  apiKey?: { scopes: readonly string[] | null } | null;
};

export type ExtractionResolutionInput = {
  /** Explicit per-request values (upload, extract, reprocess, MCP), or undefined. */
  request?: { quality?: QualityLevel | null; visuals?: VisualsLevel | null };
  /** The project's stored values (visuals null = unset). */
  project: { quality: QualityLevel; visuals: VisualsLevel | null };
  /** Replays (reprocess, bulk reprocess, reindex, full index): the source run's stamped values. */
  replay?: { quality: QualityLevel; visuals: VisualsLevel | null } | null;
  /** Resume/retry of an existing run: its immutable stamped values; the result never exceeds them. */
  authority?: { quality: QualityLevel; visuals: VisualsLevel } | null;
  origin: RunOrigin;
  caller: ExtractionCaller;
  constraints: { privacyMode?: unknown; vision?: unknown };
  policy: ExtractionPolicy;
};

export type ExtractionResolutionError = {
  status: 400 | 403;
  code: typeof QUALITY_UNAVAILABLE_CODE | typeof VISUALS_UNAVAILABLE_CODE | typeof QUALITY_RAISE_FORBIDDEN_CODE | "chart_export_models_forbidden";
  field: "quality" | "visuals";
  reason: ExtractionCapReason | "authorization";
};

export type ExtractionResolution =
  | { ok: true; quality: QualityLevel; visuals: VisualsLevel; capsApplied: ExtractionCap[] }
  | { ok: false; error: ExtractionResolutionError };

/** True when the caller may raise a run to a billed rung: an editor session, or an editor's key with the billed scope. */
export function callerMayRaiseBilled(caller: ExtractionCaller): boolean {
  if (!caller.canEdit) return false;
  if (!caller.apiKey) return true;
  const scopes = caller.apiKey.scopes;
  return !!scopes && (scopes.includes(BILLED_FEATURES_SCOPE) || scopes.includes("projects:manage"));
}

const minQuality = (a: QualityLevel, b: QualityLevel) => (QUALITY_LEVEL_RANK[a] <= QUALITY_LEVEL_RANK[b] ? a : b);
const minVisuals = (a: VisualsLevel, b: VisualsLevel) => (VISUALS_LEVEL_RANK[a] <= VISUALS_LEVEL_RANK[b] ? a : b);
const maxVisuals = (a: VisualsLevel, b: VisualsLevel) => (VISUALS_LEVEL_RANK[a] >= VISUALS_LEVEL_RANK[b] ? a : b);

/**
 * Resolves one run's `quality` and `visuals` (design section 6), the same way for server, worker, estimates and replays:
 *
 * 1. `requested = request ?? replay ?? project ?? originDefault` per field. A stored explicit `charts` the deployment
 *    does not allow counts as unset.
 * 2. A request above `project ?? originDefault` is a raise: `smart` and `charts-ai` need an editor session, or a key
 *    with `pipeline:billed-features` (or `projects:manage`) whose owner is an editor; an explicit `charts` follows
 *    `charts.explicitFree`; `balanced` and `figures` need nothing; lowering is always allowed.
 * 3. Inherited replay values are capped at the current project's value (a replay never raises itself).
 * 4. Intersect with the run's own authority (resume/retry), the switches, `privacyMode` and the vision profile's locality.
 * 5. A request step 4 blocks gets a 400; a stored or inherited value is lowered and recorded in `capsApplied`.
 *
 * Scopes never override switches, privacy or locality.
 */
export function resolveExtractionSettings(input: ExtractionResolutionInput): ExtractionResolution {
  const { policy, constraints } = input;
  const capsApplied: ExtractionCap[] = [];
  const originDefault = policy.originDefaults[input.origin];
  const projectVisuals = input.project.visuals === "charts" && !policy.explicitChartsAllowed ? null : input.project.visuals;
  const baseQuality = input.project.quality;
  const baseVisuals = projectVisuals ?? originDefault;

  // Quality.
  let quality: QualityLevel;
  const requestedQuality = input.request?.quality ?? null;
  if (requestedQuality) {
    if (QUALITY_LEVEL_RANK[requestedQuality] > QUALITY_LEVEL_RANK[baseQuality] && requestedQuality === "smart" && !callerMayRaiseBilled(input.caller)) {
      return { ok: false, error: { status: 403, code: QUALITY_RAISE_FORBIDDEN_CODE, field: "quality", reason: "authorization" } };
    }
    const blocked = qualityBlockedBy(requestedQuality, policy, constraints.privacyMode, constraints.vision);
    if (blocked) return { ok: false, error: { status: 400, code: QUALITY_UNAVAILABLE_CODE, field: "quality", reason: blocked } };
    quality = requestedQuality;
  } else if (input.replay) {
    quality = minQuality(input.replay.quality, baseQuality);
    if (quality !== input.replay.quality) capsApplied.push({ field: "quality", from: input.replay.quality, to: quality, reason: "replay" });
  } else {
    quality = baseQuality;
  }

  // Visuals.
  let visuals: VisualsLevel;
  const requestedVisuals = input.request?.visuals ?? null;
  if (requestedVisuals) {
    const raise = VISUALS_LEVEL_RANK[requestedVisuals] > VISUALS_LEVEL_RANK[baseVisuals];
    if (raise && requestedVisuals === "charts-ai" && !callerMayRaiseBilled(input.caller)) {
      return { ok: false, error: { status: 403, code: "chart_export_models_forbidden", field: "visuals", reason: "authorization" } };
    }
    const blocked = visualsBlockedBy(requestedVisuals, policy, constraints.privacyMode);
    if (blocked) return { ok: false, error: { status: 400, code: VISUALS_UNAVAILABLE_CODE, field: "visuals", reason: blocked } };
    visuals = requestedVisuals;
  } else if (input.replay) {
    const inherited = input.replay.visuals ?? originDefault;
    // The most an unset project resolves to: the higher origin default, and `charts` while it may be chosen explicitly.
    const cap = projectVisuals ?? [policy.originDefaults.app, policy.originDefaults.machine].reduce(maxVisuals, policy.explicitChartsAllowed ? "charts" : "figures");
    visuals = minVisuals(inherited, cap);
    if (visuals !== inherited) capsApplied.push({ field: "visuals", from: inherited, to: visuals, reason: "replay" });
  } else {
    visuals = baseVisuals;
  }

  // Run authority: a resume or retry never exceeds what its run was admitted with.
  if (input.authority) {
    const q = minQuality(quality, input.authority.quality);
    if (q !== quality) { capsApplied.push({ field: "quality", from: quality, to: q, reason: "replay" }); quality = q; }
    const v = minVisuals(visuals, input.authority.visuals);
    if (v !== visuals) { capsApplied.push({ field: "visuals", from: visuals, to: v, reason: "replay" }); visuals = v; }
  }

  // Constraints on stored and inherited values: lowered, recorded.
  const qualityBlock = qualityBlockedBy(quality, policy, constraints.privacyMode, constraints.vision);
  if (qualityBlock) {
    capsApplied.push({ field: "quality", from: quality, to: "balanced", reason: qualityBlock });
    quality = "balanced";
  }
  if (visuals === "charts-ai" && privacyRestricts(constraints.privacyMode) && !requestedVisuals) {
    capsApplied.push({ field: "visuals", from: "charts-ai", to: "charts", reason: "privacy" });
    visuals = "charts";
  }
  const switched = capVisualsBySwitches(visuals, policy.disabled);
  if (switched.capped) {
    capsApplied.push({ field: "visuals", from: visuals, to: switched.level, reason: "switch" });
    visuals = switched.level;
  }
  return { ok: true, quality, visuals, capsApplied };
}

/** The rungs a caller may ask for on a new run in one project (`project.extractionChoices`). */
export type ExtractionChoices = { quality: QualityLevel[]; visuals: VisualsLevel[] };

/**
 * The `quality` and `visuals` rungs this caller may request on a new run in this project (upload, URL ingest, extract),
 * from this origin: exactly the rungs `resolveExtractionSettings` accepts as a request, so a client that offers only
 * these never offers a choice the server refuses (403 for a billed raise, 400 for privacy, locality or a switch). Rungs
 * at or below the project's own are always offered unless a constraint blocks them. Clients show these; the server
 * still resolves every request. The project's stored values are read as run creation reads them.
 */
export function extractionChoicesFor(input: {
  pipeline: unknown;
  origin: RunOrigin;
  caller: ExtractionCaller;
  policy: ExtractionPolicy;
}): ExtractionChoices {
  const record = isRecord(input.pipeline) ? input.pipeline : {};
  // Stored values as run creation compares them: no privacy lowering here (privacy refuses the request below).
  const stored = mapLegacyExtractionSettings({ ...record, privacyMode: "standard" }, { explicitFreeAllowed: input.policy.explicitChartsAllowed });
  const constraints = { privacyMode: record.privacyMode, vision: record.vision };
  const accepts = (request: { quality?: QualityLevel; visuals?: VisualsLevel }) => resolveExtractionSettings({
    request,
    project: stored,
    origin: input.origin,
    caller: input.caller,
    constraints,
    policy: input.policy,
  }).ok;
  return {
    quality: QUALITY_LEVELS.filter((quality) => accepts({ quality })),
    visuals: VISUALS_LEVELS.filter((visuals) => accepts({ visuals })),
  };
}

// ---- The run's stamped effective values (`run.pipeline.effective`) --------------------------------------------------

export type RunEffectiveExtraction = {
  quality: QualityLevel;
  visuals: VisualsLevel;
  /**
   * True when the run may read pages with a vision model beyond OCR: `smart`, or `balanced` with rescue reads on
   * (`visionFallback`). The autoscaler counts these runs' pages as page demand. `fastest` never reads pages.
   */
  readsPages: boolean;
  capsApplied: ExtractionCap[];
};

export const runEffectiveExtractionSchema = z.object({
  quality: qualityLevelSchema,
  visuals: visualsLevelSchema,
  readsPages: z.boolean(),
  capsApplied: z.array(z.object({ field: z.enum(["quality", "visuals"]), from: z.string(), to: z.string(), reason: z.string() })).default([]),
});

/**
 * The effective values a resolved legacy run pipeline runs: `quality` from its legacy quality, `visuals` from its
 * figures flag and resolved tier, `readsPages` = page reading allowed (`fast` never reads pages) and on (`visionFallback`,
 * which `good` forces on). Stamped at run creation; readers use it instead of raw legacy keys.
 */
export function runEffectiveExtraction(pipeline: {
  quality?: QualityMode | null;
  visionFallback?: boolean | null;
  figures?: boolean | null;
  chartExport?: { tier?: ChartExportTier | null } | null;
}, capsApplied: ExtractionCap[] = []): RunEffectiveExtraction {
  const legacyQuality = pipeline.quality ?? "auto";
  return {
    quality: qualityLevelFromLegacy(legacyQuality),
    visuals: visualsLevelForRun(pipeline.figures !== false, pipeline.chartExport?.tier ?? "off"),
    readsPages: legacyQuality !== "fast" && (legacyQuality === "good" || pipeline.visionFallback !== false),
    capsApplied,
  };
}

/** The response view of a run's extraction settings: its stamp, or (older runs) mapped on read with `legacy: true`. */
export function runExtractionView(pipeline: unknown): RunEffectiveExtraction & { legacy: boolean } {
  const record = isRecord(pipeline) ? pipeline : {};
  const stamped = runEffectiveExtractionSchema.safeParse(record.effective);
  if (stamped.success) return { ...(stamped.data as RunEffectiveExtraction), legacy: false };
  const chartExport = isRecord(record.chartExport) ? record.chartExport : {};
  const tier = chartExport.tier === "free" || chartExport.tier === "models" ? chartExport.tier : "off";
  return {
    ...runEffectiveExtraction({
      quality: isLegacyQualityMode(record.quality) ? record.quality : isQualityLevel(record.quality) ? legacyQualityModeFor(record.quality) : "auto",
      visionFallback: typeof record.visionFallback === "boolean" ? record.visionFallback : false,
      figures: record.figures !== false,
      chartExport: { tier },
    }),
    legacy: true,
  };
}

/** A project's extraction settings in the new names (`project.extraction`). */
export type ProjectExtractionView = { quality: QualityLevel; visuals: VisualsLevel | null };

export function projectExtractionView(pipeline: unknown, env: Env): ProjectExtractionView {
  // The view reports what is stored; constraint lowering shows up as `capsApplied` on runs, not here.
  const record = isRecord(pipeline) ? pipeline : {};
  const mapped = mapLegacyExtractionSettings({ ...record, privacyMode: "standard" }, { explicitFreeAllowed: chartExportFreeExplicitAllowed(env) });
  return { quality: mapped.quality, visuals: mapped.visuals };
}
