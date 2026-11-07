import { DEFAULT_PROJECT_CHAT_MODEL, PROJECT_CHAT_MODELS, normalizeChatModelRef } from "@docslurp/shared/project-chat-models";

export function resolveApiTextModelDefault(): string {
  // A catalog id or its llm://openrouter/<id> URI.
  const raw = process.env.DOCSLURP_SEARCH_MODEL?.trim();
  const model = raw ? normalizeChatModelRef(raw) : raw;
  if (!model) return DEFAULT_PROJECT_CHAT_MODEL;
  if (!PROJECT_CHAT_MODELS.some(({ id }) => id === model)) {
    throw new Error("DOCSLURP_SEARCH_MODEL must name an allowed project chat model");
  }
  return model;
}
