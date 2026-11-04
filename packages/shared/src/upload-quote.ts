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
import { estimateUploadMedia, uploadMediaKind, type UploadMediaEstimate, type UploadMediaFile } from "./media-upload-estimate.js";
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

export const pageMixSchema = z.object({
  text: z.number().nonnegative(),
  complex: z.number().nonnegative(),
  scanned: z.number().nonnegative(),
});

/** What pricing an upload reads from a workspace: its compiled pipeline and org capacity, nothing else. */
export const estimateProfileSchema = z.object({
  /** PRICE_CARD_VERSION the profile was built against. */
  cardVersion: z.string(),
  quality: pipelineProfileIdSchema,
  /** Optional per-document features whose stage runs on upload. */
  documentFeatures: z.object({
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

export type QuoteFile = UploadMediaFile & {
  pages?: number;
  /** Page mix measured on the client (offline probe); normalized, any positive weights work. */
  mix?: PageMix;
  /** 0-1 trust in `mix`; the rest of each end of the range stays at the unknown-mix bound. Default 1. */
  mixConfidence?: number;
};

/** Pages a non-media file counts as: its known page count, else its size at ASSUMED_BYTES_PER_PAGE (at least 1). */
export function quoteFilePages(file: { size: number; pages?: number }): number {
  return Math.max(1, Math.round(file.pages ?? Math.ceil(file.size / ASSUMED_BYTES_PER_PAGE)));
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
function quoteMixes(files: readonly QuoteFile[]): { low: PageMix; high: PageMix; measured: number } {
  const measured = files.filter((file) => file.mix).length;
  if (measured === 0) return { low: { ...QUOTE_LOW_MIX }, high: { ...QUOTE_HIGH_MIX }, measured };
  const low: PageMix = { text: 0, complex: 0, scanned: 0 };
  const high: PageMix = { text: 0, complex: 0, scanned: 0 };
  for (const file of files) {
    const pages = quoteFilePages(file);
    const fileLow = file.mix ? blendedMix(file.mix, file.mixConfidence ?? 1, QUOTE_LOW_MIX) : QUOTE_LOW_MIX;
    const fileHigh = file.mix ? blendedMix(file.mix, file.mixConfidence ?? 1, QUOTE_HIGH_MIX) : QUOTE_HIGH_MIX;
    low.text += pages * fileLow.text;
    low.complex += pages * fileLow.complex;
    low.scanned += pages * fileLow.scanned;
    high.text += pages * fileHigh.text;
    high.complex += pages * fileHigh.complex;
    high.scanned += pages * fileHigh.scanned;
  }
  return { low, high, measured };
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
  const { profile } = args;
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
  const range = mixes.measured === 0
    ? "range from all-text to scan-heavy pages"
    : `page mix measured for ${mixes.measured} of ${documents} files, others range from all-text to scan-heavy pages`;
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
