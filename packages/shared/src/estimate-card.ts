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
  estimateIngest,
  speedBoostMultiplier,
  type IngestEstimateInput,
  type PageMix,
} from "./billing.js";
import { estimateUploadMedia, type UploadMediaFile } from "./media-upload-estimate.js";
import {
  ASSUMED_BYTES_PER_PAGE,
  QUOTE_HIGH_MIX,
  QUOTE_LOW_MIX,
  quoteUpload,
  type EstimateProfile,
  type QuoteFile,
} from "./upload-quote.js";

/*
 * The offline estimator's inputs (`packages/estimate`): every price and planning constant its Rust port reads,
 * plus golden cases computed by the TypeScript functions it ports. `estimate-card.test.ts` fails when the committed
 * copies in packages/estimate/ differ; `UPDATE_ESTIMATE_CARD=1 pnpm --filter @docslurp/shared test estimate-card`
 * rewrites them. The Rust tests replay the golden cases, so a price change cannot land without the port agreeing.
 */

/** Bumped when the card's shape (not its prices) changes; the Rust port rejects other schema versions. */
export const ESTIMATE_CARD_SCHEMA = 1;

export function buildEstimateCard() {
  return {
    schema: ESTIMATE_CARD_SCHEMA,
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
    /** Extensions priced as media when the MIME type does not say (uploadMediaKind). */
    mediaExtensions: { audio: ["mp3", "m4a", "wav", "weba"], video: ["mp4", "webm"] },
  };
}
export type EstimateCard = ReturnType<typeof buildEstimateCard>;

/** Deterministic pseudo-random sequence (LCG), so golden cases are stable across runs. */
function sequence(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    bool: (p = 0.5) => next() < p,
  };
}

const PROFILE_IDS = Object.keys(PIPELINE_PROFILES) as Array<keyof typeof PIPELINE_PROFILES>;
const MIXES: PageMix[] = [
  { text: 1, complex: 0, scanned: 0 },
  { text: 0.2, complex: 0.3, scanned: 0.5 },
  { text: 0.65, complex: 0.35, scanned: 0 },
  { text: 0, complex: 0, scanned: 1 },
  { text: 3, complex: 1, scanned: 1 },
  { text: 0, complex: 0, scanned: 0 },
];

function ingestCases(): Array<{ input: IngestEstimateInput; output: ReturnType<typeof estimateIngest> }> {
  const rng = sequence(0xd0c5);
  const inputs: IngestEstimateInput[] = [
    { pages: 0, mix: {} },
    { pages: 1, mix: { text: 1 } },
    { pages: 100, mix: { scanned: 1 }, profile: "good" },
    { pages: 407, documents: 1, mix: { text: 1 } },
    { pages: 0, documents: 451, mix: { text: 1 }, audioMinutes: 51_414 },
    { pages: 600_000, documents: 6_690, mix: { text: 0.7, complex: 0.3 }, workerSlots: 50 },
  ];
  for (let i = 0; i < 120; i += 1) {
    const features: IngestEstimateInput["features"] = {};
    for (const feature of DOCUMENT_FEATURES) if (rng.bool(0.3)) features[feature] = true;
    inputs.push({
      pages: rng.pick([0, 1, 3, 10, 57, 128, 999, 12_345, 250_000]) + (rng.bool(0.2) ? rng.next() * 3 : 0),
      documents: rng.bool(0.8) ? rng.int(1, 400) : undefined,
      mix: rng.pick(MIXES),
      profile: rng.pick(PROFILE_IDS),
      workerSlots: rng.bool(0.5) ? rng.pick([1, 2, 50, 250, 1000]) : undefined,
      audioMinutes: rng.bool(0.2) ? rng.int(0, 600) + rng.next() : undefined,
      videoMinutes: rng.bool(0.2) ? rng.int(0, 120) : undefined,
      features,
    });
  }
  return inputs.map((input) => ({ input, output: estimateIngest(input) }));
}

function mediaCases(): Array<{ input: { files: UploadMediaFile[]; videoFrames: boolean }; output: ReturnType<typeof estimateUploadMedia> }> {
  const rng = sequence(0x3ed1a);
  const names = ["talk.mp3", "clip.mp4", "memo.m4a", "raw.wav", "screen.webm", "voice.weba", "notes.pdf", "noext"];
  const types = [undefined, "audio/ogg", "video/quicktime", "application/pdf", "audio/flac; codecs=flac"];
  const cases = [];
  for (let i = 0; i < 40; i += 1) {
    const files: UploadMediaFile[] = [];
    const count = rng.int(1, 5);
    for (let j = 0; j < count; j += 1) {
      const known = rng.bool(0.6);
      files.push({
        name: rng.pick(names),
        size: rng.int(0, 400_000_000),
        ...(rng.bool(0.3) ? { type: rng.pick(types) } : {}),
        ...(known ? { durationSeconds: rng.int(1, 7_200) + (rng.bool() ? 0.5 : 0) } : {}),
      });
    }
    const input = { files, videoFrames: rng.bool(0.7) };
    cases.push({ input, output: estimateUploadMedia(input.files, { videoFrames: input.videoFrames }) });
  }
  return cases;
}

function quoteCases(): Array<{ input: { files: QuoteFile[]; profile: EstimateProfile; speedBoost?: boolean }; output: ReturnType<typeof quoteUpload> }> {
  const rng = sequence(0x9a07e);
  const names = ["report.pdf", "deck.pptx", "scan.png", "a.docx", "talk.mp3", "clip.mp4", "page.html"];
  const cases = [];
  for (let i = 0; i < 80; i += 1) {
    const profile: EstimateProfile = {
      cardVersion: PRICE_CARD_VERSION,
      quality: rng.pick(PROFILE_IDS),
      documentFeatures: {
        documentSummary: rng.bool(0.3),
        structuredFields: rng.bool(0.3),
        knowledgeGraph: rng.bool(0.2),
        propositions: rng.bool(0.2),
      },
      videoFrames: rng.bool(0.7),
      ...(rng.bool(0.5) ? { workerSlots: rng.pick([1, 50, 250]) } : {}),
      stageCount: rng.int(8, 20),
      billing: rng.bool(0.9) ? "enforced" : "disabled",
    };
    const files: QuoteFile[] = [];
    const count = rng.int(1, 6);
    for (let j = 0; j < count; j += 1) {
      const name = rng.pick(names);
      const file: QuoteFile = { name, size: rng.int(0, 50_000_000) };
      if (rng.bool(0.4)) file.pages = rng.int(1, 900);
      if (rng.bool(0.2)) file.durationSeconds = rng.int(1, 3_600);
      if (rng.bool(0.35)) {
        file.mix = rng.pick(MIXES);
        if (rng.bool(0.5)) file.mixConfidence = rng.pick([0, 0.25, 0.6, 1, 1.5]);
      }
      files.push(file);
    }
    const input = { files, profile, ...(rng.bool(0.25) ? { speedBoost: rng.bool(0.6) } : {}) };
    cases.push({ input, output: quoteUpload(input) });
  }
  return cases;
}

/** Inputs and outputs of every function the Rust port reimplements. */
export function buildEstimateGoldenCases() {
  return { version: PRICE_CARD_VERSION, ingest: ingestCases(), media: mediaCases(), quote: quoteCases() };
}
