/**
 * Hosted readers for the OCR escalation read (worker ocr/hosted-reader.ts): the second read of a page the OCR recogniser
 * read poorly. Tried in order; each is an automatic call checked on its own by the automatic-call gate
 * (automatic-call-margin.ts) at the price its request can reach, and the next is tried when one is refused or no host
 * can serve it. Both are measured on the page-OCR tier benchmark (OCR_ROUTE_OPTIONS, tier-options.ts).
 *
 * - GLM 5.3 Flash on OpenRouter, with a per-request price ceiling: the request sends `max_price` at the ceiling and is
 *   restricted to `hosts`, so only hosts listed at or under it serve the read, and the gate prices the call at the
 *   ceiling. Hosts: Wafer's nvfp4 endpoint (the measured production pool's first host) and Wafer's US endpoint (same
 *   provider and quantization). OpenRouter endpoint listings, 2026-11-16: wafer/nvfp4 $0.065 / $0.24, wafer/us
 *   $0.042 / $0.184 per 1M prompt / completion tokens, no per-image fee; the pool's other hosts (friendli $0.15 / $0.50,
 *   inference-net/fp4 $0.108 / $0.35) are above the ceiling and never serve an escalation. When no host is under the
 *   ceiling, OpenRouter refuses the request (nothing billed) and the next reader is tried.
 * - Qwen3-VL 30B A3B on DeepInfra's own API, at its list price.
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
}

export const OCR_ESCALATION_ROUTES: readonly OcrEscalationRoute[] = Object.freeze([
  {
    optionId: "scan-ocr/hosted-escalation-glm",
    model: OCR_ESCALATION_GLM_MODEL,
    priceCeiling: Object.freeze({ inputUsdPerMTok: 0.065, outputUsdPerMTok: 0.24, imageUsd: 0, hosts: Object.freeze(["wafer/nvfp4", "wafer/us"]) }),
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
  const base = visionAutomaticRoute(route.model);
  const ceiling = route.priceCeiling;
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
  const model = configured?.trim();
  if (!model) return OCR_ESCALATION_ROUTES;
  const known = OCR_ESCALATION_ROUTES.find((route) => route.model === model);
  return [known ?? { optionId: "scan-ocr/hosted-escalation-configured", model, priceCeiling: null }];
}
