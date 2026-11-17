/**
 * Hosted readers for the OCR escalation read (worker ocr/hosted-reader.ts): the second read of a page the OCR recogniser
 * read poorly. Tried in order; each is an automatic call checked on its own by the automatic-call gate
 * (automatic-call-margin.ts) at the price its request can reach, and the next is tried when one is refused or no host
 * can serve it. Both are measured on the page-OCR tier benchmark (OCR_ROUTE_OPTIONS, tier-options.ts).
 *
 * - GLM 5.3 Flash on OpenRouter, with a per-request price ceiling: the request sends `max_price` at the ceiling and is
 *   restricted to `hosts`, so only hosts listed at or under it serve the read, and the gate prices the call at the
 *   ceiling. Host: Wafer's US endpoint only. It is the one GLM host whose hosting region is stated (the endpoint tag);
 *   the provider states no location for its other endpoints, so an escalation, which sends a customer page, never goes
 *   there. Measured on the tier benchmark's page-OCR development split on 2026-11-16 (composite 0.932, against 0.934
 *   for the pooled production route). OpenRouter endpoint listing, 2026-11-16: $0.042 / $0.184 per 1M prompt /
 *   completion tokens, no per-image fee; the ceiling leaves room for a price move before the next reader takes over. When no host is under the
 *   ceiling, OpenRouter refuses the request (nothing billed) and the next reader is tried.
 * - GLM 5.3 Flash on Morph's US endpoint (morph/fp8), under its own ceiling: a second, independent GLM host, so the read
 *   survives Wafer refusing or being unavailable. Morph's hosting region is OpenRouter's provider datacenters metadata
 *   (US). Measured on the page-OCR development split on 2026-11-17 (dev-page-ocr-20261117-pool-candidates, escalation
 *   prompt): composite 0.927 (tolerant text 0.907, tables 0.931, math 1.000), within 0.01 of the best measured second
 *   reader; slow (p50 54 s a page), which is why it follows Wafer. OpenRouter endpoint listing, 2026-11-17: $0.06 / $0.173
 *   per 1M prompt / completion tokens, no per-image fee.
 * - Qwen3-VL 30B A3B on DeepInfra's own API, at its list price.
 *
 * Each route is one member of the `ocr` capability pool's second-read stage (capability-pools.ts), in this order.
 */
import { visionAutomaticRoute, type AutomaticCallRoute } from "./automatic-call-margin.js";

export const OCR_ESCALATION_GLM_MODEL = "llm://openrouter/z-ai/glm-5.3-flash";
export const OCR_ESCALATION_QWEN_MODEL = "llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct";

/** A per-request price ceiling: USD per million prompt and completion tokens, USD per image, and the hosts allowed. */
export interface OcrEscalationPriceCeiling {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly imageUsd: number;
  readonly hosts: readonly string[];
}

export interface OcrEscalationRoute {
  /** The OCR route option it is measured as (OCR_ROUTE_OPTIONS). */
  readonly optionId: string;
  readonly model: string;
  readonly priceCeiling: OcrEscalationPriceCeiling | null;
  /** Whole-read timeout (ms) for this route; past it the read counts as unavailable and the next reader is tried. */
  readonly timeoutMs?: number;
}

export const OCR_ESCALATION_ROUTES: readonly OcrEscalationRoute[] = Object.freeze([
  {
    optionId: "scan-ocr/hosted-escalation-glm",
    model: OCR_ESCALATION_GLM_MODEL,
    priceCeiling: Object.freeze({ inputUsdPerMTok: 0.065, outputUsdPerMTok: 0.24, imageUsd: 0, hosts: Object.freeze(["wafer/us"]) }),
  },
  {
    optionId: "scan-ocr/hosted-escalation-glm-morph",
    model: OCR_ESCALATION_GLM_MODEL,
    priceCeiling: Object.freeze({ inputUsdPerMTok: 0.065, outputUsdPerMTok: 0.19, imageUsd: 0, hosts: Object.freeze(["morph/fp8"]) }),
    // Slow host (p50 54 s, p90 146 s on the benchmark): bounded so a stalled read moves on to Qwen.
    timeoutMs: 180_000,
  },
  { optionId: "scan-ocr/hosted-escalation", model: OCR_ESCALATION_QWEN_MODEL, priceCeiling: null },
]);

/** The escalation reader tried first, unless DOCSLURP_OCR_ESCALATION_MODEL names another. */
export const DEFAULT_OCR_ESCALATION_MODEL = OCR_ESCALATION_ROUTES[0]!.model;

/**
 * The automatic-call route of an escalation read: the vision call as the runtime sends it, lowered to the route's price
 * ceiling when it has one (the request's `max_price`, its host allowlist and no per-image fee).
 */
export function ocrEscalationAutomaticRoute(route: OcrEscalationRoute): AutomaticCallRoute {
  return cappedVisionAutomaticRoute(route.model, route.priceCeiling);
}

/** A vision call's automatic route lowered to a per-request price ceiling (`max_price`, host allowlist, no image fee). */
export function cappedVisionAutomaticRoute(model: string, ceiling: OcrEscalationPriceCeiling | null): AutomaticCallRoute {
  const base = visionAutomaticRoute(model);
  if (!ceiling) return base;
  const cap = { inputUsdPerMTok: ceiling.inputUsdPerMTok, outputUsdPerMTok: ceiling.outputUsdPerMTok };
  const lower = (sent: { inputUsdPerMTok: number; outputUsdPerMTok: number } | null | undefined) => sent
    ? { inputUsdPerMTok: Math.min(sent.inputUsdPerMTok, cap.inputUsdPerMTok), outputUsdPerMTok: Math.min(sent.outputUsdPerMTok, cap.outputUsdPerMTok) }
    : cap;
  return {
    ...base,
    hosts: [...ceiling.hosts],
    capUsdPerMTok: lower(base.capUsdPerMTok),
    maxPriceSent: lower(base.maxPriceSent),
    capImageUsd: Math.min(base.capImageUsd ?? ceiling.imageUsd, ceiling.imageUsd),
  };
}

/**
 * The escalation readers to try, in order: the configured model alone (its own measured route when it is one of these,
 * else uncapped), or every route above.
 */
export function ocrEscalationRoutes(configured: string | null | undefined): readonly OcrEscalationRoute[] {
  const raw = configured?.trim();
  if (!raw) return OCR_ESCALATION_ROUTES;
  // A bare OpenRouter id (`z-ai/glm-5.3-flash`) is the same model as its `llm://openrouter/` URI.
  const model = /^llm:\/\//i.test(raw) ? raw : `llm://openrouter/${raw}`;
  // A model with several measured routes (GLM on two hosts) keeps all of them, in order.
  const known = OCR_ESCALATION_ROUTES.filter((route) => route.model === model);
  return known.length ? known : [{ optionId: "scan-ocr/hosted-escalation-configured", model, priceCeiling: null }];
}
