import { describe, expect, it } from "vitest";

import {
  PRICE_CARD,
  QUALITY_MODES,
  defaultPipelineFeatures,
  blankPages,
  defaultDocumentExtractionConfig,
  documentExtractionForQuality,
  isPageImageReferenceBlock,
  pageImageExtension,
  pageImageReferencePages,
  workspaceTemplates,
  legacyQualityMode,
  mergePipelineFeatures,
  migrateLegacyQualitySettings,
  normalizePipelineFeatures,
  pageImageReferenceMarkdown,
  parseStoredPipelineFeatures,
  parserPlaybookForQuality,
  pipelineFeatureOverridesSchema,
  pipelineFeaturesSchema,
  qualityAllowsPageReading,
  qualityModePriceRange,
  qualityReadsEveryPage,
} from "../index.js";

describe("pipeline.quality", () => {
  it("defaults to auto and derives the balanced playbook", () => {
    expect(defaultPipelineFeatures.quality).toBe("auto");
    expect(normalizePipelineFeatures(null).quality).toBe("auto");
    expect(pipelineFeaturesSchema.parse({}).quality).toBe("auto");
    expect(parserPlaybookForQuality("auto")).toBe("balanced");
    expect(parserPlaybookForQuality(undefined)).toBe("balanced");
  });

  it("maps each mode to its internal playbook and vision behaviour", () => {
    expect(parserPlaybookForQuality("fast")).toBe("fast");
    expect(parserPlaybookForQuality("good")).toBe("review-grade");
    expect(qualityReadsEveryPage("good")).toBe(true);
    expect(qualityReadsEveryPage("auto")).toBe(false);
    expect(qualityAllowsPageReading("fast")).toBe(false);
    expect(qualityAllowsPageReading("auto")).toBe(true);
    expect(qualityAllowsPageReading("good")).toBe(true);
  });

  it("rejects unknown modes", () => {
    expect(() => normalizePipelineFeatures({ quality: "best" as never })).toThrow();
    expect(pipelineFeatureOverridesSchema.safeParse({ quality: "deep" }).success).toBe(false);
  });

  it("no longer exposes parserPlaybook or vision.forceAllPages", () => {
    const parsed = normalizePipelineFeatures(null) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("parserPlaybook");
    expect(parsed.vision).not.toHaveProperty("forceAllPages");
  });
});

describe("legacy quality input", () => {
  it.each([
    [{ parserPlaybook: "fast" }, "fast"],
    [{ parserPlaybook: "balanced" }, "auto"],
    [{ parserPlaybook: "layout-aware" }, "auto"],
    [{ parserPlaybook: "agentic" }, "auto"],
    // review-grade never read every page: it maps to auto, not good (which would multiply spend).
    [{ parserPlaybook: "review-grade" }, "auto"],
    [{ parserPlaybook: "review-grade", vision: { forceAllPages: false } }, "auto"],
    [{ parserPlaybook: "agentic", vision: { forceAllPages: false } }, "auto"],
    [{ parserPlaybook: "review-grade", vision: { forceAllPages: true } }, "good"],
    [{ vision: { forceAllPages: true } }, "good"],
    [{ parserPlaybook: "fast", vision: { forceAllPages: true } }, "good"],
  ] as const)("maps %j to %s", (legacy, expected) => {
    expect(legacyQualityMode(legacy)).toBe(expected);
    expect(normalizePipelineFeatures(legacy as never).quality).toBe(expected);
    expect(parseStoredPipelineFeatures(legacy).quality).toBe(expected);
  });

  it("treats forceAllPages: false alone as saying nothing", () => {
    expect(legacyQualityMode({ vision: { forceAllPages: false } })).toBeNull();
    expect(normalizePipelineFeatures({ vision: { forceAllPages: false } } as never).quality).toBe("auto");
  });

  it("lets an explicit quality win over legacy keys", () => {
    expect(normalizePipelineFeatures({ quality: "fast", parserPlaybook: "review-grade" } as never).quality).toBe("fast");
  });

  it("parses a full stored pipeline that carries the retired keys", () => {
    const stored = {
      ...structuredClone(defaultPipelineFeatures),
      parserPlaybook: "review-grade",
      vision: { ...defaultPipelineFeatures.vision, forceAllPages: false, maxPagesPerDocument: 4 },
    } as Record<string, unknown>;
    delete stored.quality;
    const parsed = parseStoredPipelineFeatures(stored) as Record<string, unknown>;
    expect(parsed.quality).toBe("auto");
    expect(parsed).not.toHaveProperty("parserPlaybook");
    expect(parsed.vision).not.toHaveProperty("forceAllPages");
  });

  it("accepts legacy request overrides and merges them as quality", () => {
    const override = pipelineFeatureOverridesSchema.parse({ parserPlaybook: "fast" });
    expect(override).toEqual({ quality: "fast" });
    const forced = pipelineFeatureOverridesSchema.parse({ vision: { forceAllPages: true } });
    expect(forced).toEqual({ quality: "good", vision: {} });

    const workspace = normalizePipelineFeatures({ quality: "good" });
    expect(mergePipelineFeatures(workspace, { parserPlaybook: "fast" } as never).quality).toBe("fast");
    expect(mergePipelineFeatures(workspace, { vision: { forceAllPages: false } } as never).quality).toBe("good");
    expect(mergePipelineFeatures(workspace, { quality: "auto" }).quality).toBe("auto");
  });

  it("keeps an in-flight review-grade run row (forceAllPages: false) on auto through normalizePipelineFeatures", () => {
    // A workspace_runs.pipeline row written before quality existed, read back by the worker mid-run.
    const runRow = JSON.parse(JSON.stringify({
      ...defaultPipelineFeatures,
      quality: undefined,
      parserPlaybook: "review-grade",
      visionFallback: true,
      vision: { ...defaultPipelineFeatures.vision, forceAllPages: false },
    }));
    const pipeline = normalizePipelineFeatures(runRow);
    expect(pipeline.quality).toBe("auto");
    expect(qualityReadsEveryPage(pipeline.quality)).toBe(false);
    expect(mergePipelineFeatures(runRow, {}).quality).toBe("auto");
  });

  it("ships the Legal Contracts and Medical Records templates on auto, locked", () => {
    for (const key of ["legal-contracts", "medical-records"]) {
      const template = workspaceTemplates.find((entry) => entry.key === key)!;
      expect(template, key).toBeDefined();
      expect(template.pipeline.quality).toBe("auto");
      expect(template.lockedSettings).toContain("quality");
    }
  });

  it("returns sources without legacy keys unchanged", () => {
    const source = { summarize: true };
    expect(migrateLegacyQualitySettings(source)).toBe(source);
  });
});

describe("quality good turns vision on", () => {
  it("normalizes { quality: good, visionFallback: false } to vision on", () => {
    expect(normalizePipelineFeatures({ quality: "good", visionFallback: false }).visionFallback).toBe(true);
    expect(normalizePipelineFeatures({ quality: "auto", visionFallback: false }).visionFallback).toBe(false);
  });

  it("enables vision when Good merges into a workspace with fallback disabled", () => {
    const workspace = normalizePipelineFeatures({ quality: "auto", visionFallback: false });
    const merged = mergePipelineFeatures(workspace, { quality: "good" });
    expect(merged.quality).toBe("good");
    expect(merged.visionFallback).toBe(true);
    // Switching back to Auto leaves vision on (the merged workspace value); turning it off stays allowed.
    expect(mergePipelineFeatures(merged, { quality: "auto", visionFallback: false }).visionFallback).toBe(false);
  });

  it("says a cost cap can stop vision in Good's price note", () => {
    expect(QUALITY_MODES.good.priceNote).toMatch(/cost cap can stop vision/);
    expect(QUALITY_MODES.good.priceNote).not.toMatch(/^Every page bills Rich/);
  });
});

describe("documentExtractionForQuality", () => {
  const hostile = {
    ...defaultDocumentExtractionConfig,
    order: { pdf: ["dolphin", "graph-local", "kreuzberg"], image: ["dolphin"] },
    options: {
      kreuzberg: { forceOcr: true, ocr: { backend: "paddleocr" }, forceOcrPages: [1, 2], tesseractOcrConfig: {}, outputFormat: "markdown" },
      dolphin: { mode: "layout" },
    },
    enrich: ["page/ocr-text"],
    voting: { enabled: true, secondary: "dolphin" },
    forceOcr: true,
  };

  it("leaves auto and good unchanged", () => {
    expect(documentExtractionForQuality(hostile, "auto")).toEqual({ config: hostile, removed: [] });
    expect(documentExtractionForQuality(hostile, "good").config).toBe(hostile);
  });

  it("restricts fast to text-layer extractors with Kreuzberg OCR explicitly off", () => {
    const { config, removed } = documentExtractionForQuality(hostile, "fast");
    expect(config.order).toEqual({ pdf: ["kreuzberg"] });
    expect(config.options).toEqual({ kreuzberg: { outputFormat: "markdown", disableOcr: true } });
    expect(config.enrich).toEqual([]);
    expect(config.voting.secondary).toBe("next-in-order");
    expect(config.forceOcr).toBe(false);
    expect(removed).toEqual(expect.arrayContaining([
      "order.pdf:dolphin", "order.pdf:graph-local", "order.image:dolphin", "options.dolphin",
      "options.kreuzberg.forceOcr", "options.kreuzberg.ocr", "options.kreuzberg.forceOcrPages",
      "options.kreuzberg.tesseractOcrConfig", "enrich", "voting.secondary:dolphin", "forceOcr",
    ]));
  });

  it("passes Kreuzberg disableOcr even when nothing was configured", () => {
    const { config, removed } = documentExtractionForQuality(defaultDocumentExtractionConfig, "fast");
    expect(config.options).toEqual({ kreuzberg: { disableOcr: true } });
    expect(removed).toEqual([]);
  });

  it("strips a stored workspace's OCR settings too (normalized pipelines keep documentExtraction)", () => {
    const pipeline = normalizePipelineFeatures({ quality: "fast", documentExtraction: { options: { kreuzberg: { forceOcr: true } } } });
    expect(documentExtractionForQuality(pipeline.documentExtraction, pipeline.quality).config.options)
      .toEqual({ kreuzberg: { disableOcr: true } });
  });
});

describe("QUALITY_MODES", () => {
  it("prices each mode from PRICE_CARD", () => {
    expect(QUALITY_MODES.fast.creditsPer1kPages).toEqual({ min: PRICE_CARD.fastPer1kPages, max: PRICE_CARD.fastPer1kPages });
    expect(QUALITY_MODES.auto.creditsPer1kPages).toEqual({ min: PRICE_CARD.fastPer1kPages, max: PRICE_CARD.richPer1kPages });
    expect(QUALITY_MODES.good.creditsPer1kPages).toEqual({ min: PRICE_CARD.richPer1kPages, max: PRICE_CARD.richPer1kPages });
  });

  it("formats the price per 1,000 pages", () => {
    expect(qualityModePriceRange("fast")).toBe("$0.05");
    expect(qualityModePriceRange("auto")).toBe("$0.05 to $2.50");
    expect(qualityModePriceRange("good")).toBe("$2.50");
  });

  it("says Fast keeps scans as images", () => {
    expect(QUALITY_MODES.fast.description).toMatch(/Scanned pages are kept as images, not read/);
  });
});

describe("Fast page-image references", () => {
  it("references the export page image with alt text naming the page", () => {
    expect(pageImageReferenceMarkdown(3)).toBe("![Page 3: scanned page image, no text layer](images/page-0003.png)");
  });

  it.each([
    ["s3://bucket/run/images/doc/v2-150dpi/page-1.jpg", "jpg"],
    ["images/doc/page-2.WEBP", "webp"],
    ["page-3.gif?x=1", "gif"],
    ["page-4.png", "png"],
    ["page-5", "png"],
    ["page-6.exe", "png"],
  ])("names the reference after the stored image format (%s -> %s)", (uri, extension) => {
    expect(pageImageExtension(uri)).toBe(extension);
    expect(pageImageReferenceMarkdown(7, pageImageExtension(uri))).toContain(`(images/page-0007.${extension})`);
  });

  it("recognizes references structurally, never by their text", () => {
    const text = pageImageReferenceMarkdown(2);
    const reference = { pageNumber: 2, text, metadata: { extractor: "page-image" } };
    // A text layer that contains the exact reference string is ordinary text.
    const spoof = { pageNumber: 3, text, metadata: { extractor: "native-pdf" } };
    expect(isPageImageReferenceBlock(reference)).toBe(true);
    expect(isPageImageReferenceBlock(spoof)).toBe(false);
    expect(isPageImageReferenceBlock({ metadata: {} })).toBe(false);
    expect([...pageImageReferencePages([reference, spoof])]).toEqual([2]);
    // A reference page that also has real text is not a reference page.
    expect([...pageImageReferencePages([reference, { pageNumber: 2, text: "real", metadata: {} }])]).toEqual([]);
    expect(blankPages(`Intro\f${text}\f${text}`, new Set([2]))).toBe(`Intro\f\f${text}`);
  });
});
