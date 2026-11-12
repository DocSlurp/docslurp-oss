/**
 * OpenRouter provider pools: the 1-5 hosts a route may send a request to. A pool is reviewed configuration (a host
 * joins only after its output quality is measured and it is a disclosed subprocessor); live data may rank hosts
 * inside a pool but never adds one. Each host is a distinct provider, so a second entry adds real redundancy rather
 * than a second tag of the same infrastructure.
 *
 * Sent as `provider.only` (with `sort` and fallbacks inside the pool) or, for `order` pools, as a strict
 * `provider.order`.
 */

/** Most hosts one pool may name. */
export const MAX_PROVIDER_POOL_HOSTS = 5;

export type ProviderPoolSort = "price" | "latency" | "throughput" | "order";

export interface ProviderPool {
  /** Endpoint tags (`wafer/nvfp4`) or provider slugs (`fireworks`), 1-5, each from a distinct provider. */
  readonly hosts: readonly string[];
  /** `price`/`latency`/`throughput`: OpenRouter sorts the pool on its live stats. `order`: tried as listed. */
  readonly sort: ProviderPoolSort;
  /** `order` pools only: let OpenRouter fall back to hosts outside the pool after the listed ones. */
  readonly fallbackBeyondPool?: boolean;
}

/** The provider slug of a host: `amazon-bedrock/us-east-1` -> `amazon-bedrock`. */
export function providerOfHost(host: string): string {
  return host.split("/")[0]!;
}

/** Whether `endpoint` (an OpenRouter endpoint tag) is served by pool host `host` (a tag or a provider slug). */
export function hostMatchesEndpoint(host: string, endpoint: string): boolean {
  return endpoint === host || (!host.includes("/") && endpoint.startsWith(`${host}/`));
}

/** Problems with `pool`, empty when it is valid. */
export function providerPoolProblems(pool: ProviderPool): string[] {
  const problems: string[] = [];
  if (pool.hosts.length < 1 || pool.hosts.length > MAX_PROVIDER_POOL_HOSTS) {
    problems.push(`a pool names 1-${MAX_PROVIDER_POOL_HOSTS} hosts, not ${pool.hosts.length}`);
  }
  const providers = pool.hosts.map(providerOfHost);
  const repeated = providers.filter((provider, index) => providers.indexOf(provider) !== index);
  if (repeated.length) problems.push(`hosts must be distinct providers; repeated: ${[...new Set(repeated)].join(", ")}`);
  if (pool.hosts.some((host) => !/^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)*$/.test(host))) problems.push("hosts must be lowercase OpenRouter tags");
  if (pool.fallbackBeyondPool && pool.sort !== "order") problems.push("only an order pool may fall back beyond the pool");
  return problems;
}

/** Throws when `pool` is invalid. */
export function assertProviderPool(pool: ProviderPool, label = "provider pool"): ProviderPool {
  const problems = providerPoolProblems(pool);
  if (problems.length) throw new Error(`${label}: ${problems.join("; ")}`);
  return pool;
}

export type ProviderPoolPreferences =
  | { order: string[]; allow_fallbacks: boolean }
  | { only: string[]; sort: Exclude<ProviderPoolSort, "order">; allow_fallbacks: true };

/** OpenRouter `provider` preferences for `pool`; `hosts` narrows it (a subset chosen from live data, in rank order). */
export function providerPoolPreferences(pool: ProviderPool, hosts: readonly string[] = pool.hosts): ProviderPoolPreferences {
  const chosen = hosts.filter((host) => pool.hosts.includes(host));
  if (chosen.length === 0) throw new Error("provider pool: no host left to send to");
  return pool.sort === "order"
    ? { order: [...chosen], allow_fallbacks: Boolean(pool.fallbackBeyondPool) }
    : { only: [...chosen], sort: pool.sort, allow_fallbacks: true };
}
