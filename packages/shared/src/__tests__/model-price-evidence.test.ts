import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAT_MODEL_PRICES_USD_PER_MTOK } from "../chat-model-prices.js";
import { visionModelCatalog } from "../embedding.js";
import { DEFAULT_PIPELINE_TEXT_MODEL } from "../pipeline.js";
import { defaultAiUsagePricing } from "../usage.js";
import { HOSTED_EQUIVALENT_REFERENCES } from "../billing.js";

const evidence = JSON.parse(readFileSync(new URL("../../../../docs/evals/model-prices-2026-10-25.json", import.meta.url), "utf8")) as {
  models: { id: string; pricing: { prompt: string; completion: string }; context_length: number; architecture: { input_modalities: string[] } }[];
  unavailable: string[];
};
const registry = JSON.parse(readFileSync(new URL("../../../../scripts/lib/model-prices.json", import.meta.url), "utf8")) as {
  models: Record<string, { input: number; output: number; vision?: boolean; contextWindow?: number; unavailable?: string }>;
};
const prices = new Map(evidence.models.map(model => [model.id, model]));

describe("official model price evidence", () => {
  it("keeps available registry prices and capabilities consistent with the retained official response", () => {
    for (const [id, model] of Object.entries(registry.models)) {
      if (model.unavailable) {
        expect(evidence.unavailable).toContain(id);
        expect(CHAT_MODEL_PRICES_USD_PER_MTOK[id]).toBeUndefined();
        continue;
      }
      const live = prices.get(id)!;
      expect(live, id).toBeDefined();
      expect(model.input, id).toBeCloseTo(Number(live.pricing.prompt) * 1e6, 10);
      expect(model.output, id).toBeCloseTo(Number(live.pricing.completion) * 1e6, 10);
      expect(model.contextWindow, id).toBe(live.context_length);
      expect(model.vision, id).toBe(live.architecture.input_modalities.includes("image"));
    }
  });

  it("keeps runtime chat, vision, default text and billing reference prices in agreement", () => {
    const rates = (id: string, input: number, output: number) => {
      const live = prices.get(id)!;
      expect(live, id).toBeDefined();
      expect(input, id).toBeCloseTo(Number(live.pricing.prompt) * 1e6, 10);
      expect(output, id).toBeCloseTo(Number(live.pricing.completion) * 1e6, 10);
    };
    for (const [id, price] of Object.entries(CHAT_MODEL_PRICES_USD_PER_MTOK)) rates(id, price.input, price.output);
    for (const model of visionModelCatalog) {
      if (!model.tokenPricing) continue;
      const id = model.id === "gpt-4.1-mini" ? "openai/gpt-4.1-mini" : model.id;
      rates(id, model.tokenPricing.inputUsdPerMillion, model.tokenPricing.outputUsdPerMillion);
      expect(prices.get(id)!.architecture.input_modalities).toContain("image");
    }
    rates(DEFAULT_PIPELINE_TEXT_MODEL, defaultAiUsagePricing.costPer1kInputTokens * 10, defaultAiUsagePricing.costPer1kOutputTokens * 10);
    for (const reference of Object.values(HOSTED_EQUIVALENT_REFERENCES)) {
      if (reference.provider === "openrouter") rates(reference.model, reference.inputUsdPerMTok, reference.outputUsdPerMTok);
    }
  });
});
