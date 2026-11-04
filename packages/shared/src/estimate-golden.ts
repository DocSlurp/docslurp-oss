import { DOCUMENT_FEATURES, PIPELINE_PROFILES, PRICE_CARD_VERSION, estimateIngest, type IngestEstimateInput, type PageMix } from "./billing.js";
import { estimateUploadMedia, type UploadMediaFile } from "./media-upload-estimate.js";
import { quoteUpload, type EstimateProfile, type QuoteFile } from "./upload-quote.js";

/*
 * Golden cases for the offline estimator's Rust port: inputs and outputs of every TypeScript function it
 * reimplements. Test support only (estimate-card.test.ts writes them to packages/estimate/golden/); not exported.
 */

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
const DOCUMENT_FEATURE_SETS = [
  { documentSummary: false, structuredFields: false, knowledgeGraph: false, propositions: false },
  { documentSummary: true, structuredFields: true, knowledgeGraph: true, propositions: true },
];

function ingestCases() {
  const rng = sequence(0xd0c5);
  const inputs: IngestEstimateInput[] = [
    { pages: 0, mix: {} },
    { pages: 1, mix: { text: 1 } },
    { pages: 100, mix: { scanned: 1 }, profile: "good" },
    { pages: 0, documents: 451, mix: { text: 1 }, audioMinutes: 51_414.5, videoMinutes: 3 },
    { pages: 600_000, documents: 6_690, mix: { text: 0.7, complex: 0.3 }, workerSlots: 50 },
    { pages: 12.5, documents: 0, mix: { text: -1, scanned: 2 }, workerSlots: 0 },
  ];
  for (let i = 0; i < 30; i += 1) {
    const features: IngestEstimateInput["features"] = {};
    for (const feature of DOCUMENT_FEATURES) if (rng.bool(0.3)) features[feature] = true;
    inputs.push({
      pages: rng.pick([0, 1, 3, 10, 57, 128, 999, 12_345, 250_000]) + (rng.bool(0.2) ? rng.next() * 3 : 0),
      documents: rng.bool(0.8) ? rng.int(1, 400) : undefined,
      mix: rng.pick(MIXES),
      profile: rng.pick(PROFILE_IDS),
      workerSlots: rng.bool(0.5) ? rng.pick([1, 2, 50, 250, 1000]) : undefined,
      features,
    });
  }
  return inputs.map((input) => ({ input, output: estimateIngest(input) }));
}

function mediaCases() {
  const rng = sequence(0x3ed1a);
  const names = ["talk.mp3", "clip.mp4", "memo.m4a", "raw.wav", "screen.webm", "voice.weba", "song.flac", "film.mov", "rec.OGG", "notes.pdf", "noext"];
  const types = [undefined, "audio/ogg", "video/quicktime", "application/pdf", "audio/flac; codecs=flac", "image/png"];
  const cases: Array<{ input: { files: UploadMediaFile[]; videoFrames: boolean }; output: ReturnType<typeof estimateUploadMedia> }> = [];
  for (let i = 0; i < 24; i += 1) {
    const files: UploadMediaFile[] = [];
    const count = rng.int(1, 4);
    for (let j = 0; j < count; j += 1) {
      files.push({
        name: rng.pick(names),
        size: rng.int(0, 400_000_000),
        ...(rng.bool(0.3) ? { type: rng.pick(types) } : {}),
        ...(rng.bool(0.6) ? { durationSeconds: rng.int(1, 7_200) + (rng.bool() ? 0.5 : 0) } : {}),
      });
    }
    const input = { files, videoFrames: rng.bool(0.7) };
    cases.push({ input, output: estimateUploadMedia(input.files, { videoFrames: input.videoFrames }) });
  }
  return cases;
}

function quoteCases() {
  const rng = sequence(0x9a07e);
  const names = ["report.pdf", "deck.pptx", "scan.png", "photo.JPG", "a.docx", "talk.mp3", "song.flac", "clip.mp4", "film.mov", "page.html", "data"];
  const types = [undefined, undefined, "image/heic", "application/pdf", "audio/aac", "video/x-msvideo"];
  const profileFor = (overrides: Partial<EstimateProfile> = {}): EstimateProfile => ({
    cardVersion: PRICE_CARD_VERSION,
    quality: rng.pick(PROFILE_IDS),
    documentFeatures: rng.pick(DOCUMENT_FEATURE_SETS),
    videoFrames: rng.bool(0.7),
    ...(rng.bool(0.5) ? { workerSlots: rng.pick([1, 50, 250]) } : {}),
    stageCount: rng.int(8, 20),
    billing: rng.bool(0.9) ? "enforced" : "disabled",
    ...overrides,
  });
  const inputs: Array<{ files: QuoteFile[]; profile: EstimateProfile; speedBoost?: boolean }> = [
    // Branches the random cases may miss: media only, billing disabled, speed boost with a lighter video option,
    // every file's mix known, untrusted and over-trusted mixes, an image with a page count.
    { files: [{ name: "talk.mp3", size: 9_000_000 }], profile: profileFor({ billing: "enforced" }) },
    { files: [{ name: "a.pdf", size: 1, pages: 40 }, { name: "clip.mov", size: 1, durationSeconds: 61 }], profile: profileFor({ billing: "disabled" }) },
    { files: [{ name: "clip.mp4", size: 1, durationSeconds: 600 }], profile: profileFor({ videoFrames: true, billing: "enforced" }), speedBoost: true },
    { files: [{ name: "a.pdf", size: 1, pages: 10, mix: { text: 1, complex: 0, scanned: 3 } }, { name: "b.png", size: 5_000_000 }], profile: profileFor({ quality: "auto", billing: "enforced" }) },
    { files: [{ name: "a.pdf", size: 1, pages: 10, mix: { text: 0, complex: 0, scanned: 1 }, mixConfidence: 0 }], profile: profileFor({ billing: "enforced" }) },
    { files: [{ name: "a.pdf", size: 1, pages: 10, mix: { text: 0, complex: 0, scanned: 1 }, mixConfidence: 1.5 }], profile: profileFor({ billing: "enforced" }) },
    { files: [{ name: "scan.tiff", size: 90_000_000, pages: 12 }, { name: "x.pdf", size: 0 }], profile: profileFor({ quality: "fast", billing: "enforced" }) },
    // Uncounted pages: a 12 MB scan quoted over its size-allowed page range, text over the line rule, a CJK-sized CSV, Fast flat.
    { files: [{ name: "scan.pdf", size: 12 * 1024 * 1024 }], profile: profileFor({ quality: "auto", billing: "enforced" }) },
    { files: [{ name: "scan.pdf", size: 12 * 1024 * 1024 }], profile: profileFor({ quality: "fast", billing: "enforced" }) },
    { files: [{ name: "rows.csv", size: 1_000_000 }, { name: "notes.md", size: 12_345, type: "text/markdown" }, { name: "deck.pptx", size: 8_000_000, pages: 42 }], profile: profileFor({ quality: "good", billing: "enforced" }) },
    { files: [{ name: "a.pdf", size: 12 * 1024 * 1024, pages: 300, mix: { text: 0, complex: 0, scanned: 1 } }, { name: "b.docx", size: 90_000 }], profile: profileFor({ quality: "auto", billing: "enforced" }), speedBoost: true },
  ];
  for (let i = 0; i < 40; i += 1) {
    const files: QuoteFile[] = [];
    const count = rng.int(1, 6);
    for (let j = 0; j < count; j += 1) {
      const file: QuoteFile = { name: rng.pick(names), size: rng.int(0, 50_000_000) };
      if (rng.bool(0.25)) file.type = rng.pick(types);
      if (rng.bool(0.4)) file.pages = rng.int(1, 900);
      if (rng.bool(0.2)) file.durationSeconds = rng.int(1, 3_600);
      if (rng.bool(0.35)) {
        file.mix = rng.pick(MIXES);
        if (rng.bool(0.5)) file.mixConfidence = rng.pick([0, 0.25, 0.6, 1]);
      }
      files.push(file);
    }
    inputs.push({ files, profile: profileFor(), ...(rng.bool(0.25) ? { speedBoost: rng.bool(0.6) } : {}) });
  }
  return inputs.map((input) => ({ input, output: quoteUpload(input) }));
}

/** Inputs and outputs of every function the Rust port reimplements. */
export function buildEstimateGoldenCases() {
  return { version: PRICE_CARD_VERSION, ingest: ingestCases(), media: mediaCases(), quote: quoteCases() };
}

/** Golden cases as JSON with one case per line, so a regenerated file diffs by case. */
export function serializeGoldenCases(golden: ReturnType<typeof buildEstimateGoldenCases>): string {
  const section = (cases: unknown[]) => `[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]`;
  return `{"version":${JSON.stringify(golden.version)},\n"ingest":${section(golden.ingest)},\n"media":${section(golden.media)},\n"quote":${section(golden.quote)}}\n`;
}
