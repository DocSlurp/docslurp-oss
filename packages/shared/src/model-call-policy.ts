/**
 * Call-time model policy for automatic selection: every model a pipeline stage invokes (text generation, structured
 * extraction, vision) is checked where it is called, whatever wrote the config. A model is refused when it is
 * automatic-selection-denied (automatic-model-selection.ts), Pro/Ultra (on the normalized id), or priced at or above
 * the output cap ($50 per 1M tokens) by a known price. Operator private routes (`llm://private/...`) skip the price
 * check (their cost is the operator's) but not the denylist.
 */
import { isAutomaticSelectionDenied } from "./automatic-model-selection.js";
import { normalizeHostedModelRef } from "./model-uri.js";
import { resolvePipelineTextModel, type PipelineFeatures, type PipelineTextOperation } from "./pipeline.js";
import { isProhibitedRoutingModelId, MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE } from "./routing-targets.js";
import { resolveAiUsagePricingWithSource } from "./usage.js";

/** A model a stage may not call; the stage fails loudly instead of calling it. */
export class ModelCallRefusedError extends Error {
  readonly code = "model_call_refused" as const;
  constructor(readonly label: string, readonly reason: string) {
    super(`${label}: the configured model is not allowed (${reason})`);
    this.name = "ModelCallRefusedError";
  }
}

/** The bare hosted id for price and policy lookups: no `llm://openrouter/`, no query, no `:variant`. */
export function policyModelId(ref: string): string {
  const hosted = normalizeHostedModelRef(ref.trim());
  return (hosted.split(/[?#]/, 1)[0] ?? "").split(":", 1)[0]!.trim().toLowerCase();
}

/** Why a stage may not call `ref`, or null. */
export function automaticModelCallProblem(ref: string | null | undefined): string | null {
  if (!ref?.trim()) return null;
  if (isAutomaticSelectionDenied(ref)) return "never selected automatically";
  if (isProhibitedRoutingModelId(ref)) return "prohibited model";
  const trimmed = ref.trim();
  if (/^llm:\/\//i.test(trimmed) && !/^llm:\/\/openrouter\//i.test(trimmed)) return null;
  const id = policyModelId(trimmed);
  const { pricing, pricingSource } = resolveAiUsagePricingWithSource({ provider: "openrouter", model: id });
  // Cents per 1K tokens x 10 = USD per 1M tokens. An unknown price is not proof of a cheap model, but refusing every
  // unpriced default at call time would stop ingestion: admin writes require a verified price instead.
  if (pricingSource !== "configured-fallback" && pricing.costPer1kOutputTokens * 10 >= MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE) {
    return "output price at or above the cap";
  }
  return null;
}

export function assertAutomaticModelCallAllowed(ref: string | null | undefined, label: string): void {
  const problem = automaticModelCallProblem(ref);
  if (problem) {
    console.error(`[model-policy] refused ${label} model=${String(ref).slice(0, 160)} reason=${problem}`);
    throw new ModelCallRefusedError(label, problem);
  }
}

/** resolvePipelineTextModel, then the call-time policy. Every text stage resolves its model through this. */
export function resolveAllowedPipelineTextModel(
  pipeline: { textGeneration?: PipelineFeatures["textGeneration"] },
  operation: PipelineTextOperation,
  deploymentModel?: string,
): string {
  const model = resolvePipelineTextModel(pipeline, operation, deploymentModel);
  assertAutomaticModelCallAllowed(model, `text model (${operation})`);
  return model;
}

/** The structured-extraction model (its own override, else the text chain), then the call-time policy. */
export function resolveAllowedStructuredExtractionModel(
  pipeline: Pick<PipelineFeatures, "structuredExtraction"> & { textGeneration?: PipelineFeatures["textGeneration"] },
  deploymentModel?: string,
): string {
  const model = pipeline.structuredExtraction.model ?? resolvePipelineTextModel(pipeline, "structured-extraction", deploymentModel);
  assertAutomaticModelCallAllowed(model, "structured-extraction model");
  return model;
}
