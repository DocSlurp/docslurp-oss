import {
  CREDITS_PER_DOLLAR,
  DOCUMENT_FEATURES,
  FIXED_OVERHEAD_SECONDS,
  FUNDED_WORKER_SLOTS,
  MAX_PAGE_FANOUT_PER_RUN,
  MEDIA_BYTES_PER_MINUTE,
  MEDIA_WORKER_SECONDS_PER_MINUTE,
  PARALLEL_EFFICIENCY,
  PIPELINE_PROFILES,
  PRICE_CARD,
  PRICE_CARD_VERSION,
  speedBoostMultiplier,
} from "./billing.js";
import { sha256Hex } from "./hash.js";
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  TEXT_EXTENSIONS,
  TEXT_PAGE_CHARS,
  TEXT_PAGE_LINES,
  TEXT_PAGE_MIME_PREFIXES,
  VIDEO_EXTENSIONS,
} from "./media-upload-estimate.js";
import { PAGE_RASTER_ROUTING } from "./page-raster-routing.js";
import { defaultPipelineFeatures } from "./pipeline.js";
import { ASSUMED_BYTES_PER_PAGE, estimateProfileFor, QUOTE_HIGH_MIX, QUOTE_LOW_MIX } from "./upload-quote.js";

/*
 * The offline estimator's card (`packages/estimate`): every price, planning constant and routing threshold its Rust
 * port reads. `estimate-card.test.ts` fails when the committed card.json or golden cases differ from what the
 * TypeScript produces; `UPDATE_ESTIMATE_CARD=1 pnpm --filter @docslurp/shared test estimate-card` rewrites them.
 * `GET /v1/billing/estimate-card` serves the same card, so offline builds can quote current prices.
 */

/** The card's JSON shape. A port rejects cards with another schema. */
export const ESTIMATE_CARD_SCHEMA = 2;
/**
 * Version of the pricing formulas (quoteUpload, estimateIngest, estimateUploadMedia, the file-type rules). Bump it
 * with any change to them, so a port built for other rules refuses the card instead of quoting with stale logic.
 */
export const ESTIMATE_RULES = 3;

function cardBody() {
  return {
    schema: ESTIMATE_CARD_SCHEMA,
    rules: ESTIMATE_RULES,
    version: PRICE_CARD_VERSION,
    creditsPerDollar: CREDITS_PER_DOLLAR,
    priceCard: { ...PRICE_CARD },
    profiles: Object.fromEntries(Object.entries(PIPELINE_PROFILES).map(([id, profile]) => [id, profile.pages])),
    documentFeatures: [...DOCUMENT_FEATURES],
    parallelEfficiency: PARALLEL_EFFICIENCY,
    fixedOverheadSeconds: FIXED_OVERHEAD_SECONDS,
    mediaWorkerSecondsPerMinute: { ...MEDIA_WORKER_SECONDS_PER_MINUTE },
    mediaBytesPerMinute: { ...MEDIA_BYTES_PER_MINUTE },
    maxPageFanoutPerRun: MAX_PAGE_FANOUT_PER_RUN,
    fundedWorkerSlots: FUNDED_WORKER_SLOTS,
    speedBoostMultiplier: speedBoostMultiplier(true),
    assumedBytesPerPage: ASSUMED_BYTES_PER_PAGE,
    quoteLowMix: { ...QUOTE_LOW_MIX },
    quoteHighMix: { ...QUOTE_HIGH_MIX },
    /** A new hosted workspace with default settings, for quotes made without a workspace's profile. */
    defaultProfile: estimateProfileFor(defaultPipelineFeatures, { env: { DOCSLURP_BILL_INGEST: "true" } }),
    /** Extensions priced as media or as image files when the MIME type does not say (uploadMediaKind). */
    extensions: { audio: [...AUDIO_EXTENSIONS], video: [...VIDEO_EXTENSIONS], image: [...IMAGE_EXTENSIONS], text: [...TEXT_EXTENSIONS] },
    /** Text files: MIME prefixes counted from their text, and the lines and characters per page. */
    textPages: { mimePrefixes: [...TEXT_PAGE_MIME_PREFIXES], lines: TEXT_PAGE_LINES, chars: TEXT_PAGE_CHARS },
    /** PDF page classification thresholds the worker routes with. */
    pageRasterRouting: { ...PAGE_RASTER_ROUTING },
  };
}

/** The card plus `revision`, a sha256 of its content, so a change to any constant is visible to clients. */
export function buildEstimateCard() {
  const body = cardBody();
  return { ...body, revision: sha256Hex(JSON.stringify(body)) };
}
export type EstimateCard = ReturnType<typeof buildEstimateCard>;


let cachedCard: EstimateCard | null = null;

/** This build's card, built once (its inputs are constants). */
export function estimateCard(): EstimateCard {
  cachedCard ??= buildEstimateCard();
  return cachedCard;
}

/** Revision of this build's card; the upload estimate returns it so offline clients notice a newer card. */
export function estimateCardRevision(): string {
  return estimateCard().revision;
}
