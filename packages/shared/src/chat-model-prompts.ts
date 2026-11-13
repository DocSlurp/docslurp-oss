import { nitroBaseModel } from "./project-chat-models.js";

/**
 * Per-model chat answer guidance appended to the shared chat instructions, for models whose defaults measurably
 * miss the shared style. Keyed by base model id (`:nitro` variants inherit). Every entry is general style guidance
 * that names no document, field or benchmark value (evaluation integrity rules), and is placed at the end of the static
 * instructions so it never splits the cached prompt prefix.
 *
 * - anthropic/claude-haiku-5.5 (2026-11-13; record in core docs/evals/haiku-5-5-chat/): on the model-calibration
 *   chat.answer cases without guidance it answered with ~4x GPT-6 Luna's output tokens and lost the pairwise judge on
 *   unrequested background and advice, not on facts. With the length sentence it was non-inferior to Luna and ahead of
 *   GLM 5.3 Flash on dev (small n; see the record for held-out limits), output fell from ~176 to ~66 tokens a turn,
 *   and gold recall and correct declines were unchanged. The last sentence keeps the mandatory disclosures of the
 *   agent rules (failed tools, gaps, unverified results) above the length rule.
 */
const CHAT_MODEL_PROMPT_ADDENDA: Readonly<Record<string, string>> = {
  "anthropic/claude-haiku-5.5": "Length: answer only what the question asks, in as few sentences as the evidence needs. Do not add background, suggestions, next steps or offers of further help that the question did not ask for. This never overrides the rules above on citations, saying that the evidence does not answer, coverage gaps, failed or unavailable tools, or unverified results: always state those.",
};

/** The chat guidance for `model` (an OpenRouter id, with or without `:nitro`), or an empty string. */
export function chatModelPromptAddendum(model: string | null | undefined): string {
  if (!model) return "";
  const id = model.trim();
  return CHAT_MODEL_PROMPT_ADDENDA[nitroBaseModel(id) ?? id] ?? "";
}
