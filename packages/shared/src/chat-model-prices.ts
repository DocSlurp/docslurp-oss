/**
 * Verified OpenRouter list prices (USD per 1M tokens) for models that can drive
 * workspace chat: the chat catalog plus the operator eval candidates. It mirrors
 * the matching entries of scripts/lib/model-prices.json, which a test keeps in
 * sync; runtime packages cannot read that script file.
 *
 * Provider-reported cost (the OpenRouter usage receipt or generation lookup)
 * always wins. These prices only estimate a call whose receipt is missing, and
 * gate eval models: an eval model without a verified price here is refused.
 */
export const CHAT_MODEL_PRICES_CHECKED = "2026-10-25";

export const CHAT_MODEL_PRICES_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  "z-ai/glm-5.3-flash": { input: 0.15, output: 0.5 },
  "anthropic/claude-haiku-5.5": { input: 0.1, output: 0.5 },
  "deepseek/deepseek-v4.1-flash": { input: 0.02, output: 1 },
  "deepseek/deepseek-v4.1-flash-1017": { input: 0.15, output: 0.6 },
  "openai/gpt-6.1-sol": { input: 2, output: 10 },
  "openai/gpt-6-luna": { input: 0.1, output: 0.5 },
  "inception/mercury-3": { input: 0.1, output: 0.35 },
  "reflection/beam-1.0-501b-a23b": { input: 0.25, output: 1 },
  "liquid/lfm-2.5-24b-a2b": { input: 0.05, output: 0.7 },
  "xiaomi/mimo-v2.6-flash": { input: 0.14, output: 0.28 },
  "qwen/qwen3.8-max-prime": { input: 4, output: 12 },
  "nvidia/nemotron-3.5-super-vl": { input: 0.15, output: 0.5 },
};

/** USD per token, the unit OpenRouter's /models listing uses. */
export function chatModelPricePerToken(model: string): { input: number; output: number } | undefined {
  const price = CHAT_MODEL_PRICES_USD_PER_MTOK[model];
  return price ? { input: price.input / 1_000_000, output: price.output / 1_000_000 } : undefined;
}
