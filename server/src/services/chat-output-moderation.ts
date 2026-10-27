import type { PrivacyMode, WorkspaceChatResponse } from "@docslurp/shared";

import { recordUsageEvent } from "../lib/ai-usage.js";
import { assertCanSpend } from "./billing/spend-guard.js";
import type { RequestActor } from "../lib/request-actor.js";

/**
 * Optional output moderation for chat answers shown to the public: browser
 * (publishable) keys, which back the embed widget and public docs search. OFF
 * by default (`CHAT_OUTPUT_MODERATION` unset or `off`), pending an owner
 * decision on cost and privacy; see docs/search-api.md#output-moderation.
 *
 * The interface is provider-neutral; the default is a no-op. The one adapter,
 * Llama Guard 4 12B on OpenRouter pinned to DeepInfra (US), classifies the
 * question and answer pair. Only `standard` privacy-mode workspaces are sent
 * to it; any other mode refuses the public answer without a provider call, because the answer
 * text would leave the workspace's allowed providers; the answer is withheld.
 *
 * When it applies, the chat turn buffers streamed text and emits only the
 * moderated answer. A moderation failure fails closed for these public actors:
 * the answer is withheld with a short message. The stored conversation turn
 * keeps the original text.
 */

export interface ModerationVerdict {
  flagged: boolean;
  unavailable?: boolean;
  /** Provider category codes (for Llama Guard, S1..S14). */
  categories: string[];
  usage?: { model: string; inputTokens: number; outputTokens: number; costCents?: number; metadata?: Record<string, unknown> };
}

export interface OutputModerator {
  readonly name: string;
  moderate(input: { question: string; answer: string }, signal?: AbortSignal): Promise<ModerationVerdict>;
}

export const noopOutputModerator: OutputModerator = {
  name: "none",
  async moderate() {
    return { flagged: false, categories: [] };
  },
};

export const LLAMA_GUARD_MODEL = "meta-llama/llama-guard-4-12b";
/** USD per 1M tokens on DeepInfra via OpenRouter, checked 2026-10-26. */
export const LLAMA_GUARD_PRICE = { input: 0.18, output: 0.18 } as const;

/** Llama Guard 4 over OpenRouter's chat completions API. `fetch` is injectable for tests. */
export function llamaGuardOutputModerator(args: { apiKey: string; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }): OutputModerator {
  const doFetch = args.fetch ?? fetch;
  return {
    name: "llama-guard-4",
    async moderate(input, signal) {
      // Refuse oversized output; never classify a prefix and release an unchecked suffix.
      if (input.question.length > 4_000 || input.answer.length > 16_000) throw new Error("moderation input exceeds limit");
      const timeout = AbortSignal.timeout(args.timeoutMs ?? 8_000);
      const response = await doFetch(`${args.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${args.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: LLAMA_GUARD_MODEL,
          messages: [
            { role: "user", content: input.question },
            { role: "assistant", content: input.answer },
          ],
          max_tokens: 16,
          temperature: 0,
          provider: { only: ["deepinfra"], allow_fallbacks: false, data_collection: "deny" },
          usage: { include: true },
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`moderation provider returned ${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
      const verdict = (body.choices?.[0]?.message?.content ?? "").trim().toLowerCase();
      const valid = /^(?:safe|unsafe(?:\s+s(?:[1-9]|1[0-4])(?:\s*,\s*s(?:[1-9]|1[0-4]))*)?)$/.test(verdict);
      const flagged = verdict !== "safe";
      const categories = valid && flagged ? [...verdict.matchAll(/s(?:1[0-4]|[1-9])/g)].map(match => match[0].toUpperCase()) : [];
      const inputTokens = body.usage?.prompt_tokens ?? 0;
      const outputTokens = body.usage?.completion_tokens ?? 0;
      return {
        flagged,
        ...(valid ? {} : { unavailable: true }),
        categories,
        usage: {
          model: LLAMA_GUARD_MODEL, inputTokens, outputTokens,
          costCents: typeof body.usage?.cost === "number" ? body.usage.cost * 100 : (inputTokens * LLAMA_GUARD_PRICE.input + outputTokens * LLAMA_GUARD_PRICE.output) / 10_000,
        },
      };
    },
  };
}

/** Validates CHAT_OUTPUT_MODERATION at startup, so a misconfiguration fails the boot instead of a chat turn. */
export function assertOutputModerationConfig(env: NodeJS.ProcessEnv = process.env): void {
  const moderator = configuredOutputModerator(env);
  if (moderator) console.warn(`[chat-moderation] output moderation on (${moderator.name}) for browser-key answers`);
}

/** The configured moderator, or null when moderation is off (the default). */
export function configuredOutputModerator(env: NodeJS.ProcessEnv = process.env): OutputModerator | null {
  const mode = env.CHAT_OUTPUT_MODERATION?.trim().toLowerCase() ?? "off";
  if (mode === "" || mode === "off" || mode === "false" || mode === "0") return null;
  if (mode === "llama-guard") {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) throw new Error("CHAT_OUTPUT_MODERATION=llama-guard needs OPENROUTER_API_KEY");
    return llamaGuardOutputModerator({ apiKey });
  }
  throw new Error(`Unknown CHAT_OUTPUT_MODERATION value: ${mode}`);
}

/** Public answers: browser (publishable) keys, used by the embed widget and public docs search. */
export function moderationAppliesTo(actor: RequestActor | null | undefined): boolean {
  return actor?.type === "apiKey" && actor.apiKey.keyType !== "server";
}

export const MODERATED_ANSWER = "I can't help with that.";
/** Shown when the check itself failed: the answer is withheld (fail closed). */
export const MODERATION_UNAVAILABLE_ANSWER = "I couldn't check this answer, so I can't show it right now. Please try again.";

/**
 * Moderate a public answer when moderation is on. A flagged answer is replaced
 * with a short refusal and loses its citations. A moderation failure withholds
 * the answer the same way (fail closed) and is logged loudly.
 */
export async function moderateChatAnswer(response: WorkspaceChatResponse, args: {
  actor: RequestActor | null | undefined;
  question: string;
  userId: string;
  workspaceId: string;
  orgId?: string | null;
  privacyMode: PrivacyMode;
  moderator?: OutputModerator | null;
  signal?: AbortSignal;
}): Promise<WorkspaceChatResponse> {
  const moderator = args.moderator === undefined ? configuredOutputModerator() : args.moderator;
  if (!moderator || moderator === noopOutputModerator || !moderationAppliesTo(args.actor) || !response.answer.trim()) return response;
  if (args.privacyMode !== "standard") {
    console.warn(`[chat-moderation] skipped workspace=${args.workspaceId}: privacy mode ${args.privacyMode} does not allow the moderation provider`);
    return { ...response, answer: MODERATION_UNAVAILABLE_ANSWER, citations: [], evidenceSpans: [] };
  }
  let verdict: ModerationVerdict;
  try {
    await assertCanSpend(args.orgId ?? null, args.workspaceId, { kind: "interactive", hold: false });
    verdict = await moderator.moderate({ question: args.question, answer: response.answer }, args.signal);
  } catch (error) {
    console.error(`[chat-moderation] failed workspace=${args.workspaceId}; answer withheld:`, error instanceof Error ? error.message : String(error));
    return { ...response, answer: MODERATION_UNAVAILABLE_ANSWER, citations: [], evidenceSpans: [] };
  }
  if (verdict.usage) {
    await recordUsageEvent({
      userId: args.userId,
      scope: { orgId: args.orgId ?? null, workspaceId: args.workspaceId, sessionId: response.sessionId },
      usage: { provider: "openrouter", model: verdict.usage.model, metric: "chat-output-moderation",
        inputTokens: verdict.usage.inputTokens, outputTokens: verdict.usage.outputTokens, costCents: verdict.usage.costCents,
        metadata: { moderator: moderator.name, flagged: verdict.flagged } },
    });
  }
  if (verdict.unavailable) return { ...response, answer: MODERATION_UNAVAILABLE_ANSWER, citations: [], evidenceSpans: [] };
  if (!verdict.flagged) return response;
  console.warn(`[chat-moderation] flagged workspace=${args.workspaceId} categories=${verdict.categories.join(",") || "unknown"}`);
  return { ...response, answer: MODERATED_ANSWER, citations: [], evidenceSpans: [] };
}
