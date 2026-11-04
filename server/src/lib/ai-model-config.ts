import { DEFAULT_WORKSPACE_CHAT_MODEL, WORKSPACE_CHAT_MODELS, normalizeChatModelRef } from "@docslurp/shared/workspace-chat-models";

export function resolveApiTextModelDefault(): string {
  // A catalog id or its llm://openrouter/<id> URI.
  const raw = process.env.DOCSLURP_SEARCH_MODEL?.trim();
  const model = raw ? normalizeChatModelRef(raw) : raw;
  if (!model) return DEFAULT_WORKSPACE_CHAT_MODEL;
  if (!WORKSPACE_CHAT_MODELS.some(({ id }) => id === model)) {
    throw new Error("DOCSLURP_SEARCH_MODEL must name an allowed workspace chat model");
  }
  return model;
}
