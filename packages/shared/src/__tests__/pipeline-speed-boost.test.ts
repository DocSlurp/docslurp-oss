import { expect, it } from "vitest";
import { assertPipelineSpeedBoost, pipelineFeaturesSchema } from "../pipeline.js";
const model = "z-ai/glm-5.3-flash:nitro";
for (const configured of [
  { vision: { model } }, { vision: { modelUri: `llm://openrouter/${model}` } },
  { vision: { remoteFallbackModelUri: `llm://openrouter/${model}` } },
  { textGeneration: { model } }, { textGeneration: { models: { "document-summary": model } } },
  { pageRouter: { decisionModel: model } }, { pageRouter: { decisionModel: ["openai/gpt-6-luna", model] } },
]) {
  it(`requires explicit opt-in for ${JSON.stringify(configured)}`, () => {
    expect(() => assertPipelineSpeedBoost(configured)).toThrow("speedBoost");
    expect(() => assertPipelineSpeedBoost({ ...configured, speedBoost: false })).toThrow("speedBoost");
    expect(() => assertPipelineSpeedBoost({ ...configured, speedBoost: true })).not.toThrow();
    // The admission override wins over a previously saved opt-in.
    const saved = { ...configured, speedBoost: true };
    expect(() => assertPipelineSpeedBoost({ ...saved, speedBoost: false })).toThrow("speedBoost");
  });
}
it("schema refuses hosted Nitro without opt-in and leaves private model names alone", () => {
  expect(pipelineFeaturesSchema.safeParse({ textGeneration: { model } }).success).toBe(false);
  expect(pipelineFeaturesSchema.safeParse({ textGeneration: { model }, speedBoost: true }).success).toBe(true);
  expect(() => assertPipelineSpeedBoost({ textGeneration: { model: "llm://private/local/custom:nitro" } })).not.toThrow();
});
