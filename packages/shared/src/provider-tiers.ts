/**
 * Route tiers: "cheapest", "fastest" and "best" choices of model, host pool and config for a capability (chat
 * answers, page OCR), picked per request from live provider observations.
 *
 * Trust split:
 * - Eligibility is reviewed configuration: `TierOption` names its host pool as `llm://` entries (provider-pools.ts),
 *   which also give the model, and its measured eval score. Observations (prices, uptime, latency from the database) only rank and filter inside
 *   it; a host that is not in an option's pool is never sent a request, whatever the data says.
 * - The tier's customer price is fixed elsewhere; this module receives what one unit of work (an answer, a page)
 *   earns and never picks a host whose live cost for that unit leaves less than the minimum margin (default 10%).
 * - A request goes to exactly one host: the fastest one that keeps the margin (see `selectTierRoute`). The other
 *   hosts that also keep it are returned in rank order as `alternatives`, for the caller to retry with as a new
 *   single-host request if that call fails; nothing is sent to them otherwise.
 * - Missing or stale observations fall back to the option's first pool host (reviewed config lists the fastest
 *   first), which is inside eligibility by construction. Fresh observations under which nothing keeps the margin
 *   select nothing (fail closed): the caller refuses or uses its default route and reports it.
 */
import { hostMatchesEndpoint, providerPool, type ProviderPool } from "./provider-pools.js";

export const ROUTE_TIERS = ["cheapest", "fastest", "best"] as const;
export type RouteTier = (typeof ROUTE_TIERS)[number];

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
   * Measured quality on the capability's eval (0-1, higher is better), from a recorded run (`evalRef`). Null means
   * unmeasured: the option is never picked by "best".
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
  /** Least share of `unitRevenueUsd` a host must leave as margin, unless the pool sets `_minMargin`. Default 0.10. */
  readonly minMargin?: number;
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
}

export type TierSelection =
  | {
    readonly basis: "live";
    readonly option: TierOption;
    /** The one host this request goes to. */
    readonly host: RankedHost;
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
export const DEFAULT_MIN_MARGIN = 0.1;

/** Highest unit cost that keeps `minMargin` of `unitRevenueUsd`; null when there is no revenue to measure against. */
export function maxUnitCostForMargin(unitRevenueUsd: number | null, minMargin: number): number | null {
  return unitRevenueUsd === null ? null : unitRevenueUsd * (1 - minMargin);
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
    if (option.evalScore !== null && !(option.evalScore >= 0 && option.evalScore <= 1)) throw new Error(`tier option ${option.id}: evalScore must be 0-1`);
    if ((option.evalScore === null) !== (option.evalRef === null)) throw new Error(`tier option ${option.id}: evalScore and evalRef go together`);
  }
}

const maxAgeOf = (option: TierOption, input: TierSelectionInput) => option.pool.maxAgeMs ?? input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

/** The hosts of `option` that can serve now and keep the margin, each at its cheapest such endpoint, in pool order. */
export function eligibleHosts(option: TierOption, input: TierSelectionInput): RankedHost[] {
  const maxAge = maxAgeOf(option, input);
  const ceiling = maxUnitCostForMargin(input.unitRevenueUsd, option.pool.minMargin ?? input.minMargin ?? DEFAULT_MIN_MARGIN);
  const minUptime = option.pool.minUptime ?? input.minUptime ?? DEFAULT_MIN_UPTIME;
  const fresh = input.observations.filter((observation) => observation.model === option.model
    && input.now.getTime() - observation.observedAt.getTime() <= maxAge);
  const hosts: RankedHost[] = [];
  for (const host of option.pool.hosts) {
    let best: RankedHost | null = null;
    for (const observation of fresh) {
      if (!hostMatchesEndpoint(host, observation.endpoint)) continue;
      if (observation.inputUsdPerMTok === null || observation.outputUsdPerMTok === null) continue;
      if (observation.status !== null && observation.status < 0) continue;
      if (observation.uptime30m !== null && observation.uptime30m < minUptime) continue;
      const cost = unitCostUsd(input.unit, observation.inputUsdPerMTok, observation.outputUsdPerMTok);
      if (ceiling !== null && cost > ceiling + 1e-12) continue;
      if (!best || cost < best.unitCostUsd) {
        best = { host, endpoint: observation.endpoint, unitCostUsd: cost, inputUsdPerMTok: observation.inputUsdPerMTok,
          outputUsdPerMTok: observation.outputUsdPerMTok, latencyP50Ms: observation.latencyP50Ms };
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

const singleHost = (host: RankedHost): SingleHostPreferences => ({
  order: [host.host],
  allow_fallbacks: false,
  // OpenRouter max_price is USD per million tokens: the host may not bill above the endpoint we priced.
  max_price: { prompt: host.inputUsdPerMTok, completion: host.outputUsdPerMTok },
});

/**
 * Pick the one host for one request. Every tier prefers speed: among the tier's options, the fastest serving host
 * whose live unit cost keeps the minimum margin (default 10% of what the unit earns). The tier decides which
 * options compete and the price, hence the cost ceiling; "best" first narrows to the highest eval score that has a
 * host keeping the margin, then picks that option's fastest host. Static: when no candidate option has a fresh
 * observation, the first host of the first candidate (by eval score for "best", else as listed).
 */
export function selectTierRoute(input: TierSelectionInput): TierSelection {
  const candidates = input.options.filter((option) => option.capability === input.capability
    && option.tiers.includes(input.tier) && (input.tier !== "best" || option.evalScore !== null));
  if (candidates.length === 0) return { basis: "none", reason: `no ${input.capability} option for tier ${input.tier}` };
  const observed = candidates.some((option) => input.observations.some((observation) => observation.model === option.model
    && input.now.getTime() - observation.observedAt.getTime() <= maxAgeOf(option, input)));
  if (!observed) {
    const option = input.tier === "best" ? [...candidates].sort((a, b) => b.evalScore! - a.evalScore!)[0]! : candidates[0]!;
    return { basis: "static", option, provider: { order: [option.pool.hosts[0]!], allow_fallbacks: false } };
  }
  let ranked: Candidate[] = candidates.flatMap((option, optionIndex) => eligibleHosts(option, input)
    .map((host) => ({ option, optionIndex, hostIndex: option.pool.hosts.indexOf(host.host), host })));
  if (input.tier === "best" && ranked.length > 0) {
    const top = Math.max(...ranked.map((entry) => entry.option.evalScore!));
    ranked = ranked.filter((entry) => entry.option.evalScore === top);
  }
  ranked.sort(bySpeed);
  const chosen = ranked[0];
  if (!chosen) {
    return { basis: "none", reason: `no ${input.capability} host for tier ${input.tier} is serving within the margin` };
  }
  return {
    basis: "live",
    option: chosen.option,
    host: chosen.host,
    alternatives: ranked.slice(1).filter((entry) => entry.option === chosen.option).map((entry) => entry.host),
    provider: singleHost(chosen.host),
  };
}
