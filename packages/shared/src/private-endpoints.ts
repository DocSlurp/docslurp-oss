import { z } from "zod";

/**
 * Operator-registered private model endpoints.
 *
 * A private endpoint is an OpenAI-compatible server (vLLM, SGLang, TGI, ...)
 * running open-weight models on single-tenant hardware the operator rents or
 * owns. Only operators declare them, through the `DOCSLURP_PRIVATE_MODEL_ENDPOINTS`
 * deployment variable; workspaces and API callers can only reference a
 * registered alias with `llm://private/<alias>/<model-id>`. The base URL and
 * credentials never come from workspace settings or requests.
 *
 * `local-only` and `strict-privacy` workspaces may call registered private
 * endpoints. Every call resolves the alias, model and capability against this
 * registry and fails closed on any mismatch (see `resolveProviderTarget`).
 *
 * This module is browser-safe: without `process.env` the registry is empty.
 */

export const PRIVATE_MODEL_PROVIDER = "private";
export const PRIVATE_MODEL_ENDPOINTS_ENV = "DOCSLURP_PRIVATE_MODEL_ENDPOINTS";

export const privateModelCapabilitySchema = z.enum(["text", "vision", "embedding", "rerank", "stt"]);
export type PrivateModelCapability = z.infer<typeof privateModelCapabilitySchema>;

const usdRate = z.number().finite().nonnegative();

export const privateEndpointPricingSchema = z.object({
  /** GPU rental price. Per-call cost is request wall time × rate ÷ `concurrency`. */
  usdPerHour: usdRate.optional(),
  /** Expected concurrent requests sharing the GPU-hour; divides hourly cost. Default 1. */
  concurrency: z.number().int().min(1).max(4096).optional(),
  /** Token prices take precedence over `usdPerHour` when declared. */
  usdPerMTokInput: usdRate.optional(),
  usdPerMTokOutput: usdRate.optional(),
}).strict();
export type PrivateEndpointPricing = z.infer<typeof privateEndpointPricingSchema>;

export const privateEndpointModelSchema = z.object({
  /** Model id exactly as the server serves it (`GET /v1/models`). */
  id: z.string().trim().min(1).max(200).refine((value) => !/[\s?#]/.test(value), "Model ids must not contain whitespace, ? or #"),
  capability: privateModelCapabilitySchema,
  /** Embedding vector size; required for `embedding` models, rejected otherwise. */
  dimensions: z.number().int().min(16).max(8192).optional(),
  /** Per-model price override. */
  pricing: privateEndpointPricingSchema.optional(),
  /**
   * Sent as `chat_template_kwargs` on every chat/completions request to this
   * model (vLLM/SGLang), e.g. `{ "enable_thinking": false }` for Qwen3 models
   * that otherwise spend the output budget on reasoning.
   */
  chatTemplateKwargs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.capability === "embedding" && value.dimensions === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dimensions"], message: "Embedding models must declare dimensions" });
  }
  if (value.capability !== "embedding" && value.dimensions !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dimensions"], message: "dimensions only applies to embedding models" });
  }
});
export type PrivateEndpointModel = z.infer<typeof privateEndpointModelSchema>;

const PRIVATE_HTTP_HOST_SUFFIXES = [".internal", ".local", ".ts.net"];

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

/**
 * Plain http is allowed only where the network itself is private: loopback,
 * RFC 1918, CGNAT/Tailscale (100.64.0.0/10), IPv6 unique-local (fc00::/7), and
 * the `.internal`, `.local` and `.ts.net` names used by private DNS and tunnels.
 * Everything else must use https.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const octets = ipv4Octets(host);
  if (octets) {
    const [a, b] = octets as [number, number, number, number];
    return a === 127 || a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(":")) return /^f[cd][0-9a-f]{0,2}:/.test(host);
  return PRIVATE_HTTP_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export const privateEndpointBaseUrlSchema = z.string().trim().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "baseUrl must be an absolute URL" });
    return;
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "baseUrl must not contain credentials; use auth.tokenEnv" });
  }
  if (url.search || url.hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "baseUrl must not contain a query string or fragment" });
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isPrivateNetworkHost(url.hostname)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "baseUrl must use https, or http on a private network host (loopback, RFC 1918, 100.64/10, fc00::/7, *.internal, *.local, *.ts.net)",
  });
}).transform((value) => normalizePrivateEndpointBaseUrl(value));

export const privateEndpointAttestationSchema = z.object({
  tenancy: z.literal("single-tenant"),
  /** Who runs the hardware, e.g. `runpod`, `lambda`, `vast`, `self`. */
  hostProvider: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).optional(),
}).strict();

export const privateEndpointSchema = z.object({
  alias: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "alias must be lowercase letters, digits and dashes (max 63)"),
  baseUrl: privateEndpointBaseUrlSchema,
  auth: z.object({
    /** Header to send. Default `Authorization`. */
    header: z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/).default("Authorization"),
    /** Prefix for the header value. Default `Bearer`; empty string sends the raw token. */
    scheme: z.string().trim().max(32).default("Bearer"),
    /** Name of the environment variable holding the token. Tokens are never inlined. */
    tokenEnv: z.string().trim().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, "tokenEnv must be an environment variable name"),
  }).strict(),
  models: z.array(privateEndpointModelSchema).min(1).max(64),
  attestation: privateEndpointAttestationSchema,
  pricing: privateEndpointPricingSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.models.forEach((model, index) => {
    const key = `${model.capability}:${model.id}`;
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["models", index], message: `Duplicate ${model.capability} model ${model.id}` });
    seen.add(key);
  });
});
export type PrivateModelEndpoint = z.infer<typeof privateEndpointSchema>;

export const privateEndpointRegistrySchema = z.array(privateEndpointSchema).max(32).superRefine((endpoints, ctx) => {
  const aliases = new Set<string>();
  endpoints.forEach((endpoint, index) => {
    if (aliases.has(endpoint.alias)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "alias"], message: `Duplicate alias ${endpoint.alias}` });
    aliases.add(endpoint.alias);
  });
});

export class PrivateEndpointConfigError extends Error {
  readonly code = "PRIVATE_ENDPOINT_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "PrivateEndpointConfigError";
  }
}

export class PrivateEndpointResolutionError extends Error {
  readonly code = "PRIVATE_ENDPOINT_UNRESOLVED";
  constructor(message: string) {
    super(message);
    this.name = "PrivateEndpointResolutionError";
  }
}

export interface PrivateModelEndpointRegistry {
  readonly endpoints: readonly PrivateModelEndpoint[];
}

export function normalizePrivateEndpointBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Parses the registry JSON (an array of endpoints). Empty or unset means no endpoints. */
export function parsePrivateModelEndpointRegistry(raw: string | null | undefined): PrivateModelEndpointRegistry {
  if (!raw || !raw.trim()) return { endpoints: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new PrivateEndpointConfigError(`${PRIVATE_MODEL_ENDPOINTS_ENV} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = privateEndpointRegistrySchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new PrivateEndpointConfigError(`${PRIVATE_MODEL_ENDPOINTS_ENV} is invalid: ${detail}`);
  }
  return { endpoints: parsed.data };
}

type EnvLike = Record<string, string | undefined>;

function processEnv(): EnvLike {
  const env = (globalThis as { process?: { env?: EnvLike } }).process?.env;
  return env ?? {};
}

let cachedRegistry: { raw: string | undefined; registry: PrivateModelEndpointRegistry } | undefined;
let overrideRegistry: PrivateModelEndpointRegistry | undefined;

/**
 * The process registry, parsed from `DOCSLURP_PRIVATE_MODEL_ENDPOINTS`.
 * An invalid value throws, so every private route fails closed until fixed.
 */
export function getPrivateModelEndpointRegistry(): PrivateModelEndpointRegistry {
  if (overrideRegistry) return overrideRegistry;
  const raw = processEnv()[PRIVATE_MODEL_ENDPOINTS_ENV];
  if (cachedRegistry && cachedRegistry.raw === raw) return cachedRegistry.registry;
  const registry = parsePrivateModelEndpointRegistry(raw);
  cachedRegistry = { raw, registry };
  return registry;
}

/** Tests only: replace (or with `undefined`, restore) the process registry. */
export function setPrivateModelEndpointRegistryForTests(registry: PrivateModelEndpointRegistry | readonly unknown[] | undefined): void {
  if (registry === undefined) {
    overrideRegistry = undefined;
    return;
  }
  overrideRegistry = Array.isArray(registry)
    ? { endpoints: privateEndpointRegistrySchema.parse(registry) }
    : registry as PrivateModelEndpointRegistry;
}

/**
 * Startup validation: parses the registry, warns about unset token variables,
 * and returns a one-line summary per endpoint. Throws on invalid config.
 */
export function validatePrivateModelEndpointsAtStartup(env: EnvLike = processEnv()): string[] {
  const registry = overrideRegistry ?? parsePrivateModelEndpointRegistry(env[PRIVATE_MODEL_ENDPOINTS_ENV]);
  return registry.endpoints.map((endpoint) => {
    const tokenSet = Boolean(env[endpoint.auth.tokenEnv]?.trim());
    if (!tokenSet) console.warn(`[private-endpoints] alias=${endpoint.alias} token_env=${endpoint.auth.tokenEnv} is not set; calls will fail`);
    const models = endpoint.models.map((model) => `${model.capability}:${model.id}`).join(",");
    return `[private-endpoints] alias=${endpoint.alias} base_url=${endpoint.baseUrl} tenancy=${endpoint.attestation.tenancy} host=${endpoint.attestation.hostProvider} region=${endpoint.attestation.region} token_set=${tokenSet} models=${models}`;
  });
}

// ---------------------------------------------------------------------------
// Model URIs: llm://private/<alias>/<model-id>
// ---------------------------------------------------------------------------

export interface PrivateModelRef {
  alias: string;
  /** Model id as served by the endpoint; may contain `/`. */
  model: string;
}

/** True for `llm://private/...` strings (syntax only, no registry lookup). */
export function isPrivateModelUri(value: string | null | undefined): value is string {
  return typeof value === "string" && /^llm:\/\/private\//i.test(value.trim());
}

/**
 * Splits `<alias>/<model-id>` (the path of a private URI). Returns null when the
 * alias or model is missing or the alias is malformed.
 */
export function parsePrivateModelPath(path: string): PrivateModelRef | null {
  const trimmed = path.replace(/^\/+/, "");
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  const alias = trimmed.slice(0, slash).toLowerCase();
  const model = trimmed.slice(slash + 1);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(alias) || !model.trim()) return null;
  return { alias, model };
}

export function parsePrivateModelUri(uri: string): PrivateModelRef | null {
  if (!isPrivateModelUri(uri)) return null;
  try {
    const url = new URL(uri.trim());
    if (url.search || url.hash || url.username || url.password) return null;
    return parsePrivateModelPath(decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
}

export function formatPrivateModelUri(ref: PrivateModelRef): string {
  return `llm://private/${ref.alias}/${ref.model}`;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface PrivateModelRoute {
  endpoint: PrivateModelEndpoint;
  model: PrivateEndpointModel;
  alias: string;
  /** Normalized base URL from the registry, e.g. `https://gpu.example.com/v1`. */
  baseUrl: string;
  capability: PrivateModelCapability;
  modelUri: string;
}

export type PrivateModelRouteLookup =
  | { ok: true; route: PrivateModelRoute }
  | { ok: false; reason: string };

/**
 * Looks up `alias/model` for a capability. Fails when the alias is not
 * registered, the model is not listed for that capability, the registry is
 * invalid, or `baseUrl` is given and differs from the registered URL.
 */
export function lookupPrivateModelRoute(args: {
  ref: PrivateModelRef | string;
  capability: PrivateModelCapability;
  baseUrl?: string | null;
  registry?: PrivateModelEndpointRegistry;
}): PrivateModelRouteLookup {
  const ref = typeof args.ref === "string"
    ? (isPrivateModelUri(args.ref) ? parsePrivateModelUri(args.ref) : parsePrivateModelPath(args.ref))
    : args.ref;
  if (!ref) return { ok: false, reason: "malformed private model reference; expected llm://private/<alias>/<model>" };
  let registry: PrivateModelEndpointRegistry;
  try {
    registry = args.registry ?? getPrivateModelEndpointRegistry();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const endpoint = registry.endpoints.find((candidate) => candidate.alias === ref.alias);
  if (!endpoint) return { ok: false, reason: `private endpoint alias '${ref.alias}' is not registered` };
  const model = endpoint.models.find((candidate) => candidate.id === ref.model && candidate.capability === args.capability);
  if (!model) return { ok: false, reason: `model '${ref.model}' is not registered for ${args.capability} on private endpoint '${ref.alias}'` };
  if (args.baseUrl && normalizePrivateEndpointBaseUrl(args.baseUrl) !== endpoint.baseUrl) {
    return { ok: false, reason: `URL ${args.baseUrl} does not match the registered URL for private endpoint '${ref.alias}'` };
  }
  return {
    ok: true,
    route: {
      endpoint,
      model,
      alias: endpoint.alias,
      baseUrl: endpoint.baseUrl,
      capability: args.capability,
      modelUri: formatPrivateModelUri({ alias: endpoint.alias, model: model.id }),
    },
  };
}

export function resolvePrivateModelRoute(args: Parameters<typeof lookupPrivateModelRoute>[0]): PrivateModelRoute {
  const result = lookupPrivateModelRoute(args);
  if (!result.ok) throw new PrivateEndpointResolutionError(result.reason);
  return result.route;
}

/** Auth header for a route, read from the operator's token variable at call time. */
export function privateEndpointAuthHeaders(endpoint: PrivateModelEndpoint, env: EnvLike = processEnv()): Record<string, string> {
  const token = env[endpoint.auth.tokenEnv]?.trim();
  if (!token) {
    throw new PrivateEndpointResolutionError(`private endpoint '${endpoint.alias}' token variable ${endpoint.auth.tokenEnv} is not set`);
  }
  return { [endpoint.auth.header]: endpoint.auth.scheme ? `${endpoint.auth.scheme} ${token}` : token };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/**
 * A fetch bound to one registered endpoint: it refuses any URL outside the
 * registered base URL, injects the operator auth header, and strips any
 * Authorization header the SDK added from a placeholder API key.
 */
export function createPrivateEndpointFetch(
  route: Pick<PrivateModelRoute, "endpoint" | "baseUrl">,
  options: { baseFetch?: typeof fetch; env?: EnvLike; chatTemplateKwargs?: Record<string, unknown> } = {},
): typeof fetch {
  const baseFetch = options.baseFetch ?? fetch;
  const prefix = `${route.baseUrl}/`;
  return (async (input, init) => {
    const url = requestUrl(input);
    if (url !== route.baseUrl && !url.startsWith(prefix)) {
      throw new PrivateEndpointResolutionError(`refusing request to ${url}: outside private endpoint '${route.endpoint.alias}'`);
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.delete("authorization");
    for (const [key, value] of Object.entries(privateEndpointAuthHeaders(route.endpoint, options.env))) headers.set(key, value);
    let body = init?.body;
    if (options.chatTemplateKwargs && url.endsWith("/chat/completions") && typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const existing = parsed.chat_template_kwargs && typeof parsed.chat_template_kwargs === "object" ? parsed.chat_template_kwargs as Record<string, unknown> : {};
        body = JSON.stringify({ ...parsed, chat_template_kwargs: { ...options.chatTemplateKwargs, ...existing } });
      } catch { /* Not JSON: send unchanged. */ }
    }
    return await baseFetch(input, { ...init, headers, body });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface PrivateEndpointCost {
  costCents: number;
  metadata: Record<string, unknown>;
}

/**
 * Operator-declared cost for one private call. Token prices win; otherwise the
 * GPU-hour price is attributed by request wall time ÷ declared concurrency;
 * otherwise 0 with `costSource: "private-endpoint-unpriced"`.
 */
export function privateEndpointCallCost(args: {
  route: Pick<PrivateModelRoute, "endpoint" | "model" | "alias">;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
}): PrivateEndpointCost {
  const pricing = { ...args.route.endpoint.pricing, ...args.route.model.pricing };
  const attestation = args.route.endpoint.attestation;
  const base = {
    endpointAlias: args.route.alias,
    endpointHost: attestation.hostProvider,
    endpointRegion: attestation.region,
    tenancy: attestation.tenancy,
    // Lets the rate card find the hosted-equivalent list price for this call (billing.ts).
    capability: args.route.model.capability,
  };
  const inputTokens = Math.max(0, args.inputTokens ?? 0);
  const outputTokens = Math.max(0, args.outputTokens ?? 0);
  if (pricing.usdPerMTokInput !== undefined || pricing.usdPerMTokOutput !== undefined) {
    const usd = (inputTokens * (pricing.usdPerMTokInput ?? 0) + outputTokens * (pricing.usdPerMTokOutput ?? 0)) / 1_000_000;
    return {
      costCents: usd * 100,
      metadata: { ...base, costSource: "private-endpoint-token-rate", usdPerMTokInput: pricing.usdPerMTokInput ?? 0, usdPerMTokOutput: pricing.usdPerMTokOutput ?? 0 },
    };
  }
  if (pricing.usdPerHour !== undefined) {
    const concurrency = pricing.concurrency ?? 1;
    const durationMs = Math.max(0, args.durationMs ?? 0);
    const usd = (durationMs / 3_600_000) * pricing.usdPerHour / concurrency;
    return {
      costCents: usd * 100,
      metadata: { ...base, costSource: "private-endpoint-hourly", usdPerHour: pricing.usdPerHour, concurrency, durationMs,
        costNote: "GPU-hour price attributed by request wall time divided by declared concurrency" },
    };
  }
  return {
    costCents: 0,
    metadata: { ...base, costSource: "private-endpoint-unpriced", costNote: "No operator price declared for this private endpoint; recorded at 0" },
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface PrivateEndpointProbeResult {
  alias: string;
  ok: boolean;
  status?: number;
  served: string[];
  missing: string[];
  error?: string;
  latencyMs: number;
}

/**
 * Lists the models each endpoint serves (`GET <baseUrl>/models`) and reports
 * registered models the server does not list. Never throws; callers log.
 */
export async function probePrivateModelEndpoints(options: {
  registry?: PrivateModelEndpointRegistry;
  fetch?: typeof fetch;
  env?: EnvLike;
  timeoutMs?: number;
} = {}): Promise<PrivateEndpointProbeResult[]> {
  let registry: PrivateModelEndpointRegistry;
  try {
    registry = options.registry ?? getPrivateModelEndpointRegistry();
  } catch (error) {
    return [{ alias: "*", ok: false, served: [], missing: [], error: error instanceof Error ? error.message : String(error), latencyMs: 0 }];
  }
  return await Promise.all(registry.endpoints.map(async (endpoint): Promise<PrivateEndpointProbeResult> => {
    const startedAt = Date.now();
    const registered = [...new Set(endpoint.models.map((model) => model.id))];
    try {
      const boundFetch = createPrivateEndpointFetch({ endpoint, baseUrl: endpoint.baseUrl }, { baseFetch: options.fetch, env: options.env });
      const response = await boundFetch(`${endpoint.baseUrl}/models`, { method: "GET", signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
      if (!response.ok) {
        return { alias: endpoint.alias, ok: false, status: response.status, served: [], missing: registered, error: `HTTP ${response.status}`, latencyMs: Date.now() - startedAt };
      }
      const payload = await response.json() as { data?: Array<{ id?: unknown }> };
      const served = (payload.data ?? []).map((entry) => (typeof entry.id === "string" ? entry.id : "")).filter(Boolean);
      const missing = registered.filter((id) => !served.includes(id));
      return { alias: endpoint.alias, ok: missing.length === 0, status: response.status, served, missing, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { alias: endpoint.alias, ok: false, served: [], missing: registered, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - startedAt };
    }
  }));
}

export function formatPrivateEndpointProbe(result: PrivateEndpointProbeResult): string {
  const parts = [`[private-endpoints] probe alias=${result.alias} ok=${result.ok}`, `latency_ms=${result.latencyMs}`];
  if (result.status !== undefined) parts.push(`status=${result.status}`);
  parts.push(`served=${result.served.join(",") || "-"}`);
  if (result.missing.length) parts.push(`missing=${result.missing.join(",")}`);
  if (result.error) parts.push(`error=${JSON.stringify(result.error)}`);
  return parts.join(" ");
}

/** Fire-and-forget startup probe: logs one line per endpoint, never blocks or throws. */
export function startPrivateEndpointHealthProbe(options: Parameters<typeof probePrivateModelEndpoints>[0] = {}): void {
  let count = 0;
  try {
    count = (options.registry ?? getPrivateModelEndpointRegistry()).endpoints.length;
  } catch {
    count = 1;
  }
  if (count === 0) return;
  void probePrivateModelEndpoints(options).then((results) => {
    for (const result of results) {
      const line = formatPrivateEndpointProbe(result);
      if (result.ok) console.log(line);
      else console.warn(line);
    }
  }).catch(() => {});
}
