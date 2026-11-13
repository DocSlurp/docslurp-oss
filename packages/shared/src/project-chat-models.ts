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
 * Speed boost model swaps: a model Speed boost answers with instead of the chosen model's own Nitro variant. Empty:
 * Speed boost answers with the chosen model on Nitro. The 2026-11-10 swap from GLM 5.3 Flash to DeepSeek V4.1 Flash
 * on Nitro was removed (owner, 2026-11-13): a swap is an automatic selection, and DeepSeek V4.1 Flash is never
 * selected automatically (automatic-model-selection.ts). A swap target must never be such a model.
 */
export const SPEED_BOOST_MODEL_SWAPS: Readonly<Record<string, ProjectChatModelId>> = {};

export function isProjectChatModelId(model: unknown): model is ProjectChatModelId {
  return PROJECT_CHAT_MODELS.some((candidate) => candidate.id === model);
}

/**
 * A chat `model` as sent: a catalog id or its `llm://openrouter/<id>` URI. Returns
 * the bare id (trimmed) for policy and provider calls; unknown values pass through
 * so the caller can refuse them.
 */
export function normalizeChatModelRef(model: string): string {
  // Options (`?reasoning=high`) are not part of the model's identity; an unreadable option keeps the query so the
  // reference matches no catalog model and is refused.
  const id = normalizeHostedModelRef(parseChatModelOptions(model)?.model ?? model);
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

/**
 * How much a chat turn's answering model reasons, in OpenRouter's native effort names. `none` (the default) sends
 * each model's verified lowest setting: reasoning is the largest source of chat latency (measured 2026-11-10 on
 * DeepSeek V4.1 Flash 1017: 1.18 s p50 a call at the provider default against 0.56 s with reasoning off, on the
 * same host). `minimal` to `high` ask for more, for long multi-query questions. Search helpers (query rewrites,
 * HyDE, planning) always run at the floor.
 */
export const CHAT_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high"] as const;
export type ChatReasoningLevel = (typeof CHAT_REASONING_LEVELS)[number];
export const DEFAULT_CHAT_REASONING: ChatReasoningLevel = "none";

/** Option keys that name the reasoning level: DocSlurp's `reasoning` and the native `reasoning_effort` / `effort`. */
const CHAT_REASONING_KEYS = new Set(["reasoning", "reasoning_effort", "effort"]);
const CHAT_REASONING_ALIASES: Readonly<Record<string, ChatReasoningLevel>> = { off: "none", false: "none", disabled: "none" };

export function isChatReasoningLevel(value: unknown): value is ChatReasoningLevel {
  return typeof value === "string" && (CHAT_REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * A chat model reference split from its options: `llm://openrouter/<id>?reasoning=high`, or the bare
 * `<id>?effort=low`. The only option is the reasoning level (keys `reasoning`, `reasoning_effort`, `effort`; values
 * none, minimal, low, medium, high, plus `off` for none). Null for an unknown option, an invalid or conflicting
 * level, or a fragment: a reference DocSlurp cannot honour exactly is refused, never read loosely.
 */
export function parseChatModelOptions(ref: string): { model: string; reasoning?: ChatReasoningLevel } | null {
  const trimmed = ref.trim();
  if (trimmed.includes("#")) return null;
  const at = trimmed.indexOf("?");
  if (at < 0) return { model: trimmed };
  const model = trimmed.slice(0, at);
  let reasoning: ChatReasoningLevel | undefined;
  for (const [rawKey, rawValue] of new URLSearchParams(trimmed.slice(at + 1))) {
    if (!CHAT_REASONING_KEYS.has(rawKey.toLowerCase())) return null;
    const value = rawValue.trim().toLowerCase();
    const level = CHAT_REASONING_ALIASES[value] ?? (isChatReasoningLevel(value) ? value : undefined);
    if (!level || (reasoning && reasoning !== level)) return null;
    reasoning = level;
  }
  return reasoning ? { model, reasoning } : { model };
}

/** `model` with a reasoning option; the default level leaves the reference bare. */
export function withChatReasoning(model: string, reasoning: ChatReasoningLevel): string {
  const base = parseChatModelOptions(model)?.model ?? model;
  return reasoning === DEFAULT_CHAT_REASONING ? base : `${base}?reasoning=${reasoning}`;
}
