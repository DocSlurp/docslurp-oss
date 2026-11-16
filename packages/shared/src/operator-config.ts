/*
 * Operator config file (`DOCSLURP_OPERATOR_CONFIG`): one versioned JSON file for a deployment's tuning knobs and
 * deploy-wide model overrides, read by the API and the worker at startup (docs/self-host/operator-config.md).
 *
 * - Unset variable: code defaults (and whatever the individual environment variables say, as before).
 * - Set but missing, unreadable, not JSON, an unknown key, a value out of range or a refused model: startup refuses.
 * - Every field maps onto the environment variable its reader already understands. The file's value is written into
 *   the process environment before anything reads it, so the readers, their own validation and their defaults stay the
 *   one implementation. A variable set both in the environment and in the file must agree, or startup refuses: a
 *   rollback to a build that reads only the environment keeps the same behaviour, and the two can never silently
 *   disagree about a cap.
 * - The file can lower or move knobs only inside the bounds its schema states. It cannot lower the isolation floor:
 *   `parsing.local` (in-process engines and host parsing) is refused in every non-development environment, and nothing
 *   else in it selects where customer bytes are parsed.
 * - Its digest (sha-256 of the canonical JSON of the validated file) is reported by each worker to the capability
 *   registry, so the API can show and refuse app/worker skew (`/ops/worker-fleet`).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { isAutomaticSelectionDenied } from "./automatic-model-selection.js";
import { visionModelCatalogByUri, visionModelRefusal } from "./embedding.js";
import { ocrLanguageSchema } from "./extraction.js";
import { automaticModelCallProblem, policyModelId } from "./model-call-policy.js";
import { CHAT_TIERS } from "./project-chat-models.js";
import { isProhibitedRoutingModelId, MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE } from "./routing-targets.js";
import { isDevelopmentEnvironment } from "./runtime-environment.js";

export const OPERATOR_CONFIG_ENV = "DOCSLURP_OPERATOR_CONFIG";
export const OPERATOR_CONFIG_VERSION = 1;
/** Largest operator config file read; anything bigger is refused unread. */
export const OPERATOR_CONFIG_MAX_BYTES = 256 * 1024;

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const tierOrModes = <T extends readonly [string, ...string[]]>(modes: T) => z.enum([...modes, ...CHAT_TIERS] as [string, ...string[]]);
const modelRef = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/@+-]+$/, "a model id or llm:// URI");
/** `#123`, `owner/repo#123` or an https issue link: where the flag's removal is tracked. */
const removalTicket = z.string().trim().max(200).regex(
  /^(#\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+\/(issues|pull)\/\d+)$/,
  "#<n>, owner/repo#<n> or an https issue link",
);
const rolloutFlag = <T extends z.ZodTypeAny>(value: T) => z.strictObject({
  value,
  owner: z.string().trim().min(1).max(80),
  removalTicket,
});
const absolutePath = z.string().trim().min(1).max(1024).refine((value) => isAbsolute(value) && !value.includes("\0"), "an absolute path");

/** The schema, version 1. Every object is strict: an unknown key refuses startup. */
export const operatorConfigSchema = z.strictObject({
  version: z.literal(OPERATOR_CONFIG_VERSION),
  ocr: z.strictObject({
    /** DOCSLURP_OCR_MAX_ATTEMPTS: recogniser trial runs per page. */
    maxAttempts: int(1, 7).optional(),
    /** DOCSLURP_OCR_MAX_LONG_EDGE: long-edge cap of OCR input, px. */
    maxLongEdge: int(640, 4000).optional(),
    /** DOCSLURP_OCR_MAX_CONCURRENT: OCR jobs per worker process. */
    maxConcurrent: int(1, 32).optional(),
    /** DOCSLURP_OCR_LANGUAGE: the worker's default OCR language. */
    language: z.union([z.literal("auto"), ocrLanguageSchema]).optional(),
    /** The page image reader (DOCSLURP_OCR_PAGE_READER*). Its per-organization daily cost cap is mandatory when it is on. */
    pageReader: z.strictObject({
      mode: tierOrModes(["off", "escalation", "all"] as const),
      maxPagesPerDocument: int(0, 20_000).optional(),
      orgDailyMaxCostCents: int(0, 10_000_000).optional(),
    }).optional(),
  }).optional(),
  vision: z.strictObject({
    /** DOCSLURP_VISION_PAGE_READER: vision page transcription through the page image reader (shares its budgets). */
    pageReader: z.strictObject({ mode: tierOrModes(["off", "all"] as const) }).optional(),
    /** The vision run guards (VISION_*), bounds as their reader's. */
    guards: z.strictObject({
      pageAttempts: int(1, 4).optional(),
      regionAttemptsPerPage: int(0, 64).optional(),
      breakerMinFailures: int(1, 10_000).optional(),
      breakerFailureRate: num(0.01, 1).optional(),
      orgUnchargedLimitCents: int(1, 1_000_000).optional(),
      throttleAllowance: int(0, 20).optional(),
      routeOverrunLimit: int(1, 1_000).optional(),
      routeWeightCorrectionMax: num(1, 100).optional(),
    }).optional(),
  }).optional(),
  ai: z.strictObject({
    /** Hosted OCR escalation (DOCSLURP_OCR_ESCALATION*). */
    escalation: z.strictObject({
      enabled: z.boolean().optional(),
      maxPagesPerDocument: int(0, 10_000).optional(),
      maxAttemptsPerDocument: int(0, 20_000).optional(),
    }).optional(),
  }).optional(),
  models: z.strictObject({
    /** Deploy-wide emergency model switches, each checked against the catalog, the output-price cap and the prohibited list. */
    overrides: z.strictObject({
      vision: modelRef.optional(),
      ocrEscalation: modelRef.optional(),
      chartGenerator: modelRef.optional(),
    }).optional(),
  }).optional(),
  router: z.strictObject({
    tableGate: z.enum(["off", "shadow"]).optional(),
    /** Accept-text pages take the in-process native engine's Markdown: refused outside development. */
    preferNativeMarkdown: z.boolean().optional(),
    decisionHealthHistory: absolutePath.optional(),
  }).optional(),
  doppler: z.strictObject({
    shards: z.boolean().optional(),
    maxShards: int(1, 128).optional(),
    vmMaxParallel: int(1, 64).optional(),
    vmGlobalParallel: int(1, 256).optional(),
    shardTransferMb: int(1, 8192).optional(),
    shardCostOverhead: num(0, 10).optional(),
    figureMibInFlight: int(128, 8192).optional(),
    figureUploadConcurrency: int(1, 64).optional(),
    figureBufferBytes: int(4 * 1024 * 1024, 4 * 1024 * 1024 * 1024).optional(),
    figureWorkerBufferBytes: int(4 * 1024 * 1024, 4 * 1024 * 1024 * 1024).optional(),
  }).optional(),
  charts: z.strictObject({
    /** Visuals for a run whose project sets none, per run origin: `figures` (no chart export) or `charts` (free steps). */
    originDefaults: z.strictObject({
      app: z.enum(["figures", "charts"]).optional(),
      machine: z.enum(["figures", "charts"]).optional(),
    }).optional(),
    /** Whether an explicit `charts` (free tier) is allowed: `auto` follows `inline`. */
    explicitFree: z.enum(["auto", "on", "off"]).optional(),
    /** Free chart steps inside the quarantine VM every document already boots. */
    inline: z.boolean().optional(),
    /** Per-organization cap on free-tier chart VM runs per clock hour (non-inline path). */
    freeVmBudget: z.strictObject({ runsPerOrgHour: int(0, 10_000) }).optional(),
  }).optional(),
  figureResume: z.strictObject({
    enabled: z.boolean().optional(),
    chat: z.boolean().optional(),
    audit: z.boolean().optional(),
    gcDelete: z.boolean().optional(),
    concurrency: int(1, 16).optional(),
    globalMax: int(1, 256).optional(),
    orgDailyVmMinutes: int(0, 1_440).optional(),
    launchFloor: int(1, 64).optional(),
    launchCeiling: int(1, 512).optional(),
    vmMsPerPage: int(1, 2_000).optional(),
    vmMsPerLaunch: int(0, 120_000).optional(),
    vmHeadroom: int(1, 16).optional(),
    docVmSecondsFloor: int(60, 3_600).optional(),
    docVmSecondsCeiling: int(60, 12 * 3_600).optional(),
    noProgressLimit: int(1, 32).optional(),
    minProgressPercent: int(0, 50).optional(),
    minProgressBytes: int(0, 1_048_576).optional(),
    maxGrants: int(0, 10).optional(),
  }).optional(),
  raster: z.strictObject({
    /** PDF_PDFTOPPM_CONCURRENCY: pdftoppm lanes per selected-page render. */
    pdftoppmLanes: int(1, 4).optional(),
    /** PDF_PDFTOPPM_PROCESS_CONCURRENCY: sandboxed raster commands per worker process. */
    pdftoppmProcesses: int(1, 32).optional(),
  }).optional(),
  /** In-process parsing opt-ins. Refused in every non-development environment (VM-only parsing). */
  parsing: z.strictObject({
    local: z.strictObject({
      nativeEngine: z.enum(["off", "shadow", "native-pdf"]).optional(),
      rasterEngine: z.enum(["pdftoppm", "native-pdf"]).optional(),
    }).optional(),
  }).optional(),
  /** Unfinished-feature flags; each names its owner and the ticket that removes it. */
  rollout: z.strictObject({
    pageFacts: rolloutFlag(z.enum(["off", "store", "use"])).optional(),
    layoutSource: rolloutFlag(z.enum(["walker", "facts", "both", "selective"])).optional(),
  }).optional(),
});

export type OperatorConfig = z.infer<typeof operatorConfigSchema>;

/** Who reads a variable: `worker` only, or `both` (the API reads it too). The API applies only `both` variables. */
type Readers = "worker" | "both";
export type OperatorConfigRole = "worker" | "server";

interface KnobSpec {
  /** Dotted file path, for messages and docs. */
  path: string;
  env: string;
  readers: Readers;
  get: (config: OperatorConfig) => unknown;
  /** The environment value for a file value; null means "the variable must stay unset". */
  render: (value: never) => string | null;
  /** A canonical form of an environment value, for comparison; undefined when the reader would not accept it. */
  canonical: (raw: string) => string | undefined;
}

/** On/off words every boolean reader in this file accepts (some readers know more; none knows fewer). */
const ON = ["1", "true", "on"];
const OFF = ["0", "false", "off"];
const lower = (raw: string) => raw.trim().toLowerCase();
/**
 * Numbers compare only in their canonical spelling (no sign, leading zeros, exponent or spaces inside): some readers
 * (figure resume) reject any other spelling and fall back to their default, so a looser match could "agree" with the
 * file while the reader runs a different value. Any other spelling is a conflict.
 */
const intCanonical = (raw: string) => (/^(0|[1-9]\d*)$/.test(raw.trim()) ? raw.trim() : undefined);
const numCanonical = (raw: string) => {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  return trimmed !== "" && Number.isFinite(value) && String(value) === trimmed ? trimmed : undefined;
};
const boolCanonical = (raw: string) => (ON.includes(lower(raw)) ? "on" : OFF.includes(lower(raw)) ? "off" : undefined);
const enumCanonical = (raw: string) => lower(raw);
const exactCanonical = (raw: string) => raw.trim();

function intKnob(path: string, env: string, readers: Readers, get: KnobSpec["get"]): KnobSpec {
  return { path, env, readers, get, render: (value: number) => String(value), canonical: intCanonical };
}
function numKnob(path: string, env: string, readers: Readers, get: KnobSpec["get"]): KnobSpec {
  return { path, env, readers, get, render: (value: number) => String(value), canonical: numCanonical };
}
function boolKnob(path: string, env: string, readers: Readers, get: KnobSpec["get"], on = "on", off = "off"): KnobSpec {
  return { path, env, readers, get, render: (value: boolean) => (value ? on : off), canonical: (raw) => boolCanonical(raw) && (boolCanonical(raw) === "on" ? on : off) };
}
function enumKnob(path: string, env: string, readers: Readers, get: KnobSpec["get"]): KnobSpec {
  return { path, env, readers, get, render: (value: string) => value, canonical: enumCanonical };
}
function stringKnob(path: string, env: string, readers: Readers, get: KnobSpec["get"]): KnobSpec {
  return { path, env, readers, get, render: (value: string) => value, canonical: exactCanonical };
}

/** Chart origin default: `figures` is the variable's `off`, `charts` its `free` (anything else reads as `off`). */
const originDefaultKnob = (origin: "app" | "machine", env: string): KnobSpec => ({
  path: `charts.originDefaults.${origin}`,
  env,
  readers: "both",
  get: (c) => c.charts?.originDefaults?.[origin],
  render: (value: "figures" | "charts") => (value === "charts" ? "free" : "off"),
  // Anything but `free` reads as `off` (chart-export.ts offOrFree).
  canonical: (raw) => (lower(raw) === "free" ? "free" : "off"),
});

/**
 * Every field and the variable it sets. Order is the documentation order. A knob not listed here does not exist in the
 * file (the schema refuses it).
 */
export const OPERATOR_CONFIG_KNOBS: readonly KnobSpec[] = [
  intKnob("ocr.maxAttempts", "DOCSLURP_OCR_MAX_ATTEMPTS", "worker", (c) => c.ocr?.maxAttempts),
  intKnob("ocr.maxLongEdge", "DOCSLURP_OCR_MAX_LONG_EDGE", "worker", (c) => c.ocr?.maxLongEdge),
  intKnob("ocr.maxConcurrent", "DOCSLURP_OCR_MAX_CONCURRENT", "worker", (c) => c.ocr?.maxConcurrent),
  stringKnob("ocr.language", "DOCSLURP_OCR_LANGUAGE", "worker", (c) => c.ocr?.language),
  enumKnob("ocr.pageReader.mode", "DOCSLURP_OCR_PAGE_READER", "worker", (c) => c.ocr?.pageReader?.mode),
  intKnob("ocr.pageReader.maxPagesPerDocument", "DOCSLURP_OCR_PAGE_READER_MAX_PAGES", "worker", (c) => c.ocr?.pageReader?.maxPagesPerDocument),
  intKnob("ocr.pageReader.orgDailyMaxCostCents", "DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS", "worker", (c) => c.ocr?.pageReader?.orgDailyMaxCostCents),
  enumKnob("vision.pageReader.mode", "DOCSLURP_VISION_PAGE_READER", "worker", (c) => c.vision?.pageReader?.mode),
  intKnob("vision.guards.pageAttempts", "VISION_PAGE_ATTEMPTS", "worker", (c) => c.vision?.guards?.pageAttempts),
  intKnob("vision.guards.regionAttemptsPerPage", "VISION_REGION_ATTEMPTS_PER_PAGE", "worker", (c) => c.vision?.guards?.regionAttemptsPerPage),
  intKnob("vision.guards.breakerMinFailures", "VISION_BREAKER_MIN_FAILURES", "worker", (c) => c.vision?.guards?.breakerMinFailures),
  numKnob("vision.guards.breakerFailureRate", "VISION_BREAKER_FAILURE_RATE", "worker", (c) => c.vision?.guards?.breakerFailureRate),
  intKnob("vision.guards.orgUnchargedLimitCents", "VISION_ORG_UNCHARGED_LIMIT_CENTS", "worker", (c) => c.vision?.guards?.orgUnchargedLimitCents),
  intKnob("vision.guards.throttleAllowance", "VISION_THROTTLE_ALLOWANCE", "worker", (c) => c.vision?.guards?.throttleAllowance),
  intKnob("vision.guards.routeOverrunLimit", "VISION_ROUTE_OVERRUN_LIMIT", "worker", (c) => c.vision?.guards?.routeOverrunLimit),
  numKnob("vision.guards.routeWeightCorrectionMax", "VISION_ROUTE_WEIGHT_CORRECTION_MAX", "worker", (c) => c.vision?.guards?.routeWeightCorrectionMax),
  boolKnob("ai.escalation.enabled", "DOCSLURP_OCR_ESCALATION", "worker", (c) => c.ai?.escalation?.enabled),
  intKnob("ai.escalation.maxPagesPerDocument", "DOCSLURP_OCR_ESCALATION_MAX_PAGES", "worker", (c) => c.ai?.escalation?.maxPagesPerDocument),
  intKnob("ai.escalation.maxAttemptsPerDocument", "DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS", "worker", (c) => c.ai?.escalation?.maxAttemptsPerDocument),
  stringKnob("models.overrides.vision", "DOCSLURP_VISION_MODEL_URI", "both", (c) => c.models?.overrides?.vision),
  stringKnob("models.overrides.ocrEscalation", "DOCSLURP_OCR_ESCALATION_MODEL", "worker", (c) => c.models?.overrides?.ocrEscalation),
  stringKnob("models.overrides.chartGenerator", "CHART_EXPORT_GENERATOR_MODEL", "worker", (c) => c.models?.overrides?.chartGenerator),
  enumKnob("router.tableGate", "PAGE_ROUTER_TABLE_GATE", "worker", (c) => c.router?.tableGate),
  { ...boolKnob("router.preferNativeMarkdown", "PAGE_ROUTER_PREFER_NATIVE_MARKDOWN", "worker", (c) => c.router?.preferNativeMarkdown, "1", "0"),
    // The router reads only 1/true as on; everything else is off.
    canonical: (raw: string) => (["1", "true"].includes(lower(raw)) ? "1" : "0") },
  stringKnob("router.decisionHealthHistory", "DOCSLURP_DECISION_HEALTH_HISTORY", "worker", (c) => c.router?.decisionHealthHistory),
  boolKnob("doppler.shards", "DOCSLURP_DOPPLER_SHARDS", "worker", (c) => c.doppler?.shards),
  intKnob("doppler.maxShards", "DOCSLURP_DOPPLER_MAX_SHARDS", "worker", (c) => c.doppler?.maxShards),
  intKnob("doppler.vmMaxParallel", "DOCSLURP_DOPPLER_VM_MAX_PARALLEL", "worker", (c) => c.doppler?.vmMaxParallel),
  intKnob("doppler.vmGlobalParallel", "DOCSLURP_DOPPLER_VM_GLOBAL_PARALLEL", "worker", (c) => c.doppler?.vmGlobalParallel),
  intKnob("doppler.shardTransferMb", "DOCSLURP_DOPPLER_SHARD_TRANSFER_MB", "worker", (c) => c.doppler?.shardTransferMb),
  numKnob("doppler.shardCostOverhead", "DOCSLURP_DOPPLER_SHARD_COST_OVERHEAD", "worker", (c) => c.doppler?.shardCostOverhead),
  intKnob("doppler.figureMibInFlight", "DOCSLURP_DOPPLER_FIGURE_MIB_IN_FLIGHT", "worker", (c) => c.doppler?.figureMibInFlight),
  intKnob("doppler.figureUploadConcurrency", "DOCSLURP_DOPPLER_FIGURE_UPLOAD_CONCURRENCY", "worker", (c) => c.doppler?.figureUploadConcurrency),
  intKnob("doppler.figureBufferBytes", "DOCSLURP_DOPPLER_FIGURE_BUFFER_BYTES", "worker", (c) => c.doppler?.figureBufferBytes),
  intKnob("doppler.figureWorkerBufferBytes", "DOCSLURP_DOPPLER_FIGURE_WORKER_BUFFER_BYTES", "worker", (c) => c.doppler?.figureWorkerBufferBytes),
  originDefaultKnob("app", "DOCSLURP_CHART_EXPORT_APP_DEFAULT"),
  originDefaultKnob("machine", "DOCSLURP_CHART_EXPORT_API_DEFAULT"),
  {
    path: "charts.explicitFree",
    env: "DOCSLURP_CHART_EXPORT_FREE_EXPLICIT",
    readers: "both",
    get: (c) => c.charts?.explicitFree,
    // `auto` is the variable left unset (it then follows inline extraction).
    render: (value: "auto" | "on" | "off") => (value === "auto" ? null : value),
    // The reader's on words (chart-export.ts CHART_EXPORT_ENV_ON_VALUES); anything else refuses explicit free.
    canonical: (raw) => (["on", "1", "true", "yes"].includes(lower(raw)) ? "on" : "off"),
  },
  {
    path: "charts.inline",
    env: "DOCSLURP_CHART_EXPORT_INLINE",
    readers: "both",
    get: (c) => c.charts?.inline,
    render: (value: boolean) => (value ? "1" : "0"),
    // Inline is on for exactly `1`.
    canonical: (raw) => (raw.trim() === "1" ? "1" : "0"),
  },
  intKnob("charts.freeVmBudget.runsPerOrgHour", "DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR", "both", (c) => c.charts?.freeVmBudget?.runsPerOrgHour),
  boolKnob("figureResume.enabled", "DOCSLURP_FIGURE_RESUME", "both", (c) => c.figureResume?.enabled),
  boolKnob("figureResume.chat", "DOCSLURP_FIGURE_RESUME_CHAT", "both", (c) => c.figureResume?.chat),
  boolKnob("figureResume.audit", "DOCSLURP_FIGURE_AUDIT", "both", (c) => c.figureResume?.audit),
  boolKnob("figureResume.gcDelete", "DOCSLURP_FIGURE_GC_DELETE", "both", (c) => c.figureResume?.gcDelete),
  intKnob("figureResume.concurrency", "DOCSLURP_FIGURE_RESUME_CONCURRENCY", "both", (c) => c.figureResume?.concurrency),
  intKnob("figureResume.globalMax", "DOCSLURP_FIGURE_RESUME_GLOBAL_MAX", "both", (c) => c.figureResume?.globalMax),
  intKnob("figureResume.orgDailyVmMinutes", "DOCSLURP_FIGURE_RESUME_ORG_DAILY_VM_MINUTES", "both", (c) => c.figureResume?.orgDailyVmMinutes),
  intKnob("figureResume.launchFloor", "DOCSLURP_FIGURE_RESUME_LAUNCH_FLOOR", "both", (c) => c.figureResume?.launchFloor),
  intKnob("figureResume.launchCeiling", "DOCSLURP_FIGURE_RESUME_LAUNCH_CEILING", "both", (c) => c.figureResume?.launchCeiling),
  intKnob("figureResume.vmMsPerPage", "DOCSLURP_FIGURE_RESUME_VM_MS_PER_PAGE", "both", (c) => c.figureResume?.vmMsPerPage),
  intKnob("figureResume.vmMsPerLaunch", "DOCSLURP_FIGURE_RESUME_VM_MS_PER_LAUNCH", "both", (c) => c.figureResume?.vmMsPerLaunch),
  intKnob("figureResume.vmHeadroom", "DOCSLURP_FIGURE_RESUME_VM_HEADROOM", "both", (c) => c.figureResume?.vmHeadroom),
  intKnob("figureResume.docVmSecondsFloor", "DOCSLURP_FIGURE_RESUME_DOC_VM_SECONDS_FLOOR", "both", (c) => c.figureResume?.docVmSecondsFloor),
  intKnob("figureResume.docVmSecondsCeiling", "DOCSLURP_FIGURE_RESUME_DOC_VM_SECONDS_CEILING", "both", (c) => c.figureResume?.docVmSecondsCeiling),
  intKnob("figureResume.noProgressLimit", "DOCSLURP_FIGURE_RESUME_NO_PROGRESS", "both", (c) => c.figureResume?.noProgressLimit),
  intKnob("figureResume.minProgressPercent", "DOCSLURP_FIGURE_RESUME_MIN_PROGRESS_PERCENT", "both", (c) => c.figureResume?.minProgressPercent),
  intKnob("figureResume.minProgressBytes", "DOCSLURP_FIGURE_RESUME_MIN_PROGRESS_BYTES", "both", (c) => c.figureResume?.minProgressBytes),
  intKnob("figureResume.maxGrants", "DOCSLURP_FIGURE_RESUME_MAX_GRANTS", "both", (c) => c.figureResume?.maxGrants),
  intKnob("raster.pdftoppmLanes", "PDF_PDFTOPPM_CONCURRENCY", "worker", (c) => c.raster?.pdftoppmLanes),
  intKnob("raster.pdftoppmProcesses", "PDF_PDFTOPPM_PROCESS_CONCURRENCY", "worker", (c) => c.raster?.pdftoppmProcesses),
  enumKnob("parsing.local.nativeEngine", "DOCSLURP_PDF_ENGINE", "worker", (c) => c.parsing?.local?.nativeEngine),
  enumKnob("parsing.local.rasterEngine", "PDF_RASTER_ENGINE", "worker", (c) => c.parsing?.local?.rasterEngine),
  enumKnob("rollout.pageFacts", "DOCSLURP_DOPPLER_PAGE_FACTS", "worker", (c) => c.rollout?.pageFacts?.value),
  enumKnob("rollout.layoutSource", "DOCSLURP_DOPPLER_LAYOUT_SOURCE", "worker", (c) => c.rollout?.layoutSource?.value),
];

/** A refused operator config. The message names the file path or field, never a secret (the file holds none). */
export class OperatorConfigError extends Error {
  constructor(message: string) {
    super(`[operator-config] ${message}; refusing to start`);
    this.name = "OperatorConfigError";
  }
}

const HOSTED_OCR_PROVIDERS = new Set(["deepinfra", "openrouter", "openai"]);

function uriProvider(uri: string): string | null {
  return /^llm:\/\/([a-z0-9-]+)\//i.exec(uri.trim())?.[1]?.toLowerCase() ?? null;
}

/** A hosted vision catalog entry under the output-price cap, never prohibited or denied, or why not. */
function hostedVisionModelProblem(uri: string): string | null {
  const entry = visionModelCatalogByUri[uri];
  if (!entry) return "not a reviewed vision model (an llm:// URI from the vision catalog)";
  if (entry.target !== "hosted") return "not a hosted model";
  const refusal = visionModelRefusal(uri);
  if (refusal) return `refused by the catalog (${refusal.slice(0, 80)})`;
  const pricing = (entry as { tokenPricing?: { outputUsdPerMillion?: number } | null }).tokenPricing;
  if (!pricing || typeof pricing.outputUsdPerMillion !== "number") return "no verified price";
  if (pricing.outputUsdPerMillion >= MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE) return "output price at or above the cap";
  return null;
}

/**
 * Why a deploy-wide model override is refused, or null. Every override applies to callers who chose only a category,
 * so the same rules as automatic selection apply: never Pro/Ultra, never a denied family, a verified price under the
 * output-price cap, and a reviewed catalog entry for the reader it replaces.
 */
export function operatorModelOverrideProblem(field: "vision" | "ocrEscalation" | "chartGenerator", model: string): string | null {
  const ref = model.trim();
  if (isProhibitedRoutingModelId(ref) || isProhibitedRoutingModelId(policyModelId(ref))) return "prohibited model";
  if (isAutomaticSelectionDenied(ref)) return "never selected automatically";
  const policy = automaticModelCallProblem(ref);
  if (policy) return policy;
  if (field === "vision") return hostedVisionModelProblem(ref);
  if (field === "ocrEscalation") {
    const problem = hostedVisionModelProblem(ref);
    if (problem) return problem;
    return HOSTED_OCR_PROVIDERS.has(uriProvider(ref) ?? "") ? null : "not a hosted OCR provider";
  }
  // Chart generator: a reviewed, priced OpenRouter vision model (the worker also requires one of its admitted generator
  // candidates).
  if (uriProvider(ref) !== "openrouter") return "chart generators are llm://openrouter/ vision models";
  return hostedVisionModelProblem(ref);
}

/**
 * Checks beyond the schema. Throws OperatorConfigError on the first group of problems.
 * - `parsing.local` and `router.preferNativeMarkdown: true` are refused outside development (VM-only parsing).
 * - The page image reader on needs its per-organization daily cost cap stated in the file.
 * - Every model override passes `operatorModelOverrideProblem`.
 */
export function assertOperatorConfigPolicy(config: OperatorConfig, env: Record<string, string | undefined> = process.env): void {
  const problems: string[] = [];
  const development = isDevelopmentEnvironment(env);
  if (!development) {
    if (config.parsing?.local !== undefined) problems.push("parsing.local is refused outside development: customer files are parsed only in VMs");
    if (config.router?.preferNativeMarkdown === true) problems.push("router.preferNativeMarkdown needs the in-process native engine, refused outside development");
  }
  const reader = config.ocr?.pageReader;
  if (reader && reader.mode !== "off" && reader.orgDailyMaxCostCents === undefined) {
    problems.push("ocr.pageReader.orgDailyMaxCostCents is required when ocr.pageReader.mode is on (the reader's only spend bound)");
  }
  if (config.vision?.pageReader && config.vision.pageReader.mode !== "off" && config.ocr?.pageReader?.orgDailyMaxCostCents === undefined) {
    problems.push("ocr.pageReader.orgDailyMaxCostCents is required when vision.pageReader.mode is on (it shares the reader's spend bound)");
  }
  for (const [field, model] of Object.entries(config.models?.overrides ?? {}) as Array<["vision" | "ocrEscalation" | "chartGenerator", string | undefined]>) {
    if (model === undefined) continue;
    const problem = operatorModelOverrideProblem(field, model);
    if (problem) problems.push(`models.overrides.${field} refused: ${problem}`);
  }
  if (problems.length) throw new OperatorConfigError(problems.join("; "));
}

/** Sorted-key JSON, the digest's input. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `sha256:<hex>` of the validated config's canonical JSON: formatting and key order do not change it. */
export function operatorConfigDigest(config: OperatorConfig): string {
  return `sha256:${createHash("sha256").update(canonicalJson(config)).digest("hex")}`;
}

function zodIssues(error: z.ZodError): string {
  return error.issues.slice(0, 10).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** Parse and check a config object (already JSON-decoded). Throws OperatorConfigError. */
export function parseOperatorConfig(value: unknown, env: Record<string, string | undefined> = process.env): OperatorConfig {
  const parsed = operatorConfigSchema.safeParse(value);
  if (!parsed.success) throw new OperatorConfigError(`invalid operator config: ${zodIssues(parsed.error)}`);
  assertOperatorConfigPolicy(parsed.data, env);
  return parsed.data;
}

/**
 * The first key repeated within one object of already-valid JSON text, or null. JSON.parse keeps the last of duplicate
 * keys, so a reviewer reading the first could approve a different cap than the one that runs.
 */
export function duplicateJsonKey(text: string): string | null {
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") { stack.push(new Set()); expectKey = true; continue; }
    if (ch === "[") { stack.push(null); expectKey = false; continue; }
    if (ch === "}" || ch === "]") { stack.pop(); expectKey = false; continue; }
    if (ch === ",") { expectKey = stack[stack.length - 1] instanceof Set; continue; }
    if (ch === "\"") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\"") j += text[j] === "\\" ? 2 : 1;
      if (expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        const keys = stack[stack.length - 1];
        if (keys) {
          if (keys.has(key)) return key;
          keys.add(key);
        }
        expectKey = false;
      }
      i = j;
    }
  }
  return null;
}

export interface LoadedOperatorConfig {
  path: string;
  config: OperatorConfig;
  digest: string;
}

/**
 * Read `DOCSLURP_OPERATOR_CONFIG`. Null when the variable is unset or empty. Throws OperatorConfigError when it is set
 * and the file is not an absolute path, missing, unreadable, too big, not JSON or not a valid config.
 */
export function loadOperatorConfig(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => {
    const stat = statSync(path);
    if (!stat.isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTFILE" });
    if (stat.size > OPERATOR_CONFIG_MAX_BYTES) throw Object.assign(new Error("too big"), { code: "ETOOBIG" });
    return readFileSync(path, "utf8");
  },
): LoadedOperatorConfig | null {
  const path = env[OPERATOR_CONFIG_ENV]?.trim();
  if (!path) return null;
  if (!isAbsolute(path)) throw new OperatorConfigError(`${OPERATOR_CONFIG_ENV} must be an absolute path`);
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "EREAD";
    throw new OperatorConfigError(`${OPERATOR_CONFIG_ENV}=${path} cannot be read (${code})`);
  }
  if (Buffer.byteLength(text, "utf8") > OPERATOR_CONFIG_MAX_BYTES) throw new OperatorConfigError(`${OPERATOR_CONFIG_ENV}=${path} is larger than ${OPERATOR_CONFIG_MAX_BYTES} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OperatorConfigError(`${OPERATOR_CONFIG_ENV}=${path} is not valid JSON`);
  }
  const duplicate = duplicateJsonKey(text);
  if (duplicate) throw new OperatorConfigError(`${OPERATOR_CONFIG_ENV}=${path} repeats the key ${JSON.stringify(duplicate.slice(0, 80))} (JSON keeps only the last one)`);
  const config = parseOperatorConfig(json, env);
  return { path, config, digest: operatorConfigDigest(config) };
}

/** The environment a config sets for one process role: variable name to value (null: must stay unset). */
export function operatorConfigEnvironment(config: OperatorConfig, role: OperatorConfigRole): Map<string, { path: string; value: string | null }> {
  const out = new Map<string, { path: string; value: string | null }>();
  for (const knob of OPERATOR_CONFIG_KNOBS) {
    if (role === "server" && knob.readers !== "both") continue;
    const value = knob.get(config);
    if (value === undefined) continue;
    out.set(knob.env, { path: knob.path, value: knob.render(value as never) });
  }
  return out;
}

export interface OperatorConfigApplyResult {
  /** Variables the file set (they were unset). */
  applied: string[];
  /** Variables set in both places with the same meaning. */
  agreed: string[];
}

/**
 * Write the config's variables into `env` for `role`. A variable already set must mean the same as the file's value, or
 * this throws and changes nothing (a conflict refuses startup, whichever side is newer).
 */
export function applyOperatorConfigEnvironment(
  config: OperatorConfig,
  env: Record<string, string | undefined>,
  role: OperatorConfigRole,
): OperatorConfigApplyResult {
  const knobs = new Map(OPERATOR_CONFIG_KNOBS.map((knob) => [knob.env, knob]));
  const applied: Array<[string, string]> = [];
  const agreed: string[] = [];
  const conflicts: string[] = [];
  for (const [name, { path, value }] of operatorConfigEnvironment(config, role)) {
    const raw = env[name];
    // An empty value is a value: some readers give "" a meaning (Number("") is 0), so it is compared, never overwritten.
    if (raw === undefined) {
      if (value !== null) applied.push([name, value]);
      continue;
    }
    if (value === null && raw.trim() === "") {
      agreed.push(name);
      continue;
    }
    const knob = knobs.get(name)!;
    const envCanonical = knob.canonical(raw);
    if (value !== null && envCanonical !== undefined && envCanonical === knob.canonical(value)) {
      agreed.push(name);
      continue;
    }
    conflicts.push(`${name}=${JSON.stringify(raw.trim().slice(0, 80))} conflicts with ${path}${value === null ? " (which needs it unset)" : `=${JSON.stringify(value)}`}`);
  }
  if (conflicts.length) throw new OperatorConfigError(`environment and operator config disagree: ${conflicts.join("; ")}`);
  for (const [name, value] of applied) env[name] = value;
  return { applied: applied.map(([name]) => name), agreed };
}

export interface OperatorConfigState {
  /** Null when DOCSLURP_OPERATOR_CONFIG is unset. */
  path: string | null;
  digest: string | null;
  config: OperatorConfig | null;
  roles: OperatorConfigRole[];
  applied: string[];
  agreed: string[];
}

let state: OperatorConfigState | null = null;

/**
 * Load, check and apply the operator config for this process; call before anything reads the variables it sets (the
 * API's and the worker's env loaders do). Idempotent: a later call for another role applies that role's variables too.
 * Throws OperatorConfigError (the process must not start) on any problem.
 */
export function initializeOperatorConfig(role: OperatorConfigRole, env: Record<string, string | undefined> = process.env, log: (line: string) => void = (line) => console.log(line)): OperatorConfigState {
  const rawPath = env[OPERATOR_CONFIG_ENV]?.trim() || null;
  const loaded = state && state.path === rawPath && state.config ? { path: state.path!, config: state.config, digest: state.digest! } : loadOperatorConfig(env);
  const repeat = !!state && state.path === rawPath && state.roles.includes(role);
  if (!loaded) {
    state = { path: null, digest: null, config: null, roles: [...new Set([...(state?.roles ?? []), role])], applied: [], agreed: [] };
    return state;
  }
  // Always applied into the env given (a caller may pass its own env object); repeats change nothing and log nothing.
  const result = applyOperatorConfigEnvironment(loaded.config, env, role);
  if (repeat) return state!;
  const previous = state?.path === loaded.path ? state : null;
  state = {
    path: loaded.path,
    digest: loaded.digest,
    config: loaded.config,
    roles: [...new Set([...(previous?.roles ?? []), role])],
    applied: [...new Set([...(previous?.applied ?? []), ...result.applied])],
    agreed: [...new Set([...(previous?.agreed ?? []), ...result.agreed])],
  };
  log(`[operator-config] loaded role=${role} path=${loaded.path} version=${loaded.config.version} digest=${loaded.digest} applied=${result.applied.join(",") || "none"}`);
  const alsoInEnvironment = result.agreed.filter((name) => !previous?.applied.includes(name));
  if (alsoInEnvironment.length) {
    log(`[operator-config] also set in the environment (same value; the environment names retire later): ${alsoInEnvironment.join(",")}`);
  }
  return state;
}

/** This process's operator config state, or null before initialization. */
export function operatorConfigState(): OperatorConfigState | null {
  return state;
}

/** The digest this process runs with: null when no operator config is configured or before initialization. */
export function currentOperatorConfigDigest(): string | null {
  return state?.digest ?? null;
}

/** Test hook. */
export function resetOperatorConfigState(): void {
  state = null;
}

/** One worker as /ops/worker-fleet reports it, for the skew check. */
export interface OperatorConfigWorkerDigest {
  identity: string;
  /** undefined: the worker does not report one (an older build). */
  digest: string | null | undefined;
}

export interface OperatorConfigSkew {
  /** The API's digest. */
  app: string | null;
  /** `ok`: every live worker runs the API's config; `skew`: at least one does not; `unknown`: no live worker to compare. */
  status: "ok" | "skew" | "unknown";
  workers: Array<{ identity: string; digest: string | null; matches: boolean }>;
}

/** Pure: compare the API's digest with each live worker's. A worker that reports nothing counts as skew. */
export function assessOperatorConfigSkew(app: string | null, workers: readonly OperatorConfigWorkerDigest[]): OperatorConfigSkew {
  const rows = workers.map((worker) => ({
    identity: worker.identity,
    digest: worker.digest === undefined ? null : worker.digest,
    matches: worker.digest !== undefined && worker.digest === app,
  }));
  if (rows.length === 0) return { app, status: "unknown", workers: [] };
  return { app, status: rows.every((row) => row.matches) ? "ok" : "skew", workers: rows };
}
