import { visionRequestPricing } from "../lib/vision-pricing.js";
import { openRouterMaxPrice } from "../tools/vision-runtime.js";

/** The `provider.max_price` an OpenRouter vision request on `model` carries (its guard weight's prices). */
export function visionMaxPrice(model: string): { prompt: number; completion: number } {
  const { maxPrice } = visionRequestPricing({ model, runtime: "openai-compatible", billable: true, openRouter: true, inputTokens: 1 });
  return openRouterMaxPrice(maxPrice!);
}
