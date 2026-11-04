import { z } from "zod";

import {
  DOCUMENT_FEATURES,
  FIXED_OVERHEAD_SECONDS,
  PRICE_CARD_VERSION,
  estimateIngest,
  isBillingEnforced,
  speedBoostMultiplier,
  type DocumentFeature,
  type PageMix,
  type PipelineProfileId,
  pipelineProfileIdSchema,
} from "./billing.js";
import { costEstimateSchema, type CostEstimate } from "./jobs.js";
import {
  estimateUploadMedia,
  isUploadImageFile,
  isUploadTextFile,
  TEXT_PAGE_CHARS,
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

/** Pages assumed for a file whose page count the client does not know (about 75 KB of source per page). */
export const ASSUMED_BYTES_PER_PAGE = 75 * 1024;

/** The cheap end of a quote when a file's page mix is unknown: every page has a text layer. */
export const QUOTE_LOW_MIX: Readonly<PageMix> = { text: 1, complex: 0, scanned: 0 };
/** The expensive end when the mix is unknown: a scan-heavy corpus. */
export const QUOTE_HIGH_MIX: Readonly<PageMix> = { text: 0.2, complex: 0.3, scanned: 0.5 };

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

/**
 * Pages a non-media file counts as: its known page count; else 1 for an image file, its size over TEXT_PAGE_CHARS
 * for a text file, and its size at ASSUMED_BYTES_PER_PAGE for anything else (at least 1).
 */
export function quoteFilePages(file: { name: string; type?: string | null; size: number; pages?: number }): number {
  const pages = file.pages
    ?? (isUploadImageFile(file)
      ? 1
      // Text pages count characters (TEXT_PAGE_CHARS each); bytes bound them from above for UTF-8.
      : isUploadTextFile(file)
        ? Math.ceil(file.size / TEXT_PAGE_CHARS)
        : Math.ceil(file.size / ASSUMED_BYTES_PER_PAGE));
  return Math.max(1, Math.round(pages));
}

/** A file's known page mix and its trust: measured, every page scanned for an image file, or all text for a text file. */
function knownMix(file: QuoteFile): { mix: PageMix; confidence: number } | null {
  if (file.mix && file.mix.text + file.mix.complex + file.mix.scanned > 0) return { mix: file.mix, confidence: file.mixConfidence ?? 1 };
  if (isUploadImageFile(file)) return { mix: IMAGE_FILE_MIX, confidence: 1 };
  // Text files have no scanned pages: their pages bill Fast in every profile that bills by page class.
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

/** The low and high page mixes of a set of paged files: page-weighted, measured where a file carries a mix. */
function quoteMixes(files: readonly QuoteFile[]): { low: PageMix; high: PageMix; known: number } {
  const known = files.filter((file) => knownMix(file)).length;
  if (known === 0) return { low: { ...QUOTE_LOW_MIX }, high: { ...QUOTE_HIGH_MIX }, known };
  const low: PageMix = { text: 0, complex: 0, scanned: 0 };
  const high: PageMix = { text: 0, complex: 0, scanned: 0 };
  for (const file of files) {
    const pages = quoteFilePages(file);
    const mix = knownMix(file);
    const fileLow = mix ? blendedMix(mix.mix, mix.confidence, QUOTE_LOW_MIX) : QUOTE_LOW_MIX;
    const fileHigh = mix ? blendedMix(mix.mix, mix.confidence, QUOTE_HIGH_MIX) : QUOTE_HIGH_MIX;
    low.text += pages * fileLow.text;
    low.complex += pages * fileLow.complex;
    low.scanned += pages * fileLow.scanned;
    high.text += pages * fileHigh.text;
    high.complex += pages * fileHigh.complex;
    high.scanned += pages * fileHigh.scanned;
  }
  return { low, high, known };
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
  const mixes = quoteMixes(paged);
  const features: Partial<Record<DocumentFeature, boolean>> = {};
  for (const feature of DOCUMENT_FEATURES) features[feature] = profile.documentFeatures[feature];

  const run = (mix: PageMix) => estimateIngest({
    pages,
    documents: Math.max(1, documents),
    mix,
    profile: profile.quality as PipelineProfileId,
    features,
    ...(profile.workerSlots ? { workerSlots: profile.workerSlots } : {}),
  });
  // Same arithmetic as estimatePipelineWork with every planned stage selected, so results match it bit for bit.
  const pagedCredits = (estimate: ReturnType<typeof run>) =>
    (estimate.credits.totalCredits - estimate.credits.breakdown.features) + estimate.credits.breakdown.features;
  const low = run(mixes.low);
  const high = run(mixes.high);
  const seconds = (wall: number) => (pages > 0 ? Math.max(0, wall - FIXED_OVERHEAD_SECONDS) + FIXED_OVERHEAD_SECONDS : 0);
  const range = mixes.known === 0
    ? "range from all-text to scan-heavy pages"
    : mixes.known === documents
      ? "page mix known for every file"
      : `page mix known for ${mixes.known} of ${documents} files, others range from all-text to scan-heavy pages`;
  const pagedEstimate = costEstimateSchema.parse({
    pages,
    documents,
    billing: profile.billing,
    credits: profile.billing === "disabled"
      ? null
      : { low: roundUp5(pagedCredits(low)) * multiplier, high: roundUp5(pagedCredits(high)) * multiplier },
    seconds: { low: roundUp5(seconds(low.wallSeconds)), high: roundUp5(seconds(high.wallSeconds)) },
    basis: `${profile.quality} profile, ${profile.stageCount} of ${profile.stageCount} stages; ${range}; `
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
      basis: `${pagedEstimate.basis}; audio and video priced by duration`,
    },
  };
}
