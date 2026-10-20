import { z } from "zod";

import { PRIVATE_MODEL_PROVIDER } from "./private-endpoints.js";

// ---------------------------------------------------------------------------
// Credits
//
// 1 credit = 1 US cent. Every metered resource (CPU, RAM, GPU, storage,
// egress, AI tokens) is converted to credits by the rate card below, so one
// number answers "what did that cost?". Balances keep fractional credits
// (numeric(24,12)); invoices and UI round to whole cents / 2 decimals.
// ---------------------------------------------------------------------------

export const CENTS_PER_CREDIT = 1;
export const CREDITS_PER_DOLLAR = 100 / CENTS_PER_CREDIT;

/**
 * Whether this deployment bills at all: Stripe configured (metering is enforced), or a `DOCSLURP_BILL_*`
 * flag set to `true`. Self-hosted deployments without either run with billing disabled, so price
 * estimates there are not a charge.
 */
export function isBillingEnforced(env: Record<string, string | undefined> = process.env): boolean {
  if (env.STRIPE_SECRET_KEY?.trim()) return true;
  return Object.entries(env).some(([key, value]) => key.startsWith("DOCSLURP_BILL_") && value?.trim().toLowerCase() === "true");
}

export function creditsToDollars(credits: number): number {
  return (credits * CENTS_PER_CREDIT) / 100;
}

export function dollarsToCredits(dollars: number): number {
  return (dollars * 100) / CENTS_PER_CREDIT;
}

// ---------------------------------------------------------------------------
// Service plans
// ---------------------------------------------------------------------------

export const planIdSchema = z.enum(["free", "silver", "gold", "platinum"]);
export type PlanId = z.infer<typeof planIdSchema>;

export const paidPlanIdSchema = z.enum(["silver", "gold", "platinum"]);
export type PaidPlanId = z.infer<typeof paidPlanIdSchema>;

/** Hard ceiling on page tasks one run fans out to, whatever the plan allows. */
export const MAX_PAGE_FANOUT_PER_RUN = 128;

export type ServicePlan = {
  id: PlanId;
  label: string;
  tagline: string;
  /** Monthly minimum commitment, billed in advance. 0 for free. */
  monthlyMinimumCents: number;
  /** Credits granted each paid period (minimum converted 1:1, plus bonus). */
  includedCreditsPerMonth: number;
  /** Bonus credits as a percentage of the minimum. */
  bonusPercent: number;
  /** Org-wide ceiling on concurrently running worker slots. */
  workers: number;
  /** Storage included before metering starts; at most INCLUDED_INDEX_STORAGE_SHARE may be index. */
  includedStorageGb: number;
  support: string;
  /** Document versions kept per path when neither org nor workspace overrides it (free: always 1). */
  defaultRetainedVersions: number;
  /** Stripe Price lookup key; prices are synced by the plan sync script. */
  stripeLookupKey: string | null;
  highlights: readonly string[];
};

export const SERVICE_PLANS: readonly ServicePlan[] = [
  {
    id: "free",
    label: "Free",
    tagline: "Kick the tires with real documents.",
    monthlyMinimumCents: 0,
    includedCreditsPerMonth: 0,
    bonusPercent: 0,
    workers: 50,
    includedStorageGb: 1,
    support: "Community",
    defaultRetainedVersions: 1,
    stripeLookupKey: null,
    highlights: [
      "250 one-time starter credits",
      "50 concurrent workers",
      "1 GB storage included (50 MB index)",
    ],
  },
  {
    id: "silver",
    label: "Silver",
    tagline: "Steady ingestion for a team or a product.",
    monthlyMinimumCents: 2_000,
    includedCreditsPerMonth: 2_000,
    bonusPercent: 0,
    workers: 100,
    includedStorageGb: 10,
    support: "Email, 2 business days",
    defaultRetainedVersions: 2,
    stripeLookupKey: "docslurp_silver_monthly",
    highlights: [
      "2,000 credits every month",
      "100 concurrent workers",
      "10 GB storage included (500 MB index)",
      "Auto-recharge",
    ],
  },
  {
    id: "gold",
    label: "Gold",
    tagline: "Back-catalog imports and busy pipelines.",
    monthlyMinimumCents: 5_000,
    includedCreditsPerMonth: 5_500,
    bonusPercent: 10,
    workers: 250,
    includedStorageGb: 50,
    support: "Priority email, 1 business day",
    defaultRetainedVersions: 2,
    stripeLookupKey: "docslurp_gold_monthly",
    highlights: [
      "5,500 credits every month (+10%)",
      "250 concurrent workers",
      "50 GB storage included (2.5 GB index)",
      "Auto-recharge",
    ],
  },
  {
    id: "platinum",
    label: "Platinum",
    tagline: "Archive-scale ingestion with room to burst.",
    monthlyMinimumCents: 50_000,
    includedCreditsPerMonth: 60_000,
    bonusPercent: 20,
    workers: 1_000,
    includedStorageGb: 1_000,
    support: "Priority, shared Slack channel",
    defaultRetainedVersions: 2,
    stripeLookupKey: "docslurp_platinum_monthly",
    highlights: [
      "60,000 credits every month (+20%)",
      "1,000 concurrent workers",
      "1 TB storage included (50 GB index)",
      "Auto-recharge",
    ],
  },
] as const;

export function getPlan(id: string | null | undefined): ServicePlan {
  return SERVICE_PLANS.find((plan) => plan.id === id) ?? SERVICE_PLANS[0]!;
}

export function getPlanByLookupKey(lookupKey: string | null | undefined): ServicePlan | null {
  if (!lookupKey) return null;
  return SERVICE_PLANS.find((plan) => plan.stripeLookupKey === lookupKey) ?? null;
}

/**
 * Credits granted for a paid subscription amount. Proration invoices pay a
 * fraction of the minimum, so the grant scales with what was actually paid.
 */
export function creditsForSubscriptionPayment(planId: PlanId, amountPaidCents: number): number {
  const plan = getPlan(planId);
  if (plan.monthlyMinimumCents <= 0 || amountPaidCents <= 0) return 0;
  const credits = (amountPaidCents / CENTS_PER_CREDIT) * (1 + plan.bonusPercent / 100);
  return Math.round(credits * 100) / 100;
}

export const STARTER_CREDITS = 250;
export const MIN_TOPUP_CENTS = 500;
export const MAX_TOPUP_CENTS = 1_000_000;

// ---------------------------------------------------------------------------
// Rate card (list prices in credits)
// ---------------------------------------------------------------------------

export type CreditRateCard = {
  version: string;
  effectiveDate: string;
  cpuVcpuHour: number;
  memoryGbHour: number;
  gpuStandardHour: number;
  gpuLargeHour: number;
  objectStorageGbMonth: number;
  indexStorageGbMonth: number;
  egressGb: number;
  /** Markup applied to AI provider list cost (tokens, vision, embeddings). */
  aiMarkupPercent: number;
};

/**
 * Every line must satisfy RESOURCE_CLASS_POLICY (infra-costs.ts) against the
 * latest infra observations; run the internal pricing validation before changing it.
 * 2026-10.2: CPU/memory rebalanced to Fly's cost structure (RAM dominates),
 * storage raised to cover Tigris/Neon, large GPU restricted to A100 80 GB.
 * 2026-10.3: pages read by our own models are billed per page at 50% of the
 * hosted-equivalent list price (not per GPU-hour); AI on bonus plans carries
 * the plan-neutral factor; EU-pinned (+4%) and zero-retention (+1%) factors.
 * The CPU, memory, GPU-hour, storage and egress lines are unchanged. Rate card
 * changes need at least 30 days' notice; the owner set the effective date to
 * the end of February 2027 (2027-02-28, decided 2026-10-13).
 */
export const CREDIT_RATE_CARD: CreditRateCard = {
  version: "2026-10.3",
  effectiveDate: "2027-02-28",
  cpuVcpuHour: 1,
  memoryGbHour: 3,
  gpuStandardHour: 90,
  gpuLargeHour: 300,
  objectStorageGbMonth: 5,
  indexStorageGbMonth: 75,
  egressGb: 5,
  aiMarkupPercent: 20,
};

export type RateCardLine = {
  key: keyof Omit<CreditRateCard, "version" | "effectiveDate">;
  resource: string;
  unit: string;
  detail: string;
};

export const RATE_CARD_LINES: readonly RateCardLine[] = [
  { key: "cpuVcpuHour", resource: "CPU", unit: "vCPU-hour", detail: "Parsing, layout, chunking, CPU OCR. Metered per second." },
  { key: "memoryGbHour", resource: "Memory", unit: "GB-hour", detail: "RAM allocated to the worker while it holds your task. RAM is the larger share of worker cost." },
  { key: "gpuStandardHour", resource: "GPU · standard", unit: "GPU-hour", detail: "24 GB class (L4, RTX 4090, RTX 3090). For GPU work with no per-page price. Model-read pages on our own GPUs are priced per page, below." },
  { key: "gpuLargeHour", resource: "GPU · large", unit: "GPU-hour", detail: "80 GB class (A100 80 GB). Large models with no per-page price." },
  { key: "objectStorageGbMonth", resource: "Object storage", unit: "GB-month", detail: "Source files, Markdown, page images. Accrued daily." },
  { key: "indexStorageGbMonth", resource: "Index storage", unit: "GB-month", detail: "Vectors, full-text and graph indexes. Accrued daily." },
  { key: "egressGb", resource: "Egress", unit: "GB", detail: "Downloads of originals and exports." },
  { key: "aiMarkupPercent", resource: "AI models", unit: "% over provider list", detail: "LLM, vision and embedding tokens at provider list price plus markup." },
];

const SECONDS_PER_HOUR = 3_600;
const HOURS_PER_MONTH = 730;
const BYTES_PER_GB = 1024 ** 3;

export type MeteredResources = {
  cpuSeconds?: number;
  memoryGbSeconds?: number;
  gpuStandardSeconds?: number;
  gpuLargeSeconds?: number;
  egressBytes?: number;
  /** Provider list cost of AI calls, in cents (before markup). */
  aiProviderCents?: number;
  /**
   * Pages read by a model on our own GPUs (planning model: SELF_HOSTED_PAGE_TOKENS
   * per page), priced as self-hosted inference rather than by GPU-hour.
   */
  selfHostedPages?: number;
};

export type CreditCharge = {
  totalCredits: number;
  breakdown: {
    cpu: number;
    memory: number;
    gpu: number;
    egress: number;
    ai: number;
    /** Own-GPU model pages at the self-hosted price. */
    selfHosted: number;
  };
  /** What the self-hosted pages would cost at the hosted-equivalent list price. */
  selfHostedListCredits: number;
};

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

/** Price metered compute/AI resources in credits at list rates. */
export function priceResources(
  resources: MeteredResources,
  card: CreditRateCard = CREDIT_RATE_CARD,
): CreditCharge {
  const breakdown = {
    cpu: (nonNegative(resources.cpuSeconds) / SECONDS_PER_HOUR) * card.cpuVcpuHour,
    memory: (nonNegative(resources.memoryGbSeconds) / SECONDS_PER_HOUR) * card.memoryGbHour,
    gpu:
      (nonNegative(resources.gpuStandardSeconds) / SECONDS_PER_HOUR) * card.gpuStandardHour
      + (nonNegative(resources.gpuLargeSeconds) / SECONDS_PER_HOUR) * card.gpuLargeHour,
    egress: (nonNegative(resources.egressBytes) / BYTES_PER_GB) * card.egressGb,
    ai: (nonNegative(resources.aiProviderCents) / CENTS_PER_CREDIT) * (1 + card.aiMarkupPercent / 100),
    selfHosted: nonNegative(resources.selfHostedPages) * selfHostedPageCredits(card).billed,
  };
  return {
    totalCredits: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    breakdown,
    selfHostedListCredits: nonNegative(resources.selfHostedPages) * selfHostedPageCredits(card).list,
  };
}

// ---------------------------------------------------------------------------
// Self-hosted inference
//
// Pages read by models on our own GPUs (private endpoints, single-tenant
// boxes) are billed at SELF_HOSTED_DISCOUNT_PERCENT of the hosted-equivalent
// list price and shown as that list price struck through. They are NOT billed
// by GPU-hour: a GPU-hour line prices the hardware, not the work, and put
// own-GPU pages at ~$0.13 per 1,000 pages against ~$1 for hosted pass-through
// (internal research notes, decision 6).
//
// Hosted-equivalent list price: the tokens the call actually used, at the
// list price of the reference hosted model for its capability
// (HOSTED_EQUIVALENT_REFERENCES), plus the AI markup. Capabilities with no
// reference (rerank, speech-to-text) are billed as ordinary AI: provider cost
// plus markup, no discount.
// ---------------------------------------------------------------------------

/** Share taken off the hosted-equivalent list price for pages served by our own models. */
export const SELF_HOSTED_DISCOUNT_PERCENT = 50;

export const hostedEquivalentCapabilitySchema = z.enum(["text", "vision", "embedding"]);
export type HostedEquivalentCapability = z.infer<typeof hostedEquivalentCapabilitySchema>;

export type HostedEquivalentReference = {
  capability: HostedEquivalentCapability;
  /** Hosted model whose list price defines the hosted equivalent. */
  model: string;
  provider: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Date the list price was last checked; the internal pricing validation re-checks it live. */
  checkedAt: string;
};

/**
 * The reference hosted target per capability: the open-weight hosted default
 * for language and vision (the cheapest hosted route that serves our default
 * quality tier, so the "list" price is never inflated by a premium model),
 * and the default hosted embedding model.
 */
export const HOSTED_EQUIVALENT_REFERENCES: Record<HostedEquivalentCapability, HostedEquivalentReference> = {
  text: { capability: "text", model: "z-ai/glm-5.3-flash", provider: "openrouter", inputUsdPerMTok: 0.0261, outputUsdPerMTok: 0.9, checkedAt: "2026-10-13" },
  vision: { capability: "vision", model: "z-ai/glm-5.3-flash", provider: "openrouter", inputUsdPerMTok: 0.0261, outputUsdPerMTok: 0.9, checkedAt: "2026-10-13" },
  embedding: { capability: "embedding", model: "openai/text-embedding-3-small", provider: "openai", inputUsdPerMTok: 0.02, outputUsdPerMTok: 0, checkedAt: "2026-10-13" },
};

/**
 * Tokens one page needs when a model has to read it. Planning figure used by
 * the estimator and the pricing page; billing uses the tokens a call reports.
 * It reproduces measured hosted per-page cost within 5% for a lite vision model
 * (02-economics.md, section 1).
 */
export const SELF_HOSTED_PAGE_TOKENS = { input: 1_500, output: 800 } as const;

export function isHostedEquivalentCapability(value: unknown): value is HostedEquivalentCapability {
  return hostedEquivalentCapabilitySchema.safeParse(value).success;
}

/** Hosted-equivalent provider cost (before markup) in cents for a call's tokens. */
export function hostedEquivalentProviderCents(args: {
  capability: HostedEquivalentCapability;
  inputTokens?: number | null;
  outputTokens?: number | null;
}): number {
  const reference = HOSTED_EQUIVALENT_REFERENCES[args.capability];
  const usd = (nonNegative(args.inputTokens ?? 0) * reference.inputUsdPerMTok + nonNegative(args.outputTokens ?? 0) * reference.outputUsdPerMTok) / 1_000_000;
  return usd * 100;
}

/** Hosted-equivalent list price in credits: reference list cost plus the AI markup. */
export function hostedEquivalentListCredits(
  args: Parameters<typeof hostedEquivalentProviderCents>[0],
  card: CreditRateCard = CREDIT_RATE_CARD,
): number {
  return (hostedEquivalentProviderCents(args) / CENTS_PER_CREDIT) * (1 + card.aiMarkupPercent / 100);
}

/** What a self-hosted call is billed for a given hosted-equivalent list price. */
export function selfHostedBilledCredits(listCredits: number): number {
  return listCredits * (1 - SELF_HOSTED_DISCOUNT_PERCENT / 100);
}

/** One model-read page: list (struck through on the pricing page) and billed credits. */
export function selfHostedPageCredits(card: CreditRateCard = CREDIT_RATE_CARD): { list: number; billed: number } {
  const list = hostedEquivalentListCredits({ capability: "vision", inputTokens: SELF_HOSTED_PAGE_TOKENS.input, outputTokens: SELF_HOSTED_PAGE_TOKENS.output }, card);
  return { list, billed: selfHostedBilledCredits(list) };
}

/** Published self-hosted prices for the rate-card API and pricing page. */
export function selfHostedRateCard(card: CreditRateCard = CREDIT_RATE_CARD) {
  const page = selfHostedPageCredits(card);
  return {
    discountPercent: SELF_HOSTED_DISCOUNT_PERCENT,
    references: Object.values(HOSTED_EQUIVALENT_REFERENCES),
    pageTokens: SELF_HOSTED_PAGE_TOKENS,
    /** Credits to read 1,000 pages with a model on our own GPUs. */
    per1000Pages: { listCredits: page.list * 1000, billedCredits: page.billed * 1000 },
  };
}

// ---------------------------------------------------------------------------
// Plan-neutral AI pricing
//
// A bonus plan's credits are worth less than a cent each: Platinum pays $500
// for 60,000 credits, so a credit realizes 0.833 cents and AI charged at
// provider list + 20% in credits returns 1.2 x 0.833 = 1.00 of provider cost,
// before the 3% payment fee (a loss; Gold earns 5%). Bonus credits are meant
// for compute and storage, so AI on a bonus plan is charged (1 + bonus) times
// the credits: the same dollars on every plan, with the bonus still buying
// extra compute and storage.
// ---------------------------------------------------------------------------

/** Credits charged per list-priced AI credit on a plan: 1 + its bonus. */
export function aiBonusNeutralFactor(planId: string | null | undefined): number {
  if (!planId) return 1;
  return 1 + getPlan(planId).bonusPercent / 100;
}

// ---------------------------------------------------------------------------
// Privacy routing factors
//
// EU-pinned and zero-retention routes cost more per token for the same model
// (+42% OVHcloud vs DeepInfra, +26% Together ZDR vs DeepInfra, 2026-10-12), so
// they carry an explicit factor on the AI charge. An event is stamped
// `euPinned: true` / `zeroRetention: true` by whichever routing code selected
// the EU or zero-retention route; no deployment mode sets them yet.
// ---------------------------------------------------------------------------

export const ROUTE_FACTOR_PERCENT = { euPinned: 4, zeroRetention: 1 } as const;

export function routeFactorPercent(flags: { euPinned?: unknown; zeroRetention?: unknown } | null | undefined): number {
  return (flags?.euPinned === true ? ROUTE_FACTOR_PERCENT.euPinned : 0) + (flags?.zeroRetention === true ? ROUTE_FACTOR_PERCENT.zeroRetention : 0);
}

/**
 * Prices beyond the metered lines, published beside the rate card
 * (`GET /v1/billing/plans`): self-hosted pages, the AI credit factor each plan
 * pays, and the privacy route factors.
 */
export function rateCardExtras(card: CreditRateCard = CREDIT_RATE_CARD) {
  return {
    selfHosted: selfHostedRateCard(card),
    aiCreditFactorByPlan: Object.fromEntries(SERVICE_PLANS.map((plan) => [plan.id, aiBonusNeutralFactor(plan.id)])) as Record<PlanId, number>,
    routeFactorPercent: ROUTE_FACTOR_PERCENT,
  };
}

type PriceableAiEvent = {
  costCents: number;
  provider?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  metadata?: Record<string, unknown> | null;
};

export type AiPricingContext = {
  /** Plan of the org being billed; bonus plans pay the plan-neutral AI factor. */
  planId?: string | null;
};

function selfHostedBilling(event: PriceableAiEvent): { capability: HostedEquivalentCapability; listCredits: number; billedCredits: number } | null {
  if (event.provider !== PRIVATE_MODEL_PROVIDER) return null;
  const capability = event.metadata?.capability;
  if (!isHostedEquivalentCapability(capability)) return null;
  const inputTokens = nonNegative(event.inputTokens ?? 0);
  const outputTokens = nonNegative(event.outputTokens ?? 0);
  if (inputTokens + outputTokens <= 0) return null;
  const listCredits = hostedEquivalentListCredits({ capability, inputTokens, outputTokens });
  return { capability, listCredits, billedCredits: selfHostedBilledCredits(listCredits) };
}

/**
 * Price an AI receipt, preserving provider cost for audit. Hosted calls are
 * provider list plus markup. Calls served by our own models (private
 * endpoints) are the hosted-equivalent list price less the self-hosted
 * discount. Bonus plans pay the plan-neutral factor and privacy routes their
 * factor. Repricing an adopted/retried receipt uses its original provider cost
 * and its tokens, so the markup is never compounded. Compute/storage events
 * use their own rates.
 */
export function priceAiUsageEvent<T extends PriceableAiEvent>(event: T, context: AiPricingContext = {}): T {
  const storedProviderCost = event.metadata?.providerCostCents;
  const providerCostCents = typeof storedProviderCost === "number" && Number.isFinite(storedProviderCost) && storedProviderCost >= 0
    ? storedProviderCost
    : event.costCents;
  const selfHosted = selfHostedBilling(event);
  if (!selfHosted && !(providerCostCents > 0)) return event;
  const planFactor = aiBonusNeutralFactor(context.planId);
  const routeFactor = routeFactorPercent(event.metadata);
  const listCredits = selfHosted ? selfHosted.listCredits : providerCostCents * (1 + CREDIT_RATE_CARD.aiMarkupPercent / 100);
  const baseCredits = selfHosted ? selfHosted.billedCredits : listCredits;
  const multiplier = planFactor * (1 + routeFactor / 100);
  return {
    ...event,
    costCents: event.metadata?.billable === false ? 0 : baseCredits * multiplier,
    metadata: {
      ...event.metadata,
      providerCostCents: Math.max(0, providerCostCents),
      aiMarkupPercent: CREDIT_RATE_CARD.aiMarkupPercent,
      creditRateCard: CREDIT_RATE_CARD.version,
      ...(planFactor !== 1 ? { aiPlanCreditFactor: planFactor } : {}),
      ...(routeFactor > 0 ? { routeFactorPercent: routeFactor } : {}),
      ...(selfHosted
        ? {
            selfHosted: {
              capability: selfHosted.capability,
              discountPercent: SELF_HOSTED_DISCOUNT_PERCENT,
              referenceModel: HOSTED_EQUIVALENT_REFERENCES[selfHosted.capability].model,
              hostedEquivalentListCents: selfHosted.listCredits * multiplier,
            },
          }
        : {}),
    },
  };
}

/**
 * Share of a plan's included storage that may cover index storage. Index GB
 * cost ~15x object GB, so an uncapped allowance lets a Platinum org hold
 * $350/month of index for its $500 minimum.
 */
export const INCLUDED_INDEX_STORAGE_SHARE = 0.05;

/**
 * Storage credits for one day. Included storage is subtracted from object
 * storage first (the larger, cheaper pool), then from index storage, which
 * can use at most INCLUDED_INDEX_STORAGE_SHARE of the allowance.
 */
export function dailyStorageCredits(args: {
  objectBytes: number;
  indexBytes: number;
  includedGb: number;
  card?: CreditRateCard;
}): { objectCredits: number; indexCredits: number; totalCredits: number; billableObjectGb: number; billableIndexGb: number } {
  const card = args.card ?? CREDIT_RATE_CARD;
  const objectGb = nonNegative(args.objectBytes) / BYTES_PER_GB;
  const indexGb = nonNegative(args.indexBytes) / BYTES_PER_GB;
  let included = nonNegative(args.includedGb);
  const billableObjectGb = Math.max(0, objectGb - included);
  included = Math.min(
    Math.max(0, included - objectGb),
    nonNegative(args.includedGb) * INCLUDED_INDEX_STORAGE_SHARE,
  );
  const billableIndexGb = Math.max(0, indexGb - included);
  const perDay = HOURS_PER_MONTH / 24;
  const objectCredits = (billableObjectGb * card.objectStorageGbMonth) / perDay;
  const indexCredits = (billableIndexGb * card.indexStorageGbMonth) / perDay;
  return { objectCredits, indexCredits, totalCredits: objectCredits + indexCredits, billableObjectGb, billableIndexGb };
}

// ---------------------------------------------------------------------------
// Ingest estimator
//
// Planning model, not a quote. Per-page resource figures are engineering
// assumptions anchored to internal measurements (text-layer parsing, CPU
// layout analysis, ~160 pages/min OCR on one 24 GB GPU, ~0.3¢/page vision
// models). Real documents vary; observed run metrics are authoritative.
// ---------------------------------------------------------------------------

export const pageClassSchema = z.enum(["text", "complex", "scanned"]);
export type PageClass = z.infer<typeof pageClassSchema>;

export const pipelineProfileIdSchema = z.enum(["fast", "standard", "deep"]);
export type PipelineProfileId = z.infer<typeof pipelineProfileIdSchema>;

export type PageCost = {
  /** Seconds one worker slot is busy with the page. */
  workerSeconds: number;
  vcpu: number;
  memoryGb: number;
  gpuStandardSeconds: number;
  /** 1 when a model on our own GPUs reads the page; priced per page as self-hosted inference, not per GPU-second. */
  selfHostedModelPages: number;
  /** AI provider list cost per page in cents (embeddings, vision, LLM). */
  aiProviderCents: number;
  sourceBytes: number;
  artifactBytes: number;
  indexBytes: number;
};

export type PipelineProfile = {
  id: PipelineProfileId;
  label: string;
  description: string;
  pages: Record<PageClass, PageCost>;
};

const KB = 1024;

export const PIPELINE_PROFILES: Record<PipelineProfileId, PipelineProfile> = {
  fast: {
    id: "fast",
    label: "Fast",
    description: "Text layer and CPU OCR, chunk, embed. Best for born-digital prose.",
    pages: {
      text: { workerSeconds: 0.3, vcpu: 1, memoryGb: 1, gpuStandardSeconds: 0, selfHostedModelPages: 0, aiProviderCents: 0.0012, sourceBytes: 30 * KB, artifactBytes: 24 * KB, indexBytes: 20 * KB },
      complex: { workerSeconds: 0.8, vcpu: 1, memoryGb: 1, gpuStandardSeconds: 0, selfHostedModelPages: 0, aiProviderCents: 0.0015, sourceBytes: 120 * KB, artifactBytes: 40 * KB, indexBytes: 24 * KB },
      scanned: { workerSeconds: 3, vcpu: 1, memoryGb: 2, gpuStandardSeconds: 0, selfHostedModelPages: 0, aiProviderCents: 0.0012, sourceBytes: 250 * KB, artifactBytes: 40 * KB, indexBytes: 20 * KB },
    },
  },
  standard: {
    id: "standard",
    label: "Standard",
    description: "Layout-aware tables and figures, GPU OCR where pages need it, page images.",
    pages: {
      text: { workerSeconds: 0.5, vcpu: 1, memoryGb: 1, gpuStandardSeconds: 0, selfHostedModelPages: 0, aiProviderCents: 0.0012, sourceBytes: 30 * KB, artifactBytes: 64 * KB, indexBytes: 25 * KB },
      complex: { workerSeconds: 4, vcpu: 2, memoryGb: 4, gpuStandardSeconds: 0, selfHostedModelPages: 0, aiProviderCents: 0.0015, sourceBytes: 120 * KB, artifactBytes: 160 * KB, indexBytes: 30 * KB },
      scanned: { workerSeconds: 1.5, vcpu: 1, memoryGb: 2, gpuStandardSeconds: 0.4, selfHostedModelPages: 1, aiProviderCents: 0.0012, sourceBytes: 250 * KB, artifactBytes: 160 * KB, indexBytes: 25 * KB },
    },
  },
  deep: {
    id: "deep",
    label: "Deep",
    description: "Standard plus vision-model reading of figures and scans, summaries and knowledge graph.",
    pages: {
      text: { workerSeconds: 0.8, vcpu: 1, memoryGb: 1, gpuStandardSeconds: 0, selfHostedModelPages: 0, aiProviderCents: 0.04, sourceBytes: 30 * KB, artifactBytes: 72 * KB, indexBytes: 32 * KB },
      complex: { workerSeconds: 6, vcpu: 2, memoryGb: 4, gpuStandardSeconds: 0, selfHostedModelPages: 0, aiProviderCents: 0.35, sourceBytes: 120 * KB, artifactBytes: 180 * KB, indexBytes: 40 * KB },
      scanned: { workerSeconds: 6, vcpu: 1, memoryGb: 2, gpuStandardSeconds: 0.4, selfHostedModelPages: 1, aiProviderCents: 0.35, sourceBytes: 250 * KB, artifactBytes: 180 * KB, indexBytes: 35 * KB },
    },
  },
};

/** Share of ideal parallel speedup actually achieved (scheduling, stragglers). */
export const PARALLEL_EFFICIENCY = 0.85;
/** Fixed per-batch latency: upload, quarantine, index finalization. */
export const FIXED_OVERHEAD_SECONDS = 15;

export type PageMix = Record<PageClass, number>;

export type IngestEstimateInput = {
  pages: number;
  /** Fractions of pages per class; normalized, so any positive weights work. */
  mix: Partial<PageMix>;
  profile?: PipelineProfileId;
  plan: PlanId;
  /** Number of files in the batch. Each run fans out to at most MAX_PAGE_FANOUT_PER_RUN workers. */
  documents?: number;
  card?: CreditRateCard;
};

export type IngestEstimate = {
  pages: number;
  plan: PlanId;
  profile: PipelineProfileId;
  workers: number;
  effectiveParallelism: number;
  workerSeconds: number;
  wallSeconds: number;
  pagesPerMinute: number;
  minutesPer100Pages: number;
  credits: CreditCharge;
  /** Pages read by models on our own GPUs, at the self-hosted price (list is struck through). */
  selfHosted: { pages: number; listCredits: number; billedCredits: number; discountPercent: number };
  pagesPerDollar: number;
  creditsPer1000Pages: number;
  storage: {
    objectBytes: number;
    indexBytes: number;
    /** Monthly storage credits before any plan allowance. */
    monthlyCredits: number;
  };
};

function normalizeMix(mix: Partial<PageMix>): PageMix {
  const text = nonNegative(mix.text);
  const complex = nonNegative(mix.complex);
  const scanned = nonNegative(mix.scanned);
  const total = text + complex + scanned;
  if (total <= 0) return { text: 1, complex: 0, scanned: 0 };
  return { text: text / total, complex: complex / total, scanned: scanned / total };
}

export function estimateIngest(input: IngestEstimateInput): IngestEstimate {
  const card = input.card ?? CREDIT_RATE_CARD;
  const profile = PIPELINE_PROFILES[input.profile ?? "standard"];
  const plan = getPlan(input.plan);
  const pages = Math.max(0, Math.round(nonNegative(input.pages)));
  const documents = Math.max(1, Math.round(nonNegative(input.documents ?? 1)));
  const mix = normalizeMix(input.mix);

  const totals = { workerSeconds: 0, cpuSeconds: 0, memoryGbSeconds: 0, gpuStandardSeconds: 0, selfHostedPages: 0, aiProviderCents: 0, sourceBytes: 0, artifactBytes: 0, indexBytes: 0 };
  let slowestPageSeconds = 0;
  for (const pageClass of pageClassSchema.options) {
    const count = pages * mix[pageClass];
    if (count <= 0) continue;
    const cost = profile.pages[pageClass];
    totals.workerSeconds += count * cost.workerSeconds;
    totals.cpuSeconds += count * cost.workerSeconds * cost.vcpu;
    totals.memoryGbSeconds += count * cost.workerSeconds * cost.memoryGb;
    totals.gpuStandardSeconds += count * cost.gpuStandardSeconds;
    totals.selfHostedPages += count * cost.selfHostedModelPages;
    totals.aiProviderCents += count * cost.aiProviderCents;
    totals.sourceBytes += count * cost.sourceBytes;
    totals.artifactBytes += count * cost.artifactBytes;
    totals.indexBytes += count * cost.indexBytes;
    slowestPageSeconds = Math.max(slowestPageSeconds, cost.workerSeconds);
  }

  const effectiveParallelism = Math.max(1, Math.min(plan.workers, documents * MAX_PAGE_FANOUT_PER_RUN, Math.max(1, pages)));
  const wallSeconds = pages === 0
    ? 0
    : Math.max(slowestPageSeconds, totals.workerSeconds / (effectiveParallelism * PARALLEL_EFFICIENCY)) + FIXED_OVERHEAD_SECONDS;

  const credits = priceResources({
    cpuSeconds: totals.cpuSeconds,
    memoryGbSeconds: totals.memoryGbSeconds,
    selfHostedPages: totals.selfHostedPages,
    aiProviderCents: totals.aiProviderCents,
  }, card);

  const objectBytes = totals.sourceBytes + totals.artifactBytes;
  const monthlyStorageCredits = (objectBytes / BYTES_PER_GB) * card.objectStorageGbMonth
    + (totals.indexBytes / BYTES_PER_GB) * card.indexStorageGbMonth;
  const pagesPerMinute = wallSeconds > 0 ? pages / (wallSeconds / 60) : 0;
  const dollars = creditsToDollars(credits.totalCredits);

  return {
    pages,
    plan: plan.id,
    profile: profile.id,
    workers: plan.workers,
    effectiveParallelism,
    workerSeconds: totals.workerSeconds,
    wallSeconds,
    pagesPerMinute,
    minutesPer100Pages: pagesPerMinute > 0 ? 100 / pagesPerMinute : 0,
    credits,
    selfHosted: {
      pages: totals.selfHostedPages,
      listCredits: credits.selfHostedListCredits,
      billedCredits: credits.breakdown.selfHosted,
      discountPercent: SELF_HOSTED_DISCOUNT_PERCENT,
    },
    pagesPerDollar: dollars > 0 ? pages / dollars : 0,
    creditsPer1000Pages: pages > 0 ? (credits.totalCredits / pages) * 1000 : 0,
    storage: { objectBytes, indexBytes: totals.indexBytes, monthlyCredits: monthlyStorageCredits },
  };
}

export type ExampleCorpus = {
  id: string;
  title: string;
  detail: string;
  pages: number;
  documents: number;
  mix: PageMix;
};

/** Reference inputs for pricing pages. Page counts are typical print editions. */
export const EXAMPLE_CORPORA: readonly ExampleCorpus[] = [
  { id: "annual-report", title: "A 10-K annual report", detail: "~120 pages, a third of them financial tables", pages: 120, documents: 1, mix: { text: 0.65, complex: 0.35, scanned: 0 } },
  { id: "moby-dick", title: "Moby-Dick", detail: "~210k words, ~625 pages of prose", pages: 625, documents: 1, mix: { text: 1, complex: 0, scanned: 0 } },
  { id: "textbook", title: "A 1,000-page textbook", detail: "Figures, tables, equations, a few scanned plates", pages: 1_000, documents: 1, mix: { text: 0.6, complex: 0.3, scanned: 0.1 } },
  { id: "war-and-peace", title: "War and Peace", detail: "~587k words, ~1,300 pages of prose", pages: 1_300, documents: 1, mix: { text: 1, complex: 0, scanned: 0 } },
  { id: "proust", title: "In Search of Lost Time", detail: "All seven volumes, ~4,200 pages", pages: 4_200, documents: 7, mix: { text: 1, complex: 0, scanned: 0 } },
  { id: "archive", title: "A scanned case archive", detail: "100,000 pages across 2,000 files, mostly scans", pages: 100_000, documents: 2_000, mix: { text: 0.1, complex: 0.2, scanned: 0.7 } },
];

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export const subscriptionStatusValueSchema = z.enum([
  "none",
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
]);
export type SubscriptionStatusValue = z.infer<typeof subscriptionStatusValueSchema>;

export const autoRechargeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** Recharge when available credits fall below this. */
    thresholdCredits: z.number().int().min(100).max(1_000_000),
    /** Amount charged per recharge. */
    amountCents: z.number().int().min(MIN_TOPUP_CENTS).max(MAX_TOPUP_CENTS),
    /** Hard ceiling on auto-recharge spend per calendar month. */
    monthlyLimitCents: z.number().int().min(MIN_TOPUP_CENTS).max(10_000_000),
  })
  .refine((value) => value.monthlyLimitCents >= value.amountCents, {
    message: "Monthly limit must be at least one recharge amount",
    path: ["monthlyLimitCents"],
  });
export type AutoRechargeSettings = z.infer<typeof autoRechargeSettingsSchema>;

export const billingOverviewSchema = z.object({
  orgId: z.string(),
  /** Archived (retained) document versions still holding files; `monthlyCredits` is null when billing is not enforced. */
  retainedVersionStorage: z.object({
    bytes: z.number().nonnegative(),
    pages: z.number().nonnegative(),
    monthlyCredits: z.number().nonnegative().nullable(),
    /** False on self-hosted deployments: retention settings apply on every plan. */
    billingEnforced: z.boolean().optional(),
  }).optional(),
  plan: planIdSchema,
  subscriptionStatus: subscriptionStatusValueSchema,
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  /** Pending plan change scheduled for the period end, if any. */
  scheduledPlan: planIdSchema.nullable(),
  credits: z.object({
    includedRemaining: z.number(),
    includedGranted: z.number(),
    /** Purchased + starter + promotional; may be negative after overrun. */
    prepaid: z.number(),
    /**
     * Usage recorded but not yet applied to the pools (applied within seconds).
     * includedRemaining and prepaid already have it subtracted.
     */
    pending: z.number().default(0),
    /** Included + prepaid − pending: the real balance, never minus holds. May be negative. */
    available: z.number(),
    /**
     * Credits kept for chat and search: uploads and automation stop once the
     * balance reaches this (chat-reserve.ts).
     */
    chatReserve: z.number().default(0),
    /** How far below zero chat and search may take the balance (0: not at all). */
    chatOverdraft: z.number().default(0),
  }),
  workers: z.object({
    limit: z.number().int(),
    inUse: z.number().int(),
  }),
  storage: z.object({
    /** Source bytes (measured) plus derived artifacts estimated from page counts. */
    objectBytes: z.number(),
    /** Estimated from page counts; there is no measured index size yet. */
    indexBytes: z.number(),
    /** Measured source-file bytes, the exact part of objectBytes. */
    sourceBytes: z.number().optional(),
    /** True while objectBytes/indexBytes include per-page planning estimates. */
    estimated: z.boolean().optional(),
    includedGb: z.number(),
    projectedMonthlyCredits: z.number(),
  }),
  spendThisPeriod: z.object({
    compute: z.number(),
    ai: z.number(),
    storage: z.number(),
    other: z.number(),
    total: z.number(),
  }),
  autoRecharge: autoRechargeSettingsSchema.nullable(),
  monthlyBudgetCredits: z.number().nullable(),
  stripeConfigured: z.boolean(),
  hasPaymentMethod: z.boolean(),
});
export type BillingOverview = z.infer<typeof billingOverviewSchema>;

export const creditLedgerEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  deltaCredits: z.number(),
  reason: z.string(),
  pool: z.enum(["included", "prepaid"]).nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type CreditLedgerEntry = z.infer<typeof creditLedgerEntrySchema>;

export const usageBreakdownSchema = z.object({
  orgId: z.string(),
  lastHour: z.object({ tokens: z.number().int().nonnegative(), costCents: z.number().nonnegative(), eventCount: z.number().int().nonnegative() }),
  last24h: z.object({ tokens: z.number().int().nonnegative(), costCents: z.number().nonnegative(), eventCount: z.number().int().nonnegative() }),
  currentMonth: z.object({ tokens: z.number().int().nonnegative(), costCents: z.number().nonnegative(), eventCount: z.number().int().nonnegative() }),
  dailyBreakdown: z.array(z.object({ date: z.string(), tokens: z.number().int().nonnegative(), costCents: z.number().nonnegative(), eventCount: z.number().int().nonnegative() })),
});
export type UsageBreakdown = z.infer<typeof usageBreakdownSchema>;

export const ingestJobCostSchema = z.object({
  runId: z.string(),
  documentId: z.string().nullable().default(null),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costCents: z.number().nonnegative(),
  model: z.string(),
  provider: z.string(),
  stage: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type IngestJobCost = z.infer<typeof ingestJobCostSchema>;

/**
 * House organizations whose spend is never blocked for lack of credits (our
 * own docs site search and indexing keys). Usage is still metered, debited and
 * reported; only the credit gate is skipped. Workspace and org budget caps
 * still apply. Comma-separated org ids in BILLING_EXEMPT_ORG_IDS.
 */
export function billingExemptOrgIds(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  return new Set((env.BILLING_EXEMPT_ORG_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

export function isBillingExemptOrg(orgId: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(orgId) && billingExemptOrgIds(env).has(orgId!);
}
