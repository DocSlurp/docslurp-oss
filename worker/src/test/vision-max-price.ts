import { visionRequestPricing } from "../lib/vision-pricing.js";
import { openRouterMaxPrice } from "../tools/vision-runtime.js";

/** The `provider.max_price` an OpenRouter vision request on `model` carries (its guard weight's prices and fee caps). */
export function visionMaxPrice(model: string): { prompt: number; completion: number; image: number; request: number } {
  const { maxPrice } = visionRequestPricing({ model, runtime: "openai-compatible", billing: "openrouter", inputTokens: 1 });
  return openRouterMaxPrice(maxPrice!);
}
