import { nitroBaseModel } from "./project-chat-models.js";

/**
 * Per-model chat answer guidance appended to the shared chat instructions, for models whose defaults measurably
 * miss the shared style. Keyed by base model id (`:nitro` variants inherit). Every entry is general style guidance
 * that names no document, field or benchmark value (evaluation integrity rules), and is placed at the end of the static
 * instructions so it never splits the cached prompt prefix.
 *
 * - anthropic/claude-haiku-5.5, measured 2026-11-13 (model-calibration chat.answer, 30 cases, blinded Sonnet 5.5
 *   pairwise judge; record in docs/evals/haiku-5-5-chat/): without guidance it answered with ~4x Luna's output
 *   tokens and lost on unrequested background and advice (mean 4.15 vs Luna 4.60, dev). With this line: dev 4.55 vs
 *   4.65 and held-out 5.00 vs 4.78 against Luna, and 4.62 vs 4.10 / 5.00 vs 4.56 against GLM 5.3 Flash; output fell
 *   from 176 to 66 tokens a turn and median latency from 1.7 s to 0.8 s. Gold recall and correct declines unchanged.
 */
const CHAT_MODEL_PROMPT_ADDENDA: Readonly<Record<string, string>> = {
  "anthropic/claude-haiku-5.5": "Length: answer only what the question asks, in as few sentences as the evidence needs. Do not add background, suggestions, next steps or offers of further help that the question did not ask for.",
};

/** The chat guidance for `model` (an OpenRouter id, with or without `:nitro`), or an empty string. */
export function chatModelPromptAddendum(model: string | null | undefined): string {
  if (!model) return "";
  const id = model.trim();
  return CHAT_MODEL_PROMPT_ADDENDA[nitroBaseModel(id) ?? id] ?? "";
}
