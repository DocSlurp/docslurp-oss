export const WORKSPACE_CHAT_MODELS = [
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", description: "Default efficient model" },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", description: "Compact Claude model" },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", description: "Efficient reasoning" },
  { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", description: "Complex reasoning" },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", description: "Fast, focused answers" },
] as const;

export type WorkspaceChatModelId = (typeof WORKSPACE_CHAT_MODELS)[number]["id"];

export const DEFAULT_WORKSPACE_CHAT_MODEL: WorkspaceChatModelId =
  "z-ai/glm-5.3-flash";

export function resolveWorkspaceChatModel(
  model: string | null | undefined,
): WorkspaceChatModelId {
  return (
    WORKSPACE_CHAT_MODELS.find((candidate) => candidate.id === model)?.id ??
    DEFAULT_WORKSPACE_CHAT_MODEL
  );
}
