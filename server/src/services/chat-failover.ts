import { admitAutomaticCall, nitroBaseModel, prepareAutomaticCallPrices, withoutAutomaticSelectionDenied } from "@docslurp/shared";

/** Failover candidates of `models` for a turn on `preferredModel`, in order (none when failover is off). One answers at most. */
export function failoverCandidates(models: readonly string[], preferredModel: string, failover = true): string[] {
  if (!failover) return [];
  // A Speed boost variant is the same model: a Luna Nitro project fails over to Haiku, never to plain Luna.
  const base = nitroBaseModel(preferredModel) ?? preferredModel;
  return withoutAutomaticSelectionDenied(models).filter((model) => model !== base);
}

/**
 * The first failover candidate that keeps the automatic-call margin now, or null. Each refusal is logged with its reason
 * by the gate; a refused candidate is skipped, never sent.
 */
export async function admittedChatFailover(
  candidates: readonly string[],
  turn: { inputTokens?: number; outputTokens?: number } = {},
): Promise<{ model: string; decision: ReturnType<typeof admitAutomaticCall> } | null> {
  if (candidates.length === 0) return null;
  await prepareAutomaticCallPrices("chat-answer", candidates.map((model) => ({ model })));
  for (const model of candidates) {
    // Priced at this turn's own size (its prompt and output cap) when larger than the planning shape.
    const decision = admitAutomaticCall("chat-answer", { model }, "chat failover", { role: "failover", tokens: turn });
    if (decision.allowed) return { model, decision };
  }
  return null;
}

