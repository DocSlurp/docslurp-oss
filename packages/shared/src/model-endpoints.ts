/**
 * Where a model request may go, and which platform credential it may carry.
 *
 * Two rules, shared by every caller that sends a model request:
 *
 * 1. A platform-held provider key is sent only to that provider's configured base URL: the same origin (scheme, host
 *    and port, after URL normalisation) and path. There is no fallback: an unknown, look-alike or tenant-named
 *    destination gets no key.
 * 2. A tenant setting (project pipeline, run override, per-request option) may name its own model server only for the
 *    local OpenAI-compatible providers (`ollama`, `vllm`, `lmstudio`), only on a loopback host (`localhost`,
 *    `127.0.0.1` or `[::1]` after WHATWG URL normalisation, so numeric spellings such as `127.1` or `2130706433` count
 *    as `127.0.0.1`), only on an allowed port (`DOCSLURP_TENANT_LOCAL_MODEL_PORTS`, default the three servers' standard
 *    ports 11434, 8000 and 1234), with no user info, query or fragment, and only when the operator sets
 *    `DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS=true` (a trusted host). Hosted and multi-tenant deployments leave it
 *    unset. Operator configuration from the environment (provider base URLs, private model endpoints) is trusted and is
 *    not judged here. Requests are built from the parsed base URL (`modelEndpointUrl`), never by string concatenation.
 *
 * Refusals carry a stable code; callers report the code to the tenant and keep any detail in server logs.
 */

/** Operator flag that lets tenant settings use loopback model servers. Off unless exactly "true". */
export const TENANT_LOCAL_MODEL_ENDPOINTS_ENV = "DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS";

/**
 * Operator list of loopback ports tenant model servers may use (comma-separated). Unset: the standard ports of the
 * three local servers. Set (even to an empty value) and with no valid port: none (fail closed). Invalid entries
 * (ranges, 0, out-of-range numbers, text) are dropped and logged once.
 */
export const TENANT_LOCAL_MODEL_PORTS_ENV = "DOCSLURP_TENANT_LOCAL_MODEL_PORTS";

/** Standard ports: Ollama 11434, vLLM 8000, LM Studio 1234. */
export const DEFAULT_TENANT_LOCAL_MODEL_PORTS: readonly number[] = [11434, 8000, 1234];

/** Local providers reached over HTTP at a model server's address (the only ones a tenant `baseUrl` may set). */
export const LOCAL_SERVER_MODEL_PROVIDERS = ["ollama", "vllm", "lmstudio"] as const;
export type LocalServerModelProvider = typeof LOCAL_SERVER_MODEL_PROVIDERS[number];

/** Where a local server route without a `baseUrl` is sent: the server's standard loopback address. */
export const DEFAULT_LOCAL_MODEL_BASE_URLS: Readonly<Record<LocalServerModelProvider, string>> = {
  ollama: "http://127.0.0.1:11434/v1",
  vllm: "http://127.0.0.1:8000/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
};

/** The default base URL of a local server provider, or null for any other provider. */
export function defaultLocalModelBaseUrl(provider: string): string | null {
  const normalized = provider.trim().toLowerCase();
  return isLocalServerProvider(normalized) ? DEFAULT_LOCAL_MODEL_BASE_URLS[normalized as LocalServerModelProvider] : null;
}

export type TenantModelEndpointRefusal =
  | "tenant-local-endpoints-disabled"
  | "tenant-base-url-not-allowed"
  | "tenant-base-url-not-loopback"
  | "tenant-base-url-invalid"
  | "tenant-base-url-port-not-allowed"
  | "tenant-model-uri-invalid";

const REFUSAL_MESSAGES: Record<TenantModelEndpointRefusal, string> = {
  "tenant-local-endpoints-disabled": "Tenant-selected local model endpoints are disabled",
  "tenant-base-url-not-allowed": "baseUrl overrides are only supported for local model providers",
  "tenant-base-url-not-loopback": "Local model baseUrl must use a loopback host",
  "tenant-base-url-invalid": "Local model baseUrl must be a plain http(s) URL with no user info, query or fragment",
  "tenant-base-url-port-not-allowed": "Local model baseUrl port is not allowed on this deployment",
  "tenant-model-uri-invalid": "Invalid llm:// model route",
};

/** A tenant model setting that names a destination this deployment refuses. `code` is safe to show the tenant. */
export class TenantModelEndpointRefusedError extends Error {
  readonly status = 400;
  constructor(readonly code: TenantModelEndpointRefusal) {
    super(REFUSAL_MESSAGES[code]);
    this.name = "TenantModelEndpointRefusedError";
  }
}

type Env = Record<string, string | undefined>;

export function tenantLocalModelEndpointsAllowed(env: Env = process.env): boolean {
  return env[TENANT_LOCAL_MODEL_ENDPOINTS_ENV]?.trim() === "true";
}

/** The ports `DOCSLURP_TENANT_LOCAL_MODEL_PORTS` allows (see `TENANT_LOCAL_MODEL_PORTS_ENV`). */
const loggedPortListProblems = new Set<string>();

export function tenantLocalModelPorts(env: Env = process.env): ReadonlySet<number> {
  const raw = env[TENANT_LOCAL_MODEL_PORTS_ENV];
  if (raw === undefined) return new Set(DEFAULT_TENANT_LOCAL_MODEL_PORTS);
  const ports = new Set<number>();
  const invalid: string[] = [];
  for (const part of raw.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const port = /^\d{1,5}$/.test(part) ? Number(part) : Number.NaN;
    if (port >= 1 && port <= 65535) ports.add(port);
    else invalid.push(part);
  }
  if (invalid.length > 0 && !loggedPortListProblems.has(raw)) {
    if (loggedPortListProblems.size > 100) loggedPortListProblems.clear();
    loggedPortListProblems.add(raw);
    console.warn(`[model-endpoint] ${TENANT_LOCAL_MODEL_PORTS_ENV} ignored invalid entries=${JSON.stringify(invalid.map((entry) => entry.slice(0, 20)).slice(0, 10))} allowed=${JSON.stringify([...ports])}`);
  }
  return ports;
}

function isLocalServerProvider(provider: string): boolean {
  return (LOCAL_SERVER_MODEL_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * The normalised origin (`scheme://host[:port]`) of an http(s) URL, or null for anything else: another scheme, a URL
 * with user info (`https://api.example@evil.example`), or text that is not a URL.
 */
export function modelEndpointOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Why `value` cannot be a tenant base URL by shape (scheme, user info, query, fragment, host), or null. No env. */
function loopbackBaseUrlShapeProblem(value: string): "tenant-base-url-invalid" | "tenant-base-url-not-loopback" | null {
  if (modelEndpointOrigin(value) === null) return "tenant-base-url-invalid";
  // Checked on the raw text: WHATWG drops an empty `?` or `#`, and a suffix appended after either would leave the path.
  if (value.includes("?") || value.includes("#")) return "tenant-base-url-invalid";
  const url = new URL(value.trim());
  if (url.search || url.hash) return "tenant-base-url-invalid";
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" ? null : "tenant-base-url-not-loopback";
}

/** The tenant-facing message for a refusal code (fixed text, never the refused value). */
export function tenantModelEndpointRefusalMessage(code: TenantModelEndpointRefusal): string {
  return REFUSAL_MESSAGES[code];
}

/** Why `value` cannot be a tenant base URL by shape alone (`tenant-base-url-invalid` or `-not-loopback`), or null. */
export function loopbackModelBaseUrlProblem(value: string): "tenant-base-url-invalid" | "tenant-base-url-not-loopback" | null {
  return loopbackBaseUrlShapeProblem(value);
}

/**
 * True when `value` is an http(s) URL on a loopback host (`localhost`, `127.0.0.1`, `[::1]`, compared after WHATWG
 * normalisation, so `127.1` and `0x7f.1` are `127.0.0.1`) with no user info, query or fragment. Look-alike names,
 * mapped IPv6 forms, `0.0.0.0` and other schemes are not. The port is judged separately (`tenantLoopbackBaseUrlProblem`).
 */
export function isLoopbackModelBaseUrl(value: string): boolean {
  return loopbackBaseUrlShapeProblem(value) === null;
}

/** Why a tenant loopback base URL is refused (shape, host, then port against `tenantLocalModelPorts`), or null. */
export function tenantLoopbackBaseUrlProblem(value: string, env: Env = process.env): TenantModelEndpointRefusal | null {
  const shape = loopbackBaseUrlShapeProblem(value);
  if (shape) return shape;
  const url = new URL(value.trim());
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return tenantLocalModelPorts(env).has(port) ? null : "tenant-base-url-port-not-allowed";
}

/**
 * The request URL for `endpoint` (for example `chat/completions` or `embeddings`) under `baseUrl`, built from the
 * parsed URL: dot segments and percent-encoded dots are resolved by the parser first, the endpoint is appended to the
 * resolved path (once: a base that already ends with it is kept), any fragment is dropped and an operator base URL's
 * query is kept as a query. Tenant base URLs never carry a query (`tenantLoopbackBaseUrlProblem`).
 */
export function modelEndpointUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl.trim());
  const suffix = `/${endpoint.replace(/^\/+|\/+$/g, "")}`;
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  url.hash = "";
  return url.href;
}

/**
 * A base URL in comparable form: its origin plus its path without trailing slashes, or null when it has user info,
 * a query or a fragment, or is not an http(s) URL.
 */
export function normalizedModelBaseUrl(value: string | null | undefined): string | null {
  const origin = modelEndpointOrigin(value);
  if (origin === null) return null;
  const url = new URL(value!.trim());
  if (url.search || url.hash || value!.includes("#") || value!.includes("?")) return null;
  return `${origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The platform key for a request to `destination`: `grant.key` when the destination is the provider's configured
 * base URL (same origin, scheme, host and port, and the same path; no user info, query or fragment), else "" (send
 * no key). Never a fallback to a default provider's key.
 */
export function platformKeyForDestination(
  destination: string | null | undefined,
  grant: { baseUrl: string; key: string | null | undefined },
): string {
  const key = grant.key?.trim();
  if (!key) return "";
  const target = normalizedModelBaseUrl(destination);
  const owner = normalizedModelBaseUrl(grant.baseUrl);
  return target !== null && target === owner ? key : "";
}

function parseModelUri(modelUri: string): { provider: string; params: URLSearchParams } | null {
  try {
    // Trimmed the way the settings schema (`llmModelUriSchema`) trims, so every reader judges the same text.
    const url = new URL(modelUri.trim());
    if (url.protocol !== "llm:") return null;
    return { provider: url.hostname.toLowerCase(), params: url.searchParams };
  } catch {
    return null;
  }
}

/**
 * Every `baseUrl` value in the URI's query, matched case-insensitively (a destination can hide in any spelling). Used
 * where refusing more is safe (save and call time); the stored-row reader matches only `resolverBaseUrlValues`.
 */
function baseUrlValues(params: URLSearchParams): string[] {
  const values: string[] = [];
  for (const [key, value] of params) if (key.trim().toLowerCase() === "baseurl") values.push(value);
  return values;
}

/** The `baseUrl` values under the exact key the route resolvers read (`params.get("baseUrl")`). */
function resolverBaseUrlValues(params: URLSearchParams): string[] {
  return params.getAll("baseUrl");
}

/**
 * Why a tenant `llm://` model URI names a destination this deployment refuses, or null: the call-time rule. A local
 * server route is refused while the flag is off; with it on, each `baseUrl` (or, with none, the provider's default
 * base URL, `DEFAULT_LOCAL_MODEL_BASE_URLS`) must be loopback, plain and on an allowed port.
 */
export function tenantModelEndpointProblem(modelUri: string, env: Env = process.env): TenantModelEndpointRefusal | null {
  const parsed = parseModelUri(modelUri);
  if (!parsed) return "tenant-model-uri-invalid";
  const baseUrls = baseUrlValues(parsed.params);
  if (!isLocalServerProvider(parsed.provider)) return baseUrls.length > 0 ? "tenant-base-url-not-allowed" : null;
  if (!tenantLocalModelEndpointsAllowed(env)) return "tenant-local-endpoints-disabled";
  for (const baseUrl of baseUrls.length > 0 ? baseUrls : [defaultLocalModelBaseUrl(parsed.provider)!]) {
    const problem = tenantLoopbackBaseUrlProblem(baseUrl, env);
    if (problem) return problem;
  }
  return null;
}

/**
 * The run-creation rule: only a destination the tenant supplied (a `baseUrl` parameter the route resolvers read) is
 * judged, with the full `tenantModelEndpointProblem` rule. A URI with no `baseUrl` (for example one a vision profile
 * fills in) names a model category, not an endpoint, and is admitted here, as is a key spelling no resolver reads
 * (it sends nothing anywhere). The worker still judges every route at call time (`tenantModelEndpointProblem`, which
 * matches any spelling, and `assertTenantModelBaseUrlAllowed` on the resolved base URL) before anything is sent.
 */
export function tenantSuppliedEndpointProblem(modelUri: string, env: Env = process.env): TenantModelEndpointRefusal | null {
  const parsed = parseModelUri(modelUri);
  if (!parsed) return "tenant-model-uri-invalid";
  if (resolverBaseUrlValues(parsed.params).length === 0) return null;
  return tenantModelEndpointProblem(modelUri, env);
}

/**
 * `inner` (default the global fetch) with redirects refused: for model requests that carry a provider key or go to a
 * tenant-set endpoint, where following a redirect would resend the key or the request body to an unchecked host.
 */
export function noRedirectFetch(inner?: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => (inner ?? globalThis.fetch)(input, { ...init, redirect: "error" })) as typeof fetch;
}

/**
 * A tenant local server's `baseUrl` re-serialised from its parsed form, for an SDK that appends `/<endpoint>` itself:
 * dot segments resolved, no trailing slash, no fragment, and the name `localhost` pinned to `127.0.0.1` so the request
 * never depends on what the system resolver returns for it. Tenant base URLs never carry a query
 * (`tenantLoopbackBaseUrlProblem`), so the suffix the SDK appends always lands in the path.
 */
export function canonicalModelBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (url.hostname.toLowerCase() === "localhost") url.hostname = "127.0.0.1";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.search ? url.href : url.href.replace(/\/+$/, "");
}

/**
 * Why a stored tenant model URI names an endpoint the rule refuses for its own shape, so no deployment setting could
 * make it usable (a hosted provider with a `baseUrl`, or a local server's base URL that is not loopback or has user
 * info, a query or a fragment), or null. Only the `baseUrl` spelling the route resolvers read counts here. What an
 * operator setting decides is not such a refusal: with the flag off, or a port the operator does not allow, the row
 * stays as written and the worker refuses it before each request with its code (`tenant-local-endpoints-disabled`,
 * `tenant-base-url-port-not-allowed`), so a self-hoster sees that error rather than a different model. Stored-row
 * readers drop a URI this refuses (never its profile).
 */
export function storedModelEndpointRefusal(modelUri: unknown): TenantModelEndpointRefusal | null {
  if (typeof modelUri !== "string" || modelUri.trim() === "") return null;
  const parsed = parseModelUri(modelUri);
  if (!parsed) return null;
  const baseUrls = resolverBaseUrlValues(parsed.params);
  if (!isLocalServerProvider(parsed.provider)) return baseUrls.length > 0 ? "tenant-base-url-not-allowed" : null;
  // With no baseUrl the provider's default base URL is used, which is always loopback and plain.
  for (const baseUrl of baseUrls.length > 0 ? baseUrls : [defaultLocalModelBaseUrl(parsed.provider)!]) {
    const problem = loopbackBaseUrlShapeProblem(baseUrl);
    if (problem) return problem;
  }
  return null;
}

/** Throws `TenantModelEndpointRefusedError` when `tenantModelEndpointProblem` refuses the URI. */
export function assertTenantModelEndpointAllowed(modelUri: string, env: Env = process.env): void {
  const problem = tenantModelEndpointProblem(modelUri, env);
  if (problem) throw new TenantModelEndpointRefusedError(problem);
}

/**
 * Call-time check of a resolved route (`provider` plus the base URL the request will use): the same rule as
 * `tenantModelEndpointProblem`, for code that holds a resolved profile rather than the URI it came from.
 */
export function assertTenantModelBaseUrlAllowed(provider: string, baseUrl: string | null | undefined, env: Env = process.env): void {
  const normalized = provider.trim().toLowerCase();
  if (!isLocalServerProvider(normalized)) return;
  if (!tenantLocalModelEndpointsAllowed(env)) throw new TenantModelEndpointRefusedError("tenant-local-endpoints-disabled");
  // No base URL: the provider's default one is where the request would go, so that is judged (its port included).
  const problem = tenantLoopbackBaseUrlProblem(baseUrl?.trim() || defaultLocalModelBaseUrl(normalized)!, env);
  if (problem) throw new TenantModelEndpointRefusedError(problem);
}

/**
 * The tenant model URIs a pipeline names, each refusal with its setting path. Unknown shapes are skipped.
 * `rule: "save"` (project create and update) applies the full `tenantModelEndpointProblem`; `rule: "run"` (run
 * creation, retries, reprocess, reindex, clones, materialise) applies `tenantSuppliedEndpointProblem`, which judges
 * only a tenant-supplied `baseUrl`, so a profile's model category never refuses a run.
 */
export function tenantPipelineEndpointProblems(
  pipeline: unknown,
  env: Env = process.env,
  options: { rule?: "save" | "run" } = {},
): Array<{ path: string; code: TenantModelEndpointRefusal }> {
  const judge = options.rule === "run" ? tenantSuppliedEndpointProblem : tenantModelEndpointProblem;
  const problems: Array<{ path: string; code: TenantModelEndpointRefusal }> = [];
  if (!pipeline || typeof pipeline !== "object") return problems;
  const record = pipeline as Record<string, unknown>;
  const fields: Array<[string, unknown]> = [];
  const section = (name: string) => (record[name] && typeof record[name] === "object" ? record[name] as Record<string, unknown> : null);
  fields.push(["embedding.modelUri", section("embedding")?.modelUri]);
  fields.push(["vision.modelUri", section("vision")?.modelUri]);
  fields.push(["vision.remoteFallbackModelUri", section("vision")?.remoteFallbackModelUri]);
  for (const [path, value] of fields) {
    if (typeof value !== "string" || value === "") continue;
    const code = judge(value, env);
    if (code) problems.push({ path, code });
  }
  return problems;
}
