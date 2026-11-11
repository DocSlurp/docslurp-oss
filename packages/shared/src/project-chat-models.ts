import { normalizeHostedModelRef } from "./model-uri.js";

export const PROJECT_CHAT_MODELS = [
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", description: "Default efficient model" },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", description: "Compact Claude model" },
  { id: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash", description: "Efficient reasoning" },
  { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", description: "Complex reasoning" },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", description: "Fast, focused answers" },
  { id: "z-ai/glm-5.3-flash:nitro", label: "GLM 5.3 Flash (Nitro)", description: "Cheapest fast host, price capped" },
  { id: "deepseek/deepseek-v4.1-flash-1017:nitro", label: "DeepSeek V4.1 Flash (Nitro)", description: "Cheapest fast host, price capped" },
  { id: "openai/gpt-6-luna:nitro", label: "GPT-6 Luna (Nitro)", description: "Cheapest fast host, price capped" },
] as const;

export type ProjectChatModelId = (typeof PROJECT_CHAT_MODELS)[number]["id"];

export const DEFAULT_PROJECT_CHAT_MODEL: ProjectChatModelId =
  "z-ai/glm-5.3-flash";

/**
 * Speed boost on the default efficient model answers with DeepSeek V4.1 Flash
 * on Nitro instead of GLM 5.3 Flash on Nitro: measured 2026-11-10 (3 runs,
 * ~3k-token prompt), DeepSeek Nitro steps took 0.9-1.1 s against 2.3-2.7 s.
 */
export const SPEED_BOOST_MODEL_SWAPS: Readonly<Record<string, ProjectChatModelId>> = {
  "z-ai/glm-5.3-flash": "deepseek/deepseek-v4.1-flash-1017:nitro",
};

export function isProjectChatModelId(model: unknown): model is ProjectChatModelId {
  return PROJECT_CHAT_MODELS.some((candidate) => candidate.id === model);
}

/**
 * A chat `model` as sent: a catalog id or its `llm://openrouter/<id>` URI. Returns
 * the bare id (trimmed) for policy and provider calls; unknown values pass through
 * so the caller can refuse them.
 */
export function normalizeChatModelRef(model: string): string {
  const id = normalizeHostedModelRef(model);
  return CHAT_MODEL_ALIASES[id] ?? id;
}

/** Earlier catalog ids that now name a newer build of the same model. */
const CHAT_MODEL_ALIASES: Readonly<Record<string, ProjectChatModelId>> = {
  "deepseek/deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash-1017",
  "deepseek/deepseek-v4.1-flash:nitro": "deepseek/deepseek-v4.1-flash-1017:nitro",
};

/** Display fallback only; request handling rejects unknown explicit models. */
export function resolveProjectChatModel(
  model: string | null | undefined,
): ProjectChatModelId {
  return (
    PROJECT_CHAT_MODELS.find((candidate) => candidate.id === (model ? normalizeChatModelRef(model) : model))?.id ??
    DEFAULT_PROJECT_CHAT_MODEL
  );
}

/** Only these reviewed variants inherit base-model policy; never strip arbitrary suffixes. */
export function nitroBaseModel(model: string): string | undefined {
  return model.endsWith(":nitro") && isProjectChatModelId(model) ? model.slice(0, -6) : undefined;
}

/**
 * Speed boost price ceilings (USD per 1M tokens) at each model's first-party list price, so a host repricing
 * above it is never chosen. With no host under the ceiling OpenRouter answers 404 and the request falls back to
 * the model's normal price-sorted route (createOpenRouterRoutingFetch in
 * openrouter-routing.ts). Open-weight hosts list from a fraction of these to several times them, and the spread moves.
 */
const SPEED_BOOST_MAX_PRICE: Readonly<Record<string, { prompt: number; completion: number }>> = {
  "deepseek/deepseek-v4.1-flash-1017": { prompt: 0.3, completion: 1.2 },
  "z-ai/glm-5.3-flash": { prompt: 0.15, completion: 0.5 },
  "openai/gpt-6-luna": { prompt: 0.1, completion: 0.5 },
};
/** The ceiling for a reviewed variant without its own entry. */
const SPEED_BOOST_DEFAULT_MAX_PRICE = { prompt: 0.3, completion: 1.2 } as const;

/** The Speed boost price ceiling for a base model id, USD per 1M tokens. */
export function speedBoostMaxPrice(base: string): { prompt: number; completion: number } {
  return SPEED_BOOST_MAX_PRICE[base] ?? SPEED_BOOST_DEFAULT_MAX_PRICE;
}
