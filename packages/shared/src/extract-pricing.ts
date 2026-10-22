import { CENTS_PER_CREDIT, CREDIT_RATE_CARD, SELF_HOSTED_PAGE_TOKENS, type CreditRateCard } from "./billing.js";
import type { LicenseClass } from "./model-license.js";
import type { AiUsagePricing } from "./usage.js";

// ---------------------------------------------------------------------------
// Flat per-page tiers (DocSlurp Extract) and private dedicated capacity
//
// Source: internal research notes, section 5
// and decisions 7-8; policy in docs/pricing-and-credits.md.
// ---------------------------------------------------------------------------

export type ExtractTierId = "text" | "ocr" | "structured";

export type ExtractTier = {
  id: ExtractTierId;
  label: string;
  /** Flat price per 1,000 pages, compute included. Holds the margin floor at the route cost cap. */
  usdPer1kPages: number;
  /**
   * Our own cost ceiling, in dollars per 1,000 pages, for a route that may serve
   * a page sold at this tier.
   */
  maxRouteCostUsdPer1kPages: number;
};

export const EXTRACT_TIERS: Record<ExtractTierId, ExtractTier> = {
  text: { id: "text", label: "Extract Text", usdPer1kPages: 0.5, maxRouteCostUsdPer1kPages: 0.25 },
  // Free matches the plain-OCR median of $1.50 per 1,000 pages (the three big
  // clouds and Upstage); markdown-grade parsers have a median near $3.75
  // (internal research notes, checked 2026-10-13). One price for every
  // account since plans were removed (2026-10-21).
  ocr: {
    id: "ocr",
    label: "Extract OCR",
    usdPer1kPages: 1.5,
    maxRouteCostUsdPer1kPages: 0.5,
  },
  structured: { id: "structured", label: "Extract Structured", usdPer1kPages: 5, maxRouteCostUsdPer1kPages: 2.5 },
};

/** Card and payment fees taken from every flat-tier charge. */
export const FLAT_TIER_PAYMENT_FEE = 0.03;

/** Lowest gross margin a flat tier may earn after fees when its route costs the full cap. */
export const FLAT_TIER_MIN_MARGIN_AT_CAP = 0.4;

/** Gross margin after payment fees when a route costs `routeCostUsdPer1kPages`. */
export function flatTierMargin(tier: ExtractTierId, routeCostUsdPer1kPages: number = EXTRACT_TIERS[tier].maxRouteCostUsdPer1kPages): number {
  const price = EXTRACT_TIERS[tier].usdPer1kPages;
  return (price * (1 - FLAT_TIER_PAYMENT_FEE) - routeCostUsdPer1kPages) / price;
}

/**
 * A flat tier is a fixed price, so a route that costs more than the cap loses
 * money on every page (Sonnet 5.5 -645%, Gemini 3.5 Flash -1,401% and Flash-Lite
 * -2% on the old $2 OCR price). Extract OCR routes must cost us at most $0.50
 * per 1,000 pages (decided 2026-10-13, down from $1.00), and
 * must also clear the quality floor below.
 */
export function flatTierRouteCostCapUsdPer1kPages(tier: ExtractTierId): number {
  return EXTRACT_TIERS[tier].maxRouteCostUsdPer1kPages;
}

/** Quality floor for an Extract OCR route: tolerant content score on the held-out OCR suites. */
export const FLAT_OCR_MIN_TOLERANT_CONTENT = 0.85;

/**
 * Measured Extract OCR routes (tolerant content / tables / math scores and cost
 * per 1,000 pages, from the 2026-10 OCR evals). Cost is observed, not derived
 * from list token prices: reasoning-light hosted runs use far fewer tokens than
 * the planning page size.
 */
export type MeasuredOcrRoute = {
  id: string;
  kind: "self-hosted" | "hosted";
  content: number;
  tables: number | null;
  math: number | null;
  costUsdPer1kPagesLow: number;
  costUsdPer1kPagesHigh: number;
  /** Licence class of the model (model-license.ts); DISABLE_NON_FREE_SOFTWARE drops "non-free" routes. */
  licenseClass: LicenseClass;
  /** Needs legal review or capacity before it can be a default. */
  note?: string;
};

export const MEASURED_OCR_ROUTES: readonly MeasuredOcrRoute[] = [
  { id: "lightonocr-3-0.8b", licenseClass: "free", kind: "self-hosted", content: 0.886, tables: 0.83, math: 0.714, costUsdPer1kPagesLow: 0.13, costUsdPer1kPagesHigh: 0.17 },
  { id: "dots.ocr", licenseClass: "non-free", kind: "self-hosted", content: 0.878, tables: null, math: 0.804, costUsdPer1kPagesLow: 0.34, costUsdPer1kPagesHigh: 0.34, note: "license addendum needs legal review" },
  { id: "olmocr-2", licenseClass: "free", kind: "self-hosted", content: 0.874, tables: 0.703, math: 0.784, costUsdPer1kPagesLow: 0.25, costUsdPer1kPagesHigh: 0.29 },
  { id: "inclusionai/ling-3.0-flash-vl (effort none)", licenseClass: "free", kind: "hosted", content: 0.911, tables: null, math: 0.826, costUsdPer1kPagesLow: 0.138, costUsdPer1kPagesHigh: 0.138, note: "OpenRouter; pass rate 0.821" },
  { id: "deepseek/deepseek-v4.1-flash (effort none)", licenseClass: "free", kind: "hosted", content: 0.885, tables: null, math: null, costUsdPer1kPagesLow: 0.21, costUsdPer1kPagesHigh: 0.21 },
  { id: "z-ai/glm-5.3-flash (minimal)", licenseClass: "free", kind: "hosted", content: 0.89, tables: null, math: null, costUsdPer1kPagesLow: 0.84, costUsdPer1kPagesHigh: 0.84 },
];

/** A measured OCR route may serve Extract OCR pages when its worst observed cost is under the cap and its content score clears the floor. */
export function isMeasuredOcrRouteEligible(route: MeasuredOcrRoute, options: FlatTierRouteOptions = {}): boolean {
  if (options.disableNonFree && route.licenseClass === "non-free") return false;
  return route.costUsdPer1kPagesHigh <= flatTierRouteCostCapUsdPer1kPages("ocr") + 1e-9 && route.content >= FLAT_OCR_MIN_TOLERANT_CONTENT;
}

/**
 * DeepInfra's DeepSeek-OCR, olmOCR-2 and PaddleOCR-VL ids are deprecated: they
 * are silently served by Gemma-4-31B, so their scores and costs are not those
 * of the named OCR model. They must never be routed for Extract OCR.
 */
export const DEPRECATED_HOSTED_OCR_IDS: readonly string[] = [
  "deepinfra/deepseek-ai/DeepSeek-OCR",
  "deepinfra/allenai/olmOCR-2-7B-1025",
  "deepinfra/PaddlePaddle/PaddleOCR-VL",
];

/**
 * Default Extract OCR route order: our own LightOnOCR when capacity exists
 * (it emits figure tags for image insets, so it needs inset handling),
 * math-heavy pages to dots.ocr / olmOCR, and the hosted Ling-3.0-flash-VL
 * (OpenRouter, reasoning effort none) when no GPU capacity is free, ahead of
 * DeepSeek V4.1 Flash.
 */
export const FLAT_OCR_DEFAULT_ROUTES = {
  default: "lightonocr-3-0.8b",
  mathPages: ["dots.ocr", "olmocr-2"],
  hostedFallback: "inclusionai/ling-3.0-flash-vl (effort none)",
  hostedFallbackSecondary: "deepseek/deepseek-v4.1-flash (effort none)",
} as const;

/** Names of the default OCR routes with non-free models removed when DISABLE_NON_FREE_SOFTWARE is on. */
export function flatOcrDefaultRoutes(options: FlatTierRouteOptions = {}): {
  default: string;
  mathPages: string[];
  hostedFallback: string;
  hostedFallbackSecondary: string;
} {
  const allowed = (id: string) => {
    const route = MEASURED_OCR_ROUTES.find((r) => r.id === id);
    return !(options.disableNonFree && route?.licenseClass === "non-free");
  };
  return {
    default: FLAT_OCR_DEFAULT_ROUTES.default,
    mathPages: FLAT_OCR_DEFAULT_ROUTES.mathPages.filter(allowed),
    hostedFallback: FLAT_OCR_DEFAULT_ROUTES.hostedFallback,
    hostedFallbackSecondary: FLAT_OCR_DEFAULT_ROUTES.hostedFallbackSecondary,
  };
}

/** True for a hosted OCR id that must not be routed (deprecated DeepInfra OCR ids). */
export function isDeprecatedHostedOcrId(id: string): boolean {
  const normalized = id.toLowerCase();
  return DEPRECATED_HOSTED_OCR_IDS.some((deprecated) => deprecated.toLowerCase() === normalized);
}

/** A route that can serve a page: our own models, or a hosted model at per-token prices. */
export type FlatTierRoute = (
  | { kind: "self-hosted" }
  | { kind: "native" }
  | { kind: "hosted"; pricing: AiUsagePricing | null | undefined }
) & {
  /** Licence class of the route's model (model-license.ts); absent is treated as free. */
  licenseClass?: LicenseClass;
};

export interface FlatTierRouteOptions {
  /** DISABLE_NON_FREE_SOFTWARE: a route whose licence class is "non-free" never serves a flat-tier page. */
  disableNonFree?: boolean;
}

/**
 * Cost of reading 1,000 pages on a hosted route, from its per-token list
 * prices and the planning page size (SELF_HOSTED_PAGE_TOKENS). Reproduces
 * measured per-page cost within about 5% for lite vision models.
 */
export function hostedRouteCostUsdPer1kPages(pricing: AiUsagePricing): number {
  const centsPerPage = (SELF_HOSTED_PAGE_TOKENS.input / 1000) * pricing.costPer1kInputTokens
    + (SELF_HOSTED_PAGE_TOKENS.output / 1000) * pricing.costPer1kOutputTokens;
  return (centsPerPage * 1000) / 100;
}

/**
 * Whether a route may serve pages sold at a flat tier price. Own models and
 * native parsers always may (their cost is infrastructure, below the cap by
 * construction). A hosted route may only when its token prices are known and
 * put it at or under the cap; unknown prices fail closed.
 */
export function isRouteEligibleForFlatTier(tier: ExtractTierId, route: FlatTierRoute, options: FlatTierRouteOptions = {}): boolean {
  if (options.disableNonFree && route.licenseClass === "non-free") return false;
  if (route.kind !== "hosted") return true;
  if (!route.pricing) return false;
  const cost = hostedRouteCostUsdPer1kPages(route.pricing);
  return Number.isFinite(cost) && cost <= flatTierRouteCostCapUsdPer1kPages(tier) + 1e-9;
}

export function filterFlatTierRoutes<T extends { route: FlatTierRoute }>(tier: ExtractTierId, candidates: readonly T[], options: FlatTierRouteOptions = {}): T[] {
  return candidates.filter((candidate) => isRouteEligibleForFlatTier(tier, candidate.route, options));
}

/**
 * Charge for pages sold at a flat tier. Pages that escalated to a route that
 * is not eligible are billed at metered rates for that model's work (provider
 * cost plus the AI markup) on top of the flat price, so an expensive model
 * never serves a flat-priced page at a loss.
 */
export function priceFlatTierPages(args: {
  tier: ExtractTierId;
  pages: number;
  /** Provider list cost, in cents, of calls made on routes that are not flat-tier eligible. */
  escalatedProviderCents?: number;
  card?: CreditRateCard;
}): { flatCredits: number; escalationCredits: number; totalCredits: number } {
  const card = args.card ?? CREDIT_RATE_CARD;
  const pages = Math.max(0, Number.isFinite(args.pages) ? args.pages : 0);
  const usdPer1k = EXTRACT_TIERS[args.tier].usdPer1kPages;
  const flatCredits = ((pages / 1000) * usdPer1k * 100) / CENTS_PER_CREDIT;
  const escalated = Math.max(0, Number.isFinite(args.escalatedProviderCents) ? args.escalatedProviderCents ?? 0 : 0);
  const escalationCredits = (escalated / CENTS_PER_CREDIT) * (1 + card.aiMarkupPercent / 100);
  return { flatCredits, escalationCredits, totalCredits: flatCredits + escalationCredits };
}

// ---------------------------------------------------------------------------
// Private dedicated (single-tenant) capacity
// ---------------------------------------------------------------------------

/**
 * A single-tenant box earns about 24% at $2,500 a month on a marketplace host
 * and -3% on a managed endpoint (HF RTX PRO 6000, $2.75/h), not the 47% once
 * quoted: that figure left out payment fees and about $500 a month of ops.
 *
 * Chosen rule: the monthly price gives a 40% gross margin after payment fees
 * on the box's rental plus ops, and is never below the floor. For a managed
 * RTX PRO 6000-class box that is $4,399, so the floor is $4,400. (The research
 * shorthand "cost +40%" would be a 1.4x markup, a 21% margin after fees; the
 * margin form is what reproduces its $4,399.) Marketplace hosts (Vast) do not
 * qualify for single-tenant custody promises: hosts can read container data.
 */
export const PRIVATE_DEDICATED_PRICING = {
  floorUsdPerMonth: 4_400,
  targetGrossMarginPercent: 40,
  paymentFeePercent: 3,
  /** Monitoring, on-call, upgrades and the reaper, per box. */
  opsUsdPerMonthPerBox: 500,
  hoursPerMonth: 730,
} as const;

/** Monthly price in US dollars for `boxes` managed single-tenant GPU boxes. */
export function privateDedicatedMonthlyUsd(args: { gpuUsdPerHour: number; boxes?: number }): number {
  const pricing = PRIVATE_DEDICATED_PRICING;
  const boxes = Math.max(1, Math.round(args.boxes ?? 1));
  if (!(args.gpuUsdPerHour >= 0) || !Number.isFinite(args.gpuUsdPerHour)) {
    throw new Error("gpuUsdPerHour must be a nonnegative number");
  }
  const cost = boxes * (args.gpuUsdPerHour * pricing.hoursPerMonth + pricing.opsUsdPerMonthPerBox);
  const price = cost / (1 - (pricing.targetGrossMarginPercent + pricing.paymentFeePercent) / 100);
  return Math.max(boxes * pricing.floorUsdPerMonth, Math.ceil(price));
}
