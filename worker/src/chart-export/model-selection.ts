/**
 * Generator model selection.
 *
 * - Default: the first admitted model of `CHART_GENERATOR_CANDIDATES`, in preference order. The order comes from the
 *   chart-export evaluation (2026-11-10): GPT-6 Luna at reasoning `none` scored best on held-out charts and diagrams,
 *   Gemini 3.1 Flash Lite at reasoning `minimal` next; GLM 5.3 Flash is last for its unstable latency. A pure
 *   cheapest-first sort would have picked GLM.
 * - Override: a configured model (managed setting: env `CHART_EXPORT_GENERATOR_MODEL`; projects never name one) is
 *   used only when it is one of the candidates, the routing-target catalog admits it (image input, a list price, not
 *   Pro/Ultra, runtime-accepted) and its output list price is at most `CHART_EXPORT_MAX_OUTPUT_USD_PER_MTOK`. The
 *   per-visual price assumes a cheap generator, so anything else is refused (logged) and the default is used.
 * - Chart calls never fail over to the project's vision fallback model (`chartExportVisionConfig`): that model is
 *   priced for page reads, not for the flat per-visual charge.
 */
import type { OpenRouterReasoning, RoutingTarget, VisionConfig } from "@docslurp/shared";

import { visionConfigForModel } from "../routing/routed-vision.js";
import type { VisualKind } from "./types.js";

/** Output list price ceiling for a chart generator (USD per million output tokens). */
export const CHART_EXPORT_MAX_OUTPUT_USD_PER_MTOK = 2;

/**
 * Admitted chart generators, in preference order. Every entry must have a list price in `scripts/lib/model-prices.json`
 * at or under the ceiling (chart-export.test.ts checks); the app's `pricing:validate` should check this same list.
 */
export const CHART_GENERATOR_CANDIDATES: readonly string[] = [
  "llm://openrouter/openai/gpt-6-luna",
  "llm://openrouter/google/gemini-3.1-flash-lite",
  "llm://openrouter/deepseek/deepseek-v4.1-flash-1017",
  "llm://openrouter/z-ai/glm-5.3-flash",
];
/** Diagrams scored best on the same order (2026-11-10 evaluation). */
export const DIAGRAM_GENERATOR_CANDIDATES: readonly string[] = CHART_GENERATOR_CANDIDATES;

export interface GeneratorSelection {
  modelUri: string;
  targetId: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  reason: "project-override" | "env-override" | "preferred-candidate";
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

function admittedGenerator(target: RoutingTarget | undefined): target is RoutingTarget {
  return !!target
    && target.kind === "hosted-vlm"
    && target.capabilities.imageInput
    && !!target.ref.modelUri
    && target.pricing.inputUsdPerMTok !== undefined
    && target.pricing.outputUsdPerMTok !== undefined
    && target.pricing.outputUsdPerMTok <= CHART_EXPORT_MAX_OUTPUT_USD_PER_MTOK;
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
  projectModel?: string | null;
  envModel?: string | null;
  candidates?: readonly string[];
}): GeneratorSelection | null {
  const pool = args.candidates ?? (args.kind === "diagram" ? DIAGRAM_GENERATOR_CANDIDATES : CHART_GENERATOR_CANDIDATES);
  const allowed = new Set(pool);
  const byUri = new Map(args.catalog.filter((t) => t.ref.modelUri).map((t) => [t.ref.modelUri!, t]));
  for (const [configured, reason] of [[args.projectModel, "project-override"], [args.envModel, "env-override"]] as const) {
    if (!configured?.trim()) continue;
    const uri = normalizeUri(configured);
    const target = allowed.has(uri) ? byUri.get(uri) : undefined;
    if (admittedGenerator(target)) return toSelection(target, reason);
    // Fail closed to the default: a model outside the allowlist, unadmitted or over the ceiling is never called.
    console.warn(`[chart-export] generator model refused (not an admitted chart generator at or under $${CHART_EXPORT_MAX_OUTPUT_USD_PER_MTOK}/M output); using the default model=${loggableModel(configured)} source=${reason}`);
  }
  for (const uri of pool) {
    const target = byUri.get(uri);
    if (admittedGenerator(target)) return toSelection(target, "preferred-candidate");
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
  "google/gemini-3.1-flash-lite": { effort: "minimal" },
};

/** The chart-export reasoning for `modelUri` (`llm://openrouter/<model>` or a bare model id), if pinned. */
export function chartExportReasoning(modelUri: string): OpenRouterReasoning | undefined {
  const model = modelUri.replace(/^llm:\/\/openrouter\//, "");
  const reasoning = CHART_EXPORT_REASONING[model];
  return reasoning ? { ...reasoning } : undefined;
}
