/**
 * Route tiers: the customer tiers (CHAT_TIERS: "fastest", "balanced", "smart"; one vocabulary, defined in
 * project-chat-models.ts) applied to host routing: a choice of model, host pool and config for a capability (chat
 * answers, page OCR), picked per request from live provider observations. "smart" ranks options by measured eval
 * score; "fastest" and "balanced" take options in their reviewed order.
 *
 * Trust split:
 * - Eligibility is reviewed configuration: `TierOption` names its host pool as `llm://` entries (provider-pools.ts),
 *   which also give the model, and its measured eval score. Observations (prices, uptime, latency from the database) only rank and filter inside
 *   it; a host that is not in an option's pool is never sent a request, whatever the data says.
 * - The tier's customer price is fixed elsewhere; this module receives what one unit of work (an answer, a page)
 *   earns. Margin = 1 - unit cost / unit revenue.
 * - A request goes to exactly one host (see `selectTierRoute`): the fastest that keeps the preferred margin (default
 *   20%); when none does, the one with the best margin, and never one that loses money. A pick under the global
 *   margin threshold (`warnBelowMargin`, default 10%) carries a `marginWarning` for the caller to log, and so does a
 *   served request whose actual usage lands under it (`servedMargin`).
 * - The other eligible hosts of the option come back in rank order as `alternatives`, for the caller to retry with as
 *   a new single-host request if that call fails; nothing is sent to them otherwise.
 * - Missing or stale observations fall back to the option's first pool host (reviewed config lists the fastest
 *   first), which is inside eligibility by construction. Fresh observations under which every host would lose money
 *   select nothing (fail closed): the caller refuses or uses its default route and reports it.
 */
import { CHAT_TIERS, type ChatTier } from "./project-chat-models.js";
import { isAutomaticSelectionDenied } from "./automatic-model-selection.js";
import { automaticModelCallProblem } from "./model-call-policy.js";
import { MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE } from "./routing-targets.js";
import { hostMatchesEndpoint, providerPool, type ProviderPool } from "./provider-pools.js";

/** The customer tier vocabulary, reused for routing; there is no separate routing vocabulary. */
export const ROUTE_TIERS = CHAT_TIERS;
export type RouteTier = ChatTier;

export const ROUTE_CAPABILITIES = ["chat", "page-ocr"] as const;
export type RouteCapability = (typeof ROUTE_CAPABILITIES)[number];

/** A tier option as configured: its pool is `llm://` entry URIs. */
export interface TierOptionConfig {
  /** Stable id, recorded with each routed request. */
  readonly id: string;
  readonly capability: RouteCapability;
  /** Reviewed hosts this option may use, one `llm://openrouter/<model>?_provider=<host>` entry each. */
  readonly pool: readonly string[];
  /** Tiers that may pick this option. */
  readonly tiers: readonly RouteTier[];
  /**
   * The option's composite score on the capability's tier benchmark (0-1, higher is better): for page OCR the mean
   * tolerant-markdown@v1 `content`, from a recorded run (`evalRef`) that keeps every component score. "smart" ranks by
   * it. Null means unmeasured: the option is never picked by "smart".
   */
  readonly evalScore: number | null;
  readonly evalRef: string | null;
}

/** A parsed tier option. */
export interface TierOption extends Omit<TierOptionConfig, "pool"> {
  /** OpenRouter model id, from the pool entries. */
  readonly model: string;
  readonly pool: ProviderPool;
}

/** Parses configured tier options (their pool URIs) and validates the list; throws on any problem. */
export function defineTierOptions(configs: readonly TierOptionConfig[]): readonly TierOption[] {
  const options = configs.map((config) => {
    const pool = providerPool(config.pool, `tier option ${config.id}`);
    return Object.freeze({ ...config, model: pool.model, pool });
  });
  assertTierOptions(options);
  return Object.freeze(options);
}

/** Tokens in one unit of work: what a cost ceiling and a host's unit cost are measured on. */
export interface WorkUnit {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The latest known state of one model x endpoint, merged across sources (catalog prices, our own traffic). */
export interface EndpointObservation {
  readonly model: string;
  /** OpenRouter endpoint tag. */
  readonly endpoint: string;
  readonly observedAt: Date;
  /** USD per million tokens; null when unknown (the endpoint is then never chosen live). */
  readonly inputUsdPerMTok: number | null;
  readonly outputUsdPerMTok: number | null;
  /** Percent, 0-100, over the last 30 minutes. */
  readonly uptime30m: number | null;
  /** OpenRouter endpoint status: 0 is serving; negative values are degraded or down. */
  readonly status: number | null;
  /** Median time to first token measured on our own traffic, in milliseconds. */
  readonly latencyP50Ms: number | null;
}

export interface TierSelectionInput {
  readonly capability: RouteCapability;
  readonly tier: RouteTier;
  readonly options: readonly TierOption[];
  readonly observations: readonly EndpointObservation[];
  /** USD one unit of work earns at this tier's fixed price; null when the caller has no price (no margin check). */
  readonly unitRevenueUsd: number | null;
  /** Speed is preferred among hosts keeping at least this margin, unless the pool sets `_preferredMargin`. Default 0.20. */
  readonly preferredMargin?: number;
  /** The global margin threshold: a pick under it carries `marginWarning`. Default 0.10. */
  readonly warnBelowMargin?: number;
  readonly unit: WorkUnit;
  readonly now: Date;
  /** Observations older than this are ignored, unless the pool sets `_maxAge`. Default 2 hours. */
  readonly maxAgeMs?: number;
  /** Hosts under this 30-minute uptime are skipped, unless the pool sets `_minUptime`. Default 90. */
  readonly minUptime?: number;
}

export interface RankedHost {
  readonly host: string;
  /** The cheapest serving endpoint of the host that keeps the margin. */
  readonly endpoint: string;
  readonly unitCostUsd: number;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly latencyP50Ms: number | null;
  /** 1 - unitCostUsd / unitRevenueUsd; null when the caller gave no revenue. */
  readonly margin: number | null;
}

export interface MarginWarning {
  readonly margin: number;
  readonly threshold: number;
}

export type TierSelection =
  | {
    readonly basis: "live";
    readonly option: TierOption;
    /** The one host this request goes to. */
    readonly host: RankedHost;
    /** `speed`: fastest host keeping the preferred margin. `margin`: none kept it, so the best-margin host. */
    readonly policy: "speed" | "margin";
    /** Set when the chosen host's margin is under the global threshold. */
    readonly marginWarning: MarginWarning | null;
    /** Other hosts of the option that keep the margin, in rank order: retry targets only, never sent alongside. */
    readonly alternatives: readonly RankedHost[];
    /** OpenRouter `provider` for `host` alone: no fallbacks, priced at most at its endpoint. */
    readonly provider: SingleHostPreferences;
  }
  | { readonly basis: "static"; readonly option: TierOption; readonly provider: SingleHostPreferences }
  | { readonly basis: "none"; readonly reason: string };

export interface SingleHostPreferences {
  readonly order: [string];
  readonly allow_fallbacks: false;
  readonly max_price?: { prompt: number; completion: number };
}

const DEFAULT_MAX_AGE_MS = 2 * 3600 * 1000;
const DEFAULT_MIN_UPTIME = 90;
export const DEFAULT_PREFERRED_MARGIN = 0.2;
export const DEFAULT_WARN_BELOW_MARGIN = 0.1;

/** 1 - cost / revenue; null without revenue. A non-positive revenue has no margin to keep: -Infinity unless free. */
export function unitMargin(unitCostUsd: number, unitRevenueUsd: number | null): number | null {
  if (unitRevenueUsd === null) return null;
  if (!(unitRevenueUsd > 0)) return unitCostUsd > 0 ? Number.NEGATIVE_INFINITY : 0;
  return 1 - unitCostUsd / unitRevenueUsd;
}

const marginWarningOf = (margin: number | null, threshold: number): MarginWarning | null =>
  margin !== null && margin < threshold - 1e-12 ? { margin, threshold } : null;

/**
 * The margin a served request actually earned, from its billed usage and the endpoint's prices, with a warning when
 * it is under the global threshold (actual tokens can exceed the estimate the host was picked on).
 */
export function servedMargin(input: {
  readonly usage: WorkUnit;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly unitRevenueUsd: number;
  readonly warnBelowMargin?: number;
}): { margin: number; costUsd: number; marginWarning: MarginWarning | null } {
  const costUsd = unitCostUsd(input.usage, input.inputUsdPerMTok, input.outputUsdPerMTok);
  const margin = unitMargin(costUsd, input.unitRevenueUsd)!;
  return { margin, costUsd, marginWarning: marginWarningOf(margin, input.warnBelowMargin ?? DEFAULT_WARN_BELOW_MARGIN) };
}

export function unitCostUsd(unit: WorkUnit, inputUsdPerMTok: number, outputUsdPerMTok: number): number {
  return (unit.inputTokens * inputUsdPerMTok + unit.outputTokens * outputUsdPerMTok) / 1e6;
}

/** Throws when an option list is malformed: duplicate ids, a model that is not its pool's, scores outside 0-1. */
export function assertTierOptions(options: readonly TierOption[]): void {
  const ids = new Set<string>();
  for (const option of options) {
    if (ids.has(option.id)) throw new Error(`tier option ${option.id}: duplicate id`);
    ids.add(option.id);
    if (option.model !== option.pool.model) throw new Error(`tier option ${option.id}: model must be the pool's model`);
    if (option.tiers.length === 0) throw new Error(`tier option ${option.id}: names no tier`);
    // A tier picks among its options automatically, so a model that is never selected automatically is never an option.
    if (isAutomaticSelectionDenied(option.model)) throw new Error(`tier option ${option.id}: ${option.model} is never selected automatically`);
    // The call-time policy too: no Pro/Ultra, no model whose known output price reaches the $50 per 1M token cap.
    const problem = automaticModelCallProblem(option.model);
    if (problem) throw new Error(`tier option ${option.id}: ${option.model} is not allowed (${problem})`);
    if (option.evalScore !== null && !(option.evalScore >= 0 && option.evalScore <= 1)) throw new Error(`tier option ${option.id}: evalScore must be 0-1`);
    if ((option.evalScore === null) !== (option.evalRef === null)) throw new Error(`tier option ${option.id}: evalScore and evalRef go together`);
  }
}

const maxAgeOf = (option: TierOption, input: TierSelectionInput) => option.pool.maxAgeMs ?? input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

/** The hosts of `option` that can serve now without losing money, each at its cheapest such endpoint, in pool order. */
export function eligibleHosts(option: TierOption, input: TierSelectionInput): RankedHost[] {
  const maxAge = maxAgeOf(option, input);
  const minUptime = option.pool.minUptime ?? input.minUptime ?? DEFAULT_MIN_UPTIME;
  const fresh = input.observations.filter((observation) => observation.model === option.model
    && input.now.getTime() - observation.observedAt.getTime() <= maxAge);
  const hosts: RankedHost[] = [];
  for (const host of option.pool.hosts) {
    let best: RankedHost | null = null;
    for (const observation of fresh) {
      if (!hostMatchesEndpoint(host, observation.endpoint)) continue;
      if (observation.inputUsdPerMTok === null || observation.outputUsdPerMTok === null) continue;
      // A host that bills at or above the platform output cap is never chosen, whatever the margin.
      if (observation.outputUsdPerMTok >= MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE) continue;
      if (observation.status !== null && observation.status < 0) continue;
      if (observation.uptime30m !== null && observation.uptime30m < minUptime) continue;
      const cost = unitCostUsd(input.unit, observation.inputUsdPerMTok, observation.outputUsdPerMTok);
      const margin = unitMargin(cost, input.unitRevenueUsd);
      if (margin !== null && margin < -1e-12) continue;
      if (!best || cost < best.unitCostUsd) {
        best = { host, endpoint: observation.endpoint, unitCostUsd: cost, inputUsdPerMTok: observation.inputUsdPerMTok,
          outputUsdPerMTok: observation.outputUsdPerMTok, latencyP50Ms: observation.latencyP50Ms, margin };
      }
    }
    if (best) hosts.push(best);
  }
  return hosts;
}

interface Candidate {
  readonly option: TierOption;
  /** Position of the option in the configured list, then of the host in its pool: the reviewed speed prior. */
  readonly optionIndex: number;
  readonly hostIndex: number;
  readonly host: RankedHost;
}

/**
 * Fastest first: measured p50 latency (unmeasured after every measured host), then the reviewed order (options as
 * listed, hosts as their pool lists them; config lists the faster first), then the cheaper.
 */
const bySpeed = (a: Candidate, b: Candidate) =>
  (a.host.latencyP50Ms ?? Number.POSITIVE_INFINITY) - (b.host.latencyP50Ms ?? Number.POSITIVE_INFINITY)
  || a.optionIndex - b.optionIndex || a.hostIndex - b.hostIndex
  || a.host.unitCostUsd - b.host.unitCostUsd;

/** Best margin first (cheapest), then fastest. */
const byMargin = (a: Candidate, b: Candidate) => a.host.unitCostUsd - b.host.unitCostUsd || bySpeed(a, b);

const singleHost = (host: RankedHost): SingleHostPreferences => ({
  order: [host.host],
  allow_fallbacks: false,
  // OpenRouter max_price is USD per million tokens: the host may not bill above the endpoint we priced.
  max_price: { prompt: host.inputUsdPerMTok, completion: host.outputUsdPerMTok },
});

/**
 * Pick the one host for one request. Every tier prefers speed within the preferred margin: among the tier's options,
 * the fastest serving host whose live unit cost keeps at least `preferredMargin` (default 20%; a pool's
 * `_preferredMargin` overrides it for its hosts). When no host keeps it, the host with the best margin that still
 * does not lose money. The tier decides which options compete and the price; "smart" first narrows to the highest
 * eval score that has a serving host, then picks within that option. Static: when no candidate option has a fresh
 * observation, the first host of the first candidate (by eval score for "smart", else as listed).
 */
export function selectTierRoute(input: TierSelectionInput): TierSelection {
  // Options are asserted at load (assertTierOptions); the call-time policy is applied again here so an option list
  // built elsewhere can never route a tier to a Pro/Ultra, denied or over-cap model.
  const candidates = input.options.filter((option) => option.capability === input.capability
    && option.tiers.includes(input.tier) && (input.tier !== "smart" || option.evalScore !== null)
    && automaticModelCallProblem(option.model) === null);
  if (candidates.length === 0) return { basis: "none", reason: `no ${input.capability} option for tier ${input.tier}` };
  const observed = candidates.some((option) => input.observations.some((observation) => observation.model === option.model
    && input.now.getTime() - observation.observedAt.getTime() <= maxAgeOf(option, input)));
  if (!observed) {
    const option = input.tier === "smart" ? [...candidates].sort((a, b) => b.evalScore! - a.evalScore!)[0]! : candidates[0]!;
    return { basis: "static", option, provider: { order: [option.pool.hosts[0]!], allow_fallbacks: false } };
  }
  let ranked: Candidate[] = candidates.flatMap((option, optionIndex) => eligibleHosts(option, input)
    .map((host) => ({ option, optionIndex, hostIndex: option.pool.hosts.indexOf(host.host), host })));
  if (input.tier === "smart" && ranked.length > 0) {
    const top = Math.max(...ranked.map((entry) => entry.option.evalScore!));
    ranked = ranked.filter((entry) => entry.option.evalScore === top);
  }
  const keepsPreferred = (entry: Candidate) => entry.host.margin === null
    || entry.host.margin >= (entry.option.pool.preferredMargin ?? input.preferredMargin ?? DEFAULT_PREFERRED_MARGIN) - 1e-12;
  const preferred = ranked.filter(keepsPreferred).sort(bySpeed);
  const rest = ranked.filter((entry) => !keepsPreferred(entry)).sort(byMargin);
  const ordered = [...preferred, ...rest];
  const chosen = ordered[0];
  if (!chosen) {
    return { basis: "none", reason: `no ${input.capability} host for tier ${input.tier} is serving without a loss` };
  }
  return {
    basis: "live",
    option: chosen.option,
    host: chosen.host,
    policy: preferred.length > 0 ? "speed" : "margin",
    marginWarning: marginWarningOf(chosen.host.margin, input.warnBelowMargin ?? DEFAULT_WARN_BELOW_MARGIN),
    alternatives: ordered.slice(1).filter((entry) => entry.option === chosen.option).map((entry) => entry.host),
    provider: singleHost(chosen.host),
  };
}
