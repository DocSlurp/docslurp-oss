import { describe, expect, it } from "vitest";

import { defaultPipelineFeatures, normalizePipelineFeatures, parseStoredPipelineFeatures } from "./pipeline.js";

describe("parseStoredPipelineFeatures", () => {
  it("reads historical snapshots with retired keys and nulls (prod /v1/runs 500)", () => {
    const stored = structuredClone(defaultPipelineFeatures) as unknown as Record<string, any>;
    stored.documentExtraction = { ...stored.documentExtraction, pages: null };
    stored.vision = { ...stored.vision, model: "gpt-4o", baseUrl: "https://x", runtime: "remote", remoteFallbackModel: "y" };
    expect(() => normalizePipelineFeatures(stored as never)).toThrow();
    const parsed = parseStoredPipelineFeatures(stored);
    expect(parsed.vision).not.toHaveProperty("baseUrl");
    expect(Array.isArray(parsed.documentExtraction.pages) || parsed.documentExtraction.pages === undefined).toBe(true);
    expect(parsed.parserPlaybook).toBe(defaultPipelineFeatures.parserPlaybook);
  });

  it("keeps valid settings and falls back to defaults for garbage", () => {
    expect(parseStoredPipelineFeatures({ ...defaultPipelineFeatures, summarize: true }).summarize).toBe(true);
    expect(parseStoredPipelineFeatures(null).summarize).toBe(defaultPipelineFeatures.summarize);
    expect(parseStoredPipelineFeatures("nonsense").embed).toBe(true);
  });
});
