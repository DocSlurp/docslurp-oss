import { resolveVisionRoute, visionListPriceCents, type VisionConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import { buildSchemaAwareVisionPrompt, visionMaxOutputTokens } from "../tools/vision-runtime.js";
import { sanitizeCents, visionInputTokenBound } from "./vision-spend-guard.js";

type PricingConfig = Pick<Config, "openAiBaseUrl" | "costPer1kInputTokens" | "costPer1kOutputTokens">;

/** Whether a vision route bills us per token (OpenAI, OpenRouter); local and self-hosted runtimes do not. */
export function isBillableVisionRuntime(route: { runtime: string; baseUrl: string | null }, cfg: Pick<Config, "openAiBaseUrl">): boolean {
  const normalizedBaseUrl = route.baseUrl?.replace(/\/+$/, "") ?? null;
  const normalizedOpenAiBaseUrl = cfg.openAiBaseUrl?.replace(/\/+$/, "") ?? null;
  return (
    route.runtime === "remote-openai" ||
    (route.runtime === "openai-compatible" &&
      (normalizedBaseUrl === normalizedOpenAiBaseUrl || Boolean(normalizedBaseUrl?.includes("openrouter.ai"))))
  );
}

/**
 * Guard reservation for one vision call (lib/vision-spend-guard.ts) at that call's own model
 * price: two attempts (the stream guard retries a rejected output once on another route) of the
 * bounded input (prompt plus the image at its size, `visionInputTokenBound`) and the model's full
 * output cap. Models without a catalog list price use the configured per-1k rates; runtimes that
 * do not bill us reserve nothing.
 */
export function visionReserveCents(
  vision: VisionConfig,
  cfg: PricingConfig,
  image: { widthPx: number | null; heightPx: number | null } | null,
  options: { prompt?: string; outputSchema?: Record<string, unknown> | null } = {},
): number {
  const route = resolveVisionRoute(vision);
  if (!isBillableVisionRuntime(route, cfg)) return 0;
  const prompt = options.prompt ?? buildSchemaAwareVisionPrompt(route.prompt, options.outputSchema);
  const usage = { inputTokens: visionInputTokenBound(image, prompt), outputTokens: visionMaxOutputTokens(route.model) };
  const cents = visionListPriceCents(route.model, usage) ??
    (usage.inputTokens / 1000) * cfg.costPer1kInputTokens + (usage.outputTokens / 1000) * cfg.costPer1kOutputTokens;
  return 2 * sanitizeCents(cents);
}
