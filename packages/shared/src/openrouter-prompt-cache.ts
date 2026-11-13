import { nitroBaseModel } from "./project-chat-models.js";

/**
 * Prompt-cache breakpoints for OpenRouter Chat Completions requests to models that cache only at explicit
 * `cache_control` markers. Measured 2026-11-13 on anthropic/claude-haiku-5.5 (8.3k-token repeated system prompt, three
 * calls each): no marker never cached; a marker on a content part or a top-level `cache_control` both cached on Chat
 * Completions (call cost −88% on a hit); on the Responses API only the top-level field cached, part markers were
 * ignored. OpenAI, DeepSeek, GLM and most open-weight hosts cache a repeated prefix on their own and get nothing here.
 *
 * Markers go at the end of stable content, never after the per-request tail, so a request never pays the
 * cache-write premium (1.25x input) on bytes no later request can read:
 * - the last part of the last system message (instructions shared by every call of a feature);
 * - in the final user message, the part before its last one when it has several: callers put reusable context
 *   (retrieved evidence, a document) first and the per-request question last.
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

function markStablePrefixOfUser(message: Message): Message | null {
  if (!Array.isArray(message.content) || message.content.length < 2) return null;
  const parts = [...message.content] as Part[];
  const index = parts.length - 2;
  if (parts[index]?.type !== "text") return null;
  parts[index] = { ...parts[index], cache_control: MARKER };
  return { ...message, content: parts };
}

/** A Chat Completions body with breakpoints added (see the module comment), or the same body when none apply. */
export function withPromptCacheBreakpoints<T extends Record<string, unknown>>(body: T): T {
  if (!needsExplicitPromptCache(typeof body.model === "string" ? body.model : undefined)) return body;
  if (!Array.isArray(body.messages) || hasMarker(body.messages) || "cache_control" in body) return body;
  const messages = [...body.messages] as Message[];
  let changed = false;
  const lastIndexOf = (role: string) => { for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === role) return i; return -1; };
  const lastSystem = lastIndexOf("system");
  if (lastSystem >= 0) {
    const marked = markLastPart(messages[lastSystem]!);
    if (marked) { messages[lastSystem] = marked; changed = true; }
  }
  const lastUser = lastIndexOf("user");
  if (lastUser >= 0 && lastUser === messages.length - 1) {
    const marked = markStablePrefixOfUser(messages[lastUser]!);
    if (marked) { messages[lastUser] = marked; changed = true; }
  }
  return changed ? { ...body, messages } : body;
}

/** Fetch wrapper applying `withPromptCacheBreakpoints` to Chat Completions request bodies; others pass through. */
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
    const next = withPromptCacheBreakpoints(body);
    return baseFetch(input, next === body ? init : { ...init, body: JSON.stringify(next) });
  };
}
