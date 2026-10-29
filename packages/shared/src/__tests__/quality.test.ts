import { describe, expect, it } from "vitest";

import {
  PRICE_CARD,
  QUALITY_MODES,
  defaultPipelineFeatures,
  isPageImageReferenceMarkdown,
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
  stripPageImageReferences,
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
    [{ parserPlaybook: "review-grade" }, "good"],
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
    expect(parsed.quality).toBe("good");
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

  it("returns sources without legacy keys unchanged", () => {
    const source = { summarize: true };
    expect(migrateLegacyQualitySettings(source)).toBe(source);
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

  it("is recognized and stripped so it never becomes a text chunk", () => {
    const page = pageImageReferenceMarkdown(12);
    expect(isPageImageReferenceMarkdown(page)).toBe(true);
    expect(isPageImageReferenceMarkdown(`${page}\n\nreal text`)).toBe(false);
    expect(isPageImageReferenceMarkdown("")).toBe(false);
    expect(stripPageImageReferences(`Intro\n\f${page}\n\fOutro`).replace(/\s+/g, " ").trim()).toBe("Intro Outro");
  });
});
