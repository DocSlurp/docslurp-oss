/**
 * Where each model-serving provider is based, for the China-based provider policy.
 *
 * Source: OpenRouter provider metadata, https://openrouter.ai/api/v1/providers (`headquarters`,
 * `datacenters`), checked 2026-10-29 (117 providers; `fake-provider` and `stealth` omitted). Region:
 *
 * - `cn`: headquartered in China, or a Chinese-owned company listed under an international entity (named in
 *   `basis`). Its requests are under Chinese jurisdiction whatever its datacenters.
 * - `other`: OpenRouter lists a headquarters outside China and the company is not Chinese-owned.
 * - `unknown`: OpenRouter lists no headquarters. Never guessed: an organization or workspace that turned
 *   China-based providers off cannot reach these either.
 *
 * Direct (non-OpenRouter) providers use the same slugs (`openai`, `anthropic`, `deepinfra`, `perplexity`,
 * `cloudflare`, `liquid`). A provider missing from this table is `unknown`.
 * Refresh: re-fetch the providers endpoint, keep the Chinese-owned list, and review every changed row.
 */

export type ProviderRegion = "cn" | "other" | "unknown";

export interface ProviderRegionEntry {
  region: ProviderRegion;
  /** ISO country code OpenRouter lists, or null when it lists none. */
  headquarters: string | null;
  datacenters: readonly string[];
  basis: string;
}

export const PROVIDER_REGIONS_CHECKED = "2026-10-29";
export const PROVIDER_REGIONS_SOURCE = "https://openrouter.ai/api/v1/providers";

export const PROVIDER_REGIONS: Readonly<Record<string, ProviderRegionEntry>> = {
  "ai21": { region: "other", headquarters: "IL", datacenters: [], basis: "headquarters IL" },
  "aion-labs": { region: "other", headquarters: "IL", datacenters: [], basis: "headquarters IL" },
  "akashml": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "alibaba": { region: "cn", headquarters: "SG", datacenters: ["SG", "CN"], basis: "Chinese-owned: Alibaba Group (Hangzhou); listed under its Singapore entity" },
  "amazon-bedrock": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "amazon-nova": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "ambient": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "anthropic": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "arcee-ai": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "assemblyai": { region: "unknown", headquarters: null, datacenters: ["US"], basis: "no headquarters in OpenRouter metadata" },
  "atlas-cloud": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "avian": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "azure": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "baidu": { region: "cn", headquarters: "CN", datacenters: [], basis: "headquarters CN" },
  "baseten": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "black-forest-labs": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "cerebras": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "chutes": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "cirrascale": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "clarifai": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "claude-on-aws": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "cloudflare": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "cohere": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "coreweave": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "cosine": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "crucible": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "crusoe": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "darkbloom": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "databricks": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "decart": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "deepgram": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "deepinfra": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "deepseek": { region: "cn", headquarters: "CN", datacenters: [], basis: "headquarters CN" },
  "dekallm": { region: "other", headquarters: "ID", datacenters: ["ID"], basis: "headquarters ID" },
  "digitalocean": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "elevenlabs": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "featherless": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "fireworks": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "fish-audio": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "friendli": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "gmicloud": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "google-ai-studio": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "google-vertex": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "groq": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "heygen": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "inception": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "inceptron": { region: "other", headquarters: "SE", datacenters: ["FI"], basis: "headquarters SE" },
  "inferact-vllm": { region: "other", headquarters: "US", datacenters: ["US", "FI"], basis: "headquarters US" },
  "inference-net": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "infermatic": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "inflection": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "io-net": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "ionstream": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "krea": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "kt": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "liquid": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "makora": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "mancer": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "mara": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "meta": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "minimax": { region: "cn", headquarters: "SG", datacenters: ["US"], basis: "Chinese-owned: MiniMax (Shanghai); listed under its Singapore entity" },
  "mistral": { region: "other", headquarters: "FR", datacenters: [], basis: "headquarters FR" },
  "modal": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "modelrun": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "modular": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "moonshotai": { region: "cn", headquarters: "SG", datacenters: ["SG"], basis: "Chinese-owned: Moonshot AI (Beijing); listed under its Singapore entity" },
  "morph": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "near-ai": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "nebius": { region: "other", headquarters: "NL", datacenters: [], basis: "headquarters NL" },
  "nex-agi": { region: "cn", headquarters: "CN", datacenters: ["SG"], basis: "headquarters CN" },
  "nextbit": { region: "other", headquarters: "ES", datacenters: ["ES"], basis: "headquarters ES" },
  "novita": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "nvidia": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "ollama": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "open-inference": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "openai": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "parasail": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "pareto-alpha": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "particle-ai": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "perceptron": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "perplexity": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "phala": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "poolside": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "primalabs": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "primeintellect": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "quiver": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "recraft": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "recursive": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "reka": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "relace": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "respan": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "runway": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "sail-research": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "sakana": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "sambanova": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "scaledown": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "seed": { region: "cn", headquarters: "SG", datacenters: [], basis: "Chinese-owned: ByteDance Seed (Beijing); listed under its Singapore entity" },
  "siliconflow": { region: "cn", headquarters: "SG", datacenters: ["US"], basis: "Chinese-owned: SiliconFlow (Beijing); listed under its Singapore entity" },
  "sourceful": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "stepfun": { region: "cn", headquarters: null, datacenters: [], basis: "Chinese-owned: StepFun (Shanghai); no headquarters in OpenRouter metadata" },
  "streamlake": { region: "cn", headquarters: "CN", datacenters: [], basis: "headquarters CN" },
  "switchpoint": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "tencent": { region: "cn", headquarters: "CN", datacenters: ["SG"], basis: "headquarters CN" },
  "tenstorrent": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "thinkingmachines": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "together": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "typesafe": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "unbiased": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "upstage": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "venice": { region: "other", headquarters: "US", datacenters: ["US"], basis: "headquarters US" },
  "voyageai": { region: "unknown", headquarters: null, datacenters: [], basis: "no headquarters in OpenRouter metadata" },
  "wafer": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "xai": { region: "other", headquarters: "US", datacenters: [], basis: "headquarters US" },
  "xiaomi": { region: "cn", headquarters: "CN", datacenters: ["SG", "NL"], basis: "headquarters CN" },
  "z-ai": { region: "cn", headquarters: "SG", datacenters: ["SG"], basis: "Chinese-owned: Zhipu AI / Z.ai (Beijing); listed under its Singapore entity" },
};

/** `deepinfra/fp8/flex` -> `deepinfra`; OpenRouter endpoint slugs are `provider[/variant][/region][/tier]`. */
export function baseProviderSlug(slug: string): string {
  return slug.trim().toLowerCase().split("/")[0] ?? "";
}

/** Region of a provider slug (endpoint variants resolve to their provider); unlisted providers are `unknown`. */
export function providerRegion(slug: string | null | undefined): ProviderRegion {
  if (!slug) return "unknown";
  const entry = PROVIDER_REGIONS[baseProviderSlug(slug)];
  return entry ? entry.region : "unknown";
}

/**
 * Maps an OpenRouter served-provider display name (`"DeepInfra"`, `"Z.AI"`, `"Amazon Bedrock"`) to a table slug
 * by normalising both sides, for labelling usage records. Unmatched names return null (region `unknown`).
 */
export function providerSlugFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  if (PROVIDER_REGIONS[name.toLowerCase()]) return name.toLowerCase();
  for (const slug of Object.keys(PROVIDER_REGIONS)) if (slug.replace(/[^a-z0-9]/g, "") === key) return slug;
  return PROVIDER_NAME_ALIASES[key] ?? null;
}

/** Display names that do not normalise to their slug. */
const PROVIDER_NAME_ALIASES: Readonly<Record<string, string>> = {
  google: "google-vertex", googleaistudio: "google-ai-studio", googlevertex: "google-vertex",
  moonshot: "moonshotai", moonshotaiai: "moonshotai", zhipu: "z-ai", zai: "z-ai", nexagi: "nex-agi",
  inferencenet: "inference-net", amazonbedrock: "amazon-bedrock", sailresearch: "sail-research",
};

/** Providers the policy treats as China-based. */
export const CHINA_PROVIDER_SLUGS: readonly string[] = Object.freeze(
  Object.entries(PROVIDER_REGIONS).filter(([, entry]) => entry.region === "cn").map(([slug]) => slug),
);

/** Providers a China-restricted request may use: only those with a known headquarters outside China. */
export const NON_CHINA_PROVIDER_SLUGS: readonly string[] = Object.freeze(
  Object.entries(PROVIDER_REGIONS).filter(([, entry]) => entry.region === "other").map(([slug]) => slug),
);

/** Whether a request under `allowChinaProviders` may be served by `slug` (fail closed on unknown). */
export function isProviderAllowedByRegion(slug: string | null | undefined, allowChinaProviders: boolean): boolean {
  return allowChinaProviders || providerRegion(slug) === "other";
}

/**
 * Usage metadata with the served provider and its region (`servedProvider`, `servedProviderSlug`,
 * `servedProviderRegion`), so spend can be audited by host jurisdiction. `served` is the provider name or slug
 * the response reported; metadata is returned unchanged when it is unknown.
 */
export function withServedProviderRegion<T extends Record<string, unknown> | undefined>(metadata: T, served: unknown): T | Record<string, unknown> {
  if (typeof served !== "string" || !served.trim()) return metadata;
  const slug = providerSlugFromName(served) ?? (PROVIDER_REGIONS[baseProviderSlug(served)] ? baseProviderSlug(served) : null);
  return { ...metadata, servedProvider: served, servedProviderSlug: slug, servedProviderRegion: providerRegion(slug) };
}
