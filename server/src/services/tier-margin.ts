import { emitTelemetryLog } from "@docslurp/shared/observability";
import { DEFAULT_PREFERRED_MARGIN, DEFAULT_WARN_BELOW_MARGIN, servedMargin, type TierSelection, type WorkUnit } from "@docslurp/shared";

/**
 * Margin policy for route tiers and the warnings it raises. Two numbers, both shares of what a unit of work earns:
 * - DOCSLURP_TIER_PREFERRED_MARGIN (default 0.20): hosts keeping it compete on speed.
 * - DOCSLURP_TIER_MARGIN_WARN_BELOW (default 0.10): the global threshold; a pick or a served request under it logs a
 *   warning (`docslurp.route_tier.margin_low`). Requests are still served down to zero margin, never at a loss.
 */
export interface TierMarginPolicy {
  readonly preferredMargin: number;
  readonly warnBelowMargin: number;
}

function share(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const number = Number(value);
  if (!(number >= 0 && number < 1)) throw new Error(`${name} must be a share from 0 to below 1, not ${value}`);
  return number;
}

/** Reads the policy; throws on a malformed value rather than routing on a guess. */
export function tierMarginPolicy(env: NodeJS.ProcessEnv = process.env): TierMarginPolicy {
  return {
    preferredMargin: share(env.DOCSLURP_TIER_PREFERRED_MARGIN, DEFAULT_PREFERRED_MARGIN, "DOCSLURP_TIER_PREFERRED_MARGIN"),
    warnBelowMargin: share(env.DOCSLURP_TIER_MARGIN_WARN_BELOW, DEFAULT_WARN_BELOW_MARGIN, "DOCSLURP_TIER_MARGIN_WARN_BELOW"),
  };
}

export interface TierMarginContext {
  readonly tier: string;
  readonly capability: string;
  readonly requestId?: string;
}

type Emit = typeof emitTelemetryLog;

/** Telemetry log (SigNoz) plus a console line, so the warning shows without an OTel exporter too. */
const warnEverywhere: Emit = (args) => {
  console.warn(`[route-tier] ${args.body}`);
  emitTelemetryLog(args);
};
const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;

/** Logs a warning when a live pick's margin is under the global threshold; returns whether it did. */
export function warnOnTierSelection(selection: TierSelection, context: TierMarginContext, emit: Emit = warnEverywhere): boolean {
  if (selection.basis !== "live" || !selection.marginWarning) return false;
  const { margin, threshold } = selection.marginWarning;
  emit({
    severityText: "warn",
    body: `route tier ${context.tier} picked a host at ${pct(margin)} margin, under the ${pct(threshold)} threshold`,
    eventName: "docslurp.route_tier.margin_low",
    attributes: { stage: "selected", tier: context.tier, capability: context.capability, option: selection.option.id, model: selection.option.model,
      host: selection.host.host, endpoint: selection.host.endpoint, policy: selection.policy, margin, threshold,
      unitCostUsd: selection.host.unitCostUsd, ...(context.requestId ? { requestId: context.requestId } : {}) },
  });
  return true;
}

/** Checks a served request's actual margin (billed usage at the endpoint's prices) and logs a warning under the threshold. */
export function warnOnServedMargin(input: {
  readonly context: TierMarginContext;
  readonly optionId: string;
  readonly host: string;
  readonly usage: WorkUnit;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly unitRevenueUsd: number;
  readonly policy?: TierMarginPolicy;
}, emit: Emit = warnEverywhere): { margin: number; warned: boolean } {
  const policy = input.policy ?? tierMarginPolicy();
  const served = servedMargin({ usage: input.usage, inputUsdPerMTok: input.inputUsdPerMTok, outputUsdPerMTok: input.outputUsdPerMTok,
    unitRevenueUsd: input.unitRevenueUsd, warnBelowMargin: policy.warnBelowMargin });
  if (!served.marginWarning) return { margin: served.margin, warned: false };
  emit({
    severityText: "warn",
    body: `route tier ${input.context.tier} served at ${pct(served.margin)} margin, under the ${pct(policy.warnBelowMargin)} threshold`,
    eventName: "docslurp.route_tier.margin_low",
    attributes: { stage: "served", tier: input.context.tier, capability: input.context.capability, option: input.optionId, host: input.host,
      margin: served.margin, threshold: policy.warnBelowMargin, costUsd: served.costUsd, inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens, ...(input.context.requestId ? { requestId: input.context.requestId } : {}) },
  });
  return { margin: served.margin, warned: true };
}
