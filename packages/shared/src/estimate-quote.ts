import { z } from "zod";

import { isBillingEnforced, pipelineProfileIdSchema } from "./billing.js";
import { chartTierForVisuals, isQualityLevel, legacyQualityModeFor, visualsLevelSchema } from "./extraction-config.js";
import { fileProfileSchema } from "./file-profile.js";
import { CHAT_ANSWER_TIERS, pricing } from "./pricing-provider.js";
import { CHART_EXPORT_TIER_UNAVAILABLE_CODE, CHART_EXPORT_FORMATS, chartExportFormatSchema, chartExportOverrideRefusal, chartExportTierSchema, defaultChartExportConfig, effectiveChartExportConfig, resolveChartExportTier, type ChartExportTier, type RunOrigin } from "./chart-export.js";
import type { PipelineFeatures } from "./pipeline.js";
import type { CostEstimate } from "./jobs.js";
import type { UploadMediaEstimate } from "./media-upload-estimate.js";
import { applyFileProfile, capCreditsToLadderShare, estimateProfileFor, ladderShareProfile, type EstimateProfile, type QuoteFile } from "./upload-quote.js";
import { ladderChartExportTier, pageReadingQuality } from "./auto-ladder.js";

/*
 * The one estimate: `POST /v1/estimate` (anonymous or authenticated) and the authenticated upload estimate both answer
 * with `quoteEstimate`. The client profiles its files once (`@docslurp/estimate`, in a Web Worker) and re-sends the small
 * profiles with each change of settings; the server prices them with the pricing provider. Prices and their rules never
 * leave the server. An estimate is never a charge: billing is measured by the worker.
 */

/** Estimate files per request: anonymous callers, and authenticated ones. */
export const ESTIMATE_MAX_FILES_ANONYMOUS = 200;
export const ESTIMATE_MAX_FILES = 1_000;

/**
 * The knobs a quote can turn, in customer terms. Every one is a real pipeline or usage choice that changes cost. Omitted
 * knobs take the project's value (authenticated, with a project) or a new project's default.
 */
export const quoteSettingsSchema = z.strictObject({
  /**
   * Processing quality: `fastest` reads text layers only, `balanced` reads scans and complex pages, `smart` reads every
   * page. The deprecated `fast`/`auto`/`good` are still accepted; quotes answer with the deprecated words for now.
   */
  quality: z.preprocess((value) => (isQualityLevel(value) ? legacyQualityModeFor(value) : value), pipelineProfileIdSchema),
  /**
   * `full` indexes every page for search and chat on upload (`pipeline.indexingMode: "full"`); `on-demand` maps the
   * documents and indexes pages when a query first needs them (`"map"`); `visual` embeds every page image on upload
   * (`"visual"`), a model read of every page, so it cannot be combined with `fast` quality.
   */
  indexing: z.enum(["full", "on-demand", "visual"]),
  /** Optional per-document features. */
  documentSummary: z.boolean(),
  structuredFields: z.boolean(),
  knowledgeGraph: z.boolean(),
  propositions: z.boolean(),
  /** Read video frames (otherwise a video is read from its audio track). */
  videoFrames: z.boolean(),
  /** Opt-in faster processing. */
  speedBoost: z.boolean(),
  /** How long the files stay hosted, in months (1 to 60), for the hosting total. */
  hostingMonths: z.number().int().min(1).max(60),
  /** Expected monthly searches and chat answers over these files. */
  searchesPerMonth: z.number().int().min(0).max(10_000_000),
  chatAnswersPerMonth: z.number().int().min(0).max(1_000_000),
  /** The chat model class the answers use. */
  chatTier: z.enum(CHAT_ANSWER_TIERS as unknown as [string, ...string[]]),
  /**
   * Chart and diagram export tier. Omitted: the project's tier, else the caller's default (`off` for the DocSlurp app and
   * for API, MCP, SDK and CLI calls unless the deployment sets one). The deploy switch caps it. Only `models` (reading
   * charts with AI) is priced.
   */
  chartExport: chartExportTierSchema,
  /**
   * Visuals (`none` | `figures` | `charts` | `charts-ai`), replacing `chartExport`: `charts-ai` prices AI chart reads, the
   * rest price none. Normalized onto `chartExport` (`normalizeQuoteSettingsInput`); both together must agree.
   */
  visuals: visualsLevelSchema.optional(),
  /** Chart export formats and diagrams the `models` tier prices with: the project's own, so the quote's charts line equals the upload's `chartExport.credits`. */
  chartFormats: z.array(chartExportFormatSchema).min(1).max(CHART_EXPORT_FORMATS.length),
  chartDiagrams: z.boolean(),
  /**
   * Auto ladder above-fast share (`pipeline.ladder.maxEscalationShare.aboveFast`): the largest share of each document's
   * pages a model may read; the rest are quoted Fast. Omitted: the project's, else no cap. Only `auto` uses it.
   */
  aboveFastShare: z.number().finite().min(0).max(1).nullable().optional(),
});
export type QuoteSettings = z.infer<typeof quoteSettingsSchema>;

/**
 * Quote settings from a request with `visuals` folded onto `chartExport` (the field the pricing reads). Throws
 * `QuoteSettingsError` (`extraction_config_conflict`) when both are given and disagree.
 */
export function normalizeQuoteSettingsInput<T extends Partial<QuoteSettings> | undefined>(settings: T): T {
  if (!settings || settings.visuals === undefined) return settings;
  const { visuals, ...rest } = settings;
  const tier = chartTierForVisuals(visuals);
  if (rest.chartExport && rest.chartExport !== tier) throw new QuoteSettingsError(`settings.visuals '${visuals}' conflicts with settings.chartExport '${rest.chartExport}'; send visuals only`, "extraction_config_conflict");
  return { ...rest, chartExport: tier } as T;
}

export const DEFAULT_QUOTE_SETTINGS: QuoteSettings = {
  quality: "auto",
  indexing: "full",
  documentSummary: false,
  structuredFields: false,
  knowledgeGraph: false,
  propositions: false,
  videoFrames: true,
  speedBoost: false,
  hostingMonths: 12,
  searchesPerMonth: 0,
  chatAnswersPerMonth: 0,
  chatTier: "standard",
  chartExport: "off",
  chartFormats: [...defaultChartExportConfig.formats],
  chartDiagrams: defaultChartExportConfig.diagrams,
};

type QuoteOrigin = { origin?: RunOrigin; env?: Record<string, string | undefined> };

/**
 * The chart tier a quote prices: the request's, else the project's (`base`), else the caller's origin default; then
 * capped by the deploy switch, as ingest resolves it (`stampRunChartExport` + the worker's ceiling).
 */
function quoteChartTier(requested: ChartExportTier | undefined, base: ChartExportTier | undefined, options: QuoteOrigin): ChartExportTier {
  const env = options.env ?? process.env;
  for (const value of [requested, base]) {
    if (value !== undefined && !chartExportTierSchema.safeParse(value).success) throw new QuoteSettingsError("chartExport must be off, free or models");
  }
  // A requested `models` quote where the deployment does not offer it is refused, as the upload itself would be.
  if (requested && chartExportOverrideRefusal(requested, env)) throw new QuoteSettingsError("That chart export tier is not available on this deployment", CHART_EXPORT_TIER_UNAVAILABLE_CODE);
  const tier = resolveChartExportTier({ requested: requested ?? null, project: base ? { tier: base } : null, origin: options.origin ?? "machine", env });
  return effectiveChartExportConfig({ ...defaultChartExportConfig, tier }, env).tier;
}

/** One file to estimate: name, size and type, a counted page count or duration, and its client file profile. */
export const estimateFileSchema = z.strictObject({
  name: z.string().min(1).max(1024),
  size: z.number().int().nonnegative().max(10 ** 13),
  type: z.string().max(255).optional(),
  pages: z.number().int().positive().max(10_000_000).optional(),
  durationSeconds: z.number().positive().max(24 * 3600).optional(),
  profile: fileProfileSchema.optional(),
});

export const estimateRequestSchema = z.strictObject({
  files: z.array(estimateFileSchema).min(1).max(ESTIMATE_MAX_FILES),
  settings: quoteSettingsSchema.partial().optional(),
  /** Authenticated callers only: the project whose settings (and balance) the estimate uses. */
  project: z.string().min(1).max(256).optional(),
});
export type EstimateRequest = z.infer<typeof estimateRequestSchema>;

export type CreditRange = { low: number; high: number };

/** A neutral, customer-facing line: what is charged, never how it is derived. */
export type EstimateLine = {
  id: "pages" | "media" | "features" | "charts" | "storage" | "search" | "chat";
  label: string;
  period: "once" | "month";
  credits: CreditRange;
};

export type EstimateQuote = {
  kind: "estimate";
  /** The pricing rules that priced this estimate. */
  pricingVersion: string;
  /** When to re-quote: a freshness hint, not a price hold. Prices may change without notice. */
  validUntil: string;
  /** `disabled`: this deployment does not bill, and every credit figure is null. */
  billing: "enforced" | "disabled";
  settings: QuoteSettings;
  files: { total: number; profiled: number };
  /** Pages (or page-equivalents) the files hold: a range when some were not counted. */
  pages: CreditRange;
  mediaMinutes: number;
  /** Processing these files once. */
  ingest: { credits: CreditRange | null; seconds: CreditRange };
  /** Keeping them stored and indexed. */
  hosting: { bytes: CreditRange; creditsPerMonth: CreditRange | null; months: number; credits: CreditRange | null };
  /** Searching and chatting over them at the stated monthly volume. */
  usage: { creditsPerMonth: CreditRange | null };
  lines: EstimateLine[];
  /** Throughput figures: pages per $1 of the ingest estimate, and pages per minute of processing. */
  rates: { pagesPerDollar: CreditRange | null; pagesPerMinute: CreditRange };
  basis: string;
};

/** What the pricing provider prices: validated, clamped files and complete settings. */
export type ProviderEstimateArgs = {
  files: readonly QuoteFile[];
  settings: QuoteSettings;
  /** The project profile these settings describe (quality, features, worker slots, billing). */
  profile: EstimateProfile;
  /**
   * Work on documents already stored (reprocess, full index, a config change), priced stage by stage by the provider's
   * own delegates (`estimatePipelineWork`): it replaces the upload quote as the ingest figure. `files` are then the
   * stored documents, from the worker's measured counts, for pages and hosting.
   */
  work?: { estimate: CostEstimate; media: UploadMediaEstimate | null };
};

/** The knobs a project pipeline is set to: the base an authenticated caller's settings override. */
export function quoteSettingsForPipeline(pipeline: PipelineFeatures): Partial<QuoteSettings> {
  const features = estimateProfileFor(pipeline, { env: {} }).documentFeatures;
  const ladderShare = ladderShareProfile(pipeline).aboveFastShare;
  const chartTier = ladderChartExportTier(pipeline, pipeline.chartExport?.tier);
  return {
    // Auto capped at the fast rung (pipeline.ladder) reads, and is quoted, as Fast.
    quality: pageReadingQuality(pipeline),
    ...(ladderShare !== undefined ? { aboveFastShare: ladderShare } : {}),
    indexing: pipeline.indexingMode === "visual" ? "visual" : pipeline.indexingMode === "map" ? "on-demand" : "full",
    ...features,
    videoFrames: pipeline.mediaVideo?.enabled !== false,
    speedBoost: pipeline.speedBoost === true,
    // Only an explicit project tier; an unset one resolves per caller at quote time.
    ...(chartTier ? { chartExport: chartTier } : {}),
    ...(pipeline.chartExport?.formats?.length ? { chartFormats: [...pipeline.chartExport.formats] } : {}),
    ...(pipeline.chartExport ? { chartDiagrams: pipeline.chartExport.diagrams !== false } : {}),
  };
}

/** The upload pipeline a set of settings describes, as an EstimateProfile. */
export function estimateProfileForSettings(settings: QuoteSettings, options: { workerSlots?: number; billing: "enforced" | "disabled" }): EstimateProfile {
  const stages = 5 + (settings.indexing === "on-demand" ? 1 : 2)
    + [settings.documentSummary, settings.structuredFields, settings.knowledgeGraph, settings.propositions].filter(Boolean).length;
  return {
    pricingVersion: pricing().version,
    // Visual indexing embeds every page image: a model read of every page, priced as the quality that reads every page.
    quality: settings.indexing === "visual" ? "good" : settings.quality,
    documentFeatures: {
      documentSummary: settings.documentSummary,
      structuredFields: settings.structuredFields,
      knowledgeGraph: settings.knowledgeGraph,
      propositions: settings.propositions,
    },
    videoFrames: settings.videoFrames,
    ...(options.workerSlots ? { workerSlots: options.workerSlots } : {}),
    stageCount: stages,
    billing: options.billing,
  };
}

/**
 * Quote work on documents the server already holds: `files` from their measured counts (`billing_pages`, size, type,
 * pages a model read), never a client profile; `work` the stage-precise estimate of the work itself, or null to quote
 * ingesting them afresh. The same quote shape as `POST /v1/estimate`.
 */
export function quoteStoredWork(args: {
  files: readonly QuoteFile[];
  work: { estimate: CostEstimate; media: UploadMediaEstimate | null } | null;
  base?: Partial<QuoteSettings>;
  settings?: Partial<QuoteSettings>;
  workerSlots?: number;
  env?: Record<string, string | undefined>;
  origin?: RunOrigin;
}): EstimateQuote {
  args = { ...args, settings: normalizeQuoteSettingsInput(args.settings) };
  const settings = quoteSettingsSchema.parse({
    ...DEFAULT_QUOTE_SETTINGS, ...args.base, ...args.settings,
    chartExport: quoteChartTier(args.settings?.chartExport, args.base?.chartExport, args),
  });
  if (settings.indexing === "visual" && settings.quality === "fast") throw new QuoteSettingsError("Visual indexing reads every page and cannot be combined with fast quality");
  const billing = isBillingEnforced(args.env ?? process.env) ? "enforced" : "disabled";
  const files = args.files.map(({ profile: _ignored, ...file }) => file);
  const profile = estimateProfileForSettings(settings, { billing, ...(args.workerSlots ? { workerSlots: args.workerSlots } : {}) });
  // Stage-precise work estimates already price the ladder (estimatePipelineWork); a fresh ingest quote is capped here.
  return providerQuote({ files, settings, profile, ...(args.work ? { work: args.work } : {}) }, billing, !args.work);
}

/**
 * The provider's quote for these settings, the ladder's above-fast share applied: the provider prices the settings
 * without it (it never sees the knob), and a share below 1 on `auto` caps the ingest credits at Fast plus the Rich
 * surcharge of the pages the share allows (capCreditsToLadderShare).
 */
function providerQuote(args: ProviderEstimateArgs, billing: "enforced" | "disabled", capIngest: boolean): EstimateQuote {
  const { aboveFastShare, ...settings } = args.settings;
  const quote = pricing().quote({ ...args, settings: settings as QuoteSettings });
  if (quote.kind !== "estimate" || quote.billing !== billing) throw new Error("pricing provider returned an invalid estimate");
  if (!capIngest || typeof aboveFastShare !== "number" || args.profile.quality !== "auto" || !quote.ingest.credits) return quote;
  const fast = pricing().quote({ ...args, settings: { ...settings, quality: "fast" } as QuoteSettings, profile: { ...args.profile, quality: "fast" } });
  if (fast.kind !== "estimate" || !fast.ingest.credits) return quote;
  const before = quote.ingest.credits;
  const ingest = capCreditsToLadderShare({ credits: before, fastCredits: fast.ingest.credits, files: args.files, share: aboveFastShare });
  const saved = { low: before.low - ingest.low, high: before.high - ingest.high };
  const pagesPerDollar = quote.rates.pagesPerDollar && ingest.high > 0 && ingest.low > 0
    ? { low: quote.pages.low / (ingest.high / 100), high: quote.pages.high / (ingest.low / 100) }
    : quote.rates.pagesPerDollar;
  return {
    ...quote,
    settings: { ...quote.settings, aboveFastShare },
    ingest: { ...quote.ingest, credits: ingest },
    lines: quote.lines.map((line) => line.id === "pages"
      ? { ...line, credits: { low: Math.max(0, line.credits.low - saved.low), high: Math.max(0, line.credits.high - saved.high) } }
      : line),
    rates: { ...quote.rates, pagesPerDollar },
    basis: `${quote.basis}; at most ${Math.round(aboveFastShare * 1000) / 10}% of each document's pages read by a model (pipeline.ladder)`,
  };
}

/** Settings a project could not be configured with (a quote refuses them as the project API does). */
export class QuoteSettingsError extends Error {
  override name = "QuoteSettingsError";
  /** The public error code; `invalid_request` unless a specific refusal (`chart_export_tier_unavailable`). */
  readonly code: string;
  constructor(message: string, code = "invalid_request") {
    super(message);
    this.code = code;
  }
}

/**
 * Price an estimate request with the active pricing provider. `base` is the project's settings for an authenticated
 * caller, else the defaults; `request.settings` overrides them knob by knob. Profiles are validated by the schema,
 * clamped against each file's size and merged (`applyFileProfile`) before the provider sees them.
 */
export function quoteEstimate(
  request: EstimateRequest,
  options: { base?: Partial<QuoteSettings>; workerSlots?: number; env?: Record<string, string | undefined>; origin?: RunOrigin } = {},
): EstimateQuote {
  request = { ...request, settings: normalizeQuoteSettingsInput(request.settings) };
  const settings = quoteSettingsSchema.parse({
    ...DEFAULT_QUOTE_SETTINGS, ...options.base, ...request.settings,
    chartExport: quoteChartTier(request.settings?.chartExport, options.base?.chartExport, options),
  });
  if (settings.indexing === "visual" && settings.quality === "fast") throw new QuoteSettingsError("Visual indexing reads every page and cannot be combined with fast quality");
  const billing = isBillingEnforced(options.env ?? process.env) ? "enforced" : "disabled";
  const files = request.files.map((file) => applyFileProfile(file));
  const profile = estimateProfileForSettings(settings, { billing, ...(options.workerSlots ? { workerSlots: options.workerSlots } : {}) });
  return providerQuote({ files, settings, profile }, billing, true);
}
