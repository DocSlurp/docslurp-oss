import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenRouterReasoningFetch, createOpenRouterRoutingFetch } from "@docslurp/shared";
import { instrumentFetch } from "@docslurp/shared/observability";
import { DEFAULT_CHAT_REASONING, type ChatReasoningLevel } from "@docslurp/shared/project-chat-models";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * The turn's reasoning request (the chat model reference's `?reasoning=` option). `none` sends nothing here: the
 * reasoning fetch (createChatAgentModel) forces each model's verified lowest setting. `minimal` to `high` ask the
 * model for that effort explicitly.
 */
export function chatAgentProviderOptions(_model: string, reasoning: ChatReasoningLevel = DEFAULT_CHAT_REASONING) {
  return reasoning === "none" ? undefined : { openrouter: { reasoning: { effort: reasoning } } };
}

/**
 * Prompt-cache breakpoint for upstreams that cache only at explicit
 * cache_control markers (Anthropic and Gemini through OpenRouter). Others
 * (OpenAI, DeepSeek, GLM, Qwen and most open-weight hosts) cache a repeated
 * prefix on their own, so they get no marker. Cached reads are billed at a
 * discount, and OpenRouter's receipt cost already reflects it.
 */
export function promptCacheBreakpoint(model: string) {
  return /^(anthropic|google)\//.test(model) ? { openrouter: { cacheControl: { type: "ephemeral" as const } } } : undefined;
}

/**
 * The agent's chat model. It uses OpenRouter's AI SDK provider rather than the
 * OpenAI adapter because the adapter drops `reasoning` / `reasoning_details`
 * from chat completions, so every follow-up step resent assistant turns
 * without their reasoning. Interleaved-thinking models reject that with a 400
 * ("missing its reasoning"), and other reasoning models lose their context.
 * This provider keeps each step's reasoning_details (including signatures and
 * encrypted blocks) on the assistant message; OpenRouter maps them to each
 * upstream's format (for example `reasoning_content`).
 * `fetch` is the usage-capture fetch; the reasoning fetch wraps it. With `reasoning` none it forces each model's
 * verified lowest setting (or switches reasoning off, retrying with the provider default when a model answers
 * "reasoning is mandatory"); otherwise the explicit effort from chatAgentProviderOptions passes through.
 * Each agent step gets an `openrouter.chat-agent` span carrying the routed
 * model, provider sort, upstream host, time to first chunk and usage.
 */
export function createChatAgentModel(args: { apiKey: string; model: string; fetch: typeof fetch; reasoning?: ChatReasoningLevel }) {
  const effort = (args.reasoning ?? DEFAULT_CHAT_REASONING) === "none" ? "none" : undefined;
  const provider = createOpenRouter({ apiKey: args.apiKey, baseURL: OPENROUTER_BASE_URL, compatibility: "strict",
    fetch: createOpenRouterReasoningFetch(createOpenRouterRoutingFetch(instrumentFetch("openrouter", "chat-agent", args.fetch)), effort) });
  return provider.chat(args.model, { usage: { include: true } });
}
