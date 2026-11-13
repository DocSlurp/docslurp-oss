/**
 * Generator model selection.
 *
 * - Default: the first admitted model of `CHART_GENERATOR_CANDIDATES`, in preference order. GPT-6 Luna at reasoning
 *   `none` scored best on held-out charts and diagrams in the 2026-11-10 evaluation; Claude Haiku 5.5 (reasoning off)
 *   matched it on a 2026-11-13 development screen; GLM 5.3 Flash is last for its unstable latency. Removed: Gemini 3.1
 *   Flash Lite (cost per read on real documents) and DeepSeek V4.1 Flash (never selected automatically,
 *   automatic-model-selection.ts).
 * - Override: a configured model (managed setting: env `CHART_EXPORT_GENERATOR_MODEL`; projects never name one) is
 *   used only when it is one of the candidates, the routing-target catalog admits it (image input, a list price, not
 *   Pro/Ultra, runtime-accepted) and its input and output list prices are at most `chartGeneratorPriceCeiling()`. The
 *   per-visual price assumes a cheap generator, so anything else is refused (logged) and the default is used. The
 *   default candidates pass the same ceiling: with none admitted, the stage exports deterministic visuals only.
 * - Chart calls never fail over to the project's vision fallback model (`chartExportVisionConfig`): that model is
 *   priced for page reads, not for the flat per-visual charge.
 */
import {
  assertNoAutomaticSelectionDenied,
  creditsToDollars,
  isAutomaticSelectionDenied,
  pricing,
  visualExportCredits,
  type ChartGeneratorPriceCeiling,
  type OpenRouterReasoning,
  type RoutingTarget,
  type VisionConfig,
} from "@docslurp/shared";

import { visionConfigForModel } from "../routing/routed-vision.js";
import { CHART_EXPORT_LIMITS } from "./config.js";
import type { VisualKind } from "./types.js";

/**
 * Input and output list price ceilings for a chart generator (USD per million tokens), or null for none. A generator is
 * admitted only when both hold.
 *
 * - The pricing provider states them (`internalCost.chartGeneratorMaxPricesUsdPerMTok`): the per-visual price is the
 *   provider's, so is the generator price it covers.
 * - A provider that returns null gets ceilings derived from its own per-visual charge: the input price at which one call
 *   at the image limit (`CHART_EXPORT_LIMITS.maxImageTokensPerCall`) costs the whole charge, and the output price at
 *   which one answer at the output cap (`maxOutputTokensPerCall`) does.
 * - Nothing charged per visual (the open default, billing off): no ceiling beyond the vision catalog's own limits.
 * - An invalid stated value throws (fail closed: the export pass fails and is logged; nothing is called).
 */
export function chartGeneratorPriceCeiling(): ChartGeneratorPriceCeiling | null {
  const stated = pricing().internalCost.chartGeneratorMaxPricesUsdPerMTok();
  if (stated !== null) {
    const valid = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
    if (!stated || typeof stated !== "object" || !valid(stated.inputUsdPerMTok) || !valid(stated.outputUsdPerMTok)) {
      throw new Error("pricing provider returned an invalid chart generator price ceiling");
    }
    return { inputUsdPerMTok: stated.inputUsdPerMTok, outputUsdPerMTok: stated.outputUsdPerMTok };
  }
  const chargeUsd = creditsToDollars(visualExportCredits({ visuals: 1, source: "vision", formats: ["description"] }));
  if (!(chargeUsd > 0)) return null;
  return {
    inputUsdPerMTok: (chargeUsd * 1_000_000) / CHART_EXPORT_LIMITS.maxImageTokensPerCall,
    outputUsdPerMTok: (chargeUsd * 1_000_000) / CHART_EXPORT_LIMITS.maxOutputTokensPerCall,
  };
}

/**
 * Admitted chart generators, in preference order. Every entry must have a list price in `scripts/lib/model-prices.json`
 * (chart-export.test.ts checks). A deployment's pricing checks should price this same list.
 */
export const CHART_GENERATOR_CANDIDATES: readonly string[] = [
  "llm://openrouter/openai/gpt-6-luna",
  // Added 2026-11-13 from a 60-chart development screen (reasoning off): spec and description scores at parity with
  // Luna, faster. Descriptive only: the held-out set was not yet run on it.
  "llm://openrouter/anthropic/claude-haiku-5.5",
  "llm://openrouter/z-ai/glm-5.3-flash",
];
assertNoAutomaticSelectionDenied("CHART_GENERATOR_CANDIDATES", CHART_GENERATOR_CANDIDATES);
/** Diagrams scored best on the same order (2026-11-10 evaluation). */
export const DIAGRAM_GENERATOR_CANDIDATES: readonly string[] = CHART_GENERATOR_CANDIDATES;

export interface GeneratorSelection {
  modelUri: string;
  targetId: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  reason: "env-override" | "preferred-candidate";
}

function normalizeUri(uri: string): string {
  const trimmed = uri.trim();
  return trimmed.startsWith("llm://") ? trimmed : `llm://openrouter/${trimmed}`;
}

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

/** A configured model string for a log line: control characters replaced, length bounded, quoted. */
export function loggableModel(value: string): string {
  return JSON.stringify(value.replace(CONTROL_CHARS, "?").slice(0, 120));
}

function admittedGenerator(target: RoutingTarget | undefined, ceiling: ChartGeneratorPriceCeiling | null): target is RoutingTarget {
  return !!target
    && target.kind === "hosted-vlm"
    && target.capabilities.imageInput
    && !!target.ref.modelUri
    && target.pricing.inputUsdPerMTok !== undefined
    && target.pricing.outputUsdPerMTok !== undefined
    && (ceiling === null || (target.pricing.inputUsdPerMTok <= ceiling.inputUsdPerMTok && target.pricing.outputUsdPerMTok <= ceiling.outputUsdPerMTok))
    && !isAutomaticSelectionDenied(target.ref.modelUri);
}

function toSelection(target: RoutingTarget, reason: GeneratorSelection["reason"]): GeneratorSelection {
  return {
    modelUri: target.ref.modelUri!,
    targetId: target.id,
    inputUsdPerMTok: target.pricing.inputUsdPerMTok ?? 0,
    outputUsdPerMTok: target.pricing.outputUsdPerMTok ?? 0,
    reason,
  };
}

/**
 * `catalog` is the privacy-filtered admitted catalog (`buildRuntimeCatalog().targets`). Returns null when no
 * candidate is admitted: the stage then exports deterministic visuals only.
 */
export function selectGeneratorModel(args: {
  kind: VisualKind | null;
  catalog: readonly RoutingTarget[];
  /** The managed override (env `CHART_EXPORT_GENERATOR_MODEL`). Projects and requests never name a model. */
  envModel?: string | null;
  candidates?: readonly string[];
}): GeneratorSelection | null {
  const pool = args.candidates ?? (args.kind === "diagram" ? DIAGRAM_GENERATOR_CANDIDATES : CHART_GENERATOR_CANDIDATES);
  const allowed = new Set(pool);
  const ceiling = chartGeneratorPriceCeiling();
  const byUri = new Map(args.catalog.filter((t) => t.ref.modelUri).map((t) => [t.ref.modelUri!, t]));
  for (const [configured, reason] of [[args.envModel, "env-override"]] as const) {
    if (!configured?.trim()) continue;
    const uri = normalizeUri(configured);
    const target = allowed.has(uri) ? byUri.get(uri) : undefined;
    if (admittedGenerator(target, ceiling)) return toSelection(target, reason);
    // Fail closed to the default: a model outside the allowlist, unadmitted or over the ceiling is never called.
    const limit = ceiling === null ? "" : ` at or under $${ceiling.inputUsdPerMTok.toFixed(3)}/M input and $${ceiling.outputUsdPerMTok.toFixed(3)}/M output`;
    console.warn(`[chart-export] generator model refused (not an admitted chart generator${limit}); using the default model=${loggableModel(configured)} source=${reason}`);
  }
  for (const uri of pool) {
    const target = byUri.get(uri);
    if (admittedGenerator(target, ceiling)) return toSelection(target, "preferred-candidate");
  }
  return null;
}

/**
 * Vision config for one chart-export call on `modelUri`: the project's vision settings with the model swapped in and
 * no remote fallback, so a rate-limited generator never fails over to a pricier page-reading model.
 * Call site: the chart model client in `stages/vision-extract.ts` (in place of `visionConfigForModel`).
 */
export function chartExportVisionConfig(selection: VisionConfig, modelUri: string): VisionConfig {
  return { ...visionConfigForModel(selection, modelUri), remoteFallbackModelUri: null };
}

/**
 * Reasoning per generator, as run in the 2026-11-10 chart & diagram export evaluation. Scoped to chart-export calls so
 * page transcription and chat keep their own settings for the same models.
 */
export const CHART_EXPORT_REASONING: Readonly<Record<string, OpenRouterReasoning>> = {
  "openai/gpt-6-luna": { effort: "none" },
  "anthropic/claude-haiku-5.5": { enabled: false },
  "google/gemini-3.1-flash-lite": { effort: "minimal" },
};

/** The chart-export reasoning for `modelUri` (`llm://openrouter/<model>` or a bare model id), if pinned. */
export function chartExportReasoning(modelUri: string): OpenRouterReasoning | undefined {
  const model = modelUri.replace(/^llm:\/\/openrouter\//, "");
  const reasoning = CHART_EXPORT_REASONING[model];
  return reasoning ? { ...reasoning } : undefined;
}
