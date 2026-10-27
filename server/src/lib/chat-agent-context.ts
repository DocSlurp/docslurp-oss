import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Set by the chat search agent around its in-process tool dispatch, so the
 * retrieval it triggers can name the chat session (span attribute and
 * search_sessions metadata) and stops when the turn does. Never read from
 * request input.
 */
const chatAgentContext = new AsyncLocalStorage<{ chatSessionId: string | null; signal?: AbortSignal }>();

export function runInChatAgentContext<T>(chatSessionId: string | null, run: () => T, signal?: AbortSignal): T {
  return chatAgentContext.run({ chatSessionId, ...(signal ? { signal } : {}) }, run);
}

export function currentChatSessionId(): string | null {
  return chatAgentContext.getStore()?.chatSessionId ?? null;
}

/**
 * The calling agent turn's tool signal (turn deadline, tool budget or client
 * disconnect). The in-process tool dispatcher does not open a new request
 * context, so without this nested work would only see the outer HTTP request.
 */
export function currentChatAgentSignal(): AbortSignal | undefined {
  return chatAgentContext.getStore()?.signal;
}

/** Whether the current call runs inside a chat agent turn's tool dispatch (vs. an external MCP client). */
export function inChatAgentContext(): boolean {
  return chatAgentContext.getStore() !== undefined;
}
