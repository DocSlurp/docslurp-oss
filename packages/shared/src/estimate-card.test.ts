import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { estimateUploadMedia } from "./media-upload-estimate.js";
import { estimatePipelineWork } from "./config-change.js";
import { buildEstimateCard, ESTIMATE_RULES } from "./estimate-card.js";
import { buildEstimateGoldenCases, serializeGoldenCases } from "./estimate-golden.js";
import { compilePipelinePlan, defaultPipelineFeatures, type PipelineFeatures } from "./pipeline.js";
import { speedBoostMultiplier } from "./billing.js";
import { estimateProfileFor, quoteFileSchema, quoteUpload, type QuoteFile } from "./upload-quote.js";
import { isUploadImageFile, isUploadTextFile, textPageCount, uploadMediaKind } from "./media-upload-estimate.js";

const estimateDir = join(dirname(fileURLToPath(import.meta.url)), "../../estimate");
const files = {
  card: join(estimateDir, "card.json"),
  golden: join(estimateDir, "golden/cases.json"),
};

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

describe("offline estimator card", () => {
  it("matches the committed card and golden cases (UPDATE_ESTIMATE_CARD=1 rewrites them)", () => {
    const expected = { card: serialize(buildEstimateCard()), golden: serializeGoldenCases(buildEstimateGoldenCases()) };
    if (process.env.UPDATE_ESTIMATE_CARD === "1") {
      mkdirSync(dirname(files.golden), { recursive: true });
      writeFileSync(files.card, expected.card);
      writeFileSync(files.golden, expected.golden);
    }
    const hint = "price card or estimate rules changed: run UPDATE_ESTIMATE_CARD=1 pnpm --filter @docslurp/shared test estimate-card";
    expect(readFileSync(files.card, "utf8"), hint).toBe(expected.card);
    expect(readFileSync(files.golden, "utf8"), hint).toBe(expected.golden);
  });

  it("identifies the card by rules version and content revision", () => {
    const card = buildEstimateCard();
    expect(card.rules).toBe(ESTIMATE_RULES);
    expect(card.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(buildEstimateCard().revision).toBe(card.revision);
  });
});

/** The upload estimate before quoteUpload: estimatePipelineWork over the compiled plan plus media, as the server did. */
function legacyUploadEstimate(args: { files: QuoteFile[]; pipeline: PipelineFeatures; speedBoost?: boolean; workerSlots?: number; env: Record<string, string> }) {
  const paged = args.files.filter((file) => !/\.(mp3|m4a|wav|weba|mp4|webm)$/.test(file.name) && !/^(audio|video)\//.test(file.type ?? ""));
  const pages = paged.reduce((sum, file) => sum + Math.max(1, Math.round(file.pages ?? Math.ceil(file.size / (75 * 1024)))), 0);
  const features = { ...args.pipeline, speedBoost: args.speedBoost === true };
  const estimate = estimatePipelineWork({
    features,
    stages: compilePipelinePlan(args.pipeline).stageOrder,
    documents: paged.length,
    pages,
    workerSlots: args.workerSlots,
    env: args.env,
  });
  const multiplier = speedBoostMultiplier(features.speedBoost);
  const pagedEstimate = { ...estimate, credits: estimate.credits ? { low: estimate.credits.low * multiplier, high: estimate.credits.high * multiplier } : null };
  const media = estimateUploadMedia(args.files, { videoFrames: args.pipeline.mediaVideo?.enabled !== false });
  return { pagedEstimate, media };
}

describe("quoteUpload", () => {
  const enforced = { DOCSLURP_BILL_INGEST: "true" };
  const pipelines: Array<[string, PipelineFeatures]> = [
    ["default", defaultPipelineFeatures],
    ["good + graph", { ...defaultPipelineFeatures, quality: "good", graphRag: true }],
    ["fast, no video frames", { ...defaultPipelineFeatures, quality: "fast", mediaVideo: { ...defaultPipelineFeatures.mediaVideo, enabled: false } }],
  ];
  const batches: QuoteFile[][] = [
    [{ name: "a.pdf", size: 2_000_000 }],
    [{ name: "a.pdf", size: 10, pages: 300 }, { name: "b.docx", size: 90_000 }, { name: "c.xlsx", size: 4_000_000 }],
    [{ name: "talk.mp3", size: 30_000_000 }, { name: "deck.pptx", size: 8_000_000, pages: 42 }, { name: "clip.mp4", size: 1, durationSeconds: 125 }],
  ];

  for (const [label, pipeline] of pipelines) {
    for (const [index, batch] of batches.entries()) {
      for (const speedBoost of [false, true]) {
        it(`matches the server's pipeline estimate (${label}, batch ${index}, speedBoost ${speedBoost})`, () => {
          const legacy = legacyUploadEstimate({ files: batch, pipeline, speedBoost, workerSlots: 50, env: enforced });
          const quote = quoteUpload({ files: batch, profile: estimateProfileFor(pipeline, { workerSlots: 50, env: enforced }), speedBoost });
          if (!legacy.media) {
            expect(quote.estimate).toEqual(legacy.pagedEstimate);
            expect(quote.media).toBeNull();
            return;
          }
          expect(quote.estimate.credits).toEqual({
            low: legacy.pagedEstimate.credits!.low + legacy.media.credits.low * (speedBoost ? 4 : 1),
            high: legacy.pagedEstimate.credits!.high + legacy.media.credits.high * (speedBoost ? 4 : 1),
          });
          expect(quote.estimate.seconds).toEqual(legacy.pagedEstimate.seconds);
          expect(quote.estimate.basis).toBe(`${legacy.pagedEstimate.basis}; audio and video priced by duration`);
        });
      }
    }
  }

  it("prices an image file as one scanned page", () => {
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: enforced });
    const photo = quoteUpload({ files: [{ name: "photo.JPG", size: 4_000_000 }], profile }).estimate;
    const scannedPage = quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 1, mix: { text: 0, complex: 0, scanned: 1 } }], profile }).estimate;
    expect(photo.pages).toBe(1);
    expect(photo.credits).toEqual(scannedPage.credits);
    expect(isUploadImageFile({ name: "scan", type: "image/heic" })).toBe(true);
    expect(isUploadImageFile({ name: "notes.pdf" })).toBe(false);
  });

  it("counts text files the way the API counts their pages, as text", () => {
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: enforced });
    const csv = quoteUpload({ files: [{ name: "rows.csv", size: 1_000_000 }], profile }).estimate;
    expect(csv.pages).toBe(Math.ceil(1_000_000 / 3_500));
    expect(csv.credits!.low).toBe(csv.credits!.high);
    expect(isUploadTextFile({ name: "notes", type: "application/x-ndjson" })).toBe(true);
    expect(isUploadTextFile({ name: "notes.md", type: "application/pdf" })).toBe(false);
    expect(textPageCount(`${"x\n".repeat(120)}`)).toBe(3);
    expect(textPageCount("y".repeat(7_001))).toBe(3);
  });

  it("trusts the declared MIME type over the extension, as billing does", () => {
    expect(isUploadImageFile({ name: "scan.png", type: "application/pdf" })).toBe(false);
    expect(isUploadImageFile({ name: "scan.png", type: "application/octet-stream" })).toBe(true);
  });

  it("prices every media format the worker accepts by duration", () => {
    for (const name of ["a.flac", "a.ogg", "a.opus", "a.aac", "a.mp3", "a.weba"]) expect(uploadMediaKind({ name }), name).toBe("audio");
    for (const name of ["a.MOV", "a.mkv", "a.avi", "a.mp4"]) expect(uploadMediaKind({ name }), name).toBe("video");
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: enforced });
    const movie = quoteUpload({ files: [{ name: "film.mov", size: 1_000_000_000, durationSeconds: 300 }], profile });
    expect(movie.estimate.pages).toBe(0);
    expect(movie.media?.videoFiles).toBe(1);
  });

  it("refuses profiles and mixes from a newer contract instead of under-quoting", () => {
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: enforced });
    const file = { name: "a.pdf", size: 1, pages: 10 };
    expect(() => quoteUpload({ files: [file], profile: { ...profile, quality: "ultra" as never } })).toThrow();
    expect(() => quoteUpload({ files: [file], profile: { ...profile, documentFeatures: { ...profile.documentFeatures, citations: true } as never } })).toThrow();
    expect(quoteFileSchema.safeParse({ ...file, mix: { text: 1 } }).success).toBe(false);
    expect(quoteFileSchema.safeParse({ ...file, mixConfidence: 1.5 }).success).toBe(false);
  });

  it("narrows the range around a measured page mix", () => {
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: enforced });
    const unknown = quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 100 }], profile }).estimate.credits!;
    const allText = quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 100, mix: { text: 1, complex: 0, scanned: 0 } }], profile }).estimate;
    const scanned = quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 100, mix: { text: 0, complex: 0, scanned: 1 } }], profile }).estimate;
    expect(allText.credits).toEqual({ low: unknown.low, high: unknown.low });
    expect(scanned.credits!.low).toBe(scanned.credits!.high);
    expect(scanned.credits!.low).toBeGreaterThan(unknown.high);
    expect(allText.basis).toContain("page mix known for every file");
  });

  it("keeps the unknown-mix bounds when the measured mix has no confidence", () => {
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: enforced });
    const unknown = quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 100 }], profile }).estimate.credits;
    const untrusted = quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 100, mix: { text: 0, complex: 0, scanned: 1 }, mixConfidence: 0 }], profile }).estimate.credits!;
    expect(untrusted.low).toBeCloseTo(unknown!.low, 9);
    expect(untrusted.high).toBeCloseTo(unknown!.high, 9);
  });

  it("returns no price when billing is disabled", () => {
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: {} });
    expect(profile.billing).toBe("disabled");
    expect(quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 10 }], profile }).estimate.credits).toBeNull();
  });
});
