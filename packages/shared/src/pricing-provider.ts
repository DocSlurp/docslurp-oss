/*
 * Pricing provider: the one seam through which DocSlurp turns measured work into credits and internal cost.
 *
 * Core measures work (pages read, model output tokens, media seconds, stored bytes, searches, chat answers) and owns the
 * usage ledger, spend checks, attribution, budgets and AI-usage logging. How that work is priced is the provider's:
 * per-unit prices, which work is charged, plan limits, quotes and internal cost rates.
 *
 * Core ships an open default (`OPEN_PRICING`, pricing-open.ts): a flat, transparent per-page rule a self-hosted
 * deployment can live with. A deployment replaces it with a provider module named in DOCSLURP_PRICING_PLUGIN
 * (`@docslurp/shared/pricing-loader`). Fail closed: under DOCSLURP_SERVICE_PROFILE=service nothing here falls back to
 * the open default; `pricing()` throws until a non-default provider is installed.
 *
 * Contract: docs/billing/pricing-provider.md.
 */
import type { CostEstimate } from "./jobs.js";
import { OPEN_PRICING } from "./pricing-open.js";
import type { QualityMode } from "./quality.js";

export const PRICING_PROVIDER_API_VERSION = 1;

/** How one page is charged: a page whose text layer is used, or a page a model reads. */
export type PageMode = "fast" | "rich";
/** Chat answer price tiers; the provider maps models to them. */
export type ChatAnswerTier = "standard" | "advanced" | "premium";
export const CHAT_ANSWER_TIERS: readonly ChatAnswerTier[] = ["standard", "advanced", "premium"];
/** Optional per-document features, charged once per document when their stage runs. */
export const DOCUMENT_FEATURES = ["documentSummary", "structuredFields", "knowledgeGraph", "propositions"] as const;
export type DocumentFeature = (typeof DOCUMENT_FEATURES)[number];
export type PageClass = "text" | "complex" | "scanned";
export type PageMix = Record<PageClass, number>;

export type IngestEstimateInput = {
  pages: number;
  /** Fractions of pages per class; normalized, so any positive weights work. */
  mix: Partial<PageMix>;
  profile?: QualityMode;
  /** Org concurrent worker ceiling (default: the provider's funded worker slots). */
  workerSlots?: number;
  /** Number of files in the batch. */
  documents?: number;
  audioMinutes?: number;
  videoMinutes?: number;
  /** Optional per-document features to price; off unless set. */
  features?: Partial<Record<DocumentFeature, boolean>>;
  /** Pages, beyond `pages`, that no model reads in any quality (Word, slide and sheet files). */
  fastOnlyPages?: number;
};

export type IngestEstimate = {
  pages: number;
  profile: QualityMode;
  workers: number;
  effectiveParallelism: number;
  workerSeconds: number;
  wallSeconds: number;
  pagesPerMinute: number;
  minutesPer100Pages: number;
  fastPages: number;
  richPages: number;
  /** Rich pages counted for audio and video minutes. */
  mediaRichPages: number;
  credits: {
    totalCredits: number;
    breakdown: { fast: number; rich: number; media: number; features: number };
  };
  /** Credits per enabled optional feature, across all documents. */
  featureCredits: Partial<Record<DocumentFeature, number>>;
  pagesPerDollar: number;
  creditsPer1000Pages: number;
  storage: { bytes: number; objectBytes: number; indexBytes: number; monthlyCredits: number };
};

/** What one quality mode costs, as the provider presents it. */
export type QualityModePricing = {
  /** Credits per 1,000 pages; min === max for a flat price. */
  creditsPer1kPages: { min: number; max: number };
  /** What the price depends on, for a tooltip or footnote. */
  priceNote: string;
};

/** Customer plan limits and payment options. */
export type PricingPlans = {
  /** Self-serve credit packs, in cents. */
  creditPacksCents: readonly number[];
  /** One-time starter grant per user, in credits. */
  starterCredits: number;
  /** Org-wide concurrent worker ceiling: before and after the org's first paid grant. */
  workerSlots: { starter: number; funded: number };
  /** Monthly price of a dedicated deployment, when sold. */
  privateDedicatedMonthlyUsd: number | null;
};

/** Quote request types, defined in upload-quote.ts and file-profile.ts; repeated here as the provider sees them. */
export type ProviderQuoteArgs = {
  files: readonly import("./upload-quote.js").QuoteFile[];
  profile: import("./upload-quote.js").EstimateProfile;
  speedBoost?: boolean;
};
export type ProviderQuote = { estimate: CostEstimate; media: import("./media-upload-estimate.js").UploadMediaEstimate | null };

/** Internal cost rates for local compute, in cents. Any omitted rate keeps the deployment's configured value. */
export type ComputeRateOverrides = Partial<{
  cpuCentsPerSecond: number;
  memoryCentsPerGbSecond: number;
  gpuCentsPerSecond: number;
  storageCentsPerGbMonth: number;
}>;

export interface PricingProvider {
  apiVersion: typeof PRICING_PROVIDER_API_VERSION;
  /** Stable id for logs and receipts. `open` is reserved for the open default. */
  id: string;
  /** Stamped on every billable unit event and pinned on runs, so a receipt says which rules charged it. */
  version: string;
  plans: PricingPlans;
  /**
   * The dense-page allowance (an integer, 1 or more) for PDF pages and image frames: a page whose text counts as this many
   * pages or fewer bills its text as 1, above it its full text volume; its area always bills in full
   * (billedPagePageEquivalents: max(text above the allowance else 1, area)). Office, EPUB, HTML and text files have none.
   * Billing (recordPageEquivalents' `allowance`) and quotes both apply it. Core's default is
   * DEFAULT_PAGE_EQUIVALENT_ALLOWANCE.
   */
  pageEquivalentAllowance: number;

  /** Credits for `pages` pages charged in `mode` (fractional). */
  pageCredits(mode: PageMode, pages: number): number;
  /** Rich pages one model read of a page counts as, given its output tokens (unknown: 1). */
  richPagesForOutputTokens(outputTokens: number | null | undefined): number;
  /** Rich pages an audio or video file counts as for its duration. */
  mediaRichPages(kind: "audio" | "video", seconds: number): number;
  /** Monthly storage credits for `bytes` stored. */
  storageCreditsPerMonth(bytes: number): number;
  /** Credits for keeping `bytes` for `months` (30-day months) beyond an extract's free window. */
  extractRetentionCredits(bytes: number, months: number): number;
  /** Searches one search counts as (LLM query strategies may count more). */
  searchUnits(opts: { llmStrategies?: boolean }): number;
  /** Credits for `searches` searches. */
  searchCredits(searches: number, opts: { llmStrategies?: boolean }): number;
  webSearchCredits(opts: { deep?: boolean; includeContent?: boolean }): number;
  webPageCredits(pages: number): number;
  webMapCredits(urls: number): number;
  /** Answer tier of a chat model id (`provider/model`, bare `model`). */
  chatModelTier(model: string | null | undefined): ChatAnswerTier;
  /** Chat answers one turn of `totalTokens` counts as. */
  chatAnswerUnits(totalTokens: number | null | undefined): number;
  chatAnswerCredits(opts: { model?: string | null; tier?: ChatAnswerTier; totalTokens?: number | null }): number;
  /** Credits for one optional feature over one document of `pages` pages. */
  featureCredits(feature: DocumentFeature, pages: number): number;
  /** Multiplier on unit charges for the opt-in speed boost (1 when off). */
  speedBoostMultiplier(speedBoost: boolean): number;
  /** Share of the completion page charge a run pays, given the stages it executes and reuses. */
  pageChargeShare(plan: { stageOrder: readonly string[]; reusedStages: readonly string[] }): number;
  qualityModePricing(mode: QualityMode): QualityModePricing;
  /** Body of the public price list (`GET /v1/billing/prices`), beyond `pricingVersion` and plans. */
  publicPrices(): Record<string, unknown>;
  /** Planning estimate of ingesting pages and media. */
  estimateIngest(input: IngestEstimateInput): IngestEstimate;
  /**
   * Quote an upload. Files may carry a client file profile (`file.profile`, file-profile.ts): untrusted, already validated
   * and clamped, used only to estimate. It never affects what a run is charged.
   */
  quoteUpload(args: ProviderQuoteArgs): ProviderQuote;
  /**
   * The full estimate for files and settings: ingest credits, monthly hosting and usage, neutral lines, ranges, the
   * pricing version and how long it holds (`assembleEstimateQuote` builds the shape). Must answer in milliseconds: it runs
   * on every knob change of an interactive quote.
   */
  quote(args: import("./estimate-quote.js").ProviderEstimateArgs): import("./estimate-quote.js").EstimateQuote;

  /** Internal cost (our own cost reports; never a customer charge). */
  internalCost: {
    /** Local compute rate overrides for the named rate card (DOCSLURP_COMPUTE_RATE_CARD), or null to keep defaults. */
    computeRates(rateCard: string | undefined): ComputeRateOverrides | null;
    /** Internal list-price reference for allocated resources, in credits; null when none. */
    listCredits(resources: { cpuSeconds?: number; memoryGbSeconds?: number }): number | null;
    /** Provider cost in cents of a remote sandbox run; 0 when unknown. */
    sandboxCostCents(args: { provider: string; cores: number; memoryGib: number; seconds: number }): number;
    /** When the sandbox rates were observed (ISO date), or null. */
    sandboxRatesObservedAt(provider: string): string | null;
    /** Infrastructure cost of one worker slot per hour in USD, for routing cost bounds; null when unknown. */
    workerSlotUsdPerHour(): number | null;
  };
}

const REQUIRED_METHODS: ReadonlyArray<keyof PricingProvider> = [
  "pageCredits", "richPagesForOutputTokens", "mediaRichPages", "storageCreditsPerMonth", "extractRetentionCredits",
  "searchUnits", "searchCredits", "webSearchCredits", "webPageCredits", "webMapCredits", "chatModelTier",
  "chatAnswerUnits", "chatAnswerCredits", "featureCredits", "speedBoostMultiplier", "pageChargeShare",
  "qualityModePricing", "publicPrices", "estimateIngest", "quoteUpload", "quote",
];

/** Throw unless `value` is a complete provider for this API version. */
export function assertPricingProvider(value: unknown): asserts value is PricingProvider {
  const provider = value as Partial<PricingProvider> | null;
  if (!provider || typeof provider !== "object") throw new Error("pricing provider must be an object");
  if (provider.apiVersion !== PRICING_PROVIDER_API_VERSION) {
    throw new Error(`pricing provider apiVersion ${String(provider.apiVersion)} is not ${PRICING_PROVIDER_API_VERSION}`);
  }
  if (typeof provider.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider.id)) throw new Error("pricing provider id must be a short lowercase id");
  if (typeof provider.version !== "string" || !provider.version.trim() || provider.version.length > 64) throw new Error("pricing provider version must be a non-empty string");
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== "function") throw new Error(`pricing provider ${provider.id} has no ${String(method)}()`);
  }
  const plans = provider.plans;
  if (!Number.isSafeInteger(provider.pageEquivalentAllowance) || provider.pageEquivalentAllowance! < 1 || provider.pageEquivalentAllowance! > 64) {
    throw new Error(`pricing provider ${provider.id} has an invalid pageEquivalentAllowance`);
  }
  if (!plans || !Array.isArray(plans.creditPacksCents) || !(plans.workerSlots?.starter >= 1) || !(plans.workerSlots?.funded >= 1)
    || !(plans.starterCredits >= 0)) {
    throw new Error(`pricing provider ${provider.id} has invalid plans`);
  }
  const cost = provider.internalCost;
  if (!cost || typeof cost.computeRates !== "function" || typeof cost.listCredits !== "function"
    || typeof cost.sandboxCostCents !== "function" || typeof cost.sandboxRatesObservedAt !== "function"
    || typeof cost.workerSlotUsdPerHour !== "function") {
    throw new Error(`pricing provider ${provider.id} has an incomplete internalCost`);
  }
}

/** The id the open default uses; a deployment provider may not claim it. */
export const OPEN_PRICING_ID = "open";

let installed: PricingProvider | null = null;

/** Whether this process runs the hosted service profile, where the open default is never allowed. */
export function pricingServiceProfile(env: Record<string, string | undefined> | undefined = processEnv()): boolean {
  return env?.DOCSLURP_SERVICE_PROFILE?.trim().toLowerCase() === "service";
}

function processEnv(): Record<string, string | undefined> | undefined {
  return typeof process !== "undefined" && process?.env ? process.env : undefined;
}

/**
 * Whether this process must price with a deployment provider: the service profile, or DOCSLURP_PRICING_REQUIRED=1 (set by
 * every deployed process that charges, including ones that do not run the service profile, such as the chat executor).
 */
export function pricingRequired(env: Record<string, string | undefined> | undefined = processEnv()): boolean {
  return pricingServiceProfile(env) || env?.DOCSLURP_PRICING_REQUIRED?.trim() === "1";
}

/**
 * The active provider. Fail closed: when pricing is required (pricingRequired), throws until a deployment provider is
 * installed (startup loads it before serving or polling), so a deployment that bills never prices with the open default,
 * even in a process whose startup forgot to load it.
 */
export function pricing(): PricingProvider {
  if (installed) return installed;
  if (pricingRequired()) {
    throw new Error("pricing is required here (DOCSLURP_SERVICE_PROFILE=service or DOCSLURP_PRICING_REQUIRED=1) but no pricing provider is installed (DOCSLURP_PRICING_PLUGIN); refusing to price with the open default");
  }
  return OPEN_PRICING;
}

/** Whether a deployment provider (not the open default) is installed. */
export function pricingProviderInstalled(): boolean {
  return installed !== null;
}

/** Install a deployment provider. Once per process; a second, different provider is an error. */
export function installPricingProvider(provider: PricingProvider): void {
  assertPricingProvider(provider);
  if (provider.id === OPEN_PRICING_ID) throw new Error("a deployment pricing provider may not use the reserved id `open`");
  if (installed && installed !== provider) throw new Error(`a pricing provider (${installed.id}) is already installed`);
  installed = provider;
}

/** Tests only: drop the installed provider. */
export function resetPricingProviderForTests(): void {
  installed = null;
}
