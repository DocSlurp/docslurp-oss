import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Set by the chat search agent around its in-process tool dispatch, so the
 * retrieval it triggers can name the chat session (span attribute and
 * search_sessions metadata). Never read from request input.
 */
const chatAgentContext = new AsyncLocalStorage<{ chatSessionId: string }>();

export function runInChatAgentContext<T>(chatSessionId: string, run: () => T): T {
  return chatAgentContext.run({ chatSessionId }, run);
}

export function currentChatSessionId(): string | null {
  return chatAgentContext.getStore()?.chatSessionId ?? null;
}
