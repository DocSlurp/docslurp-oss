/**
 * OpenRouter provider pools: the hosts a route may send a request to. A pool is reviewed configuration (a host
 * joins only after its output quality is measured and it is a disclosed subprocessor); live data may rank hosts
 * inside a pool but never adds one. Each host is a distinct provider, so a second entry adds real redundancy rather
 * than a second tag of the same infrastructure. There is no fixed size limit. A request goes to one host of the pool
 * (provider-tiers.ts picks it); the others are retry targets, never sent alongside.
 *
 * A pool is written as `llm://` model URIs, one per host:
 *
 *   llm://openrouter/deepseek/deepseek-v4.1-flash-1017?_provider=fireworks&_sort=latency&_timeout=60s
 *   llm://openrouter/deepseek/deepseek-v4.1-flash-1017?_provider=parasail#minUptime=95&minMargin=0.15
 *
 * - The path is the model (`llm://openrouter/<vendor>/<model>`); every entry names the same model.
 * - Plain query parameters (`?reasoning=low`) are model options, passed to the model call; every entry repeats the
 *   same ones.
 * - Pool options are `_`-prefixed query parameters or fragment (`#`) arguments, with or without the `_` there.
 *   `_provider` belongs to its entry; every other pool option applies to the whole pool and may be written on any
 *   entry, once or repeated with the same value. An unknown pool option, a conflicting value, or a key given both as
 *   `_key` and `#key` is an error, never ignored.
 *
 * Sent as `provider.only` (with `sort` and fallbacks inside the pool) or, for `order` pools, as a strict
 * `provider.order`.
 */
import { openRouterModelIdFromUri } from "./model-uri.js";

export type ProviderPoolSort = "price" | "latency" | "throughput" | "order";
const SORTS: readonly ProviderPoolSort[] = ["price", "latency", "throughput", "order"];

/** Pool options, by URI key (without the `_`). `provider` is per entry; the rest are pool-wide. */
export const PROVIDER_POOL_OPTION_KEYS = ["provider", "sort", "fallbacks", "timeout", "minUptime", "maxAge", "minMargin"] as const;
export type ProviderPoolOptionKey = (typeof PROVIDER_POOL_OPTION_KEYS)[number];

export interface ProviderPool {
  /** The entry URIs as configured. */
  readonly uris: readonly string[];
  /** OpenRouter model id shared by every entry. */
  readonly model: string;
  /** Model options (plain query parameters), shared by every entry. */
  readonly modelOptions: Readonly<Record<string, string>>;
  /** Endpoint tags (`wafer/nvfp4`) or provider slugs (`fireworks`), one per entry, each from a distinct provider. */
  readonly hosts: readonly string[];
  /** `_sort`. `price`/`latency`/`throughput`: OpenRouter sorts the pool on its live stats. `order`: tried as listed. Default `price`. */
  readonly sort: ProviderPoolSort;
  /** `_fallbacks=true`, `order` pools only: let OpenRouter fall back to hosts outside the pool after the listed ones. */
  readonly fallbackBeyondPool: boolean;
  /** `_timeout` (`30s`, `500ms`, `2m`): whole-request timeout. Null: the caller's default. */
  readonly timeoutMs: number | null;
  /** `_minUptime` (0-100): hosts under this 30-minute uptime are skipped live. Null: the caller's default. */
  readonly minUptime: number | null;
  /** `_maxAge` (duration): observations older than this are ignored. Null: the caller's default. */
  readonly maxAgeMs: number | null;
  /** `_minMargin` (0-1): least share of a unit's revenue the chosen host must leave. Null: the caller's default (0.10). */
  readonly minMargin: number | null;
}

/** The provider slug of a host: `amazon-bedrock/us-east-1` -> `amazon-bedrock`. */
export function providerOfHost(host: string): string {
  return host.split("/")[0]!;
}

/** Whether `endpoint` (an OpenRouter endpoint tag) is served by pool host `host` (a tag or a provider slug). */
export function hostMatchesEndpoint(host: string, endpoint: string): boolean {
  return endpoint === host || (!host.includes("/") && endpoint.startsWith(`${host}/`));
}

const HOST = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)*$/;

/** `30s`, `500ms`, `2m`, `1h` or bare milliseconds -> milliseconds; null when malformed or not positive. */
export function parsePoolDuration(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) return null;
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[(match[2] ?? "ms") as "ms" | "s" | "m" | "h"];
  const ms = Number(match[1]) * unit;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

interface ParsedEntry {
  readonly model: string;
  readonly modelOptions: Record<string, string>;
  readonly poolOptions: Map<ProviderPoolOptionKey, string>;
}

function parseEntry(uri: string, problems: string[]): ParsedEntry | null {
  const trimmed = uri.trim();
  const hashAt = trimmed.indexOf("#");
  const beforeHash = hashAt >= 0 ? trimmed.slice(0, hashAt) : trimmed;
  const fragment = hashAt >= 0 ? trimmed.slice(hashAt + 1) : "";
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : "";
  const model = openRouterModelIdFromUri(base);
  if (!model) {
    problems.push(`${uri}: a pool entry is llm://openrouter/<vendor>/<model>`);
    return null;
  }
  const modelOptions: Record<string, string> = {};
  const poolOptions = new Map<ProviderPoolOptionKey, string>();
  const setPoolOption = (raw: string, value: string, where: string) => {
    const key = raw.startsWith("_") ? raw.slice(1) : raw;
    if (!(PROVIDER_POOL_OPTION_KEYS as readonly string[]).includes(key)) {
      problems.push(`${uri}: unknown pool option ${where}${raw} (known: ${PROVIDER_POOL_OPTION_KEYS.join(", ")})`);
      return;
    }
    if (poolOptions.has(key as ProviderPoolOptionKey)) {
      problems.push(`${uri}: pool option ${key} given twice`);
      return;
    }
    poolOptions.set(key as ProviderPoolOptionKey, value);
  };
  for (const [key, value] of new URLSearchParams(query)) {
    if (key.startsWith("_")) setPoolOption(key, value, "");
    else if (!key) problems.push(`${uri}: empty query parameter`);
    else if (key in modelOptions) problems.push(`${uri}: model option ${key} given twice`);
    else modelOptions[key] = value;
  }
  for (const [key, value] of new URLSearchParams(fragment)) setPoolOption(key, value, "#");
  return { model, modelOptions, poolOptions };
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

/** Parses pool entry URIs; `problems` lists everything wrong (empty when valid). */
export function parseProviderPool(uris: readonly string[]): { pool: ProviderPool | null; problems: string[] } {
  const problems: string[] = [];
  if (uris.length === 0) return { pool: null, problems: ["a pool names at least one entry"] };
  const entries = uris.map((uri) => parseEntry(uri, problems));
  if (entries.some((entry) => entry === null)) return { pool: null, problems };
  const parsed = entries as ParsedEntry[];
  const model = parsed[0]!.model;
  if (parsed.some((entry) => entry.model !== model)) problems.push(`every entry names the same model; found ${[...new Set(parsed.map((entry) => entry.model))].join(", ")}`);
  const modelOptions = parsed[0]!.modelOptions;
  if (parsed.some((entry) => !sameRecord(entry.modelOptions, modelOptions))) problems.push("every entry repeats the same model options");

  const hosts = parsed.map((entry, index) => {
    const host = entry.poolOptions.get("provider");
    if (!host) problems.push(`${uris[index]}: _provider is required`);
    else if (!HOST.test(host)) problems.push(`${uris[index]}: _provider must be a lowercase OpenRouter tag`);
    return host ?? "";
  });
  const providers = hosts.filter(Boolean).map(providerOfHost);
  const repeated = providers.filter((provider, index) => providers.indexOf(provider) !== index);
  if (repeated.length) problems.push(`hosts must be distinct providers; repeated: ${[...new Set(repeated)].join(", ")}`);

  const poolWide = new Map<ProviderPoolOptionKey, string>();
  for (const entry of parsed) {
    for (const [key, value] of entry.poolOptions) {
      if (key === "provider") continue;
      const prior = poolWide.get(key);
      if (prior !== undefined && prior !== value) problems.push(`pool option ${key} conflicts: ${prior} vs ${value}`);
      else poolWide.set(key, value);
    }
  }
  const sortValue = poolWide.get("sort") ?? "price";
  if (!(SORTS as readonly string[]).includes(sortValue)) problems.push(`_sort must be one of ${SORTS.join(", ")}`);
  const sort = sortValue as ProviderPoolSort;
  const fallbacksValue = poolWide.get("fallbacks");
  if (fallbacksValue !== undefined && fallbacksValue !== "true" && fallbacksValue !== "false") problems.push("_fallbacks must be true or false");
  const fallbackBeyondPool = fallbacksValue === "true";
  if (fallbackBeyondPool && sort !== "order") problems.push("only an order pool may fall back beyond the pool");
  const duration = (key: "timeout" | "maxAge") => {
    const value = poolWide.get(key);
    if (value === undefined) return null;
    const ms = parsePoolDuration(value);
    if (ms === null) problems.push(`_${key} must be a positive duration such as 30s or 500ms`);
    return ms;
  };
  const timeoutMs = duration("timeout");
  const maxAgeMs = duration("maxAge");
  const minUptimeValue = poolWide.get("minUptime");
  const minUptime = minUptimeValue === undefined ? null : Number(minUptimeValue);
  if (minUptime !== null && !(minUptimeValue!.trim() !== "" && minUptime >= 0 && minUptime <= 100)) problems.push("_minUptime must be 0-100");
  const minMarginValue = poolWide.get("minMargin");
  const minMargin = minMarginValue === undefined ? null : Number(minMarginValue);
  if (minMargin !== null && !(minMarginValue!.trim() !== "" && minMargin >= 0 && minMargin < 1)) problems.push("_minMargin must be 0 or more and below 1");

  if (problems.length) return { pool: null, problems };
  return {
    pool: Object.freeze({ uris: Object.freeze([...uris]), model, modelOptions: Object.freeze({ ...modelOptions }), hosts: Object.freeze(hosts),
      sort, fallbackBeyondPool, timeoutMs, minUptime, maxAgeMs, minMargin }),
    problems,
  };
}

/** Parses pool entry URIs; throws listing every problem. */
export function providerPool(uris: readonly string[], label = "provider pool"): ProviderPool {
  const { pool, problems } = parseProviderPool(uris);
  if (!pool) throw new Error(`${label}: ${problems.join("; ")}`);
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
    ? { order: [...chosen], allow_fallbacks: pool.fallbackBeyondPool }
    : { only: [...chosen], sort: pool.sort, allow_fallbacks: true };
}
