import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultVisionConfig } from "../embedding.js";
import { resolveManagedPipeline } from "../managed-pipeline-models.js";
import { normalizePipelineFeatures, normalizeStoredPipelineFeatures, sanitizeStoredPipeline } from "../pipeline.js";

const REFUSED = "llm://openai/gpt-4.1-mini";

afterEach(() => vi.restoreAllMocks());

describe("a stored vision model that is no longer admitted", () => {
  it("is still refused on a new write", () => {
    expect(() => normalizePipelineFeatures({ vision: { modelUri: REFUSED } } as never)).toThrow(/is not admitted/);
  });

  it("reads with the default model instead of failing the row, and says so", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stored = { vision: { prompt: "<OCR> keep", modelUri: REFUSED, remoteFallbackModelUri: REFUSED } };
    const features = normalizeStoredPipelineFeatures(stored as never, "project p1");
    expect(features.vision.modelUri).toBe(defaultVisionConfig.modelUri);
    expect(features.vision.remoteFallbackModelUri).not.toBe(REFUSED);
    expect(JSON.stringify(features)).not.toContain("gpt-4.1-mini");
    // The rest of the stored vision settings survive, and the stored row is not mutated.
    expect(features.vision.prompt).toBe("<OCR> keep");
    expect(stored.vision.modelUri).toBe(REFUSED);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/project p1.*dropped vision\.modelUri, vision\.remoteFallbackModelUri/));
  });

  it("reads an older row that names the refused model by catalog id (the shape that failed the project list)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stored = { vision: { model: "gpt-4.1-mini", runtime: "remote-openai", remoteFallbackModel: "gpt-4.1-mini", prompt: "<OCR> keep" } };
    const features = normalizeStoredPipelineFeatures(stored as never, "project p4");
    expect(features.vision.modelUri).toBe(defaultVisionConfig.modelUri);
    expect(features.vision.remoteFallbackModelUri).toBeNull();
    expect(features.vision.prompt).toBe("<OCR> keep");
    expect(JSON.stringify(features)).not.toContain("gpt-4.1-mini");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/project p4.*dropped vision\.model, vision\.remoteFallbackModel/));
    // Through the managed-model resolver, which is what lists projects.
    expect(resolveManagedPipeline(stored, null, "project p4").pipeline.vision.modelUri).toBe(defaultVisionConfig.modelUri);
    // A refused model with an admitted legacy fallback keeps the fallback.
    const admittedId = defaultVisionConfig.modelUri.replace("llm://openrouter/", "");
    const kept = normalizeStoredPipelineFeatures({ vision: { model: "gpt-4.1-mini", remoteFallbackModel: admittedId } } as never, "project p5");
    expect(kept.vision.remoteFallbackModelUri).toBe(defaultVisionConfig.modelUri);
  });

  it("is reported as dropped, never as applied, when a managed override names it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveManagedPipeline({}, { vision: { modelUri: REFUSED, remoteFallbackModelUri: REFUSED } }, "project p6");
    expect(resolved.dropped).toEqual(["vision.modelUri", "vision.remoteFallbackModelUri"]);
    expect(resolved.applied).toEqual([]);
    expect(resolved.pipeline.vision.modelUri).toBe(defaultVisionConfig.modelUri);
  });

  it("leaves an admitted stored model and every other invalid vision setting alone", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const admitted = { vision: { modelUri: defaultVisionConfig.modelUri } };
    expect(sanitizeStoredPipeline(admitted, "project p2")).toEqual(admitted);
    expect(error).not.toHaveBeenCalled();
    // Not a refusal: an unknown hosted model still fails the read, as before.
    expect(() => normalizeStoredPipelineFeatures({ vision: { modelUri: "llm://openai/not-a-catalog-model" } } as never, "project p3")).toThrow();
  });
});
