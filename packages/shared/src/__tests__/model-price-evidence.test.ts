import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAT_MODEL_PRICES_USD_PER_MTOK } from "../chat-model-prices.js";
import { visionModelCatalog, type VisionTokenPricing } from "../embedding.js";
import { DEFAULT_PIPELINE_TEXT_MODEL } from "../pipeline.js";
import { defaultAiUsagePricing } from "../usage.js";
import { HOSTED_EQUIVALENT_REFERENCES } from "../billing.js";

const evidence = JSON.parse(readFileSync(new URL("../../../../docs/evals/model-prices-2026-10-26.json", import.meta.url), "utf8")) as {
  models: { id: string; pricing: { prompt: string; completion: string }; context_length: number; architecture: { input_modalities: string[] } }[];
  unavailable: string[];
  endpoints: Record<string, { tag: string; pricing: { prompt: string; completion: string } }[]>;
};
/** Endpoints of hosts a vision route added after the 2026-10-26 snapshot (China-based hosts of the DeepSeek route). */
const routeEvidence = JSON.parse(readFileSync(new URL("../../../../docs/evals/vision-route-prices-2026-10-29.json", import.meta.url), "utf8")) as {
  endpoints: Record<string, { tag: string; pricing: { prompt: string; completion: string } }[]>;
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
      const pricing: VisionTokenPricing | null = model.tokenPricing;
      if (!pricing) continue;
      const id = model.id === "gpt-4.1-mini" ? "openai/gpt-4.1-mini" : model.id;
      expect(prices.get(id)!.architecture.input_modalities).toContain("image");
      if (pricing.basis !== "pinned-route") {
        rates(id, pricing.inputUsdPerMillion, pricing.outputUsdPerMillion);
        continue;
      }
      // A pinned route is priced at its most expensive pinned provider, from the retained endpoint response.
      const endpoints = [...(evidence.endpoints[id] ?? []), ...(routeEvidence.endpoints[id] ?? [])];
      const pinned = endpoints.filter((endpoint) => pricing.providers!.some((provider) => endpoint.tag === provider || endpoint.tag.startsWith(`${provider}/`)));
      expect(pinned.length, id).toBeGreaterThanOrEqual(pricing.providers!.length);
      expect(pricing.inputUsdPerMillion, id).toBeCloseTo(Math.max(...pinned.map((endpoint) => Number(endpoint.pricing.prompt) * 1e6)), 10);
      expect(pricing.outputUsdPerMillion, id).toBeCloseTo(Math.max(...pinned.map((endpoint) => Number(endpoint.pricing.completion) * 1e6)), 10);
    }
    rates(DEFAULT_PIPELINE_TEXT_MODEL, defaultAiUsagePricing.costPer1kInputTokens * 10, defaultAiUsagePricing.costPer1kOutputTokens * 10);
    for (const reference of Object.values(HOSTED_EQUIVALENT_REFERENCES)) {
      if (reference.provider === "openrouter") rates(reference.model, reference.inputUsdPerMTok, reference.outputUsdPerMTok);
    }
  });
});
