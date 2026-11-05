import { z } from "zod";

import {
  DOCUMENT_FEATURES,
  FIXED_OVERHEAD_SECONDS,
  PRICE_CARD_VERSION,
  estimateIngest,
  isBillingEnforced,
  MEDIA_BYTES_PER_MINUTE,
  richPagesForOutputTokens,
  speedBoostMultiplier,
  type DocumentFeature,
  type PageMix,
  type PipelineProfileId,
  pipelineProfileIdSchema,
} from "./billing.js";
import { fileExtension, FILE_FORMATS } from "./file-formats.js";
import { costEstimateSchema, type CostEstimate } from "./jobs.js";
import {
  estimateUploadMedia,
  isUploadImageFile,
  isUploadTextFile,
  TEXT_PAGE_CHARS,
  TEXT_PAGE_MIME_PREFIXES,
  uploadMediaKind,
  type UploadMediaEstimate,
  type UploadMediaFile,
} from "./media-upload-estimate.js";
import { compilePipelinePlan, type PipelineFeatures } from "./pipeline.js";

/*
 * Upload quotes without a database: what `POST /v1/uploads/estimate` returns, computed from an EstimateProfile (the
 * workspace's compiled pipeline reduced to what pricing reads) and the files. The server and the offline estimator
 * (`packages/estimate`, Rust/WASM) both price uploads with this function's rules; the Rust port is held to it by the
 * golden cases `estimate-card.test.ts` writes.
 */

/** Pages assumed for a file whose page count the client does not know (about 75 KB of source per page): the middle of its range. */
export const ASSUMED_BYTES_PER_PAGE = 75 * 1024;
/**
 * The ends of that range. A page of source is anywhere from a bilevel scan or dense vector page (about 16 KB) to a photographic
 * scan (about 300 KB), so a file of unknown page count is quoted over the pages those sizes give, not at one guess. The high end is
 * a ceiling only when pages are measured.
 */
export const UNMEASURED_MIN_BYTES_PER_PAGE = 16 * 1024;
export const UNMEASURED_MAX_BYTES_PER_PAGE = 300 * 1024;
/**
 * Text files of unknown line count: pages by characters need 3,500 per page (UTF-8; a UTF-16 file has half as many characters per
 * byte), pages by lines up to one per 12 bytes of line (60 lines, the shortest lines a text file realistically has).
 */
export const UNMEASURED_TEXT_MAX_BYTES_PER_PAGE = 7_000;
export const UNMEASURED_TEXT_MIN_BYTES_PER_PAGE = 720;

/**
 * Formats whose page count only the worker can measure (it converts or parses the file): intake counts them as one page and the
 * page count is `assumed`. A file of these is priced over its size, at bytes per page that hold for the format rather than for a scan:
 * a Word, slide, sheet or EPUB file holds a page in a few KB to a few tens of KB, far below a PDF's 16 KB to 300 KB scanned page.
 */
export type WorkerCountedFormat = "office-word" | "office-other" | "office-excel" | "office-pptx" | "epub";
export const WORKER_COUNTED_FORMATS: readonly WorkerCountedFormat[] = ["office-word", "office-other", "office-excel", "office-pptx", "epub"];
/**
 * Bytes of source per page for each of those formats, as `[min, typical, max]`: `min` is the densest file (the most pages: the
 * high end of a quote), `typical` prices the middle, `max` is an image-heavy file (the fewest pages: the low end). Judgement
 * from what the formats hold (compressed text, a page of a .docx is 1 to 7 KB; a slide is a few KB with no pictures and
 * 100 KB or more with them; a sheet page is 3,500 characters of CSV, about 1 KB compressed). They are quoted, never billed:
 * the worker measures the real count.
 */
export const UNMEASURED_WORKER_COUNTED_BYTES_PER_PAGE: Readonly<Record<WorkerCountedFormat, { min: number; typical: number; max: number }>> = {
  "office-word": { min: 1_024, typical: 12 * 1024, max: 150 * 1024 },
  "office-other": { min: 2_048, typical: 24 * 1024, max: 300 * 1024 },
  "office-excel": { min: 512, typical: 4 * 1024, max: 300 * 1024 },
  "office-pptx": { min: 2_048, typical: 40 * 1024, max: 300 * 1024 },
  epub: { min: 1_024, typical: 6 * 1024, max: 300 * 1024 },
};

/**
 * Of those, the formats no model ever reads, in any quality: Word, legacy Office, OpenDocument, RTF, slide and sheet files have their
 * text extracted and are never rendered for a vision model, so each of their pages bills Fast. A quote prices them Fast at both ends.
 */
export const FAST_ONLY_FORMATS: readonly WorkerCountedFormat[] = ["office-word", "office-other", "office-excel", "office-pptx"];

/**
 * Whether a file's pages bill Fast whatever the workspace's quality (FAST_ONLY_FORMATS). A page mix the client sent does not change
 * that: no model reads these files, so a measured scanned share would quote Rich pages the worker never bills.
 */
export function isFastOnlyFile(file: { name: string; type?: string | null }): boolean {
  const format = workerCountedFormat(file);
  return format !== null && FAST_ONLY_FORMATS.includes(format);
}

/**
 * The MIME types and extensions that make a file one of those formats (the card ships them for ports that cannot import the table).
 * A MIME type the API counts as text (`text/rtf`) is left out: intake counts such a file from its text.
 */
export function workerCountedFormatTable(): Array<{ format: WorkerCountedFormat; mimeTypes: string[]; extensions: string[] }> {
  cachedFormatTable ??= WORKER_COUNTED_FORMATS.map((format) => {
    const specs = FILE_FORMATS.filter((spec) => spec.format === format);
    return {
      format,
      mimeTypes: [...new Set(specs.flatMap((spec) => [spec.mimeType, ...(spec.aliases ?? [])]))]
        .filter((type) => !TEXT_PAGE_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))),
      extensions: [...new Set(specs.flatMap((spec) => spec.extensions.map((extension) => extension.slice(1))))],
    };
  });
  return cachedFormatTable;
}
let cachedFormatTable: Array<{ format: WorkerCountedFormat; mimeTypes: string[]; extensions: string[] }> | null = null;

/**
 * The worker-counted format of a file: its declared MIME type when one of them claims it, else its extension when the type is absent
 * or generic (the rule `isUploadImageFile` and `isUploadTextFile` follow, which the offline estimator's port repeats).
 */
export function workerCountedFormat(file: { name: string; type?: string | null }): WorkerCountedFormat | null {
  const type = (file.type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const table = workerCountedFormatTable();
  const byType = table.find((entry) => entry.mimeTypes.includes(type));
  if (byType) return byType.format;
  if (type !== "" && type !== "application/octet-stream") return null;
  const extension = fileExtension(file.name).slice(1);
  return table.find((entry) => entry.extensions.includes(extension))?.format ?? null;
}

/**
 * Where intake's page count came from: `counted` (a PDF's own count, the text rule over a text file, a single-frame image's one page)
 * or `assumed` (one page for a format only the worker can count, and for a multi-frame image, whose frames the OCR engine counts).
 * Stored as documents.page_count_source (migration 0126).
 */
export type PageCountSource = "counted" | "assumed";
export function intakePageCountSource(file: { name: string; type?: string | null }): PageCountSource {
  return workerCountedFormat(file) || isMultiFrameImageFile(file) ? "assumed" : "counted";
}

/**
 * The pages a cost forecast may pass as counted for a stored document: the worker's measured billing pages, else intake's page count
 * when intake counted it. An assumed count is left out so the forecast prices the file's size instead of one page.
 */
export function countedPagesForForecast(document: { pageCount: number; billingPages?: number | null; pageCountSource?: string | null }): number | undefined {
  if (Number(document.billingPages) > 0) return Number(document.billingPages);
  return document.pageCountSource !== "assumed" && Number(document.pageCount) > 0 ? Number(document.pageCount) : undefined;
}

/** Pages of a file of `format` from its size alone, at the format's typical bytes per page (at least 1). */
export function pagesFromSize(format: WorkerCountedFormat, sizeBytes: number): number {
  return Math.max(1, Math.ceil(Math.max(0, sizeBytes) / UNMEASURED_WORKER_COUNTED_BYTES_PER_PAGE[format].typical));
}

/**
 * Frames one multi-frame image file (a TIFF) may hold: the OCR engine reads each frame as a page, and refuses a file with more
 * (split it, or upload a PDF). A quote prices a TIFF's frames as its pages, up to this many.
 */
export const IMAGE_MAX_FRAMES = 64;
/** Image formats that can hold several frames (pages). */
export const MULTI_FRAME_IMAGE_MIME_TYPES: readonly string[] = ["image/tiff", "image/tiff-fx"];
export const MULTI_FRAME_IMAGE_EXTENSIONS: readonly string[] = ["tif", "tiff"];

/** Whether a file is a multi-frame image: its declared type, else its extension when the type is absent or generic. */
export function isMultiFrameImageFile(file: { name: string; type?: string | null }): boolean {
  const type = (file.type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (MULTI_FRAME_IMAGE_MIME_TYPES.includes(type)) return true;
  if (type !== "" && type !== "application/octet-stream") return false;
  return MULTI_FRAME_IMAGE_EXTENSIONS.includes(fileExtension(file.name).slice(1));
}

/** The cheap end of a quote when a file's page mix is unknown: every page has a text layer. */
export const QUOTE_LOW_MIX: Readonly<PageMix> = { text: 1, complex: 0, scanned: 0 };
/** The expensive end when the mix is unknown: every page is read by a vision model (Rich). */
export const QUOTE_HIGH_MIX: Readonly<PageMix> = { text: 0, complex: 0, scanned: 1 };
/**
 * Output tokens of a dense full page, for the top of a quote. A Rich page whose output exceeds richIncludedOutputTokens bills extra
 * Rich pages (richPagesForOutputTokens), so each Rich page at the high end counts as this many.
 */
export const QUOTE_HIGH_RICH_OUTPUT_TOKENS = 2_000;
export const QUOTE_HIGH_RICH_PAGE_FACTOR = richPagesForOutputTokens(QUOTE_HIGH_RICH_OUTPUT_TOKENS);

export const pageMixSchema = z.strictObject({
  text: z.number().nonnegative(),
  complex: z.number().nonnegative(),
  scanned: z.number().nonnegative(),
});

/** Every page scanned: an image file read whole. */
const IMAGE_FILE_MIX: Readonly<PageMix> = { text: 0, complex: 0, scanned: 1 };
/** Every page text: a text file. */
const TEXT_FILE_MIX: Readonly<PageMix> = { text: 1, complex: 0, scanned: 0 };

/** One file of an upload quote, as `POST /v1/uploads/estimate` accepts it. Unknown fields are ignored. */
export const quoteFileSchema = z.object({
  name: z.string().min(1).max(1024),
  size: z.number().int().nonnegative().max(10 ** 13),
  pages: z.number().int().positive().max(10_000_000).optional(),
  /** MIME type, so audio, video and images are priced as such even when the name has no extension. */
  type: z.string().max(255).optional(),
  /** Length in seconds when the client can read it; otherwise estimated from the size. */
  durationSeconds: z.number().positive().max(24 * 3600).optional(),
  /** Page mix the client measured (offline probe, `@docslurp/estimate`); narrows the price range. Estimate only, never billed. */
  mix: pageMixSchema.optional(),
  /** 0-1 trust in `mix`; default 1. */
  mixConfidence: z.number().min(0).max(1).optional(),
});

/** What pricing an upload reads from a workspace: its compiled pipeline and org capacity, nothing else. */
export const estimateProfileSchema = z.strictObject({
  /** PRICE_CARD_VERSION the profile was built against. */
  cardVersion: z.string(),
  quality: pipelineProfileIdSchema,
  /** Optional per-document features whose stage runs on upload. */
  documentFeatures: z.strictObject({
    documentSummary: z.boolean(),
    structuredFields: z.boolean(),
    knowledgeGraph: z.boolean(),
    propositions: z.boolean(),
  }),
  /** Whether video frames are read (`mediaVideo.enabled`), which triples a video minute's price. */
  videoFrames: z.boolean(),
  /** Org concurrent worker ceiling; omitted uses FUNDED_WORKER_SLOTS. */
  workerSlots: z.number().int().positive().optional(),
  /** Stages an upload runs; only shown in the estimate's basis. */
  stageCount: z.number().int().nonnegative(),
  billing: z.enum(["enforced", "disabled"]),
});
export type EstimateProfile = z.infer<typeof estimateProfileSchema>;

/** Reduce a workspace pipeline to its EstimateProfile, exactly as the upload estimate prices it. */
export function estimateProfileFor(
  pipeline: PipelineFeatures,
  options: { workerSlots?: number; env: Record<string, string | undefined> },
): EstimateProfile {
  const stages = compilePipelinePlan(pipeline).stageOrder;
  return {
    cardVersion: PRICE_CARD_VERSION,
    quality: pipeline.quality,
    documentFeatures: {
      documentSummary: stages.includes("document-summary"),
      structuredFields: stages.includes("structured-extract"),
      knowledgeGraph: stages.includes("graph-enrich") && Boolean(pipeline.graphRag),
      propositions: stages.includes("proposition-index"),
    },
    videoFrames: pipeline.mediaVideo?.enabled !== false,
    ...(options.workerSlots ? { workerSlots: options.workerSlots } : {}),
    stageCount: stages.length,
    billing: isBillingEnforced(options.env) ? "enforced" : "disabled",
  };
}

/**
 * `mix` is normalized, so any non-negative weights work; `mixConfidence` (default 1) is the share of each end of the
 * range taken from `mix`, the rest staying at the unknown-mix bound.
 */
export type QuoteFile = UploadMediaFile & {
  pages?: number;
  mix?: PageMix;
  mixConfidence?: number;
};

/** Where a file's page count sits: the cheap end, the middle, and the expensive end; `measured` when the client counted them. */
export type PageRange = { low: number; central: number; high: number; measured: boolean };

/**
 * Pages a non-media file counts as: its known page count; else 1 for an image file, its size over TEXT_PAGE_CHARS
 * for a text file, and its size at ASSUMED_BYTES_PER_PAGE for anything else (at least 1). A TIFF counts its frames (1 when not
 * counted), at most IMAGE_MAX_FRAMES.
 */
export function quoteFilePages(file: { name: string; type?: string | null; size: number; pages?: number }): number {
  // A TIFF's frames are its pages, up to the frames one file may hold (more are refused, never read or billed).
  if (isMultiFrameImageFile(file)) return Math.max(1, Math.min(IMAGE_MAX_FRAMES, Math.round(file.pages ?? 1)));
  const counted = file.pages === undefined ? workerCountedFormat(file) : null;
  const pages = file.pages
    ?? (isUploadImageFile(file)
      ? 1
      // Text pages count characters (TEXT_PAGE_CHARS each); bytes bound them from above for UTF-8.
      : isUploadTextFile(file)
        ? Math.ceil(file.size / TEXT_PAGE_CHARS)
        : counted
          ? pagesFromSize(counted, file.size)
          : Math.ceil(file.size / ASSUMED_BYTES_PER_PAGE));
  return Math.max(1, Math.round(pages));
}

/** Pages of a file over the range its size allows when the client has not counted them; one value when they are known. */
export function quoteFilePageRange(file: { name: string; type?: string | null; size: number; pages?: number }): PageRange {
  const central = quoteFilePages(file);
  // An uncounted TIFF holds one frame to as many as its size allows at the densest page, up to IMAGE_MAX_FRAMES.
  if (file.pages === undefined && isMultiFrameImageFile(file)) {
    return { low: 1, central, high: Math.max(central, Math.min(IMAGE_MAX_FRAMES, Math.ceil(file.size / UNMEASURED_MIN_BYTES_PER_PAGE))), measured: false };
  }
  if (file.pages !== undefined || isUploadImageFile(file)) return { low: central, central, high: central, measured: true };
  const counted = workerCountedFormat(file);
  const [lowDivisor, highDivisor] = isUploadTextFile(file)
    ? [UNMEASURED_TEXT_MAX_BYTES_PER_PAGE, UNMEASURED_TEXT_MIN_BYTES_PER_PAGE]
    : counted
      ? [UNMEASURED_WORKER_COUNTED_BYTES_PER_PAGE[counted].max, UNMEASURED_WORKER_COUNTED_BYTES_PER_PAGE[counted].min]
      : [UNMEASURED_MAX_BYTES_PER_PAGE, UNMEASURED_MIN_BYTES_PER_PAGE];
  return {
    low: Math.max(1, Math.min(central, Math.round(Math.ceil(file.size / lowDivisor)))),
    central,
    high: Math.max(central, Math.round(Math.ceil(file.size / highDivisor))),
    measured: false,
  };
}

/** A file's known page mix and its trust: measured, every page scanned for an image file, or all text for a text file. */
function knownMix(file: QuoteFile): { mix: PageMix; confidence: number } | null {
  if (file.mix && file.mix.text + file.mix.complex + file.mix.scanned > 0) return { mix: file.mix, confidence: file.mixConfidence ?? 1 };
  if (isUploadImageFile(file)) return { mix: IMAGE_FILE_MIX, confidence: 1 };
  // Text files have no scanned pages whatever their length; only their page count is uncertain (quoteFilePageRange).
  if (isUploadTextFile(file)) return { mix: TEXT_FILE_MIX, confidence: 1 };
  return null;
}

function blendedMix(mix: PageMix, confidence: number, bound: Readonly<PageMix>): PageMix {
  const total = mix.text + mix.complex + mix.scanned;
  if (!(total > 0)) return { ...bound };
  const trust = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 1;
  return {
    text: (mix.text / total) * trust + bound.text * (1 - trust),
    complex: (mix.complex / total) * trust + bound.complex * (1 - trust),
    scanned: (mix.scanned / total) * trust + bound.scanned * (1 - trust),
  };
}

/**
 * The expensive end for a file with a known mix: blended toward the scan-heavy bound, but never below the measured
 * scanned share (blending a scan-heavy measurement toward a 50%-scanned bound would lower the high end).
 */
function highMix(mix: PageMix, confidence: number): PageMix {
  const blended = blendedMix(mix, confidence, QUOTE_HIGH_MIX);
  const total = mix.text + mix.complex + mix.scanned;
  const measuredScanned = mix.scanned / total;
  return measuredScanned > blended.scanned ? { text: mix.text / total, complex: mix.complex / total, scanned: measuredScanned } : blended;
}

/**
 * The low and high page mixes of a set of paged files, as page counts: page-weighted, measured where a file carries a mix. The low end
 * counts a file's fewest pages as cheap text; the high end its most pages with the scanned share read by vision, each such page
 * counting QUOTE_HIGH_RICH_PAGE_FACTOR times (a dense page's output tokens).
 */
function quoteMixes(files: readonly QuoteFile[], richFactor: number): {
  low: PageMix; high: PageMix; fastLow: number; fastHigh: number; known: number; unmeasured: number; rangeLow: number; rangeHigh: number;
} {
  // A Word, slide or sheet file's pages are as known as a text file's: no model reads them.
  const known = files.filter((file) => isFastOnlyFile(file) || knownMix(file)).length;
  const low: PageMix = { text: 0, complex: 0, scanned: 0 };
  const high: PageMix = { text: 0, complex: 0, scanned: 0 };
  let fastLow = 0;
  let fastHigh = 0;
  let unmeasured = 0;
  let rangeLow = 0;
  let rangeHigh = 0;
  for (const file of files) {
    const range = quoteFilePageRange(file);
    if (!range.measured) unmeasured += 1;
    rangeLow += range.low;
    rangeHigh += range.high;
    // No model reads a Word, slide or sheet page in any quality: Fast at both ends, over its page range.
    if (isFastOnlyFile(file)) {
      fastLow += range.low;
      fastHigh += range.high;
      continue;
    }
    const mix = knownMix(file);
    const fileLow = mix ? blendedMix(mix.mix, mix.confidence, QUOTE_LOW_MIX) : QUOTE_LOW_MIX;
    const fileHigh = mix ? highMix(mix.mix, mix.confidence) : QUOTE_HIGH_MIX;
    low.text += range.low * fileLow.text;
    low.complex += range.low * fileLow.complex;
    low.scanned += range.low * fileLow.scanned;
    high.text += range.high * fileHigh.text;
    high.complex += range.high * fileHigh.complex;
    high.scanned += range.high * fileHigh.scanned * richFactor;
  }
  return { low, high, fastLow, fastHigh, known, unmeasured, rangeLow, rangeHigh };
}

/**
 * What the high end of a quote assumes of a page a vision model reads: a dense page's typical output, `factor` Rich pages. A
 * longer output bills one more Rich page per 1,000 tokens past the first 1,000, so the high end is typical, not a ceiling.
 */
function richHighEnd(factor: number): string {
  return `high end assumes ${factor} Rich pages for each page a vision model reads (a dense page's typical ${QUOTE_HIGH_RICH_OUTPUT_TOKENS.toLocaleString("en-US")}-token output; each further 1,000 output tokens bills one more, so it is typical, not a ceiling)`;
}

/** The bitrates durations are assumed at when a media file's length is not known, for the quote's basis text. */
function assumedBitrates(): string {
  const kbps = (bytesPerMinute: number) => Math.round((bytesPerMinute * 8) / 60 / 1000);
  const mbps = (bytesPerMinute: number) => Math.round((bytesPerMinute * 8) / 60 / 100_000) / 10;
  return `${kbps(MEDIA_BYTES_PER_MINUTE.audio)} kbps audio and ${mbps(MEDIA_BYTES_PER_MINUTE.video)} Mbps video`;
}

function roundUp5(value: number): number {
  return Math.ceil(value * 100_000) / 100_000;
}

/**
 * Price an upload of `files` into a workspace with `profile`. Audio and video are priced by duration (`media`, also
 * included in `estimate.credits`); everything else by page, over a range from the cheap to the expensive page mix.
 */
export function quoteUpload(args: {
  files: readonly QuoteFile[];
  profile: EstimateProfile;
  speedBoost?: boolean;
}): { estimate: CostEstimate; media: UploadMediaEstimate | null } {
  // A profile from a newer server (unknown quality or feature) is refused rather than priced as something cheaper.
  const profile = estimateProfileSchema.parse(args.profile);
  const multiplier = speedBoostMultiplier(args.speedBoost === true);
  const paged = args.files.filter((file) => !uploadMediaKind(file));
  const pages = Math.max(0, Math.round(paged.reduce((sum, file) => sum + quoteFilePages(file), 0)));
  const documents = paged.length;
  // Fast never reads a page with a model, so no page can bill the extra Rich pages of a long output.
  const mixes = quoteMixes(paged, profile.quality === "fast" ? 1 : QUOTE_HIGH_RICH_PAGE_FACTOR);
  const features: Partial<Record<DocumentFeature, boolean>> = {};
  for (const feature of DOCUMENT_FEATURES) features[feature] = profile.documentFeatures[feature];

  // `mix` holds page counts; the pages priced are their sum, so each end of the range prices its own page count.
  const run = (mix: PageMix, bound: Readonly<PageMix>, fastOnly: number) => {
    const total = mix.text + mix.complex + mix.scanned;
    const fastOnlyPages = Math.max(0, Math.round(fastOnly));
    return estimateIngest({
      pages: total > 0 ? Math.max(0, Math.round(total)) : fastOnlyPages > 0 ? 0 : pages,
      fastOnlyPages,
      documents: Math.max(1, documents),
      mix: total > 0 ? mix : { ...bound },
      profile: profile.quality as PipelineProfileId,
      features,
      ...(profile.workerSlots ? { workerSlots: profile.workerSlots } : {}),
    });
  };
  // Same arithmetic as estimatePipelineWork with every planned stage selected, so results match it bit for bit.
  const pagedCredits = (estimate: ReturnType<typeof estimateIngest>) =>
    (estimate.credits.totalCredits - estimate.credits.breakdown.features) + estimate.credits.breakdown.features;
  const low = run(mixes.low, QUOTE_LOW_MIX, mixes.fastLow);
  const high = run(mixes.high, QUOTE_HIGH_MIX, mixes.fastHigh);
  const seconds = (wall: number) => (pages > 0 ? Math.max(0, wall - FIXED_OVERHEAD_SECONDS) + FIXED_OVERHEAD_SECONDS : 0);
  const mixRange = mixes.known === 0
    ? "range from all-text to every page read by vision"
    : mixes.known === documents
      ? "page mix known for every file"
      : `page mix known for ${mixes.known} of ${documents} files, others range from all-text to every page read by vision`;
  const range = mixes.unmeasured === 0
    ? mixRange
    : `${mixRange}; pages not counted for ${mixes.unmeasured} of ${documents} files, assumed ${Math.max(0, Math.round(mixes.rangeLow))} to ${Math.max(0, Math.round(mixes.rangeHigh))} from their sizes`;
  // A TIFF with more frames than one file may hold is refused unread; it is quoted at the cap, the most it could bill.
  const tooManyFrames = paged.filter((file) => isMultiFrameImageFile(file) && (file.pages ?? 0) > IMAGE_MAX_FRAMES).length;
  const framesNote = tooManyFrames > 0
    ? `${tooManyFrames} image ${tooManyFrames === 1 ? "file holds" : "files hold"} more than ${IMAGE_MAX_FRAMES} frames and will be refused (quoted at ${IMAGE_MAX_FRAMES}); `
    : "";
  const pagedEstimate = costEstimateSchema.parse({
    pages,
    documents,
    billing: profile.billing,
    credits: profile.billing === "disabled"
      ? null
      : { low: roundUp5(pagedCredits(low)) * multiplier, high: roundUp5(pagedCredits(high)) * multiplier },
    seconds: { low: roundUp5(seconds(low.wallSeconds)), high: roundUp5(seconds(high.wallSeconds)) },
    ...(mixes.unmeasured > 0
      ? { pagesRange: { low: Math.max(0, Math.round(mixes.rangeLow)), high: Math.max(0, Math.round(mixes.rangeHigh)) }, unmeasuredFiles: mixes.unmeasured }
      : {}),
    basis: `${profile.quality} profile, ${profile.stageCount} of ${profile.stageCount} stages; ${range}; `
      + (profile.quality === "fast" ? "" : `${richHighEnd(QUOTE_HIGH_RICH_PAGE_FACTOR)}; `)
      + framesNote
      + "modeled averages, not measured for this corpus",
  });

  const media = estimateUploadMedia(args.files, { videoFrames: profile.videoFrames });
  if (media) {
    media.credits = { low: media.credits.low * multiplier, high: media.credits.high * multiplier };
    if (media.lighter) {
      media.lighter.credits *= multiplier;
      media.lighter.savedCredits *= multiplier;
    }
  }
  if (!media) return { estimate: pagedEstimate, media };
  // Media files add their own price; the page estimate already covers any other files in the batch.
  return {
    media,
    estimate: {
      ...pagedEstimate,
      documents: pagedEstimate.documents + media.audioFiles + media.videoFiles,
      credits: pagedEstimate.credits
        ? { low: pagedEstimate.credits.low + media.credits.low, high: pagedEstimate.credits.high + media.credits.high }
        : null,
      basis: `${pagedEstimate.basis}; audio and video priced by duration${media.durationsAssumed ? ` (not read from every file: assumed from size at ${assumedBitrates()})` : ""}`,
    },
  };
}
