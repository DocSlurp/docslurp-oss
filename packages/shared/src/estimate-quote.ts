import { z } from "zod";

import { isBillingEnforced, pipelineProfileIdSchema } from "./billing.js";
import { fileProfileSchema } from "./file-profile.js";
import { CHAT_ANSWER_TIERS, pricing } from "./pricing-provider.js";
import { CHART_EXPORT_TIER_UNAVAILABLE_CODE, CHART_EXPORT_FORMATS, chartExportFormatSchema, chartExportOverrideRefusal, chartExportTierSchema, defaultChartExportConfig, effectiveChartExportConfig, resolveChartExportTier, type ChartExportTier, type RunOrigin } from "./chart-export.js";
import type { PipelineFeatures } from "./pipeline.js";
import type { CostEstimate } from "./jobs.js";
import type { UploadMediaEstimate } from "./media-upload-estimate.js";
import { applyFileProfile, estimateProfileFor, type EstimateProfile, type QuoteFile } from "./upload-quote.js";

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
  /** Processing quality: fast reads text layers only, auto reads scans and complex pages, good reads every page. */
  quality: pipelineProfileIdSchema,
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
   * Chart and diagram export tier. Omitted: the project's tier, else the caller's default (the DocSlurp app: free; API,
   * MCP, SDK and CLI: off). The deploy switch caps it. Only `models` (reading charts with AI) is priced.
   */
  chartExport: chartExportTierSchema,
  /** Chart export formats and diagrams the `models` tier prices with: the project's own, so the quote's charts line equals the upload's `chartExport.credits`. */
  chartFormats: z.array(chartExportFormatSchema).min(1).max(CHART_EXPORT_FORMATS.length),
  chartDiagrams: z.boolean(),
});
export type QuoteSettings = z.infer<typeof quoteSettingsSchema>;

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
  /** The pricing rules that priced this estimate, and until when it holds. */
  pricingVersion: string;
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
  return {
    quality: pipeline.quality,
    indexing: pipeline.indexingMode === "visual" ? "visual" : pipeline.indexingMode === "map" ? "on-demand" : "full",
    ...features,
    videoFrames: pipeline.mediaVideo?.enabled !== false,
    speedBoost: pipeline.speedBoost === true,
    // Only an explicit project tier; an unset one resolves per caller at quote time.
    ...(pipeline.chartExport?.tier ? { chartExport: pipeline.chartExport.tier } : {}),
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
  const settings = quoteSettingsSchema.parse({
    ...DEFAULT_QUOTE_SETTINGS, ...args.base, ...args.settings,
    chartExport: quoteChartTier(args.settings?.chartExport, args.base?.chartExport, args),
  });
  if (settings.indexing === "visual" && settings.quality === "fast") throw new QuoteSettingsError("Visual indexing reads every page and cannot be combined with fast quality");
  const billing = isBillingEnforced(args.env ?? process.env) ? "enforced" : "disabled";
  const files = args.files.map(({ profile: _ignored, ...file }) => file);
  const profile = estimateProfileForSettings(settings, { billing, ...(args.workerSlots ? { workerSlots: args.workerSlots } : {}) });
  const quote = pricing().quote({ files, settings, profile, ...(args.work ? { work: args.work } : {}) });
  if (quote.kind !== "estimate" || quote.billing !== billing) throw new Error("pricing provider returned an invalid estimate");
  return quote;
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
  const settings = quoteSettingsSchema.parse({
    ...DEFAULT_QUOTE_SETTINGS, ...options.base, ...request.settings,
    chartExport: quoteChartTier(request.settings?.chartExport, options.base?.chartExport, options),
  });
  if (settings.indexing === "visual" && settings.quality === "fast") throw new QuoteSettingsError("Visual indexing reads every page and cannot be combined with fast quality");
  const billing = isBillingEnforced(options.env ?? process.env) ? "enforced" : "disabled";
  const files = request.files.map((file) => applyFileProfile(file));
  const profile = estimateProfileForSettings(settings, { billing, ...(options.workerSlots ? { workerSlots: options.workerSlots } : {}) });
  const quote = pricing().quote({ files, settings, profile });
  if (quote.kind !== "estimate" || quote.billing !== billing) throw new Error("pricing provider returned an invalid estimate");
  return quote;
}
