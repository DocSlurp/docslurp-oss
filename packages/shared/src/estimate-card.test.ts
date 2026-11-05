import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { estimateUploadMedia } from "./media-upload-estimate.js";
import { estimatePipelineWork } from "./config-change.js";
import { buildEstimateCard, ESTIMATE_RULES } from "./estimate-card.js";
import { buildEstimateGoldenCases, serializeGoldenCases } from "./estimate-golden.js";
import { compilePipelinePlan, defaultPipelineFeatures, type PipelineFeatures } from "./pipeline.js";
import { pageCredits, speedBoostMultiplier } from "./billing.js";
import { ASSUMED_BYTES_PER_PAGE, countedPagesForForecast, estimatedPdfPages, estimateProfileFor, IMAGE_MAX_FRAMES, intakePageCountSource, isMultiFrameImageFile, QUOTE_HIGH_RICH_PAGE_FACTOR, quoteFilePageRange, quoteFileSchema, quoteUpload, workerCountedFormat, type QuoteFile } from "./upload-quote.js";
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
  // Counted pages: the server's estimate is the reference for the cheap end; uncounted pages are quoted over a range (below).
  // The server's page estimate does not know formats, so these are files a model may read (Word, slide and sheet files, which
  // no model reads, are priced Fast in every quality: tested below).
  const batches: QuoteFile[][] = [
    [{ name: "a.pdf", size: 2_000_000, pages: 27 }],
    [{ name: "a.pdf", size: 10, pages: 300 }, { name: "b.pdf", size: 90_000, pages: 2 }, { name: "c.pdf", size: 4_000_000, pages: 54 }],
    [{ name: "talk.mp3", size: 30_000_000 }, { name: "deck.pdf", size: 8_000_000, pages: 42 }, { name: "clip.mp4", size: 1, durationSeconds: 125 }],
  ];

  for (const [label, pipeline] of pipelines) {
    for (const [index, batch] of batches.entries()) {
      for (const speedBoost of [false, true]) {
        it(`matches the server's pipeline estimate (${label}, batch ${index}, speedBoost ${speedBoost})`, () => {
          const legacy = legacyUploadEstimate({ files: batch, pipeline, speedBoost, workerSlots: 50, env: enforced });
          const quote = quoteUpload({ files: batch, profile: estimateProfileFor(pipeline, { workerSlots: 50, env: enforced }), speedBoost });
          if (!legacy.media) {
            // Same pages, documents and cheap end as the server's estimate; the expensive end is a ceiling above it.
            expect(quote.estimate.pages).toBe(legacy.pagedEstimate.pages);
            expect(quote.estimate.documents).toBe(legacy.pagedEstimate.documents);
            expect(quote.estimate.credits!.low).toBe(legacy.pagedEstimate.credits!.low);
            expect(quote.estimate.credits!.high).toBeGreaterThanOrEqual(legacy.pagedEstimate.credits!.high);
            expect(quote.estimate.seconds!.low).toBe(legacy.pagedEstimate.seconds!.low);
            expect(quote.media).toBeNull();
            return;
          }
          expect(quote.estimate.credits!.low).toBe(legacy.pagedEstimate.credits!.low + legacy.media.credits.low * (speedBoost ? 4 : 1));
          expect(quote.estimate.credits!.high).toBeGreaterThanOrEqual(legacy.pagedEstimate.credits!.high + legacy.media.credits.high * (speedBoost ? 4 : 1));
          expect(quote.estimate.seconds!.low).toBe(legacy.pagedEstimate.seconds!.low);
          expect(quote.estimate.basis).toContain("; audio and video priced by duration");
        });
      }
    }
  }

  it("prices Word, slide and sheet files Fast in every quality: no model reads their pages", () => {
    const office: QuoteFile[] = [{ name: "b.docx", size: 90_000, pages: 2 }, { name: "c.xlsx", size: 4_000_000, pages: 54 }, { name: "deck.pptx", size: 8_000_000, pages: 42 }];
    const quotes = (["fast", "auto", "good"] as const).map((quality) =>
      quoteUpload({ files: office, profile: estimateProfileFor({ ...defaultPipelineFeatures, quality }, { env: enforced }) }).estimate);
    for (const quote of quotes) {
      expect(quote.pages).toBe(98);
      expect(quote.credits).toEqual({ low: pageCredits("fast", 98), high: pageCredits("fast", 98) });
      expect(quote.basis).toContain("page mix known for every file");
    }
    // A Good DOCX was quoted at the Rich price: 300 pages, 75 credits at both ends. It bills 1.5.
    const good = estimateProfileFor({ ...defaultPipelineFeatures, quality: "good" }, { env: enforced });
    expect(quoteUpload({ files: [{ name: "contract.docx", size: 400_000, pages: 300 }], profile: good }).estimate.credits).toEqual({ low: 1.5, high: 1.5 });
    // An uncounted one is quoted Fast over its size's page range; a PDF beside it keeps its own range.
    const uncounted = quoteUpload({ files: [{ name: "memo.doc", size: 400_000, type: "application/msword" }], profile: good }).estimate;
    expect(uncounted.credits!.high).toBe(pageCredits("fast", uncounted.pagesRange!.high));
    const mixed = quoteUpload({ files: [{ name: "memo.doc", size: 400_000, type: "application/msword" }, { name: "scan.pdf", size: 1, pages: 10 }], profile: good }).estimate;
    expect(mixed.credits!.low).toBeCloseTo(pageCredits("fast", uncounted.pagesRange!.low) + pageCredits("rich", 10));
  });

  it("keeps a Word file Fast when the client sends a scan-heavy page mix (Good and Auto)", () => {
    for (const quality of ["good", "auto"] as const) {
      const profile = estimateProfileFor({ ...defaultPipelineFeatures, quality }, { env: enforced });
      // Was priced as 30 Rich pages (7.5 credits low, more at the high end); it bills 30 Fast pages, 0.15 credits.
      const quote = quoteUpload({ files: [{ name: "contract.docx", size: 1_200_000, pages: 30, mix: { text: 0, complex: 0, scanned: 1 } }], profile }).estimate;
      expect(quote.credits).toEqual({ low: pageCredits("fast", 30), high: pageCredits("fast", 30) });
    }
  });

  it("prices a TIFF's frames as its pages, up to the frame cap, and notes a file over it", () => {
    const profile = estimateProfileFor({ ...defaultPipelineFeatures, quality: "auto" }, { env: enforced });
    const scannedPages = (pages: number) => quoteUpload({ files: [{ name: "a.pdf", size: 1, pages, mix: { text: 0, complex: 0, scanned: 1 } }], profile }).estimate.credits;
    // 7 counted frames: 7 Rich pages (was quoted as 1).
    const counted = quoteUpload({ files: [{ name: "fax.tiff", size: 2_000_000, pages: 7 }], profile }).estimate;
    expect(counted.pages).toBe(7);
    expect(counted.credits).toEqual(scannedPages(7));
    // Over the cap: quoted at the cap and noted as refused.
    const over = quoteUpload({ files: [{ name: "archive.tif", size: 9_000_000, pages: 100 }], profile }).estimate;
    expect(over.pages).toBe(IMAGE_MAX_FRAMES);
    expect(over.basis).toContain(`1 image file holds more than ${IMAGE_MAX_FRAMES} frames and will be refused`);
    // Uncounted: 1 frame to its size at the densest page, at most the cap.
    const uncounted = quoteUpload({ files: [{ name: "scan", size: 300_000, type: "image/tiff" }], profile }).estimate;
    expect(uncounted.pagesRange).toEqual({ low: 1, high: Math.ceil(300_000 / (16 * 1024)) });
    expect(quoteFilePageRange({ name: "big.tiff", size: 90_000_000 })).toMatchObject({ low: 1, high: IMAGE_MAX_FRAMES, measured: false });
    // A TIFF's frames are counted only by the OCR boundary: intake has no evidence (server source-metadata.ts gives `none`).
    expect(intakePageCountSource("none")).toBe("assumed");
    expect(isMultiFrameImageFile({ name: "x.pdf", type: "image/tiff" })).toBe(true);
    expect(isMultiFrameImageFile({ name: "x.tiff", type: "image/png" })).toBe(false);
  });

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
    // Unprobed: pages from size are a floor (short lines bill more), so the range stays open.
    const csv = quoteUpload({ files: [{ name: "rows.csv", size: 1_000_000 }], profile }).estimate;
    expect(csv.pages).toBe(Math.ceil(1_000_000 / 3_500));
    expect(csv.credits!.low).toBeLessThan(csv.credits!.high);
    // Uncounted: the line rule (60 lines a page) can need far more pages than characters do, and the quote says so.
    expect(csv.pagesRange).toEqual({ low: Math.ceil(1_000_000 / 7_000), high: Math.ceil(1_000_000 / 720) });
    expect(csv.unmeasuredFiles).toBe(1);
    // Text never bills Rich, whatever the length: the high end is more Fast pages, not vision.
    const countedHigh = quoteUpload({ files: [{ name: "rows.csv", size: 1_000_000, pages: Math.ceil(1_000_000 / 720) }], profile }).estimate;
    expect(csv.credits!.high).toBeCloseTo(countedHigh.credits!.high, 9);
    // Counted (probe): all text pages, an exact price.
    const counted = quoteUpload({ files: [{ name: "rows.csv", size: 1_000_000, pages: 334 }], profile }).estimate;
    expect(counted.credits!.low).toBe(counted.credits!.high);
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
    // Vision output is unknown until read, so even a measured scan spans one to QUOTE_HIGH_RICH_PAGE_FACTOR Rich pages each.
    expect(scanned.credits!.low).toBeGreaterThan(unknown.low);
    expect(scanned.credits!.high).toBeCloseTo(unknown.high, 9);
    expect(scanned.credits!.high).toBeCloseTo(scanned.credits!.low * QUOTE_HIGH_RICH_PAGE_FACTOR, 9);
    expect(allText.basis).toContain("page mix known for every file");
  });

  it("never lowers the high end below a measured scan-heavy mix", () => {
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: enforced });
    const allScanned = quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 100, mix: { text: 0, complex: 0, scanned: 1 }, mixConfidence: 0.5 }], profile }).estimate.credits!;
    const certain = quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 100, mix: { text: 0, complex: 0, scanned: 1 } }], profile }).estimate.credits!;
    expect(allScanned.high).toBe(certain.high);
  });

  it("ignores an untrusted mix on the low end but never quotes below it on the high end", () => {
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: enforced });
    const unknown = quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 100 }], profile }).estimate.credits!;
    const untrusted = quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 100, mix: { text: 0, complex: 0, scanned: 1 }, mixConfidence: 0 }], profile }).estimate.credits!;
    expect(untrusted.low).toBeCloseTo(unknown.low, 9);
    expect(untrusted.high).toBeGreaterThanOrEqual(unknown.high - 1e-9);
  });

  it("returns no price when billing is disabled", () => {
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: {} });
    expect(profile.billing).toBe("disabled");
    expect(quoteUpload({ files: [{ name: "a.pdf", size: 1, pages: 10 }], profile }).estimate.credits).toBeNull();
  });
});

describe("quoteUpload with uncounted pages", () => {
  const enforced = { DOCSLURP_BILL_INGEST: "true" };
  const profile = estimateProfileFor(defaultPipelineFeatures, { env: enforced });

  it("quotes a 12 MB scan over the pages its size allows, not as 157 pages with a ceiling", () => {
    const quote = quoteUpload({ files: [{ name: "scan.pdf", size: 12 * 1024 * 1024 }], profile }).estimate;
    expect(quote.pages).toBe(Math.ceil((12 * 1024 * 1024) / (75 * 1024)));
    expect(quote.unmeasuredFiles).toBe(1);
    // The real count (300 pages) is inside the stated range, and the high end covers all of them read by vision.
    expect(quote.pagesRange!.low).toBeLessThan(300);
    expect(quote.pagesRange!.high).toBeGreaterThan(300);
    const real = quoteUpload({ files: [{ name: "scan.pdf", size: 12 * 1024 * 1024, pages: 300, mix: { text: 0, complex: 0, scanned: 1 } }], profile }).estimate.credits!;
    expect(quote.credits!.high).toBeGreaterThanOrEqual(real.high);
    expect(quote.credits!.low).toBeLessThanOrEqual(real.low);
    expect(quote.basis).toContain("pages not counted for 1 of 1 files");
  });

  it("says when media durations were assumed from size, and not when they were read", () => {
    const assumed = quoteUpload({ files: [{ name: "talk.mp3", size: 30_000_000 }], profile }).estimate;
    expect(assumed.basis).toContain("audio and video priced by duration (not read from every file: assumed from size at");
    expect(assumed.basis).toMatch(/\d+ kbps audio and [\d.]+ Mbps video/);
    const read = quoteUpload({ files: [{ name: "talk.mp3", size: 30_000_000, durationSeconds: 600 }], profile }).estimate;
    expect(read.basis.endsWith("audio and video priced by duration")).toBe(true);
  });

  it("counted pages quote exactly their pages, with no range", () => {
    const quote = quoteUpload({ files: [{ name: "a.pdf", size: 12 * 1024 * 1024, pages: 300 }], profile }).estimate;
    expect(quote.pagesRange).toBeUndefined();
    expect(quote.unmeasuredFiles).toBeUndefined();
    expect(quote.pages).toBe(300);
  });

  it("puts the output-token surcharge on the high end of page-reading profiles only", () => {
    const fast = estimateProfileFor({ ...defaultPipelineFeatures, quality: "fast" }, { env: enforced });
    const file = { name: "a.pdf", size: 1, pages: 100, mix: { text: 0, complex: 0, scanned: 1 } };
    const fastQuote = quoteUpload({ files: [file], profile: fast }).estimate.credits!;
    expect(fastQuote.high).toBe(fastQuote.low);
    const auto = quoteUpload({ files: [file], profile }).estimate.credits!;
    expect(auto.high).toBeCloseTo(auto.low * QUOTE_HIGH_RICH_PAGE_FACTOR, 9);
  });

  it("gives a page range per file: one value when counted, a spread from the size when not", () => {
    expect(quoteFilePageRange({ name: "a.pdf", size: 3_000_000, pages: 40 })).toEqual({ low: 40, central: 40, high: 40, measured: true });
    expect(quoteFilePageRange({ name: "photo.jpg", size: 3_000_000 })).toEqual({ low: 1, central: 1, high: 1, measured: true });
    const range = quoteFilePageRange({ name: "b.pdf", size: 3_000_000 });
    expect(range.measured).toBe(false);
    expect(range.low).toBeLessThan(range.central);
    expect(range.central).toBeLessThan(range.high);
  });

  it("quotes a Word, slide, sheet or EPUB file of unknown pages over bytes per page that hold for the format, not a scan's 16 KB", () => {
    // 600 KB: a scan's 16 KB a page would cap the high end at 37 pages; a .docx holds a page in 1 to 7 KB.
    const docx = quoteFilePageRange({ name: "contract.docx", size: 600_000 });
    expect(docx).toEqual({ low: 4, central: 49, high: 586, measured: false });
    expect(quoteFilePageRange({ name: "contract.pdf", size: 600_000 }).high).toBe(37);
    // By MIME type or, when it is absent or generic, by extension; a declared PDF or a text type is something else.
    expect(workerCountedFormat({ name: "x", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe("office-excel");
    expect(workerCountedFormat({ name: "deck.PPTX", type: "application/octet-stream" })).toBe("office-pptx");
    expect(workerCountedFormat({ name: "book.epub" })).toBe("epub");
    expect(workerCountedFormat({ name: "a.docx", type: "application/pdf" })).toBeNull();
    expect(workerCountedFormat({ name: "n.rtf", type: "text/rtf" })).toBeNull();
    expect(workerCountedFormat({ name: "n.rtf", type: "application/rtf" })).toBe("office-other");
    // Counted pages are not a range whatever the format.
    expect(quoteFilePageRange({ name: "contract.docx", size: 600_000, pages: 12 })).toEqual({ low: 12, central: 12, high: 12, measured: true });
  });

  it("says in the basis that the high end counts a page's typical vision output, and not for Fast", () => {
    const quote = quoteUpload({ files: [{ name: "scan.pdf", size: 3_000_000 }], profile }).estimate;
    expect(quote.basis).toContain(`high end assumes ${QUOTE_HIGH_RICH_PAGE_FACTOR} Rich pages for each page a vision model reads`);
    expect(quote.basis).toContain("typical, not a ceiling");
    const fast = quoteUpload({ files: [{ name: "scan.pdf", size: 3_000_000 }], profile: estimateProfileFor({ ...defaultPipelineFeatures, quality: "fast" }, { env: enforced }) }).estimate;
    expect(fast.basis).not.toContain("Rich pages");
  });

  it("labels a page count counted only on evidence from the bytes, never on a name or declared type", () => {
    // Evidence the API took from the bytes in full.
    expect(intakePageCountSource("text-rule")).toBe("counted");
    expect(intakePageCountSource("image-header")).toBe("counted");
    // Estimates and absences: a PDF's size estimate (the API never parses one), a sampled text count, a format only the worker counts.
    for (const evidence of ["size-estimate", "text-sample", "none", null, undefined] as const) {
      expect(intakePageCountSource(evidence)).toBe("assumed");
    }
    // A MIME type or filename is not evidence: the old type-based call shape cannot reach `counted`.
    for (const file of [{ name: "a.pdf", type: "application/pdf" }, { name: "a.csv", type: "text/csv" }, { name: "photo.png", type: "image/png" }]) {
      expect(intakePageCountSource(file as never)).toBe("assumed");
    }
  });

  it("passes a forecast pages only when they were counted or the worker measured them; an estimate is priced over the size", () => {
    // Intake's estimate (assumed) is never passed as pages; nor is a count of unknown or missing provenance.
    expect(countedPagesForForecast({ pageCount: 40, pageCountSource: "assumed" })).toBeUndefined();
    expect(countedPagesForForecast({ pageCount: 40, pageCountSource: null })).toBeUndefined();
    expect(countedPagesForForecast({ pageCount: 40 })).toBeUndefined();
    expect(countedPagesForForecast({ pageCount: 40, pageCountSource: "estimated" })).toBeUndefined();
    // The worker's measurement wins, whatever intake recorded.
    expect(countedPagesForForecast({ pageCount: 1, billingPages: 300, pageCountSource: "assumed" })).toBe(300);
    expect(countedPagesForForecast({ pageCount: 40, pageCountSource: "counted" })).toBe(40);
    expect(countedPagesForForecast({ pageCount: 0, pageCountSource: "counted" })).toBeUndefined();
    // Without pages a PDF is quoted as a labelled estimate (a range, measured: false) from its size, and the size estimate intake
    // stores is not what the quote uses; only a client's count makes the quote measured.
    const size = 40 * ASSUMED_BYTES_PER_PAGE;
    expect(estimatedPdfPages(size)).toBe(40);
    const estimated = quoteFilePageRange({ name: "contract.pdf", size });
    expect(estimated.measured).toBe(false);
    expect(estimated.low).toBeLessThan(estimated.high);
    expect(quoteFilePageRange({ name: "contract.pdf", size, pages: 40 })).toEqual({ low: 40, central: 40, high: 40, measured: true });
  });
});
