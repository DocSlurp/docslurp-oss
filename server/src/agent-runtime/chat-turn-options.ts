import { z } from "zod";
import { chatRetrievalOverridesSchema, chatSearchFiltersSchema } from "@docslurp/shared";
import { CHAT_REASONING_LEVELS, CHAT_TIERS } from "@docslurp/shared/project-chat-models";
import { isFirstPartyAppActor } from "../lib/first-party-app.js";
import type { RequestActor } from "../lib/request-actor.js";

/**
 * Composer options a durable chat launch carries: the same speed boost, web,
 * suggestions, retrieval and filter settings the streaming project chat
 * route accepts. They are stored with the operation and validated again when
 * the executor runs it.
 */
export const durableChatOptionsShape = {
  speedBoost: z.boolean().optional(),
  /** The chat tier; backend models are never a customer choice. */
  tier: z.enum(CHAT_TIERS).optional(),
  reasoning: z.enum(CHAT_REASONING_LEVELS).optional(),
  webTools: z.boolean().optional(),
  suggestions: z.boolean().optional(),
  retrieval: chatRetrievalOverridesSchema.optional(),
  filters: chatSearchFiltersSchema.optional(),
};
const durableChatOptionsSchema = z.object(durableChatOptionsShape);

/** Maps stored launch input onto chatProject options. Invalid stored input fails the turn. */
export function durableChatTurnOptions(input: Record<string, unknown>, actor: RequestActor) {
  const options = durableChatOptionsSchema.parse({
    speedBoost: input.speedBoost, webTools: input.webTools, suggestions: input.suggestions,
    retrieval: input.retrieval, filters: input.filters, tier: input.tier, reasoning: input.reasoning,
  });
  return {
    speedBoost: options.speedBoost === true,
    ...(options.tier ? { tier: options.tier } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    // Web tools stay off unless asked for. Suggestions are a signed-in app
    // capability and default on there, as in the streaming route.
    agent: { web: options.webTools === true, suggestions: isFirstPartyAppActor(actor) && options.suggestions !== false },
    ...(options.retrieval ? { retrieval: options.retrieval } : {}),
    ...(options.filters ? { filters: options.filters } : {}),
  };
}
