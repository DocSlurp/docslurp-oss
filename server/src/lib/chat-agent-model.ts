import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenRouterReasoningFetch } from "@docslurp/shared";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** DeepSeek V4 aliases and dated builds (deepseek/deepseek-v4.1-flash-1017) need explicit low reasoning. */
export function chatAgentProviderOptions(model: string) {
  return model.startsWith("deepseek/deepseek-v4") ? { openrouter: { reasoning: { effort: "low" as const } } } : undefined;
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
 * `fetch` is the usage-capture fetch; the verified reasoning floor wraps it.
 */
export function createChatAgentModel(args: { apiKey: string; model: string; fetch: typeof fetch }) {
  const provider = createOpenRouter({ apiKey: args.apiKey, baseURL: OPENROUTER_BASE_URL, compatibility: "strict",
    fetch: createOpenRouterReasoningFetch(args.fetch) });
  return provider.chat(args.model, { usage: { include: true } });
}
