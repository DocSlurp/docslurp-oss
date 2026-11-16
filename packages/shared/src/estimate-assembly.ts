/*
 * Assemble an EstimateQuote from a provider's parts: its ingest quote (`quoteUpload`), its stored-bytes model and its unit
 * prices (through the billing delegates, which call the active provider). Providers call this so every estimate has the
 * same shape and the same neutral lines; what each part costs stays the provider's.
 *
 * Imports only modules that do not need the pricing provider at load time (pricing-provider.ts imports the open default,
 * which imports this).
 */
import { chatAnswerCredits, creditsToDollars, expectedVisualExportCredits, searchCredits, storageCreditsPerMonth } from "./billing.js";
import { defaultChartExportConfig, type ChartExportFormat } from "./chart-export.js";
import { expectedBillableVisuals } from "./chart-export-estimate.js";
import type { EstimateLine, EstimateQuote, ProviderEstimateArgs } from "./estimate-quote.js";
import type { CostEstimate } from "./jobs.js";
import type { UploadMediaEstimate } from "./media-upload-estimate.js";
import type { ChatAnswerTier } from "./pricing-provider.js";
import { quoteFilePageRange } from "./upload-pages.js";
import { uploadMediaKind } from "./media-upload-estimate.js";
import type { QuoteFile } from "./upload-quote.js";

export type Range = { low: number; high: number };

/** Bytes kept per file for hosting: originals plus what processing derives, as a range. */
export type StoredBytesModel = (file: QuoteFile, pages: Range, settings: ProviderEstimateArgs["settings"]) => Range;

/** Text characters a file holds, from its profile's measured text volume, else from its pages (an estimate). */
export function profiledTextChars(file: QuoteFile, pages: Range, charsPerPage: number): Range {
  const profile = file.profile;
  if (profile?.textChars !== undefined) return { low: profile.textChars, high: profile.textChars };
  if (profile?.pdf && profile.pdf.sampledPages > 0 && profile.pages) {
    // Words on the sampled pages, scaled to the document, at about six characters a word.
    const perPage = (profile.pdf.sampledWords / profile.pdf.sampledPages) * 6;
    return { low: perPage * pages.low, high: perPage * pages.high };
  }
  if (profile?.office && profile.office.bodyBytes > 0) {
    // Office body XML is mostly markup: its text is a fraction of it.
    return { low: profile.office.bodyBytes * 0.05, high: profile.office.bodyBytes * 0.25 };
  }
  return { low: pages.low * charsPerPage * 0.2, high: pages.high * charsPerPage };
}

/** Page area of a file's pages in square inches, from its profile, else a letter page. */
export function profiledPageArea(file: QuoteFile): number {
  const area = file.profile?.pdf?.medianPageAreaSqIn;
  return area && area > 0 ? area : 93.5;
}

const sum = (ranges: readonly Range[]): Range => ranges.reduce((total, range) => ({ low: total.low + range.low, high: total.high + range.high }), { low: 0, high: 0 });
const scale = (range: Range, factor: number): Range => ({ low: range.low * factor, high: range.high * factor });
const ordered = (range: Range): Range => ({ low: Math.min(range.low, range.high), high: Math.max(range.low, range.high) });
const round5 = (value: number) => Math.round(value * 100_000) / 100_000;
const rounded = (range: Range): Range => ({ low: round5(range.low), high: round5(range.high) });

/**
 * Build the estimate. `ingest` is the provider's upload quote for these files and settings; `bytes` its stored-bytes
 * model; `validForMs` how long the provider expects these prices to stay current. Prices may change without notice, so
 * `validUntil` is a freshness hint for re-quoting, never a price guarantee; billing follows what processing measures.
 */
export function assembleEstimateQuote(args: ProviderEstimateArgs & {
  ingest: { estimate: CostEstimate; media: UploadMediaEstimate | null };
  bytes: StoredBytesModel;
  version: string;
  validForMs: number;
  now?: Date;
}): EstimateQuote {
  const { files, settings } = args;
  // Stage-priced work on stored documents replaces the upload quote.
  const ingest = args.work ?? args.ingest;
  const billed = args.profile.billing === "enforced";
  const paged = files.filter((file) => !uploadMediaKind(file));
  // Page equivalents: a stuffed page holds (and is billed as) more than one page; hosting scales with what it holds.
  const pageRanges = new Map(paged.map((file) => {
    const range = quoteFilePageRange(file);
    const extra = Math.max(0, (file.pageEquivalents ?? range.central) - range.central);
    const extraHigh = Math.max(extra, (file.pageEquivalentsHigh ?? file.pageEquivalents ?? range.central) - range.central);
    return [file, { ...range, low: range.low + extra, central: range.central + extra, high: range.high + extraHigh }] as const;
  }));
  const pages = sum([...pageRanges.values()].map((range) => ({ low: range.low, high: range.high })));
  const stored = ordered(sum(files.map((file) => args.bytes(file, pageRanges.get(file) ?? { low: 0, high: 0 }, settings))));
  const storagePerMonth = { low: storageCreditsPerMonth(stored.low), high: storageCreditsPerMonth(stored.high) };
  const searches = searchCredits(settings.searchesPerMonth, {});
  const chat = settings.chatAnswersPerMonth * chatAnswerCredits({ tier: settings.chatTier as ChatAnswerTier });
  const media = ingest.media?.credits ?? { low: 0, high: 0 };
  // Reading charts with AI (the `models` tier, already resolved for the caller and capped by the deploy switch): billed per
  // chart or diagram a model reads, from the per-page planning prior over the quoted pages. Stage-priced work (`work`)
  // already includes it (estimatePipelineWork), so only an upload quote adds the line. `free` and `off` cost nothing.
  const charts = billed && !args.work && settings.chartExport === "models" ? chartCredits(pages, paged.length, settings) : null;
  const ingestCredits = ingest.estimate.credits && charts
    ? { low: ingest.estimate.credits.low + charts.low, high: ingest.estimate.credits.high + charts.high }
    : ingest.estimate.credits;
  const providerCredits = ingest.estimate.credits;
  const pageCredits = providerCredits ? ordered({ low: Math.max(0, providerCredits.low - media.low), high: Math.max(0, providerCredits.high - media.high) }) : null;
  const lines: EstimateLine[] = [];
  if (billed && pageCredits && pages.high > 0) lines.push({ id: "pages", label: "Document pages", period: "once", credits: rounded(pageCredits) });
  if (billed && ingest.media) lines.push({ id: "media", label: "Audio and video minutes", period: "once", credits: rounded(media) });
  if (charts) lines.push({ id: "charts", label: "Charts read with AI", period: "once", credits: rounded(charts) });
  if (billed) lines.push({ id: "storage", label: "Storage and search index", period: "month", credits: rounded(storagePerMonth) });
  if (billed && settings.searchesPerMonth > 0) lines.push({ id: "search", label: "Searches", period: "month", credits: rounded({ low: searches, high: searches }) });
  if (billed && settings.chatAnswersPerMonth > 0) lines.push({ id: "chat", label: "Chat answers", period: "month", credits: rounded({ low: chat, high: chat }) });
  const seconds = ingest.estimate.seconds ?? { low: 0, high: 0 };
  const minutes = (value: number) => Math.max(value, 1) / 60;
  const pagesPerMinute = rounded({ low: pages.low / minutes(seconds.high), high: pages.high / minutes(seconds.low) });
  const dollars = ingestCredits ? { low: creditsToDollars(ingestCredits.low), high: creditsToDollars(ingestCredits.high) } : null;
  const now = args.now ?? new Date();
  return {
    kind: "estimate",
    pricingVersion: args.version,
    validUntil: new Date(now.getTime() + Math.max(0, args.validForMs)).toISOString(),
    billing: args.profile.billing,
    settings,
    files: { total: files.length, profiled: files.filter((file) => file.profile).length },
    pages: { low: Math.round(pages.low), high: Math.round(pages.high) },
    mediaMinutes: Math.round(((ingest.media?.audioMinutes ?? 0) + (ingest.media?.videoMinutes ?? 0)) * 10) / 10,
    ingest: { credits: ingestCredits ? rounded(ingestCredits) : null, seconds: rounded(seconds) },
    hosting: {
      bytes: { low: Math.round(stored.low), high: Math.round(stored.high) },
      creditsPerMonth: billed ? rounded(storagePerMonth) : null,
      months: settings.hostingMonths,
      credits: billed ? rounded(scale(storagePerMonth, settings.hostingMonths)) : null,
    },
    usage: { creditsPerMonth: billed ? rounded({ low: searches + chat, high: searches + chat }) : null },
    lines,
    rates: {
      // The expensive end (most pages, highest price) and the cheap end (fewest pages, lowest price), per dollar.
      pagesPerDollar: dollars && dollars.low > 0 && dollars.high > 0 && pages.high > 0
        ? ordered({ low: Math.round(pages.high / dollars.high), high: Math.round(pages.low / dollars.low) })
        : null,
      pagesPerMinute,
    },
    basis: ingest.estimate.basis,
  };
}

/**
 * Credits for reading the expected charts and diagrams with AI over `pages` pages, with the formats and diagrams the
 * quote's settings carry (the project's own), from the per-page prior: the same rule as the upload's `chartExport`.
 */
function chartCredits(pages: { low: number; high: number }, documents: number, settings: { chartFormats?: readonly ChartExportFormat[]; chartDiagrams?: boolean }): { low: number; high: number } {
  const formats = settings.chartFormats?.length ? [...settings.chartFormats] : defaultChartExportConfig.formats;
  const config = { ...defaultChartExportConfig, formats, diagrams: settings.chartDiagrams ?? defaultChartExportConfig.diagrams };
  const at = (count: number) => expectedBillableVisuals({ config, pages: count, documents: Math.max(1, documents) });
  // First reads plus the expected billed second reads (one repair or cut-off retry per chart at most), priced by the
  // active provider: the same function the stage estimate (`chartExportCredits`) uses, so the line equals its credits.
  return ordered({
    low: expectedVisualExportCredits({ visuals: at(pages.low).low, formats }),
    high: expectedVisualExportCredits({ visuals: at(pages.high).high, formats }),
  });
}
