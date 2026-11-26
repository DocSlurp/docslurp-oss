import { describe, expect, it } from "vitest";
import { visionConfigSchema, visionProfileCatalog, visionProfileKeySchema } from "../embedding.js";
import { normalizePipelineFeatures, readStoredPipelineSettings } from "../pipeline.js";


describe("retired vision profiles", () => {
  it("are no longer offered", () => {
    for (const key of ["fastest-local", "good-fast-local"]) {
      expect(key in visionProfileCatalog).toBe(false);
      expect(visionProfileKeySchema.safeParse(key).success).toBe(false);
    }
  });

  it("read as the nearest current profile and keep an explicit stored model", () => {
    expect(visionConfigSchema.parse({ profile: "fastest-local" })).toMatchObject({ profile: "cheapest-local", target: "local", modelUri: visionProfileCatalog["cheapest-local"].config.modelUri });
    expect(visionConfigSchema.parse({ profile: "good-fast-local", modelUri: "llm://vllm/Qwen/Qwen2.5-VL-3B-Instruct" })).toMatchObject({ profile: "cheapest-local", modelUri: "llm://vllm/Qwen/Qwen2.5-VL-3B-Instruct" });
    expect(normalizePipelineFeatures({ vision: { profile: "good-fast-local" } } as never).vision.profile).toBe("cheapest-local");
  });

  it("never fail a stored read", () => {
    for (const profile of ["fastest-local", "good-fast-local"]) {
      expect(readStoredPipelineSettings({ vision: { profile } }, "project p1").features.vision.profile).toBe("cheapest-local");
    }
  });
});
