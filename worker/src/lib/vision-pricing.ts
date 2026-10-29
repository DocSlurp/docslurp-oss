import {
  DEFAULT_OPENROUTER_VISION_MODEL,
  readVisionModelUriOverride,
  resolveVisionRoute,
  visionListPriceCents,
  visionModelCatalog,
  visionModelTokenPricing,
  type VisionTokenPricing,
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
/** Chat template plus the fixed system message (under 200 UTF-8 bytes). */
const PROMPT_OVERHEAD_TOKENS = 200;
/**
 * Largest prompt a vision request may carry, in UTF-8 bytes. Built-in templates are under 1 KB and
 * schema labels are capped at `SCHEMA_LABEL_TOTAL_BYTES` (tools/vision-runtime.ts), so a longer
 * prompt is refused before admission rather than priced.
 */
export const VISION_MAX_PROMPT_BYTES = 16_384;

/**
 * Upper bound on a prompt's tokens: its UTF-8 bytes. Every BPE token covers at least one byte, so no
 * tokenizer can split a prompt into more tokens than it has bytes (CJK text is 3 bytes per character
 * and often one token per character; characters/3 would undercount it).
 */
export function visionPromptTokenBound(prompt: string): number {
  return Buffer.byteLength(prompt, "utf8");
}

/** Upper bound on one vision request's input tokens: the prompt plus the image at its size. */
export function visionInputTokenBound(image: { widthPx: number | null; heightPx: number | null } | null, prompt = ""): number {
  const pixels = image?.widthPx && image.heightPx ? Math.min(image.widthPx * image.heightPx, MAX_RASTER_PIXELS) : MAX_RASTER_PIXELS;
  return Math.max(MIN_IMAGE_TOKENS, Math.ceil(pixels * IMAGE_TOKENS_PER_PIXEL)) +
    visionPromptTokenBound(prompt) + PROMPT_OVERHEAD_TOKENS;
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

/** USD per million input (prompt and image) and output tokens. */
export type VisionTokenPrice = Pick<VisionTokenPricing, "inputUsdPerMillion" | "outputUsdPerMillion">;

/** Per-million prices that dominate every priced catalog vision model (input and output separately). */
export function maxCatalogVisionTokenPricing(): VisionTokenPrice {
  let inputUsdPerMillion = 0;
  let outputUsdPerMillion = 0;
  for (const spec of visionModelCatalog) {
    const pricing = visionModelTokenPricing(spec.id);
    if (!pricing) continue;
    inputUsdPerMillion = Math.max(inputUsdPerMillion, pricing.inputUsdPerMillion);
    outputUsdPerMillion = Math.max(outputUsdPerMillion, pricing.outputUsdPerMillion);
  }
  return { inputUsdPerMillion, outputUsdPerMillion };
}

/** A paid route whose model has no list price and no way to cap what the provider bills. */
export class UnpricedVisionRouteError extends Error {
  constructor(readonly model: string) {
    super(`vision model ${model} has no list price on a billed route; refusing to send (add it to the vision catalog)`);
    this.name = "UnpricedVisionRouteError";
  }
}

export interface VisionRequestPricing {
  /** What this request can cost us at most, in cents, against the vision guard's org bound. */
  weightCents: number;
  /**
   * The per-million prices the weight assumes. On OpenRouter they are sent as `provider.max_price`, so
   * no upstream provider or fallback can bill above the weight; null on local and self-hosted routes.
   */
  maxPrice: VisionTokenPrice | null;
}

/**
 * Price one vision request for the guard's org bound, from its actual input bound (prompt bytes plus
 * image size, `visionInputTokenBound`) and the model's enforced output cap:
 *
 * - a catalog model is priced at its list price;
 * - a local runtime weighs `LOCAL_VISION_REQUEST_WEIGHT_CENTS`;
 * - an uncataloged model on OpenRouter is priced at prices above every catalog model, and those
 *   prices are sent as `max_price` so OpenRouter refuses any provider charging more;
 * - an uncataloged model on another billed route (OpenAI) cannot be capped: refused (fail closed);
 * - an uncataloged self-hosted or private route (not billed per token by a provider) weighs the
 *   catalog-dominating prices, never less than the configured default model.
 */
export function visionRequestPricing(route: {
  model: string;
  runtime: string;
  /** `isBillableVisionRuntime`: a provider bills this route per token. */
  billable: boolean;
  openRouter: boolean;
  inputTokens: number;
}): VisionRequestPricing {
  const outputTokens = visionMaxOutputTokens(route.model);
  const priced = visionModelTokenPricing(route.model);
  if (priced && (priced.inputUsdPerMillion > 0 || priced.outputUsdPerMillion > 0)) {
    return { weightCents: centsAt(priced, route.inputTokens, outputTokens), maxPrice: route.openRouter ? priced : null };
  }
  if (route.runtime === "local-cli") return { weightCents: LOCAL_VISION_REQUEST_WEIGHT_CENTS, maxPrice: null };
  if (route.billable && !route.openRouter) throw new UnpricedVisionRouteError(route.model);
  const ceiling = maxCatalogVisionTokenPricing();
  const weightCents = Math.max(centsAt(ceiling, route.inputTokens, outputTokens), worstCaseVisionRequestCents(configuredVisionModel()) ?? 0);
  return { weightCents, maxPrice: route.openRouter ? ceiling : null };
}

function centsAt(pricing: VisionTokenPrice, inputTokens: number, outputTokens: number): number {
  return (inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) / 1e4;
}

/**
 * Worst-case weight of a request on `model` at the largest raster and no prompt (catalog-wide checks).
 * A local runtime weighs `LOCAL_VISION_REQUEST_WEIGHT_CENTS`; any other uncataloged model weighs the
 * catalog-dominating prices, which OpenRouter enforces with `max_price`.
 */
export function visionRequestWeightCents(model: string, runtime: string): number {
  return visionRequestPricing({ model, runtime, billable: false, openRouter: false, inputTokens: visionInputTokenBound(null) }).weightCents;
}
