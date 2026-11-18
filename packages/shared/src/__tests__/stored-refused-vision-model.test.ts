import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultVisionConfig, readVisionModelUriOverride, visionModelCatalog } from "../embedding.js";
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

  it("a project never runs on a model named in an old row, refused or not: the profile decides", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const admittedId = defaultVisionConfig.modelUri.replace("llm://openrouter/", "");
    for (const model of ["gpt-4.1-mini", admittedId]) {
      const resolved = resolveManagedPipeline({ vision: { profile: "cheapest-hosted", model, runtime: "openai-compatible", remoteFallbackModel: model } }, null, "project p7");
      expect(resolved.pipeline.vision.profile).toBe("cheapest-hosted");
      expect(resolved.pipeline.vision.modelUri).toBe("llm://openrouter/z-ai/glm-5.3-flash");
      expect(resolved.pipeline.vision.remoteFallbackModelUri).toBeNull();
    }
    // Stripped as a managed field, so nothing was "rejected by the schema" and nothing is logged.
    expect(error).not.toHaveBeenCalled();
  });

  it("does not reroute a row that pinned its own endpoint, drops the stale target, and reports an unknown fallback", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // Its own endpoint: still refused on a direct read, exactly as before.
    expect(() => normalizeStoredPipelineFeatures({ vision: { model: "gpt-4.1-mini", runtime: "remote-openai", baseUrl: "https://eu.example.com/v1" } } as never, "run r1")).toThrow();
    // The official endpoint is not a choice of its own.
    expect(normalizeStoredPipelineFeatures({ vision: { model: "gpt-4.1-mini", baseUrl: "https://openrouter.ai/api/v1/" } } as never, "run r2").vision.modelUri).toBe(defaultVisionConfig.modelUri);
    // A target stored for the dropped model does not contradict the model that replaces it.
    const local = normalizeStoredPipelineFeatures({ vision: { profile: "good-fast-local", target: "hosted", modelUri: REFUSED } } as never, "run r3");
    expect(local.vision).toMatchObject({ profile: "good-fast-local", target: "local" });
    error.mockClear();
    expect(normalizeStoredPipelineFeatures({ vision: { model: "gpt-4.1-mini", remoteFallbackModel: "nope/unknown" } } as never, "run r4").vision.remoteFallbackModelUri).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/run r4.*vision\.model, vision\.remoteFallbackModel/));
    // A project (through the managed resolver) ignores the endpoint, loudly.
    error.mockClear();
    expect(resolveManagedPipeline({ vision: { model: "gpt-4.1-mini", baseUrl: "https://eu.example.com/v1" } }, null, "project p8").pipeline.vision.modelUri).toBe(defaultVisionConfig.modelUri);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/project p8 names its own vision endpoint/));
  });

  it("is never the deployment default either", () => {
    const messages: string[] = [];
    expect(readVisionModelUriOverride({ DOCSLURP_VISION_MODEL_URI: "llm://openrouter/google/gemini-2.5-flash-lite" }, (message) => messages.push(message))).toBeNull();
    expect(messages.join(" ")).toMatch(/ignored/);
    expect(messages.join(" ")).not.toContain("gpt-4.1-mini,");
  });

  it("reads the row shape found in production, for every refused catalog model", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusedIds = visionModelCatalog.filter((spec) => "refusedReason" in spec).map((spec) => spec.id);
    expect(refusedIds).toContain("gpt-4.1-mini");
    for (const id of refusedIds) {
      const row = { vision: { model: id, prompt: "<OCR>", baseUrl: null, runtime: "remote-openai", benchmarkProfile: "difficult-pages", maxPagesPerDocument: 4, remoteFallbackModel: id } };
      for (const features of [normalizeStoredPipelineFeatures(row as never, "project p9"), resolveManagedPipeline(row, null, "project p9").pipeline]) {
        expect(features.vision.modelUri, id).toBe(defaultVisionConfig.modelUri);
        expect(features.vision.remoteFallbackModelUri, id).toBeNull();
      }
    }
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
