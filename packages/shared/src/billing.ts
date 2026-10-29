import { z } from "zod";

import { PRIVATE_MODEL_PROVIDER } from "./private-endpoints.js";
import { qualityModeSchema, type QualityMode } from "./quality.js";

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
// Price card (spec: performance/pricing-2026-10-21/spec.md in DocSlurp/app)
//
// Customers buy prepaid credit packs and pay per unit: a page (Fast or Rich),
// a GB-month of storage, a search, a chat answer. Every billable usage event
// is built from these numbers (`unitChargeMetadata`); provider tokens and
// compute are recorded for our own cost reports but never debit credits.
// Credits do not expire while the account exists.
// ---------------------------------------------------------------------------

/*
 * Calibration (SigNoz production traces 2026-10-13..22):
 * - Rich pages (Gemini 3.1 Flash Lite vision): 1,149 input tokens; output p50 884 /
 *   p95 1,759 / p99 2,035 tokens. Break-even at 250 credits/1k is ~1,390 output
 *   tokens, so each 1,000 output tokens beyond the first 1,000 count as one more
 *   Rich page (rounded up).
 * - Chat cost per answer, mean / p90 USD: glm-5.3-flash .0043/.0092, mercury-3
 *   .0064/.018, lfm-2.5-24b .0037/.010, claude-haiku-5.5 .0091/.011, mimo-v2.6-flash
 *   .0086/.023, minimax-m3.1-flash:free 0, deepseek-v4.1-flash .0177/.042,
 *   beam-1.0-501b .0349/.085, gpt-6.1-sol .067/.163, qwen3.8-max-prime .287/.602.
 *   p95 tokens per answer run 130k-580k, so the 100k token-block multiplier stays.
 * - Standard answers 2.5 -> 1.5 credits (owner decision 2026-10-25), with chat
 *   cost cuts shipped alongside: each evidence passage sent to the model once
 *   (OSS #161), rarely used tools removed, a 4-step dynamic step budget and
 *   prompt caching. Standard-model means above (.0037-.0095) leave 1.6-4x at
 *   1.5 credits before those cuts; recheck per-model means after deploy.
 *   mercury-3 and mimo-v2.6-flash (p90 .018/.023, above 1.5 credits; eval-only,
 *   not in WORKSPACE_CHAT_MODELS) move to advanced.
 * - Standard answers 1.5 -> 1 credit (owner decision 2026-10-25), after the cuts.
 *   Measured on production /v1/chat (88 turns per model, 2026-10-25), p50 / p90
 *   USD per answer: glm-5.3-flash .0022/.0041, claude-haiku-5.5 .0024/.0039,
 *   gpt-6-luna .0019/.0039 (deepseek-v4.1-flash .0065/.0139 stays advanced),
 *   leaving ~60% margin at p90 for every standard catalog model. lfm-2.5-24b
 *   (eval-only, pre-cut p90 .010, at the new price) moves to advanced.
 *
 * No per-file minimum (owner decision 2026-10-21): a file pays only for its
 * pages, fractional credits included. Our per-document overhead (queue,
 * workflow, object writes; ~$0.0005 typical, cost-basis.md section 6) is
 * absorbed, so workloads of very small files (1-10 Fast pages each) run below
 * cost. The fix for those is batching small files, not a fee.
 */
export const PRICE_CARD = {
  /** Text-layer PDF, Office, HTML, Markdown, EPUB, text. */
  fastPer1kPages: 5,
  /** Scanned, image, or complex layout read by a vision/OCR model. */
  richPer1kPages: 250,
  /** One audio minute counts as this many Rich pages. */
  audioMinuteRichPages: 1,
  /** One video minute counts as this many Rich pages. */
  videoMinuteRichPages: 3,
  /** Originals, page images and indexes. */
  storageGbMonth: 25,
  searchPer1k: 10,
  /** Credits per chat answer by model tier (CHAT_MODEL_TIERS). */
  chatAnswerTiers: { standard: 1, advanced: 7.5, premium: 50 },
  /** Vision output tokens one Rich page includes. */
  richIncludedOutputTokens: 1_000,
  /** Each further block of this many output tokens counts as one more Rich page (rounded up). */
  richExtraPageOutputTokens: 1_000,
  /** A search that runs LLM query strategies counts as this many searches. */
  llmSearchMultiplier: 10,
  /** A chat answer counts once more per this many total tokens beyond the first block. */
  chatAnswerTokenBlock: 100_000,
  /** Optional per-document features (DOCUMENT_FEATURES), charged once per document when the stage runs. */
  documentSummary: 0.5,
  structuredFieldsPer10Pages: 1,
  knowledgeGraphPer10Pages: 1.5,
  /** Provisional: no production measurements yet. */
  propositionsPer10Pages: 1,
  /** One web search (fast, snippets only). Provider cost $0.0005-0.008 (docs/research/web-providers-2026-10.md). */
  webSearch: 1,
  /** A deep web search, or one that returns page content, counts as this many web searches. Provider cost up to $0.017. */
  webSearchDeepMultiplier: 2,
  /** One web page read to Markdown (fetch or crawl). Provider cost $0.00025-0.0024 per page. */
  webPage: 0.25,
  /** One site map: 1 credit per started block of this many discovered URLs. */
  webMapUrlsPerCredit: 50,
} as const;
export type PriceCard = typeof PRICE_CARD;

/*
 * Optional per-document features (Langfuse events_full 2026-10, last 30 days,
 * tokens x live OpenRouter prices: qwen/qwen3.5-flash-02-23 $0.065/$0.26 per M,
 * gemini-3.1-flash-lite $0.25/$1.50 per M):
 * - document summary: 1 call per document, avg 4,664 in (p90 17,650) / 498 out
 *   -> $0.0004 (qwen) to $0.0019 (gemini) per document. Price 0.5 credit.
 * - knowledge graph extraction: ~19 calls per document (571 calls / 30 traces),
 *   avg 2,831 in / 1,597 out per call -> ~$0.0006 (qwen) to $0.0031 (gemini) per
 *   call; community summaries are tiny (244 in / 220 out). Price 1.5 credits per
 *   started 10 pages.
 * - structured extraction: 1 sample, 505 in / 246 out on gemini (~$0.0005); it
 *   scales with document length. Price 1 credit per started 10 pages.
 * - propositions: no data; 1 credit per started 10 pages is provisional.
 * - contextual chunk preambles are required and already inside the Fast price.
 */
export const DOCUMENT_FEATURES = ["documentSummary", "structuredFields", "knowledgeGraph", "propositions"] as const;
export type DocumentFeature = (typeof DOCUMENT_FEATURES)[number];

/**
 * Credits for one optional feature over one document of `pages` pages (media
 * files pass their Rich-equivalent pages, i.e. minutes x factor). A summary is
 * a flat price per document; the others are priced per started 10 pages, at
 * least one block.
 */
export function featureCredits(feature: DocumentFeature, pages: number): number {
  if (feature === "documentSummary") return PRICE_CARD.documentSummary;
  const blocks = Math.max(1, Math.ceil(Math.max(0, Number.isFinite(pages) ? pages : 0) / 10));
  const per10 = feature === "structuredFields" ? PRICE_CARD.structuredFieldsPer10Pages
    : feature === "knowledgeGraph" ? PRICE_CARD.knowledgeGraphPer10Pages
    : PRICE_CARD.propositionsPer10Pages;
  return per10 * blocks;
}

/** Stamped on billable events so a receipt says which price card charged it. */
export const PRICE_CARD_VERSION = "2026-10-25b";

/** Per dedicated machine, sold by sales, not self-serve. */
export const PRIVATE_DEDICATED_MONTHLY_USD = 2_000;

/** Self-serve credit packs: $25 / $50 / $100. */
export const CREDIT_PACK_CENTS = [2_500, 5_000, 10_000] as const;
/** $10: card fees make smaller top-ups uneconomic. */
export const MIN_TOPUP_CENTS = 1_000;
/** $10,000. */
export const MAX_TOPUP_CENTS = 1_000_000;
/** One-time, no card. */
export const STARTER_CREDITS = 250;

/**
 * Org-wide concurrent worker ceiling. "Funded" = the org has ever received a
 * paid grant (top-up, auto top-up, adjustment, promo); starter-only orgs are
 * "starter". Above the funded ceiling is Enterprise.
 */
export const STARTER_WORKER_SLOTS = 50;
export const FUNDED_WORKER_SLOTS = 250;

/** Grant sources that make an org funded (credit_grants.source). `starter` never does. */
export const FUNDED_GRANT_SOURCES = ["topup", "auto_recharge", "adjustment", "promo"] as const;

export function workerSlotsFor(funded: boolean): number {
  return funded ? FUNDED_WORKER_SLOTS : STARTER_WORKER_SLOTS;
}

export type PageMode = "fast" | "rich";

const BYTES_PER_GB = 1024 ** 3;

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

/** Credits for `pages` pages in `mode` (fractional; balances keep fractions). */
export function pageCredits(mode: PageMode, pages: number): number {
  const per1k = mode === "rich" ? PRICE_CARD.richPer1kPages : PRICE_CARD.fastPer1kPages;
  return (nonNegative(pages) * per1k) / 1_000;
}

/**
 * Rich pages one vision/OCR read of a page counts as: 1, plus one more per
 * started `richExtraPageOutputTokens` beyond `richIncludedOutputTokens`
 * (1,000 tokens: 1; 1,001-2,000: 2; 2,500: 3). Unknown token counts count as 1.
 */
export function richPagesForOutputTokens(outputTokens: number | null | undefined): number {
  const extra = nonNegative(outputTokens ?? 0) - PRICE_CARD.richIncludedOutputTokens;
  return 1 + (extra > 0 ? Math.ceil(extra / PRICE_CARD.richExtraPageOutputTokens) : 0);
}

/** Monthly storage credits for `bytes` stored (object + index). No included GB. */
export function storageCreditsPerMonth(bytes: number): number {
  return (nonNegative(bytes) / BYTES_PER_GB) * PRICE_CARD.storageGbMonth;
}

/** Storage credits for one day of a month with `daysInMonth` days (the daily meter). */
export function dailyStorageCredits(bytes: number, daysInMonth: number): number {
  const days = Number.isFinite(daysInMonth) && daysInMonth > 0 ? daysInMonth : 30;
  return storageCreditsPerMonth(bytes) / days;
}

/** Days in the UTC month containing `day` (YYYY-MM-DD or Date). */
export function daysInUtcMonth(day: string | Date): number {
  const date = typeof day === "string" ? new Date(`${day.slice(0, 10)}T00:00:00Z`) : day;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Credits for `searches` searches; LLM query strategies count each as `llmSearchMultiplier`. */
export function searchCredits(searches: number, opts: { llmStrategies?: boolean } = {}): number {
  const multiplier = opts.llmStrategies ? PRICE_CARD.llmSearchMultiplier : 1;
  return (nonNegative(searches) * multiplier * PRICE_CARD.searchPer1k) / 1_000;
}

/** Credits for one web search; deep or content-returning searches count `webSearchDeepMultiplier` times. */
export function webSearchCredits(opts: { deep?: boolean; includeContent?: boolean } = {}): number {
  return PRICE_CARD.webSearch * (opts.deep || opts.includeContent ? PRICE_CARD.webSearchDeepMultiplier : 1);
}

/** Credits for web pages read to Markdown (fetched or crawled). */
export function webPageCredits(pages: number): number {
  return nonNegative(pages) * PRICE_CARD.webPage;
}

/** Credits for one site map that discovered `urls` URLs (at least one block). */
export function webMapCredits(urls: number): number {
  return Math.max(1, Math.ceil(nonNegative(urls) / PRICE_CARD.webMapUrlsPerCredit));
}

/** Chat answers one turn counts as: 1, plus one per extra `chatAnswerTokenBlock` total tokens. */
export function chatAnswerUnits(totalTokens?: number | null): number {
  return Math.max(1, Math.ceil(nonNegative(totalTokens ?? 0) / PRICE_CARD.chatAnswerTokenBlock));
}

export type ChatAnswerTier = keyof PriceCard["chatAnswerTiers"];

/**
 * Chat model -> answer tier, keyed by model name without the provider prefix.
 * Entries ending in `*` match by prefix (dated snapshots). Unmapped models are
 * premium, so a newly added expensive model is never sold below cost.
 */
export const CHAT_MODEL_TIERS: Readonly<Record<string, ChatAnswerTier>> = {
  "glm-5.3-flash": "standard",
  "mercury-3": "advanced",
  "lfm-2.5-24b-a2b": "advanced",
  "claude-haiku-5.5": "standard",
  "gpt-6-luna": "standard",
  "mimo-v2.6-flash": "advanced",
  "minimax-m3.1-flash:free": "standard",
  "deepseek-v4.1-flash*": "advanced",
  "beam-1.0-501b-a23b": "advanced",
  "gpt-6.1-sol": "premium",
  "qwen3.8-max-prime": "premium",
};

/** Tier of a chat model id (`provider/model`, bare `model`, or a `workspace:` alias resolved by the caller). */
export function chatModelTier(model: string | null | undefined): ChatAnswerTier {
  const raw = (model ?? "").trim().toLowerCase();
  if (!raw) return "premium";
  const bare = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const exact = CHAT_MODEL_TIERS[bare];
  if (exact) return exact;
  for (const [key, tier] of Object.entries(CHAT_MODEL_TIERS)) {
    if (key.endsWith("*") && bare.startsWith(key.slice(0, -1))) return tier;
  }
  return "premium";
}

/** Credits for one delivered chat answer: the model tier's price x token blocks (min 1). */
export function chatAnswerCredits(opts: { model?: string | null; tier?: ChatAnswerTier; totalTokens?: number | null } = {}): number {
  const tier = opts.tier ?? chatModelTier(opts.model);
  return PRICE_CARD.chatAnswerTiers[tier] * chatAnswerUnits(opts.totalTokens);
}

/** Rich pages a media file counts as: its duration rounded up to whole minutes, times the kind's factor. */
export function mediaRichPages(kind: "audio" | "video", seconds: number): number {
  const minutes = Math.ceil(nonNegative(seconds) / 60);
  return minutes * (kind === "video" ? PRICE_CARD.videoMinuteRichPages : PRICE_CARD.audioMinuteRichPages);
}

/**
 * Metric names of the billable unit events. These, and only these, debit
 * customer credits; every other usage event (provider tokens, compute,
 * embeddings) is written with `billable: false` and cost 0.
 */
export const BILLABLE_UNIT_METRICS = {
  fastPage: "ingest-page-fast",
  richPage: "ingest-page-rich",
  mediaMinutes: "ingest-media-minutes",
  storage: "storage-daily",
  search: "search-query",
  chatAnswer: "chat-answer",
  documentSummary: "feature-document-summary",
  structuredFields: "feature-structured-fields",
  knowledgeGraph: "feature-knowledge-graph",
  propositions: "feature-propositions",
  webSearch: "web-search",
  webPage: "web-page",
  webMap: "web-map",
  /** Extended extract retention, prepaid as storage (extract-mode.ts). */
  extractRetention: "storage-extract-retention",
} as const;
export type BillableUnitMetric = (typeof BILLABLE_UNIT_METRICS)[keyof typeof BILLABLE_UNIT_METRICS];

/** The unit metric each optional document feature is charged under. */
export const DOCUMENT_FEATURE_METRICS: Readonly<Record<DocumentFeature, BillableUnitMetric>> = {
  documentSummary: BILLABLE_UNIT_METRICS.documentSummary,
  structuredFields: BILLABLE_UNIT_METRICS.structuredFields,
  knowledgeGraph: BILLABLE_UNIT_METRICS.knowledgeGraph,
  propositions: BILLABLE_UNIT_METRICS.propositions,
};

const BILLABLE_UNIT_METRIC_SET: ReadonlySet<string> = new Set(Object.values(BILLABLE_UNIT_METRICS));

export function isBillableUnitMetric(metric: string | null | undefined): metric is BillableUnitMetric {
  return typeof metric === "string" && BILLABLE_UNIT_METRIC_SET.has(metric);
}

/** Provider recorded on billable unit events. */
export const UNIT_CHARGE_PROVIDER = "docslurp";

/** Metadata every billable unit event carries. */
export function unitChargeMetadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, billable: true, unitCharge: true, priceCard: PRICE_CARD_VERSION };
}

/** Whether an event is a billable unit charge (as opposed to an internal cost event). */
export function isUnitChargeEvent(event: { metric?: string | null; metadata?: Record<string, unknown> | null }): boolean {
  return event.metadata?.unitCharge === true && isBillableUnitMetric(event.metric);
}

/** Monthly forecast shown on the billing page; every input is something the user can see. */
export type BillingForecast = {
  storageBytes: number;
  storageCreditsPerMonth: number;
  searchesLast30d: number;
  searchCreditsPer30d: number;
  chatAnswersLast30d: number;
  chatCreditsPer30d: number;
  fastPagesLast30d: number;
  richPagesLast30d: number;
  ingestCreditsLast30d: number;
  /** storage + searches + chat at last-30-day pace; ingest shown separately because it is lumpy. */
  recurringCreditsPerMonth: number;
  /** Days until balance reaches 0 at recurring pace (null when recurring is 0). Ignores auto top-up. */
  daysUntilEmpty: number | null;
};

/**
 * Build the forecast from what the billing page shows: stored bytes, and the
 * credits and units the last 30 days actually charged (read through
 * usage attribution, so search and chat multipliers are already included).
 */
export function buildBillingForecast(input: {
  balanceCredits: number;
  storageBytes: number;
  searchesLast30d: number;
  searchCreditsLast30d: number;
  chatAnswersLast30d: number;
  chatCreditsLast30d: number;
  fastPagesLast30d: number;
  richPagesLast30d: number;
  ingestCreditsLast30d: number;
}): BillingForecast {
  const storageMonthly = storageCreditsPerMonth(input.storageBytes);
  const searchCreditsPer30d = nonNegative(input.searchCreditsLast30d);
  const chatCreditsPer30d = nonNegative(input.chatCreditsLast30d);
  const recurring = storageMonthly + searchCreditsPer30d + chatCreditsPer30d;
  const daysUntilEmpty = recurring > 0
    ? Math.max(0, Math.floor((Math.max(0, input.balanceCredits) / recurring) * 30))
    : null;
  return {
    storageBytes: nonNegative(input.storageBytes),
    storageCreditsPerMonth: storageMonthly,
    searchesLast30d: nonNegative(input.searchesLast30d),
    searchCreditsPer30d,
    chatAnswersLast30d: nonNegative(input.chatAnswersLast30d),
    chatCreditsPer30d,
    fastPagesLast30d: nonNegative(input.fastPagesLast30d),
    richPagesLast30d: nonNegative(input.richPagesLast30d),
    ingestCreditsLast30d: nonNegative(input.ingestCreditsLast30d),
    recurringCreditsPerMonth: recurring,
    daysUntilEmpty,
  };
}

/** Public price list (`GET /v1/billing/prices`). */
export function billingPrices() {
  return {
    priceCard: PRICE_CARD,
    priceCardVersion: PRICE_CARD_VERSION,
    packsCents: [...CREDIT_PACK_CENTS],
    minTopUpCents: MIN_TOPUP_CENTS,
    maxTopUpCents: MAX_TOPUP_CENTS,
    starterCredits: STARTER_CREDITS,
    privateDedicatedMonthlyUsd: PRIVATE_DEDICATED_MONTHLY_USD,
    workerSlots: { starter: STARTER_WORKER_SLOTS, funded: FUNDED_WORKER_SLOTS },
    /** Model (without provider prefix; `*` = prefix match) -> tier; unmapped models are premium. */
    chatModelTiers: { ...CHAT_MODEL_TIERS },
  };
}
export type BillingPrices = ReturnType<typeof billingPrices>;

/** Hard ceiling on page tasks one run fans out to, whatever the org ceiling allows. */
export const MAX_PAGE_FANOUT_PER_RUN = 128;

// ---------------------------------------------------------------------------
// Internal cost reference (NOT a customer price)
//
// Customers pay PRICE_CARD units only. The resource rates below remain as our
// internal cost model: compute and AI usage events are still recorded (and
// priced here for internal cost reports and capacity planning), but they are
// written non-billable, so they never debit customer credits. Public copy
// never names CPU, memory, GPU or machine classes.
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
 * Internal resource cost reference. Every line must satisfy RESOURCE_CLASS_POLICY
 * (infra-costs.ts) against the latest infra observations.
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

const SECONDS_PER_HOUR = 3_600;
const HOURS_PER_MONTH = 730;

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
// Self-hosted inference (internal cost reference)
//
// Kept for internal cost reports of private endpoints; customers pay
// PRICE_CARD units whichever model read a page.
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
  text: { capability: "text", model: "z-ai/glm-5.3-flash", provider: "openrouter", inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.5, checkedAt: "2026-10-25" },
  vision: { capability: "vision", model: "z-ai/glm-5.3-flash", provider: "openrouter", inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.5, checkedAt: "2026-10-25" },
  embedding: { capability: "embedding", model: "openai/text-embedding-3-small", provider: "openai", inputUsdPerMTok: 0.02, outputUsdPerMTok: 0, checkedAt: "2026-10-25" },
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


// ---------------------------------------------------------------------------
// Internal cost events
// ---------------------------------------------------------------------------

type PriceableAiEvent = {
  metric?: string | null;
  costCents: number;
  provider?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Turn an AI receipt into an internal cost event. Provider cost is preserved
 * (`metadata.providerCostCents`) for our own cost reports and the `[ai-usage]`
 * line; the customer debit is 0 (`billable: false`), because customers pay
 * PRICE_CARD units (pages, searches, chat answers) instead. Billable unit
 * events (`unitChargeMetadata`) pass through unchanged. Idempotent: repricing
 * keeps the original provider cost.
 */
export function priceAiUsageEvent<T extends PriceableAiEvent>(event: T): T {
  if (isUnitChargeEvent(event)) return event;
  const storedProviderCost = event.metadata?.providerCostCents;
  const providerCostCents = typeof storedProviderCost === "number" && Number.isFinite(storedProviderCost) && storedProviderCost >= 0
    ? storedProviderCost
    : Math.max(0, Number(event.costCents) || 0);
  return {
    ...event,
    costCents: 0,
    metadata: {
      ...event.metadata,
      providerCostCents,
      billable: false,
      costRole: "provider",
    },
  };
}

// ---------------------------------------------------------------------------
// Ingest estimator
//
// Planning model, not a quote. Prices come from PRICE_CARD (Fast vs Rich page
// mix, media minutes); timing from per-page worker-second
// assumptions anchored to internal measurements. Observed runs are
// authoritative.
// ---------------------------------------------------------------------------

export const pageClassSchema = z.enum(["text", "complex", "scanned"]);
export type PageClass = z.infer<typeof pageClassSchema>;

/** Estimator profiles are the processing quality modes (`pipeline.quality`). */
export const pipelineProfileIdSchema = qualityModeSchema;
export type PipelineProfileId = QualityMode;

export type QualityModeInfo = {
  id: QualityMode;
  label: string;
  /** One line for the picker. */
  description: string;
  /** What the price depends on, for a tooltip or footnote. */
  priceNote: string;
  /** Credits per 1,000 pages, from PRICE_CARD; min === max for a flat price. */
  creditsPer1kPages: { min: number; max: number };
};

/**
 * The public processing quality choice. Prices come from PRICE_CARD: Fast never reads a page with OCR or a model
 * (scans are kept as page images), so it is Fast-priced throughout; Auto bills each page by how it was read; Good
 * reads every page with a vision model (Rich, plus the extra-output-token rule, richPagesForOutputTokens).
 */
export const QUALITY_MODES: Record<QualityMode, QualityModeInfo> = {
  fast: {
    id: "fast",
    label: "Fast",
    description: "Text layer only. Scanned pages are kept as images, not read.",
    priceNote: "Every page bills Fast. Pages without a text layer are stored as page images and are not searchable.",
    creditsPer1kPages: { min: PRICE_CARD.fastPer1kPages, max: PRICE_CARD.fastPer1kPages },
  },
  auto: {
    id: "auto",
    label: "Auto",
    description: "Reads each page the cheapest faithful way: text layer, or a vision model for scans and complex layouts.",
    priceNote: "Text pages bill Fast; scanned and complex pages read by a model bill Rich, so the price depends on the mix.",
    creditsPer1kPages: { min: PRICE_CARD.fastPer1kPages, max: PRICE_CARD.richPer1kPages },
  },
  good: {
    id: "good",
    label: "Good",
    description: "A vision model reads every page for the most faithful tables, figures and layout.",
    priceNote: `Every page a vision model reads bills Rich, and a page whose output exceeds ${PRICE_CARD.richIncludedOutputTokens.toLocaleString("en-US")} tokens counts as extra Rich pages. A run cost cap can stop vision early; pages it did not read bill as in Auto.`,
    creditsPer1kPages: { min: PRICE_CARD.richPer1kPages, max: PRICE_CARD.richPer1kPages },
  },
};

export const QUALITY_MODE_ORDER: readonly QualityMode[] = qualityModeSchema.options;

const formatUsdPer1k = (credits: number): string => {
  const dollars = creditsToDollars(credits);
  return `$${dollars.toFixed(2)}`;
};

/** "$0.05", "$0.05 to $2.50" or "$2.50" per 1,000 pages for a quality mode. */
export function qualityModePriceRange(mode: QualityMode): string {
  const { min, max } = QUALITY_MODES[mode].creditsPer1kPages;
  return min === max ? formatUsdPer1k(min) : `${formatUsdPer1k(min)} to ${formatUsdPer1k(max)}`;
}

export type PageCost = {
  /** Seconds one worker slot is busy with the page. */
  workerSeconds: number;
  /** How the page is billed in this profile. */
  mode: PageMode;
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

/**
 * Deployment assumptions behind the per-page `workerSeconds` below: seconds one
 * worker slot is held by a page task. Every field is a named parameter with its
 * provenance; none is baked into a profile constant, so a fleet change means
 * editing this object (and re-measuring), not hunting through the profiles.
 * `WORKER_SLOT` (infra-costs.ts) uses the same packing for slot cost; its priced
 * slot shape (1 vCPU + 2 GB) is a separate, billing-side unit.
 */
export const PIPELINE_PROFILE_BASIS = {
  /** Worker slots per machine. Source: fly.worker.toml DOCSLURP_WORKER_SLOTS_PER_MACHINE (shared-cpu-8x / 16 GB), 2026-10-24. */
  slotsPerHost: 2,
  /**
   * Slot tuner. Source: fly.worker.toml WORKER_SLOT_TUNER = resource (min 1, max 2, 5 s ramp), 2026-10-24.
   * Under review: it may become `fixed`. Load tests showed `fixed` and `resource` per-page busy seconds within
   * noise (0.22-0.36 vs 0.14-0.23 text/complex), so the values below hold for both; only throughput differs.
   */
  slotTuner: "resource",
  /** Worker class the figures were measured against (or its closest equivalent). Source: fly.worker.toml DOCSLURP_WORKER_CLASS. */
  workerClass: "shared-cpu-8x-16gb-slot",
  /**
   * Planned floor worker: one shared-cpu-2x / 4 GB machine. NOT measured; fewer vCPUs per slot could raise
   * busy seconds (a 0.5-vCPU-per-slot arm measured 3.4 s per text page). Re-measure before adopting.
   */
  plannedFloorWorkerClass: "shared-cpu-2x-4gb",
  /** Re-measured 2026-10-23/24; see the provenance notes on PIPELINE_PROFILES. */
  measuredAt: "2026-10-24",
} as const;

/*
 * Provenance of `workerSeconds` (re-measured 2026-10-24). Numbers only; no
 * production identifiers.
 *
 * text (fast 0.3 -> 0.2, standard 0.5 -> 0.3), `measured + production`:
 * - Load test, self-hosted stack, standard profile, 65% text / 35% complex mix,
 *   10-page synthetic PDFs, local MiniLM or a zero-CPU hosted-embedder stand-in:
 *   0.22-0.31 busy-s per text page on 1-2 slots, 0.22-0.36 on production-shaped
 *   2-slot workers (fixed and `resource` tuner), 0.18-0.22 with the hosted
 *   embedder stand-in on 8-16 slots.
 * - Production, text-native PDFs with hosted embeddings (fast configuration, no
 *   page images): whole-worker allocation of 0.07 slot-s per page on 4,000-page
 *   files and 0.27 slot-s per page on ~330-page files. These include idle slot
 *   time, so they bound busy time from above.
 * - Not representative, so excluded: oversubscribed runs (16+ slots on 16 CPUs
 *   with local ONNX embedding: 1.4-3 s per page because of intra-op thread spin)
 *   and a CPU-starved 0.5-vCPU arm (3.4 s). Production is moving to one ONNX
 *   intra-op thread per embed worker (DOCSLURP_LOCAL_EMBED_INTRA_OP_THREADS=1).
 * - Standard 0.3 is the top of the production-shaped range rounded up; fast 0.2
 *   drops the page-image stage and sits at the top of the hosted-embedder range.
 *
 * complex (unchanged: fast 0.8, standard 4, deep 6), `unmeasured`:
 * - The load test measured 0.14-0.28 s on synthetic table pages through the
 *   kreuzberg extraction path without any model call, not the native PDF engine
 *   production uses, and with vision off. That is a floor for layout-aware
 *   extraction, not a measurement of it. Production shows a model-read page
 *   (`worker.vision` spans) at p50 4.1 s, p95 32 s, which is the order of
 *   magnitude the standard and deep values assume. Revisit with a real-corpus
 *   run on the native engine.
 *
 * scanned (standard 1.5 -> 4.2; fast 3 and deep 6 unchanged), `production`:
 * - Not exercised by the load test. Production `worker.vision` spans hold a
 *   slot for p50 4.1 s per page, and an earlier vision load test measured 4.28
 *   worker-s per page. A 1.5 s standard scan was below a single vision call and
 *   below the fast profile; 4.2 restores fast <= standard <= deep.
 *
 * deep text (0.8 unchanged): summaries and graph enrichment hold slots while
 * waiting on models (graph-enrich is about a fifth of production stage-seconds)
 * and were not part of the load test.
 *
 * Byte columns (sourceBytes, artifactBytes, indexBytes) are unchanged.
 *
 * 2026-10-29: profiles became the quality modes. standard -> auto (unchanged);
 * deep -> good, where a vision model reads every page, so text pages hold a slot
 * for one vision call (4.2 s, from the scanned figure) and summaries and graph
 * enrichment are no longer assumed; fast scanned pages are kept as page images
 * (render and store only, 1 s, unmeasured) and bill Fast.
 */
export const PIPELINE_PROFILES: Record<PipelineProfileId, PipelineProfile> = {
  fast: {
    id: "fast",
    label: QUALITY_MODES.fast.label,
    description: QUALITY_MODES.fast.description,
    pages: {
      text: { workerSeconds: 0.2, mode: "fast", sourceBytes: 30 * KB, artifactBytes: 24 * KB, indexBytes: 20 * KB },
      complex: { workerSeconds: 0.8, mode: "fast", sourceBytes: 120 * KB, artifactBytes: 40 * KB, indexBytes: 24 * KB },
      // Kept as a page image: render and store it, no OCR or model read, no text to index. Render time unmeasured.
      scanned: { workerSeconds: 1, mode: "fast", sourceBytes: 250 * KB, artifactBytes: 160 * KB, indexBytes: 0 },
    },
  },
  auto: {
    id: "auto",
    label: QUALITY_MODES.auto.label,
    description: QUALITY_MODES.auto.description,
    pages: {
      text: { workerSeconds: 0.3, mode: "fast", sourceBytes: 30 * KB, artifactBytes: 64 * KB, indexBytes: 25 * KB },
      complex: { workerSeconds: 4, mode: "fast", sourceBytes: 120 * KB, artifactBytes: 160 * KB, indexBytes: 30 * KB },
      scanned: { workerSeconds: 4.2, mode: "rich", sourceBytes: 250 * KB, artifactBytes: 160 * KB, indexBytes: 25 * KB },
    },
  },
  good: {
    id: "good",
    label: QUALITY_MODES.good.label,
    description: QUALITY_MODES.good.description,
    pages: {
      // Every page holds a slot for one vision call (production worker.vision p50 4.1 s).
      text: { workerSeconds: 4.2, mode: "rich", sourceBytes: 30 * KB, artifactBytes: 160 * KB, indexBytes: 30 * KB },
      complex: { workerSeconds: 6, mode: "rich", sourceBytes: 120 * KB, artifactBytes: 180 * KB, indexBytes: 40 * KB },
      scanned: { workerSeconds: 6, mode: "rich", sourceBytes: 250 * KB, artifactBytes: 180 * KB, indexBytes: 35 * KB },
    },
  },
};

/** Share of ideal parallel speedup actually achieved (scheduling, stragglers). */
export const PARALLEL_EFFICIENCY = 0.85;
/** Fixed per-batch latency: upload, quarantine, index finalization. */
export const FIXED_OVERHEAD_SECONDS = 15;
/** Worker seconds per media minute (transcription, frames), planning figure. */
export const MEDIA_WORKER_SECONDS_PER_MINUTE = { audio: 2, video: 6 } as const;
/** Stored bytes per media minute (source plus transcript artifacts), planning figure. */
export const MEDIA_BYTES_PER_MINUTE = { audio: 1_000 * KB, video: 15_000 * KB } as const;

export type PageMix = Record<PageClass, number>;

export type IngestEstimateInput = {
  pages: number;
  /** Fractions of pages per class; normalized, so any positive weights work. */
  mix: Partial<PageMix>;
  profile?: PipelineProfileId;
  /** Org concurrent worker ceiling (default FUNDED_WORKER_SLOTS). */
  workerSlots?: number;
  /** Number of files in the batch. Each run fans out to at most MAX_PAGE_FANOUT_PER_RUN workers. */
  documents?: number;
  audioMinutes?: number;
  videoMinutes?: number;
  /** Optional per-document features to price (DOCUMENT_FEATURES); off unless set. */
  features?: Partial<Record<DocumentFeature, boolean>>;
};

export type IngestEstimate = {
  pages: number;
  profile: PipelineProfileId;
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
  storage: {
    bytes: number;
    objectBytes: number;
    indexBytes: number;
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
  const profile = PIPELINE_PROFILES[input.profile ?? "auto"];
  const workers = Math.max(1, Math.round(nonNegative(input.workerSlots ?? FUNDED_WORKER_SLOTS)) || FUNDED_WORKER_SLOTS);
  const pages = Math.max(0, Math.round(nonNegative(input.pages)));
  const documents = Math.max(1, Math.round(nonNegative(input.documents ?? 1)));
  const audioMinutes = Math.ceil(nonNegative(input.audioMinutes));
  const videoMinutes = Math.ceil(nonNegative(input.videoMinutes));
  const mix = normalizeMix(input.mix);

  const totals = { workerSeconds: 0, fastPages: 0, richPages: 0, sourceBytes: 0, artifactBytes: 0, indexBytes: 0 };
  let slowestPageSeconds = 0;
  for (const pageClass of pageClassSchema.options) {
    const count = pages * mix[pageClass];
    if (count <= 0) continue;
    const cost = profile.pages[pageClass];
    totals.workerSeconds += count * cost.workerSeconds;
    if (cost.mode === "rich") totals.richPages += count;
    else totals.fastPages += count;
    totals.sourceBytes += count * cost.sourceBytes;
    totals.artifactBytes += count * cost.artifactBytes;
    totals.indexBytes += count * cost.indexBytes;
    slowestPageSeconds = Math.max(slowestPageSeconds, cost.workerSeconds);
  }
  const mediaPages = mediaRichPages("audio", audioMinutes * 60) + mediaRichPages("video", videoMinutes * 60);
  totals.workerSeconds += audioMinutes * MEDIA_WORKER_SECONDS_PER_MINUTE.audio + videoMinutes * MEDIA_WORKER_SECONDS_PER_MINUTE.video;
  totals.sourceBytes += audioMinutes * MEDIA_BYTES_PER_MINUTE.audio + videoMinutes * MEDIA_BYTES_PER_MINUTE.video;

  const units = Math.max(1, pages + audioMinutes + videoMinutes);
  const effectiveParallelism = Math.max(1, Math.min(workers, documents * MAX_PAGE_FANOUT_PER_RUN, units));
  const hasWork = pages > 0 || audioMinutes > 0 || videoMinutes > 0;
  const wallSeconds = !hasWork
    ? 0
    : Math.max(slowestPageSeconds, totals.workerSeconds / (effectiveParallelism * PARALLEL_EFFICIENCY)) + FIXED_OVERHEAD_SECONDS;

  const fast = pageCredits("fast", totals.fastPages);
  const rich = pageCredits("rich", totals.richPages);
  const media = pageCredits("rich", mediaPages);
  // Optional features are charged per document; spread pages (and media Rich pages) evenly over the files.
  const pagesPerDocument = (pages + mediaPages) / documents;
  const featureTotals: Partial<Record<DocumentFeature, number>> = {};
  let features = 0;
  if (hasWork) {
    for (const feature of DOCUMENT_FEATURES) {
      if (!input.features?.[feature]) continue;
      const credits = featureCredits(feature, pagesPerDocument) * documents;
      featureTotals[feature] = credits;
      features += credits;
    }
  }
  const totalCredits = fast + rich + media + features;

  const objectBytes = totals.sourceBytes + totals.artifactBytes;
  const bytes = objectBytes + totals.indexBytes;
  const pagesPerMinute = wallSeconds > 0 ? pages / (wallSeconds / 60) : 0;
  const dollars = creditsToDollars(totalCredits);

  return {
    pages,
    profile: profile.id,
    workers,
    effectiveParallelism,
    workerSeconds: totals.workerSeconds,
    wallSeconds,
    pagesPerMinute,
    minutesPer100Pages: pagesPerMinute > 0 ? 100 / pagesPerMinute : 0,
    fastPages: totals.fastPages,
    richPages: totals.richPages,
    mediaRichPages: mediaPages,
    credits: { totalCredits, breakdown: { fast, rich, media, features } },
    featureCredits: featureTotals,
    pagesPerDollar: dollars > 0 ? pages / dollars : 0,
    creditsPer1000Pages: pages > 0 ? (totalCredits / pages) * 1000 : 0,
    storage: { bytes, objectBytes, indexBytes: totals.indexBytes, monthlyCredits: storageCreditsPerMonth(bytes) },
  };
}

export type CorpusBasis = "measured" | "official" | "estimate";

export type ExampleCorpus = {
  id: string;
  title: string;
  detail: string;
  /** Pages; prose without a print edition uses page-equivalents (words / 500). */
  pages: number;
  documents: number;
  mix: PageMix;
  profile?: PipelineProfileId;
  audioMinutes?: number;
  /** How the size was obtained; estimates must be labelled as estimates. */
  basis: CorpusBasis;
  source: string;
};

/**
 * Real corpora for the pricing page (research 2026-10-21, corpora.md in the
 * pricing evidence). Price them with estimateIngest; sizes marked `estimate`
 * must be shown as estimates.
 */
export const EXAMPLE_CORPORA: readonly ExampleCorpus[] = [
  { id: "crime-and-punishment", title: "Crime and Punishment", detail: "203,634 words, ~407 page-equivalents (Gutenberg, Garnett translation)", pages: 407, documents: 1, mix: { text: 1, complex: 0, scanned: 0 }, basis: "measured", source: "Project Gutenberg #2554, word count" },
  { id: "dostoevsky-four-novels", title: "Dostoevsky's four major novels", detail: "1,049,610 words, ~2,099 page-equivalents", pages: 2_099, documents: 4, mix: { text: 1, complex: 0, scanned: 0 }, basis: "measured", source: "Project Gutenberg #2554, #28054, #2638, #8117" },
  { id: "apple-10k-2025", title: "Apple 10-K (FY2025)", detail: "80 pages of text and financial tables", pages: 80, documents: 1, mix: { text: 0.65, complex: 0.35, scanned: 0 }, basis: "measured", source: "As-filed PDF, pdfinfo" },
  { id: "us-code-2024", title: "US Code (2024 edition)", detail: "53 titles, 53,380 printed pages of dense two-column legal text", pages: 53_380, documents: 53, mix: { text: 0.95, complex: 0.05, scanned: 0 }, basis: "measured", source: "govinfo title PDFs, pdfinfo" },
  { id: "all-10ks-2025", title: "Every 10-K filed in 2025", detail: "6,690 filings, ~600,000 pages of text and tables", pages: 600_000, documents: 6_690, mix: { text: 0.7, complex: 0.3, scanned: 0 }, basis: "estimate", source: "EDGAR full index 2025 (filing count measured; pages estimated)" },
  { id: "company-kb-250", title: "A 250-person company's knowledge base", detail: "~8,000 docs, ~40,000 pages of wiki, policies, specs and decks", pages: 40_000, documents: 8_000, mix: { text: 0.7, complex: 0.2, scanned: 0.1 }, basis: "estimate", source: "Working assumption: 20-50 docs per employee, ~5 pages each" },
  { id: "english-wikipedia", title: "English Wikipedia", detail: "7,254,087 articles, 5.3B words, ~10.6M page-equivalents", pages: 10_600_000, documents: 7_254_087, mix: { text: 0.9, complex: 0.1, scanned: 0 }, basis: "official", source: "MediaWiki siteinfo API (articles, words); pages = words / 500" },
  { id: "caselaw-access-project", title: "Caselaw Access Project", detail: ">40M scanned pages from ~40,000 bound volumes", pages: 40_000_000, documents: 40_000, mix: { text: 0, complex: 0, scanned: 1 }, basis: "official", source: "Harvard Library Innovation Lab" },
  { id: "huberman-lab", title: "Huberman Lab podcast", detail: "451 episodes, 856.9 audio hours", pages: 0, documents: 451, mix: { text: 1, complex: 0, scanned: 0 }, audioMinutes: 51_414, basis: "measured", source: "RSS itunes:duration sum" },
];

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export const autoTopUpSettingsSchema = z
  .object({
    /** Off by default; turning it on requires a saved card and a monthly cap. */
    enabled: z.boolean(),
    /** Top up when available credits fall below this. */
    thresholdCredits: z.number().int().min(100).max(1_000_000),
    /** Amount charged per top-up: a pack or a custom amount within the top-up limits. */
    amountCents: z.number().int().min(MIN_TOPUP_CENTS).max(MAX_TOPUP_CENTS),
    /** Required ceiling on auto top-up spend per calendar month. */
    monthlyLimitCents: z.number().int().min(MIN_TOPUP_CENTS).max(10_000_000),
  })
  .refine((value) => value.monthlyLimitCents >= value.amountCents, {
    message: "Monthly limit must be at least one top-up amount",
    path: ["monthlyLimitCents"],
  });
export type AutoTopUpSettings = z.infer<typeof autoTopUpSettingsSchema>;

export const billingForecastSchema = z.object({
  storageBytes: z.number().nonnegative(),
  storageCreditsPerMonth: z.number().nonnegative(),
  searchesLast30d: z.number().nonnegative(),
  searchCreditsPer30d: z.number().nonnegative(),
  chatAnswersLast30d: z.number().nonnegative(),
  chatCreditsPer30d: z.number().nonnegative(),
  fastPagesLast30d: z.number().nonnegative(),
  richPagesLast30d: z.number().nonnegative(),
  ingestCreditsLast30d: z.number().nonnegative(),
  recurringCreditsPerMonth: z.number().nonnegative(),
  daysUntilEmpty: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<BillingForecast>;

export const billingSpendSchema = z.object({
  ingest: z.number(),
  storage: z.number(),
  search: z.number(),
  chat: z.number(),
  other: z.number(),
  total: z.number(),
});
export type BillingSpend = z.infer<typeof billingSpendSchema>;

export const billingOverviewSchema = z.object({
  orgId: z.string(),
  /** Has ever received a paid grant (top-up, auto top-up, adjustment, promo). */
  funded: z.boolean(),
  credits: z.object({
    /** Prepaid balance (purchases + starter + promotional); may be negative after a run overdraws. */
    balance: z.number(),
    /** Usage recorded but not yet applied to the balance (applied within seconds). */
    pending: z.number(),
    /** balance − pending: the real balance. May be negative. */
    available: z.number(),
    /** Credits kept for chat and search: uploads and automation stop once the balance reaches this. */
    chatReserve: z.number(),
    /** How far below zero chat and search may take the balance (0: not at all). */
    chatOverdraft: z.number(),
  }),
  workers: z.object({
    /** Concurrent worker ceiling: STARTER_WORKER_SLOTS or FUNDED_WORKER_SLOTS unless raised. */
    limit: z.number().int(),
    inUse: z.number().int(),
  }),
  storage: z.object({
    /** objectBytes + indexBytes, the billed figure. */
    bytes: z.number(),
    objectBytes: z.number(),
    indexBytes: z.number(),
    /** Measured source-file bytes, the exact part of objectBytes. */
    sourceBytes: z.number().optional(),
    /** True while the byte counts include per-page planning estimates. */
    estimated: z.boolean().optional(),
    monthlyCredits: z.number(),
  }),
  /** Archived document versions still holding files; `monthlyCredits` is null when billing is not enforced. */
  retainedVersionStorage: z.object({
    bytes: z.number().nonnegative(),
    pages: z.number().nonnegative(),
    monthlyCredits: z.number().nonnegative().nullable(),
    billingEnforced: z.boolean().optional(),
  }).optional(),
  forecast: billingForecastSchema,
  /** Credits charged since the start of the UTC month, by category. */
  spendThisMonth: billingSpendSchema,
  autoTopUp: autoTopUpSettingsSchema.nullable(),
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
