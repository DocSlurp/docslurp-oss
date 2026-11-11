import { normalizeHostedModelRef } from "./model-uri.js";

export const PROJECT_CHAT_MODELS = [
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", description: "Default efficient model" },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", description: "Compact Claude model" },
  { id: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash", description: "Efficient reasoning" },
  { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", description: "Complex reasoning" },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", description: "Fast, focused answers" },
  { id: "z-ai/glm-5.3-flash:nitro", label: "GLM 5.3 Flash (Nitro)", description: "Throughput routing; variable provider cost" },
  { id: "deepseek/deepseek-v4.1-flash-1017:nitro", label: "DeepSeek V4.1 Flash (Nitro)", description: "Throughput routing; variable provider cost" },
  { id: "openai/gpt-6-luna:nitro", label: "GPT-6 Luna (Nitro)", description: "Throughput routing; variable provider cost" },
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
