/**
 * Route tiers: "cheapest", "fastest" and "best" choices of model, host pool and config for a capability (chat
 * answers, page OCR), picked per request from live provider observations.
 *
 * Trust split:
 * - Eligibility is reviewed configuration: `TierOption` names its host pool as `llm://` entries (provider-pools.ts),
 *   which also give the model, and its measured eval score. Observations (prices, uptime, latency from the database) only rank and filter inside
 *   it; a host that is not in an option's pool is never sent a request, whatever the data says.
 * - The tier's customer price is fixed elsewhere; this module only receives a cost ceiling per unit of work
 *   (an answer, a page) and never selects an option whose live price for that unit is above it.
 * - Missing or stale observations fall back to the option's static pool, which is inside eligibility by
 *   construction. Fresh observations under which nothing fits the ceiling select nothing (fail closed): the caller
 *   refuses or uses its default route and reports it.
 */
import { hostMatchesEndpoint, providerPool, providerPoolPreferences, type ProviderPool, type ProviderPoolPreferences } from "./provider-pools.js";

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
  /** Highest USD a unit of work may cost on the chosen host; null when the caller has no ceiling. */
  readonly maxUnitCostUsd: number | null;
  readonly unit: WorkUnit;
  readonly now: Date;
  /** Observations older than this are ignored, unless the pool sets `_maxAge`. Default 2 hours. */
  readonly maxAgeMs?: number;
  /** Hosts under this 30-minute uptime are skipped, unless the pool sets `_minUptime`. Default 90. */
  readonly minUptime?: number;
}

export interface RankedHost {
  readonly host: string;
  /** The cheapest serving endpoint of the host that fits the ceiling. */
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
    readonly hosts: readonly RankedHost[];
    /** OpenRouter `provider`: the ranked hosts in order, nothing outside them, priced at most at the dearest one. */
    readonly provider: { order: string[]; allow_fallbacks: false; max_price: { prompt: number; completion: number } };
  }
  | { readonly basis: "static"; readonly option: TierOption; readonly provider: ProviderPoolPreferences }
  | { readonly basis: "none"; readonly reason: string };

const DEFAULT_MAX_AGE_MS = 2 * 3600 * 1000;
const DEFAULT_MIN_UPTIME = 90;

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

/** The hosts of `option` that can serve now, under the ceiling, each at its cheapest fitting endpoint. */
const maxAgeOf = (option: TierOption, input: TierSelectionInput) => option.pool.maxAgeMs ?? input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

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
      if (observation.status !== null && observation.status < 0) continue;
      if (observation.uptime30m !== null && observation.uptime30m < minUptime) continue;
      const cost = unitCostUsd(input.unit, observation.inputUsdPerMTok, observation.outputUsdPerMTok);
      if (input.maxUnitCostUsd !== null && cost > input.maxUnitCostUsd + 1e-12) continue;
      if (!best || cost < best.unitCostUsd) {
        best = { host, endpoint: observation.endpoint, unitCostUsd: cost, inputUsdPerMTok: observation.inputUsdPerMTok,
          outputUsdPerMTok: observation.outputUsdPerMTok, latencyP50Ms: observation.latencyP50Ms };
      }
    }
    if (best) hosts.push(best);
  }
  return hosts;
}

const byCost = (a: RankedHost, b: RankedHost) => a.unitCostUsd - b.unitCostUsd || a.host.localeCompare(b.host);
/** Unknown latency sorts after every measured one; ties go to the cheaper host. */
const byLatency = (a: RankedHost, b: RankedHost) =>
  (a.latencyP50Ms ?? Number.POSITIVE_INFINITY) - (b.latencyP50Ms ?? Number.POSITIVE_INFINITY) || byCost(a, b);

/**
 * Pick the option and hosts for one request. Live: among options whose pools have an eligible host, "cheapest"
 * takes the lowest unit cost, "fastest" the lowest measured latency, "best" the highest eval score (cost breaks
 * ties); hosts are ranked the same way, at most the pool's `_maxHosts` (every eligible host when unset). Static: when no candidate option has a
 * fresh observation at all, the first candidate (by eval score for "best", else as listed) with its static pool.
 */
export function selectTierRoute(input: TierSelectionInput): TierSelection {
  const candidates = input.options.filter((option) => option.capability === input.capability
    && option.tiers.includes(input.tier) && (input.tier !== "best" || option.evalScore !== null));
  if (candidates.length === 0) return { basis: "none", reason: `no ${input.capability} option for tier ${input.tier}` };
  const observed = candidates.some((option) => input.observations.some((observation) => observation.model === option.model
    && input.now.getTime() - observation.observedAt.getTime() <= maxAgeOf(option, input)));
  if (!observed) {
    const option = input.tier === "best" ? [...candidates].sort((a, b) => b.evalScore! - a.evalScore!)[0]! : candidates[0]!;
    return { basis: "static", option, provider: providerPoolPreferences(option.pool) };
  }
  const order = input.tier === "fastest" ? byLatency : byCost;
  const ranked = candidates
    .map((option) => ({ option, hosts: eligibleHosts(option, input).sort(order) }))
    .filter((entry) => entry.hosts.length > 0)
    .sort((a, b) => input.tier === "best"
      ? b.option.evalScore! - a.option.evalScore! || byCost(a.hosts[0]!, b.hosts[0]!)
      : order(a.hosts[0]!, b.hosts[0]!));
  const chosen = ranked[0];
  if (!chosen) {
    return { basis: "none", reason: `no ${input.capability} host for tier ${input.tier} is serving under the cost ceiling` };
  }
  const hosts = chosen.option.pool.maxHosts === null ? chosen.hosts : chosen.hosts.slice(0, chosen.option.pool.maxHosts);
  return {
    basis: "live",
    option: chosen.option,
    hosts,
    provider: {
      order: hosts.map((host) => host.host),
      allow_fallbacks: false,
      // OpenRouter max_price is USD per million tokens: no host may bill above the dearest chosen endpoint.
      max_price: { prompt: Math.max(...hosts.map((host) => host.inputUsdPerMTok)), completion: Math.max(...hosts.map((host) => host.outputUsdPerMTok)) },
    },
  };
}
