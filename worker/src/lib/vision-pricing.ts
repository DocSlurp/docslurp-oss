import {
  DEFAULT_OPENROUTER_VISION_MODEL,
  readVisionModelUriOverride,
  resolveVisionRoute,
  visionListPriceCents,
  visionModelCatalog,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import { visionMaxOutputTokens } from "../tools/vision-runtime.js";

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

/** Tokens a page image can take: about one per 700 pixels, at least a typical page's 2,200. */
const IMAGE_TOKENS_PER_PIXEL = 1 / 700;
const MIN_IMAGE_TOKENS = 2_200;
/** Rasters are bounded to 16 MP (lib/raster-bounds.ts): the bound when the size is unknown. */
const MAX_RASTER_PIXELS = 16_000_000;
const PROMPT_OVERHEAD_TOKENS = 200;

/** Upper bound on one vision request's input tokens: the prompt plus the image at its size. */
export function visionInputTokenBound(image: { widthPx: number | null; heightPx: number | null } | null, prompt = ""): number {
  const pixels = image?.widthPx && image.heightPx ? Math.min(image.widthPx * image.heightPx, MAX_RASTER_PIXELS) : MAX_RASTER_PIXELS;
  return Math.max(MIN_IMAGE_TOKENS, Math.ceil(pixels * IMAGE_TOKENS_PER_PIXEL)) +
    Math.ceil(prompt.length / 3) + PROMPT_OVERHEAD_TOKENS;
}

/** The worker's configured default hosted vision model: `DOCSLURP_VISION_MODEL_URI`, else the built-in default. */
export function configuredVisionModel(env: Record<string, string | undefined> = process.env): string {
  const override = readVisionModelUriOverride(env, () => undefined);
  if (override) return resolveVisionRoute({ target: "hosted", modelUri: override } as never).model;
  return DEFAULT_OPENROUTER_VISION_MODEL;
}

/**
 * List price, in cents, of the worst single vision request on `model`: the largest raster (16 MP) plus the
 * prompt allowance as input and the model's full output cap. Null when the catalog has no price for it.
 */
export function worstCaseVisionRequestCents(model: string): number | null {
  return visionListPriceCents(model, { inputTokens: visionInputTokenBound(null), outputTokens: visionMaxOutputTokens(model) });
}

/** The most expensive worst-case request across every priced catalog vision model. */
export function maxCatalogWorstCaseVisionRequestCents(): number {
  let max = 0;
  for (const spec of visionModelCatalog) max = Math.max(max, worstCaseVisionRequestCents(spec.id) ?? 0);
  return max;
}

/**
 * Weight of a local (in-process, `local-cli`) request against the org bound: no provider bills it, so it
 * only bounds our compute, at 2,000 requests per day under the default $40 bound.
 */
export const LOCAL_VISION_REQUEST_WEIGHT_CENTS = 2;

/**
 * What one request on this route can cost us at most, in cents, for the vision guard's org bound: the
 * route model's worst-case list price (16 MP image, full enforced output cap). A local runtime weighs
 * `LOCAL_VISION_REQUEST_WEIGHT_CENTS`. A model without a list price (an uncataloged or private
 * route) weighs the most expensive cataloged worst case, never less than the configured default.
 */
export function visionRequestWeightCents(model: string, runtime: string): number {
  const priced = worstCaseVisionRequestCents(model);
  if (priced !== null && priced > 0) return priced;
  if (runtime === "local-cli") return LOCAL_VISION_REQUEST_WEIGHT_CENTS;
  return Math.max(maxCatalogWorstCaseVisionRequestCents(), worstCaseVisionRequestCents(configuredVisionModel()) ?? 0);
}
