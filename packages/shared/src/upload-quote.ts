import { z } from "zod";

import { isBillingEnforced, pipelineProfileIdSchema, pricingVersion } from "./billing.js";
import { fileProfileSchema, normalizeFileProfile, type FileProfile } from "./file-profile.js";
import { type CostEstimate } from "./jobs.js";
import type { UploadMediaEstimate, UploadMediaFile } from "./media-upload-estimate.js";
import { pricing } from "./pricing-provider.js";

export * from "./upload-pages.js";
import { profilePageEquivalentRange } from "./upload-pages.js";
import { compilePipelinePlan, type PipelineFeatures } from "./pipeline.js";
import { figuresEnabled } from "./doppler-figures.js";

/*
 * Upload quotes without a database: what `POST /v1/uploads/estimate` returns. This module holds the generic parts (page
 * counts and ranges from a file's name, type and size, the project's EstimateProfile, file-profile merging); the price
 * itself is the pricing provider's (pricing-provider.ts).
 */

/** One file of an upload quote, as `POST /v1/uploads/estimate` accepts it. Unknown fields are ignored. */
export const quoteFileSchema = z.object({
  name: z.string().min(1).max(1024),
  size: z.number().int().nonnegative().max(10 ** 13),
  pages: z.number().int().positive().max(10_000_000).optional(),
  /** MIME type, so audio, video and images are priced as such even when the name has no extension. */
  type: z.string().max(255).optional(),
  /** Length in seconds when the client can read it; otherwise estimated from the size. */
  durationSeconds: z.number().positive().max(24 * 3600).optional(),
  /**
   * What the offline profiler (`@docslurp/estimate`) measured about the file (file-profile.ts). Untrusted: validated, clamped
   * against `size` and used only to estimate, never to charge.
   */
  profile: fileProfileSchema.optional(),
});

/** What pricing an upload reads from a project: its compiled pipeline and org capacity, nothing else. */
export const estimateProfileSchema = z.strictObject({
  /** Pricing version (the pricing provider's) the profile was built under. */
  pricingVersion: z.string().max(64),
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
  /** Org concurrent worker ceiling; omitted uses the provider's funded worker slots. */
  workerSlots: z.number().int().positive().optional(),
  /** Stages an upload runs; only shown in the estimate's basis. */
  stageCount: z.number().int().nonnegative(),
  /**
   * Whether this run extracts figures: the deploy flag (DOCSLURP_DOPPLER_IMAGE_EXTRACT) and the project's opt-out
   * (`pipeline.figures`, figuresEnabled). Stored figure files are billed as storage, measured after the fact
   * (QuoteFile.measured.assetBytes once stored); for a new upload a pricing provider may add its own prior when this is
   * true. Omitted means unknown.
   */
  figures: z.boolean().optional(),
  billing: z.enum(["enforced", "disabled"]),
});
export type EstimateProfile = z.infer<typeof estimateProfileSchema>;

/** figuresEnabled for an estimate: the deploy flag and the project's opt-out; a malformed flag is off here, never a throw. */
function figuresOn(pipeline: { figures?: boolean | null }, env: Record<string, string | undefined>): boolean {
  try { return figuresEnabled(pipeline, env); } catch { return false; }
}

/** Reduce a project pipeline to its EstimateProfile, exactly as the upload estimate prices it. */
export function estimateProfileFor(
  pipeline: PipelineFeatures,
  options: { workerSlots?: number; env: Record<string, string | undefined> },
): EstimateProfile {
  const stages = compilePipelinePlan(pipeline).stageOrder;
  return {
    pricingVersion: pricingVersion(),
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
    figures: figuresOn(pipeline as { figures?: boolean | null }, options.env),
    billing: isBillingEnforced(options.env) ? "enforced" : "disabled",
  };
}

/** One file to quote: name, size and type, a counted page count or duration when known, and the client's file profile. */
export type QuoteFile = UploadMediaFile & {
  pages?: number;
  /**
   * Page equivalents the billing measurement will count for the file (profilePageEquivalents), when its profile measured
   * them: the structural pages plus what stuffed pages hold beyond one page each. Never below `pages`.
   */
  pageEquivalents?: number;
  /** The high end of the page equivalents (profilePageEquivalentRange): wider when text was estimated or pages unsampled. */
  pageEquivalentsHigh?: number;
  /**
   * For a document already processed: its pages and how many a model read, as the worker recorded them (trusted), and the
   * bytes of its stored figure files (the asset ledger's level, billed as storage like the source).
   */
  measured?: { pages: number; readPages: number; assetBytes?: number };
  /**
   * Server-set for every stored-document group (storedQuoteFile), measured or not: the file is already stored, so a pricing
   * provider never adds a new-upload prior (e.g. figure bytes) to it. A client cannot set it (quoteFileSchema strips it).
   */
  stored?: true;
  profile?: FileProfile;
};

/**
 * Merge a validated, clamped profile's counts into a quote file: the counted pages, the read duration and the sniffed type,
 * each only where the caller gave none. The rest of the profile stays on `file.profile` for the pricing provider.
 */
export function applyFileProfile(file: QuoteFile): QuoteFile {
  if (!file.profile) return file;
  const profile = normalizeFileProfile(file.profile, file);
  if (!profile) {
    const { profile: _dropped, ...rest } = file;
    return rest;
  }
  return {
    ...file,
    ...(file.pages === undefined && profile.pages !== undefined ? { pages: profile.pages } : {}),
    ...(() => {
      const range = profilePageEquivalentRange({ ...(file.pages !== undefined ? { pages: file.pages } : {}), profile }, pricing().pageEquivalentAllowance);
      return range !== undefined ? { pageEquivalents: range.low, pageEquivalentsHigh: range.high } : {};
    })(),
    ...(file.durationSeconds === undefined && profile.durationSeconds !== undefined ? { durationSeconds: profile.durationSeconds } : {}),
    ...(!file.type && profile.mimeType ? { type: profile.mimeType } : {}),
    profile,
  };
}

/**
 * Quote an upload of `files` into a project with `profile`: the active pricing provider's estimate. File profiles are
 * validated, clamped and merged first (applyFileProfile). An estimate only: billing is measured by the worker.
 */
export function quoteUpload(args: {
  files: readonly QuoteFile[];
  profile: EstimateProfile;
  speedBoost?: boolean;
}): { estimate: CostEstimate; media: UploadMediaEstimate | null } {
  // A profile from a newer server (unknown quality or feature) is refused rather than priced as something cheaper.
  const profile = estimateProfileSchema.parse(args.profile);
  return pricing().quoteUpload({ files: args.files.map(applyFileProfile), profile, speedBoost: args.speedBoost === true });
}
