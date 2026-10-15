import { calculateAiUsageCostCents, isPrivateModelUri, lookupPrivateModelRoute, parsePrivateModelUri, privateEndpointCallCost } from "@docslurp/shared";

/** Placeholder credential that marks a private route as available; real auth comes from the operator registry. */
export const PRIVATE_ENDPOINT_API_KEY = "private-endpoint";

/**
 * API key gate for text stages: OpenRouter ids need the OpenRouter key; private
 * routes (`llm://private/...`) carry their own operator credentials, so they
 * return a placeholder that only lets the stage proceed.
 */
export function textModelApiKey(openRouterApiKey: string | undefined, model: string): string {
  return isPrivateModelUri(model) ? PRIVATE_ENDPOINT_API_KEY : openRouterApiKey ?? "";
}

/** Usage-ledger labels for a text model: `private` + `<alias>/<model>` or `openrouter` + id. */
export function textUsageLabels(model: string): { provider: string; model: string } {
  const ref = parsePrivateModelUri(model);
  return ref ? { provider: "private", model: `${ref.alias}/${ref.model}` } : { provider: "openrouter", model };
}

/**
 * Cost when a stage only kept token totals (no provider charge): private routes
 * use the operator's token price (0 with a note when only hourly or unpriced),
 * hosted routes keep the configured per-1K fallback.
 */
export function textFallbackCost(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costPer1kInputTokens: number;
  costPer1kOutputTokens: number;
}): { costCents: number; metadata?: Record<string, unknown> } {
  if (isPrivateModelUri(args.model)) {
    const lookup = lookupPrivateModelRoute({ ref: args.model, capability: "text" });
    if (!lookup.ok) return { costCents: 0, metadata: { costSource: "private-endpoint-unresolved" } };
    const pricing = { ...lookup.route.endpoint.pricing, ...lookup.route.model.pricing };
    if (pricing.usdPerMTokInput === undefined && pricing.usdPerMTokOutput === undefined) {
      return { costCents: 0, metadata: { endpointAlias: lookup.route.alias, costSource: "private-endpoint-unpriced", costNote: "Per-call cost is recorded by the client; token totals carry no hourly attribution" } };
    }
    return privateEndpointCallCost({ route: lookup.route, inputTokens: args.inputTokens, outputTokens: args.outputTokens });
  }
  return { costCents: calculateAiUsageCostCents(args) };
}
