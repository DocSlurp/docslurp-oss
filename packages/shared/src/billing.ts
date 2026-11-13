import { z } from "zod";

import {
  DOCUMENT_FEATURES,
  pricing,
  type ChatAnswerTier,
  type DocumentFeature,
  type IngestEstimate,
  type IngestEstimateInput,
  type PageMode,
} from "./pricing-provider.js";
import type { SearchPriceOptions } from "./pricing-provider.js";
import { qualityModeSchema, type QualityMode } from "./quality.js";
import type { ChartExportFormat, VisualSource } from "./chart-export.js";
import { chartExportModelCallsPerVisual, isBillableVisualSource, type VisualExportModes } from "./chart-export-estimate.js";

export {
  CHAT_ANSWER_TIERS,
  DOCUMENT_FEATURES,
  type ChatAnswerTier,
  type DocumentFeature,
  type IngestEstimate,
  type IngestEstimateInput,
  type PageClass,
  type PageMix,
  type PageMode,
  type VisualExportChargeInput,
} from "./pricing-provider.js";

// ---------------------------------------------------------------------------
// Credits
//
// 1 credit = 1 US cent. Customers buy prepaid credits and are charged per unit of measured work: pages, media minutes,
// stored bytes, searches, chat answers, optional document features. What each unit costs is the pricing provider's
// (pricing-provider.ts): core measures the work, the provider prices it. Balances keep fractional credits
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
// Unit prices: thin delegates to the active pricing provider.
// ---------------------------------------------------------------------------

/** The active pricing rules' version: stamped on billable unit events and pinned on runs. */
export function pricingVersion(): string {
  return pricing().version;
}

/** Credits for one optional feature over one document of `pages` pages (media files pass their Rich-equivalent pages). */
export function featureCredits(feature: DocumentFeature, pages: number): number {
  return pricing().featureCredits(feature, pages);
}

/**
 * Credits for exporting charts and diagrams. Only model sources are charged: a deterministic source (Office chart XML,
 * embedded spec, SVG geometry) is free whatever the provider says. `modes` says which formats a model writes directly
 * (one call each) instead of deriving them from one shared spec.
 */
export function visualExportCredits(args: {
  visuals: number;
  source: VisualSource;
  formats: readonly ChartExportFormat[];
  modes?: VisualExportModes;
}): number {
  if (!isBillableVisualSource(args.source)) return 0;
  const visuals = Math.max(0, Math.trunc(Number.isFinite(args.visuals) ? args.visuals : 0));
  const callsPerVisual = chartExportModelCallsPerVisual(args.formats, args.modes);
  if (visuals === 0 || callsPerVisual === 0) return 0;
  const credits = pricing().visualExportCredits({ visuals, callsPerVisual, formats: [...new Set(args.formats)] });
  if (!Number.isFinite(credits) || credits < 0) throw new Error("pricing provider returned invalid visual export credits");
  return credits;
}

/**
 * Credits for the second read of a model-read visual (the one repair of an invalid answer, or the one retry after an
 * answer cut off at its output cap): billed as its own read, at most once per visual.
 */
export function visualExportRetryCredits(): number {
  const credits = pricing().visualExportRetryCredits();
  if (!Number.isFinite(credits) || credits < 0) throw new Error("pricing provider returned invalid visual export retry credits");
  return credits;
}

/** Expected second reads per model-read visual (0 to 1), as the pricing provider measures them, for estimates. */
export function chartExportExpectedRetriesPerRead(): number {
  const share = pricing().chartExportExpectedRetriesPerRead();
  if (!Number.isFinite(share) || share < 0 || share > 1) throw new Error("pricing provider returned an invalid expected chart retry share");
  return share;
}

/**
 * Expected credits for `visuals` model-read visuals: their first reads (`visualExportCredits`) plus the expected share
 * of a billed second read each (`chartExportExpectedRetriesPerRead` x `visualExportRetryCredits`). Estimates and quotes
 * price chart export with this; the worker charges what each read actually made.
 */
export function expectedVisualExportCredits(args: {
  visuals: number;
  formats: readonly ChartExportFormat[];
  modes?: VisualExportModes;
}): number {
  const first = visualExportCredits({ visuals: args.visuals, source: "vision", formats: args.formats, ...(args.modes ? { modes: args.modes } : {}) });
  if (first === 0) return 0;
  const visuals = Math.max(0, Math.trunc(Number.isFinite(args.visuals) ? args.visuals : 0));
  return first + visuals * chartExportExpectedRetriesPerRead() * visualExportRetryCredits();
}

/**
 * Pages an optional feature actually read when its model saw only part of the
 * text (structured extraction and graph enrichment read long documents in
 * windows, and a document longer than the windows allowed is read in part).
 * Pro rata on the characters read, at least one page, never more than the
 * document; nothing known about the text means the whole document.
 */
export function featurePagesRead(pages: number, charsRead: number, charsTotal: number): number {
  const total = Math.max(1, Math.trunc(Number.isFinite(pages) ? pages : 0));
  if (!(charsTotal > 0) || !(charsRead >= 0) || charsRead >= charsTotal) return total;
  return Math.min(total, Math.max(1, Math.ceil(total * (charsRead / charsTotal))));
}

/** Smallest top-up: card fees make smaller ones uneconomic ($10). */
export const MIN_TOPUP_CENTS = 1_000;
/** Largest single top-up ($10,000). */
export const MAX_TOPUP_CENTS = 1_000_000;

/** Self-serve credit packs, in cents. */
export function creditPackCents(): readonly number[] {
  return pricing().plans.creditPacksCents;
}

/** One-time starter grant, in credits. */
export function starterCredits(): number {
  return pricing().plans.starterCredits;
}

/** Grant sources that make an org funded (credit_grants.source). `starter` never does. */
export const FUNDED_GRANT_SOURCES = ["topup", "auto_recharge", "adjustment", "promo"] as const;

/**
 * Org-wide concurrent worker ceiling. "Funded" = the org has ever received a paid grant (top-up, auto top-up,
 * adjustment, promo); starter-only orgs are "starter".
 */
export function workerSlotsFor(funded: boolean): number {
  const slots = pricing().plans.workerSlots;
  return funded ? slots.funded : slots.starter;
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

/** Credits for `pages` pages in `mode` (fractional; balances keep fractions). */
export function pageCredits(mode: PageMode, pages: number): number {
  return pricing().pageCredits(mode, pages);
}

/** Rich pages one vision/OCR read of a page counts as, given its output tokens. Unknown token counts count as 1. */
export function richPagesForOutputTokens(outputTokens: number | null | undefined): number {
  return pricing().richPagesForOutputTokens(outputTokens);
}

/** Monthly storage credits for `bytes` stored (object + index). */
export function storageCreditsPerMonth(bytes: number): number {
  return pricing().storageCreditsPerMonth(bytes);
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

/** Searches one search counts as. */
export function searchUnits(opts: SearchPriceOptions = {}): number {
  return pricing().searchUnits(opts);
}

/** Credits for `searches` searches. */
export function searchCredits(searches: number, opts: SearchPriceOptions = {}): number {
  return pricing().searchCredits(searches, opts);
}

/** Credits for one web search. */
export function webSearchCredits(opts: { deep?: boolean; includeContent?: boolean } = {}): number {
  return pricing().webSearchCredits(opts);
}

/** Credits for web pages read to Markdown (fetched or crawled). */
export function webPageCredits(pages: number): number {
  return pricing().webPageCredits(pages);
}

/** Credits for one site map that discovered `urls` URLs. */
export function webMapCredits(urls: number): number {
  return pricing().webMapCredits(urls);
}

/** Chat answers one turn counts as. */
export function chatAnswerUnits(totalTokens?: number | null): number {
  return pricing().chatAnswerUnits(totalTokens);
}

/** Tier of a chat model id (`provider/model`, bare `model`, or a `project:` alias resolved by the caller). */
export function chatModelTier(model: string | null | undefined): ChatAnswerTier {
  return pricing().chatModelTier(model);
}

/** Credits for one delivered chat answer. */
export function chatAnswerCredits(opts: { model?: string | null; tier?: ChatAnswerTier; totalTokens?: number | null } = {}): number {
  return pricing().chatAnswerCredits(opts);
}

/** Rich pages a media file counts as for its duration. */
export function mediaRichPages(kind: "audio" | "video", seconds: number): number {
  return pricing().mediaRichPages(kind, seconds);
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
  /** Chart & diagram export, per visual a generator model read (exported or not). */
  chartExport: "feature-chart-export",
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

/** The opt-in acceleration price is fixed server policy (the pricing provider's), never a client multiplier. */
export function speedBoostMultiplier(speedBoost: boolean | undefined = false): number {
  if (typeof speedBoost !== "boolean") throw new Error("speedBoost must be a boolean");
  const multiplier = pricing().speedBoostMultiplier(speedBoost);
  if (!Number.isFinite(multiplier) || multiplier < 1) throw new Error("pricing provider returned an invalid speed boost multiplier");
  return multiplier;
}

/** Apply a trusted request/run snapshot once, without changing provider-dollar receipts. */
export function applySpeedBoostUnitCharge<T extends {
  provider?: string; costCents: number; metric?: string | null; metadata?: Record<string, unknown> | null;
}>(event: T, speedBoost: boolean | undefined = false): T {
  const multiplier = speedBoostMultiplier(speedBoost);
  if (event.provider !== UNIT_CHARGE_PROVIDER || !isUnitChargeEvent(event)) return event;
  const previous = event.metadata?.speedBoostCharge;
  const applied = previous && typeof previous === "object" ? previous as Record<string, unknown> : null;
  const base = applied?.version === 1 && typeof applied.baseCredits === "number"
    && Number.isFinite(applied.baseCredits) && applied.baseCredits >= 0
    && typeof applied.multiplier === "number" && Number.isFinite(applied.multiplier) && applied.multiplier >= 1
    && event.costCents === applied.baseCredits * applied.multiplier
      ? applied.baseCredits : event.costCents;
  if (!Number.isFinite(base) || base < 0) throw new Error("Invalid unit credits");
  if (multiplier === 1 && !applied) return event;
  return { ...event, costCents: base * multiplier,
    metadata: { ...event.metadata, speedBoost: speedBoost === true,
      speedBoostCharge: { version: 1, baseCredits: base, multiplier } } };
}

/** Metadata every billable unit event carries. */
export function unitChargeMetadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, billable: true, unitCharge: true, priceCard: pricingVersion() };
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
 * usage attribution).
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

/** Public price list (`GET /v1/billing/prices`): the provider's published prices plus plans and payment bounds. */
export function billingPrices() {
  const provider = pricing();
  return {
    ...provider.publicPrices(),
    pricingVersion: provider.version,
    packsCents: [...provider.plans.creditPacksCents],
    minTopUpCents: MIN_TOPUP_CENTS,
    maxTopUpCents: MAX_TOPUP_CENTS,
    starterCredits: provider.plans.starterCredits,
    privateDedicatedMonthlyUsd: provider.plans.privateDedicatedMonthlyUsd,
    workerSlots: { ...provider.plans.workerSlots },
  };
}
export type BillingPrices = ReturnType<typeof billingPrices>;

/** Hard ceiling on page tasks one run fans out to, whatever the org ceiling allows. */
export const MAX_PAGE_FANOUT_PER_RUN = 128;

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
 * unit charges (pages, searches, chat answers) instead. Billable unit
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
// Quality modes and ingest planning
// ---------------------------------------------------------------------------

export const pageClassSchema = z.enum(["text", "complex", "scanned"]);

/** Estimator profiles are the processing quality modes (`pipeline.quality`). */
export const pipelineProfileIdSchema = qualityModeSchema;
export type PipelineProfileId = QualityMode;

export type QualityModeInfo = {
  id: QualityMode;
  label: string;
  /** One line for the picker. */
  description: string;
  /** What the price depends on, for a tooltip or footnote (the pricing provider's). */
  priceNote: string;
  /** Credits per 1,000 pages (the pricing provider's); min === max for a flat price. */
  creditsPer1kPages: { min: number; max: number };
};

/** The public processing quality choice: what each mode does. Prices come from the pricing provider (`qualityModeInfo`). */
export const QUALITY_MODES: Record<QualityMode, Pick<QualityModeInfo, "id" | "label" | "description">> = {
  fast: { id: "fast", label: "Fast", description: "Text layer only. Scanned pages are kept as images, not read." },
  auto: { id: "auto", label: "Auto", description: "Reads each page the cheapest faithful way: text layer, or a vision model for scans and complex layouts." },
  good: { id: "good", label: "Good", description: "A vision model reads every page for the most faithful tables, figures and layout." },
};

export const QUALITY_MODE_ORDER: readonly QualityMode[] = qualityModeSchema.options;

/** A quality mode with the active provider's price. */
export function qualityModeInfo(mode: QualityMode): QualityModeInfo {
  return { ...QUALITY_MODES[mode], ...pricing().qualityModePricing(mode) };
}

const formatUsdPer1k = (credits: number): string => `$${creditsToDollars(credits).toFixed(2)}`;

/** "$0.05", "$0.05 to $2.50" or "$2.50" per 1,000 pages for a quality mode. */
export function qualityModePriceRange(mode: QualityMode): string {
  const { min, max } = qualityModeInfo(mode).creditsPer1kPages;
  return min === max ? formatUsdPer1k(min) : `${formatUsdPer1k(min)} to ${formatUsdPer1k(max)}`;
}

const KB = 1024;

/** Fixed per-batch latency: upload, quarantine, index finalization (planning figure). */
export const FIXED_OVERHEAD_SECONDS = 15;
/** Stored bytes per media minute (source plus transcript artifacts), planning figure for durations assumed from size. */
export const MEDIA_BYTES_PER_MINUTE = { audio: 1_000 * KB, video: 15_000 * KB } as const;

/** Planning estimate of ingesting pages and media, from the active pricing provider. */
export function estimateIngest(input: IngestEstimateInput): IngestEstimate {
  return pricing().estimateIngest(input);
}

// ---------------------------------------------------------------------------
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
    /** Credits kept for chat and search: new uploads and automation are not admitted at or below this. */
    chatReserve: z.number(),
    /** How far below zero chat and search may take the balance (0: not at all). */
    chatOverdraft: z.number(),
    /** How far below zero a job that is already running may take the balance to finish (RUN_CREDIT_OVERDRAFT_CREDITS). */
    runOverdraft: z.number(),
  }),
  workers: z.object({
    /** Concurrent worker ceiling: the provider's starter or funded worker slots unless raised. */
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
 * reported; only the credit gate is skipped. Project and org budget caps
 * still apply. Comma-separated org ids in BILLING_EXEMPT_ORG_IDS.
 */
export function billingExemptOrgIds(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  return new Set((env.BILLING_EXEMPT_ORG_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

export function isBillingExemptOrg(orgId: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(orgId) && billingExemptOrgIds(env).has(orgId!);
}
