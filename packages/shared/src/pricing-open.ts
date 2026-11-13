/*
 * The open pricing default: what a deployment without a pricing provider (DOCSLURP_PRICING_PLUGIN) charges.
 *
 * One flat, published rule, so a self-hosted operator can predict every charge:
 * - every page costs OPEN_CREDITS_PER_PAGE, whichever way it was read;
 * - an audio or video file counts one page per started minute;
 * - storage, searches, chat answers, web tools, optional features and chart & diagram export cost nothing;
 * - no speed boost surcharge, no output-token surcharge, every run pays its full page charge.
 *
 * Self-hosted deployments usually run with billing disabled (no Stripe), where nothing is charged at all and estimates
 * show no credits. This default is not DocSlurp's hosted pricing.
 */
import type { CostEstimate } from "./jobs.js";
import { estimateUploadMedia } from "./media-upload-estimate.js";
// Type-only: pricing-provider.ts imports this module for its fallback, so nothing here may need it at load time.
import type { DocumentFeature, IngestEstimate, IngestEstimateInput, PricingProvider, ProviderQuoteArgs } from "./pricing-provider.js";
import { costEstimateSchema } from "./jobs.js";
import { DEFAULT_PAGE_EQUIVALENT_ALLOWANCE } from "./page-equivalents.js";
import { assembleEstimateQuote, profiledPageArea, profiledTextChars, type StoredBytesModel } from "./estimate-assembly.js";
import { quoteFilePageRange, isMultiFrameImageFile, IMAGE_MAX_FRAMES } from "./upload-pages.js";
import { uploadMediaKind } from "./media-upload-estimate.js";

/** Credits (cents) per page under the open default: $1 per 1,000 pages. */
export const OPEN_CREDITS_PER_PAGE = 0.1;
/** Planning figures for the open default's time estimate (not measurements of any deployment). */
export const OPEN_PLANNING = {
  workerSecondsPerPage: 1,
  workerSecondsPerMediaMinute: 2,
  bytesPerPage: 100 * 1024,
  maxPageFanoutPerRun: 128,
  overheadSeconds: 15,
} as const;
/**
 * Plan facts the database already enforces (core migrations seed the starter grant and the org worker ceilings), so
 * the open default reports the same values rather than contradict the schema.
 */
const OPEN_WORKER_SLOTS = { starter: 50, funded: 250 } as const;
const OPEN_STARTER_CREDITS = 100;

function nonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function minutes(seconds: number): number {
  return Math.ceil(nonNegative(seconds) / 60);
}

function openEstimateIngest(input: IngestEstimateInput): IngestEstimate {
  const workers = Math.max(1, Math.round(nonNegative(input.workerSlots ?? OPEN_WORKER_SLOTS.funded)) || OPEN_WORKER_SLOTS.funded);
  const pages = Math.max(0, Math.round(nonNegative(input.pages))) + Math.max(0, Math.round(nonNegative(input.fastOnlyPages)));
  const documents = Math.max(1, Math.round(nonNegative(input.documents ?? 1)));
  const mediaMinutes = Math.ceil(nonNegative(input.audioMinutes)) + Math.ceil(nonNegative(input.videoMinutes));
  const workerSeconds = pages * OPEN_PLANNING.workerSecondsPerPage + mediaMinutes * OPEN_PLANNING.workerSecondsPerMediaMinute;
  const units = Math.max(1, pages + mediaMinutes);
  const effectiveParallelism = Math.max(1, Math.min(workers, documents * OPEN_PLANNING.maxPageFanoutPerRun, units));
  const wallSeconds = pages + mediaMinutes > 0 ? workerSeconds / effectiveParallelism + OPEN_PLANNING.overheadSeconds : 0;
  const pageCreditsTotal = pages * OPEN_CREDITS_PER_PAGE;
  const media = mediaMinutes * OPEN_CREDITS_PER_PAGE;
  const totalCredits = pageCreditsTotal + media;
  const pagesPerMinute = wallSeconds > 0 ? pages / (wallSeconds / 60) : 0;
  const dollars = totalCredits / 100;
  const objectBytes = pages * OPEN_PLANNING.bytesPerPage;
  const featureCredits: IngestEstimate["featureCredits"] = {};
  for (const [feature, on] of Object.entries(input.features ?? {})) if (on) featureCredits[feature as DocumentFeature] = 0;
  return {
    pages,
    profile: input.profile ?? "auto",
    workers,
    effectiveParallelism,
    workerSeconds,
    wallSeconds,
    pagesPerMinute,
    minutesPer100Pages: pagesPerMinute > 0 ? 100 / pagesPerMinute : 0,
    fastPages: pages,
    richPages: 0,
    mediaRichPages: mediaMinutes,
    credits: { totalCredits, breakdown: { fast: pageCreditsTotal, rich: 0, media, features: 0 } },
    featureCredits,
    pagesPerDollar: dollars > 0 ? pages / dollars : 0,
    creditsPer1000Pages: pages > 0 ? (totalCredits / pages) * 1000 : 0,
    storage: { bytes: objectBytes, objectBytes, indexBytes: 0, monthlyCredits: 0 },
  };
}

function openQuoteUpload(args: ProviderQuoteArgs): { estimate: CostEstimate; media: ReturnType<typeof estimateUploadMedia> } {
  const paged = args.files.filter((file) => !uploadMediaKind(file));
  let low = 0;
  let central = 0;
  let high = 0;
  let unmeasured = 0;
  for (const file of paged) {
    const range = quoteFilePageRange(file);
    if (!range.measured) unmeasured += 1;
    // A stuffed page bills the pages it holds (page equivalents): the open rule charges every one of them.
    const extra = Math.max(0, (file.pageEquivalents ?? range.central) - range.central);
    const extraHigh = Math.max(extra, (file.pageEquivalentsHigh ?? file.pageEquivalents ?? range.central) - range.central);
    low += range.low + extra;
    central += range.central + extra;
    high += range.high + extraHigh;
  }
  const media = estimateUploadMedia(args.files, { videoFrames: args.profile.videoFrames });
  const mediaCredits = media ? media.credits : { low: 0, high: 0 };
  const documents = paged.length + (media ? media.audioFiles + media.videoFiles : 0);
  const seconds = (pages: number) => openEstimateIngest({ pages, mix: { text: 1 }, documents: Math.max(1, documents), ...(args.profile.workerSlots ? { workerSlots: args.profile.workerSlots } : {}) }).wallSeconds;
  const tooManyFrames = paged.filter((file) => isMultiFrameImageFile(file) && (file.pages ?? 0) > IMAGE_MAX_FRAMES).length;
  const estimate = costEstimateSchema.parse({
    pages: central,
    documents,
    billing: args.profile.billing,
    credits: args.profile.billing === "disabled"
      ? null
      : { low: low * OPEN_CREDITS_PER_PAGE + mediaCredits.low, high: high * OPEN_CREDITS_PER_PAGE + mediaCredits.high },
    seconds: { low: seconds(low), high: seconds(high) },
    ...(unmeasured > 0 ? { pagesRange: { low, high }, unmeasuredFiles: unmeasured } : {}),
    basis: `open pricing default: ${OPEN_CREDITS_PER_PAGE} credits per page and per media minute`
      + (unmeasured > 0 ? `; pages not counted for ${unmeasured} of ${paged.length} files, assumed ${low} to ${high} from their sizes` : "")
      + (tooManyFrames > 0 ? `; ${tooManyFrames} image file(s) hold more than ${IMAGE_MAX_FRAMES} frames and will be refused` : ""),
  });
  return { estimate, media };
}

/**
 * The open default's stored-bytes model (published planning figures, not measurements of any deployment): the original,
 * a page image of about 1.2 KB per square inch of page, the extracted text twice (Markdown and chunks), and 6 KB of vector
 * per 2,000 characters when every page is indexed on upload (on-demand indexing starts with none).
 */
export const openStoredBytes: StoredBytesModel = (file, pages, settings) => {
  const text = profiledTextChars(file, pages, 2_000);
  const images = profiledPageArea(file) * 1_200;
  const index = (chars: number) => (settings.indexing !== "on-demand" ? Math.ceil(chars / 2_000) * 6 * 1024 : 0);
  // Stored figure files of a processed document are measured (QuoteFile.measured.assetBytes), never estimated.
  const figures = Math.max(0, Number(file.measured?.assetBytes) || 0);
  const bytesFor = (pageCount: number, chars: number) => file.size + figures + pageCount * images + chars * 2 + index(chars);
  return { low: bytesFor(pages.low, text.low), high: bytesFor(pages.high, text.high) };
};

export const OPEN_PRICING: PricingProvider = {
  apiVersion: 1,
  id: "open",
  version: "open-1",
  pageEquivalentAllowance: DEFAULT_PAGE_EQUIVALENT_ALLOWANCE,
  plans: { creditPacksCents: [], starterCredits: OPEN_STARTER_CREDITS, workerSlots: { ...OPEN_WORKER_SLOTS }, privateDedicatedMonthlyUsd: null },
  pageCredits: (_mode, pages) => nonNegative(pages) * OPEN_CREDITS_PER_PAGE,
  richPagesForOutputTokens: () => 1,
  mediaRichPages: (_kind, seconds) => minutes(seconds),
  storageCreditsPerMonth: () => 0,
  extractRetentionCredits: () => 0,
  searchUnits: () => 1,
  searchCredits: () => 0,
  webSearchCredits: () => 0,
  webPageCredits: () => 0,
  webMapCredits: () => 0,
  chatModelTier: () => "standard",
  chatAnswerUnits: () => 1,
  chatAnswerCredits: () => 0,
  featureCredits: () => 0,
  visualExportCredits: () => 0,
  speedBoostMultiplier: (speedBoost) => {
    if (typeof speedBoost !== "boolean") throw new Error("speedBoost must be a boolean");
    return 1;
  },
  pageChargeShare: () => 1,
  qualityModePricing: () => ({
    creditsPer1kPages: { min: OPEN_CREDITS_PER_PAGE * 1000, max: OPEN_CREDITS_PER_PAGE * 1000 },
    priceNote: "Every page is charged the same flat rate, however it is read.",
  }),
  publicPrices: () => ({
    rule: "flat",
    creditsPerPage: OPEN_CREDITS_PER_PAGE,
    mediaMinutePages: 1,
    note: "Open pricing default: a flat per-page charge; storage, search and chat are not charged.",
    summary: `Pay per use: ${OPEN_CREDITS_PER_PAGE * 1000} credits per 1,000 pages or media minutes.`,
  }),
  estimateIngest: openEstimateIngest,
  quoteUpload: openQuoteUpload,
  quote: (args) => assembleEstimateQuote({
    ...args,
    ingest: openQuoteUpload({ files: args.files, profile: args.profile, speedBoost: args.settings.speedBoost }),
    bytes: openStoredBytes,
    version: "open-1",
    validForMs: 60 * 60 * 1000,
  }),
  internalCost: {
    computeRates: () => null,
    listCredits: () => null,
    sandboxCostCents: () => 0,
    sandboxRatesObservedAt: () => null,
    workerSlotUsdPerHour: () => null,
  },
};

