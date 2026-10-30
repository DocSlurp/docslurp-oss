import {
  DEFAULT_OPENROUTER_VISION_MODEL,
  isLoopbackModelBaseUrl,
  isProhibitedPremiumModelId,
  PRIVATE_MODEL_PROVIDER,
  VISION_MAX_OUTPUT_USD_PER_MILLION,
  visionImageTokens,
  readVisionModelUriOverride,
  resolveVisionRoute,
  visionListPriceCents,
  visionModelCatalog,
  visionModelTokenPricing,
  type VisionTokenPricing,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import { visionMaxOutputTokens } from "../tools/vision-runtime.js";

/** Where `resolveChatCompletionsUrl` (tools/vision-runtime.ts) sends a route that has no base URL. */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Who bills a vision route, decided from the request's effective destination (an OpenAI-compatible route with
 * no base URL goes to api.openai.com):
 *
 * - `local`: in-process (`local-cli`); `loopback`: a server on a loopback host; `private`: an operator-registry
 *   route, priced by the registry. None of these is billed per token by a provider.
 * - `openai`: the configured OpenAI base URL; `openrouter`: an `openrouter.ai` URL. Both bill per token.
 * - `unknown-hosted`: any other remote destination. It is billed by someone we cannot price or cap, so it is
 *   refused before anything is sent, and recorded as billed if a request ever reached it.
 */
export type VisionRouteBilling = "local" | "loopback" | "private" | "openai" | "openrouter" | "unknown-hosted";

export function visionRouteBilling(
  route: { runtime: string; baseUrl: string | null; provider?: string },
  cfg: Pick<Config, "openAiBaseUrl">,
): VisionRouteBilling {
  if (route.runtime === "local-cli") return "local";
  if (route.provider === PRIVATE_MODEL_PROVIDER) return "private";
  const destination = effectiveVisionBaseUrl(route.baseUrl);
  if (isLoopbackModelBaseUrl(destination)) return "loopback";
  if (isOpenRouterBaseUrl(destination)) return "openrouter";
  if (sameBaseUrl(destination, cfg.openAiBaseUrl || DEFAULT_OPENAI_BASE_URL)) return "openai";
  return "unknown-hosted";
}

/** The base URL a hosted vision request is sent to. */
export function effectiveVisionBaseUrl(baseUrl: string | null): string {
  return baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL;
}

/** True only for an `openrouter.ai` URL (hostname equality, never a substring match). */
export function isOpenRouterBaseUrl(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "openrouter.ai";
  } catch {
    return false;
  }
}

/** True when two base URLs name the same endpoint (case-insensitive origin, trailing slashes ignored). */
export function sameBaseUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin.toLowerCase() === right.origin.toLowerCase() &&
      left.pathname.replace(/\/+$/, "") === right.pathname.replace(/\/+$/, "") && !left.search && !right.search;
  } catch {
    return false;
  }
}

/** Whether a provider bills this vision route per token: every route but local, loopback and private ones. */
export function isBillableVisionRuntime(
  route: { runtime: string; baseUrl: string | null; provider?: string },
  cfg: Pick<Config, "openAiBaseUrl">,
): boolean {
  return isBilledVisionRoute(visionRouteBilling(route, cfg));
}

export function isBilledVisionRoute(billing: VisionRouteBilling): boolean {
  return billing === "openai" || billing === "openrouter" || billing === "unknown-hosted";
}

/**
 * Image tokens on a model with no catalog bound (local, loopback and private routes, which no provider bills
 * per token): about one per 700 pixels, at least a typical page's 2,200. Billed routes use the model's catalog
 * bound (`visionImageTokens`) and are refused without one.
 */
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

type ImageSize = { widthPx: number | null; heightPx: number | null } | null;

/** Upper bound on one image's tokens on `model`: its catalog bound, else the generic per-pixel estimate. */
export function visionImageTokenBound(image: ImageSize, model?: string): number {
  const cataloged = model ? visionImageTokens(model, image) : null;
  if (cataloged !== null) return cataloged;
  const pixels = image?.widthPx && image.heightPx ? Math.min(image.widthPx * image.heightPx, MAX_RASTER_PIXELS) : MAX_RASTER_PIXELS;
  return Math.max(MIN_IMAGE_TOKENS, Math.ceil(pixels * IMAGE_TOKENS_PER_PIXEL));
}

/** Upper bound on one vision request's input tokens on `model`: the prompt plus the image at its size. */
export function visionInputTokenBound(image: ImageSize, prompt = "", model?: string): number {
  return visionImageTokenBound(image, model) + visionPromptTokenBound(prompt) + PROMPT_OVERHEAD_TOKENS;
}

/** The worker's configured default hosted vision model: `DOCSLURP_VISION_MODEL_URI`, else the built-in default. */
export function configuredVisionModel(env: Record<string, string | undefined> = process.env): string {
  const override = readVisionModelUriOverride(env, () => undefined);
  if (override) return resolveVisionRoute({ target: "hosted", modelUri: override } as never).model;
  return DEFAULT_OPENROUTER_VISION_MODEL;
}

/**
 * List price, in cents, of the worst single vision request on `model`: the largest raster (and its per-image
 * fee cap) plus the prompt allowance as input and the model's full output cap. Null when the catalog has no
 * price for it.
 */
export function worstCaseVisionRequestCents(model: string): number | null {
  // The image counted twice: as prompt tokens, and as OpenRouter's per-image fee cap (`VisionMaxPrice.imageUsd`).
  const imageFeeTokens = visionImageTokens(model, null) ?? 0;
  return visionListPriceCents(model, { inputTokens: visionInputTokenBound(null, "", model) + imageFeeTokens, outputTokens: visionMaxOutputTokens(model) });
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

/**
 * OpenRouter `provider.max_price` for one request: the token prices the weight uses plus caps on the separate
 * fees OpenRouter can bill outside them. `imageUsd` (USD per image) is the request image's catalog token bound
 * (the largest raster's when its size is unknown) times the model's input price; the weight adds it once, so an upstream that bills images as a
 * per-image fee instead of (or on top of) prompt tokens stays inside the weight. Not 0: that would exclude
 * providers that list a per-image price for images they meter as tokens. `requestUsd` is 0: no catalog model
 * charges per request.
 */
export type VisionMaxPrice = VisionTokenPrice & { imageUsd: number; requestUsd: number };

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

/** A billed route we cannot price or cap: refused before admission, so nothing is sent or counted. */
export class UnpricedVisionRouteError extends Error {
  constructor(readonly model: string, reason = "has no list price or image-token bound in the vision catalog") {
    super(`vision model ${model} ${reason} on a billed route; refusing to send`);
    this.name = "UnpricedVisionRouteError";
  }
}

export interface VisionRequestPricing {
  /** What this request can cost us at most, in cents, against the vision guard's org bound. */
  weightCents: number;
  /** Sent on OpenRouter as `provider.max_price`, so no upstream can bill above the weight; null elsewhere. */
  maxPrice: VisionMaxPrice | null;
}

/**
 * Price one vision request for the guard's org bound, from its input bound (prompt bytes plus the image at
 * its size on this model, `visionInputTokenBound`) and the model's enforced output cap. Hosted vision is
 * limited to the priced catalog:
 *
 * - a billed route (OpenAI, OpenRouter) needs a catalog model with a token price and an image-token bound,
 *   under the output-price limit and not a Pro/Ultra tier; anything else is refused (fail closed, nothing
 *   sent), on OpenRouter as on OpenAI. An unknown hosted destination is always refused;
 * - on OpenRouter the weight adds the per-image fee cap, and `maxPrice` carries the caps;
 * - a local runtime weighs `LOCAL_VISION_REQUEST_WEIGHT_CENTS`;
 * - a loopback or private route (not billed per token by a provider) weighs its catalog price when it has
 *   one, else the catalog-dominating prices, never less than the configured default model.
 */
export function visionRequestPricing(route: {
  model: string;
  runtime: string;
  /** `visionRouteBilling` of the route's effective destination. */
  billing: VisionRouteBilling;
  /** `visionInputTokenBound(image, prompt, model)`. */
  inputTokens: number;
  /** `visionImageTokenBound(image, model)` of the request's image; unset: the largest raster's. */
  imageTokens?: number;
}): VisionRequestPricing {
  const outputTokens = visionMaxOutputTokens(route.model);
  const priced = visionModelTokenPricing(route.model);
  if (isBilledVisionRoute(route.billing)) {
    if (route.billing === "unknown-hosted") throw new UnpricedVisionRouteError(route.model, "goes to a destination that is not OpenAI or OpenRouter");
    if (isProhibitedPremiumModelId(route.model)) throw new UnpricedVisionRouteError(route.model, "is a Pro/Ultra tier");
    const maxImageTokens = visionImageTokens(route.model, null);
    if (!priced || !(priced.inputUsdPerMillion > 0 || priced.outputUsdPerMillion > 0) || maxImageTokens === null) {
      throw new UnpricedVisionRouteError(route.model);
    }
    if (priced.outputUsdPerMillion >= VISION_MAX_OUTPUT_USD_PER_MILLION) {
      throw new UnpricedVisionRouteError(route.model, `costs $${priced.outputUsdPerMillion}/M output tokens, at or above the $${VISION_MAX_OUTPUT_USD_PER_MILLION}/M limit`);
    }
    const tokenCents = centsAt(priced, route.inputTokens, outputTokens);
    if (route.billing !== "openrouter") return { weightCents: tokenCents, maxPrice: null };
    const imageUsd = ((route.imageTokens ?? maxImageTokens) * priced.inputUsdPerMillion) / 1e6;
    return {
      weightCents: tokenCents + imageUsd * 100,
      maxPrice: { inputUsdPerMillion: priced.inputUsdPerMillion, outputUsdPerMillion: priced.outputUsdPerMillion, imageUsd, requestUsd: 0 },
    };
  }
  if (priced && (priced.inputUsdPerMillion > 0 || priced.outputUsdPerMillion > 0)) {
    return { weightCents: centsAt(priced, route.inputTokens, outputTokens), maxPrice: null };
  }
  if (route.runtime === "local-cli") return { weightCents: LOCAL_VISION_REQUEST_WEIGHT_CENTS, maxPrice: null };
  const ceiling = maxCatalogVisionTokenPricing();
  const weightCents = Math.max(centsAt(ceiling, route.inputTokens, outputTokens), worstCaseVisionRequestCents(configuredVisionModel()) ?? 0);
  return { weightCents, maxPrice: null };
}

function centsAt(pricing: VisionTokenPrice, inputTokens: number, outputTokens: number): number {
  return (inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) / 1e4;
}

/**
 * Worst-case weight of a request on `model` at the largest raster and no prompt (catalog-wide checks), on an
 * unbilled route: a local runtime weighs `LOCAL_VISION_REQUEST_WEIGHT_CENTS`; a catalog model its list price;
 * any other model the catalog-dominating prices.
 */
export function visionRequestWeightCents(model: string, runtime: string): number {
  return visionRequestPricing({ model, runtime, billing: runtime === "local-cli" ? "local" : "private", inputTokens: visionInputTokenBound(null, "", model) }).weightCents;
}
