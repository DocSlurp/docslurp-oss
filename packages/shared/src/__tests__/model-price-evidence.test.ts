import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAT_MODEL_PRICES_USD_PER_MTOK } from "../chat-model-prices.js";
import { visionModelCatalog, type VisionTokenPricing } from "../embedding.js";
import { DEFAULT_PIPELINE_TEXT_MODEL } from "../pipeline.js";
import { defaultAiUsagePricing } from "../usage.js";

const evidence = JSON.parse(readFileSync(new URL("../../../../docs/evals/model-prices-2026-11-12.json", import.meta.url), "utf8")) as {
  models: { id: string; pricing: { prompt: string; completion: string }; context_length: number; architecture: { input_modalities: string[] } }[];
  unavailable: string[];
  endpoints: Record<string, { tag: string; pricing: { prompt: string; completion: string } }[]>;
};
/** Endpoints of hosts a vision route added after the 2026-10-26 snapshot (China-based hosts of the DeepSeek route). */
const routeEvidence = JSON.parse(readFileSync(new URL("../../../../docs/evals/vision-route-prices-2026-10-29.json", import.meta.url), "utf8")) as {
  endpoints: Record<string, { tag: string; pricing: { prompt: string; completion: string } }[]>;
};
/** Endpoints of GPT-6 Luna's pinned route (OpenAI plus the content-filter retry hosts), fetched when it became the default. */
const lunaRouteEvidence = JSON.parse(readFileSync(new URL("../../../../docs/evals/vision-route-prices-2026-11-13.json", import.meta.url), "utf8")) as {
  endpoints: Record<string, { tag: string; pricing: { prompt: string; completion: string } }[]>;
};
/** DeepInfra's /models/list pricing for vision routes priced from a direct provider's list (`basis: "provider-list"`). */
const deepInfraEvidence = JSON.parse(readFileSync(new URL("../../../../docs/evals/deepinfra-vision-prices-2026-11-04.json", import.meta.url), "utf8")) as {
  models: { model_name: string; pricing: { cents_per_input_token: number; cents_per_output_token: number } }[];
};
const registry = JSON.parse(readFileSync(new URL("../../../../scripts/lib/model-prices.json", import.meta.url), "utf8")) as {
  models: Record<string, { input: number; output: number; vision?: boolean; contextWindow?: number; unavailable?: string; priceEndpoint?: string }>;
};
const listings = new Map(evidence.models.map(model => [model.id, model]));
/** A model's list price: the endpoint its registry entry names (`priceEndpoint`), else OpenRouter's top-level price. */
function listPrice(id: string): { prompt: string; completion: string } {
  const named = registry.models[id]?.priceEndpoint;
  if (named) {
    const endpoint = evidence.endpoints[id]?.find((entry) => entry.tag === named);
    expect(endpoint, `${id} priceEndpoint ${named}`).toBeDefined();
    return endpoint!.pricing;
  }
  const live = listings.get(id);
  expect(live, id).toBeDefined();
  return live!.pricing;
}

describe("official model price evidence", () => {
  it("keeps available registry prices and capabilities consistent with the retained official response", () => {
    for (const [id, model] of Object.entries(registry.models)) {
      if (model.unavailable) {
        expect(evidence.unavailable).toContain(id);
        expect(CHAT_MODEL_PRICES_USD_PER_MTOK[id]).toBeUndefined();
        continue;
      }
      const live = listings.get(id)!;
      expect(live, id).toBeDefined();
      const price = listPrice(id);
      expect(model.input, id).toBeCloseTo(Number(price.prompt) * 1e6, 10);
      expect(model.output, id).toBeCloseTo(Number(price.completion) * 1e6, 10);
      expect(model.contextWindow, id).toBe(live.context_length);
      expect(model.vision, id).toBe(live.architecture.input_modalities.includes("image"));
    }
  });

  it("keeps runtime chat, vision, default text and billing reference prices in agreement", () => {
    const rates = (id: string, input: number, output: number) => {
      const price = listPrice(id);
      expect(input, id).toBeCloseTo(Number(price.prompt) * 1e6, 10);
      expect(output, id).toBeCloseTo(Number(price.completion) * 1e6, 10);
    };
    for (const [id, price] of Object.entries(CHAT_MODEL_PRICES_USD_PER_MTOK)) rates(id, price.input, price.output);
    for (const model of visionModelCatalog) {
      const pricing: VisionTokenPricing | null = model.tokenPricing;
      if (!pricing) continue;
      if (pricing.basis === "provider-list") {
        // A direct-provider route is priced at that provider's retained list price (cents per token x 1e4 = USD per M).
        expect(pricing.providers, model.id).toEqual(["deepinfra"]);
        expect(model.uri.startsWith("llm://deepinfra/"), model.id).toBe(true);
        const listed = deepInfraEvidence.models.find((entry) => entry.model_name === model.id);
        expect(listed, model.id).toBeDefined();
        expect(pricing.inputUsdPerMillion, model.id).toBeCloseTo(listed!.pricing.cents_per_input_token * 1e4, 10);
        expect(pricing.outputUsdPerMillion, model.id).toBeCloseTo(listed!.pricing.cents_per_output_token * 1e4, 10);
        continue;
      }
      const id = model.id === "gpt-4.1-mini" ? "openai/gpt-4.1-mini" : model.id;
      expect(listings.get(id)!.architecture.input_modalities).toContain("image");
      if (pricing.basis !== "pinned-route") {
        rates(id, pricing.inputUsdPerMillion, pricing.outputUsdPerMillion);
        continue;
      }
      // A pinned route is priced at its most expensive pinned provider's cheapest endpoint, from the retained endpoint
      // response: every pinned provider can serve at or under the route price. A provider's dearer variants (for
      // example `fireworks/us`) never serve, since the request's max_price is the route price.
      const endpoints = [...(evidence.endpoints[id] ?? []), ...(routeEvidence.endpoints[id] ?? []), ...(lunaRouteEvidence.endpoints[id] ?? [])];
      const cheapestOf = (provider: string, side: "prompt" | "completion") => {
        const own = endpoints.filter((endpoint) => endpoint.tag === provider || endpoint.tag.startsWith(`${provider}/`));
        expect(own.length, `${id} ${provider}`).toBeGreaterThan(0);
        // The endpoint that fits both prices at once: the cheapest by prompt among those under both route prices.
        const fitting = own.filter((endpoint) => Number(endpoint.pricing.prompt) * 1e6 <= pricing.inputUsdPerMillion + 1e-9
          && Number(endpoint.pricing.completion) * 1e6 <= pricing.outputUsdPerMillion + 1e-9);
        expect(fitting.length, `${id} ${provider} has an endpoint at or under the route price`).toBeGreaterThan(0);
        return Math.min(...fitting.map((endpoint) => Number(endpoint.pricing[side]) * 1e6));
      };
      expect(pricing.inputUsdPerMillion, id).toBeCloseTo(Math.max(...pricing.providers!.map((provider) => cheapestOf(provider, "prompt"))), 10);
      expect(pricing.outputUsdPerMillion, id).toBeCloseTo(Math.max(...pricing.providers!.map((provider) => cheapestOf(provider, "completion"))), 10);
    }
    rates(DEFAULT_PIPELINE_TEXT_MODEL, defaultAiUsagePricing.costPer1kInputTokens * 10, defaultAiUsagePricing.costPer1kOutputTokens * 10);
  });
});
