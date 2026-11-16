import { nitroBaseModel } from "./project-chat-models.js";

/**
 * Prompt-cache breakpoints for OpenRouter Chat Completions requests to models that cache only at explicit
 * `cache_control` markers. Measured 2026-11-13 on anthropic/claude-haiku-5.5 (8.3k-token repeated system prompt, three
 * calls each): no marker never cached; a marker on a content part or a top-level `cache_control` both cached on Chat
 * Completions (call cost −88% on a hit); on the Responses API only the top-level field cached, part markers were
 * ignored. OpenAI, DeepSeek, GLM and most open-weight hosts cache a repeated prefix on their own and get nothing here.
 *
 * One marker, at the end of the last system (or `developer`) message: the fixed instructions every call of a feature
 * shares. Per-request content (retrieved evidence, the question, a page image) is never marked. Evidence was marked at
 * first, but with chat follow-ups re-running retrieval it rarely repeats: on 12 re-retrieved turns that marker billed
 * 82% of input as cache writes (1.25x) for 11% reads, +7% cost per answer, while the system marker alone was −9%.
 * A body that already carries a marker anywhere is left as the caller built it. Claude 5.5 models cache prefixes of
 * 512 tokens or more; shorter prefixes are simply not cached (no error, no write charge).
 */
export function needsExplicitPromptCache(model: string | undefined): boolean {
  const base = model ? nitroBaseModel(model) ?? model : "";
  return /^anthropic\//.test(base.trim());
}

const MARKER = { type: "ephemeral" } as const;

type Part = Record<string, unknown>;
type Message = { role?: unknown; content?: unknown } & Record<string, unknown>;

function hasMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasMarker);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key === "cache_control" || hasMarker(child));
}

function markLastPart(message: Message): Message | null {
  if (typeof message.content === "string") {
    return message.content ? { ...message, content: [{ type: "text", text: message.content, cache_control: MARKER }] } : null;
  }
  if (!Array.isArray(message.content) || message.content.length === 0) return null;
  const parts = [...message.content] as Part[];
  const last = parts.at(-1)!;
  if (last?.type !== "text") return null;
  parts[parts.length - 1] = { ...last, cache_control: MARKER };
  return { ...message, content: parts };
}


/** A Chat Completions body with breakpoints added (see the module comment), or the same body when none apply. */
export function withPromptCacheBreakpoints<T extends Record<string, unknown>>(body: T): T {
  if (!needsExplicitPromptCache(typeof body.model === "string" ? body.model : undefined)) return body;
  if (!Array.isArray(body.messages) || hasMarker(body.messages) || "cache_control" in body) return body;
  const messages = [...body.messages] as Message[];
  let changed = false;
  const lastIndexOf = (role: string) => { for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === role) return i; return -1; };
  // The AI SDK's OpenAI chat model sends the system prompt as a `developer` message when reasoning is requested.
  const lastSystem = Math.max(lastIndexOf("system"), lastIndexOf("developer"));
  if (lastSystem >= 0) {
    const marked = markLastPart(messages[lastSystem]!);
    if (marked) { messages[lastSystem] = marked; changed = true; }
  }
  return changed ? { ...body, messages } : body;
}

/**
 * OpenRouter's request shape for a Claude Chat Completions body built by the AI SDK's OpenAI chat model: an explicit
 * effort goes in OpenRouter's `reasoning` object (the SDK writes OpenAI's `reasoning_effort`), and the output cap in
 * `max_tokens` (the SDK writes `max_completion_tokens` for reasoning requests). Other models pass through.
 */
export function withOpenRouterClaudeChatShape<T extends Record<string, unknown>>(body: T): T {
  if (!needsExplicitPromptCache(typeof body.model === "string" ? body.model : undefined)) return body;
  const next: Record<string, unknown> = { ...body };
  let changed = false;
  if (typeof next.reasoning_effort === "string") {
    if (next.reasoning === undefined) next.reasoning = { effort: next.reasoning_effort };
    delete next.reasoning_effort;
    changed = true;
  }
  if (typeof next.max_completion_tokens === "number") {
    if (next.max_tokens === undefined) next.max_tokens = next.max_completion_tokens;
    delete next.max_completion_tokens;
    changed = true;
  }
  return (changed ? next : body) as T;
}

/**
 * Fetch wrapper for Chat Completions request bodies: `withOpenRouterClaudeChatShape`, then `withPromptCacheBreakpoints`.
 * Other endpoints pass through.
 */
export function createOpenRouterPromptCacheFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!/\/chat\/completions$/.test(url) || typeof init?.body !== "string") return baseFetch(input, init);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return baseFetch(input, init);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return baseFetch(input, init);
    const next = withPromptCacheBreakpoints(withOpenRouterClaudeChatShape(body));
    return baseFetch(input, next === body ? init : { ...init, body: JSON.stringify(next) });
  };
}
