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
 * three local servers. Set but with no valid port: none (fail closed).
 */
export const TENANT_LOCAL_MODEL_PORTS_ENV = "DOCSLURP_TENANT_LOCAL_MODEL_PORTS";

/** Standard ports: Ollama 11434, vLLM 8000, LM Studio 1234. */
export const DEFAULT_TENANT_LOCAL_MODEL_PORTS: readonly number[] = [11434, 8000, 1234];

/** Local providers reached over HTTP at a model server's address (the only ones a tenant `baseUrl` may set). */
export const LOCAL_SERVER_MODEL_PROVIDERS = ["ollama", "vllm", "lmstudio"] as const;

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
export function tenantLocalModelPorts(env: Env = process.env): ReadonlySet<number> {
  const raw = env[TENANT_LOCAL_MODEL_PORTS_ENV]?.trim();
  if (!raw) return new Set(DEFAULT_TENANT_LOCAL_MODEL_PORTS);
  const ports = raw.split(",").map((part) => part.trim()).filter((part) => /^\d{1,5}$/.test(part)).map(Number)
    .filter((port) => port >= 1 && port <= 65535);
  return new Set(ports);
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
    const url = new URL(modelUri);
    if (url.protocol !== "llm:") return null;
    return { provider: url.hostname.toLowerCase(), params: url.searchParams };
  } catch {
    return null;
  }
}

/** Every `baseUrl` value in the URI's query, matched case-insensitively (a destination can hide in any spelling). */
function baseUrlValues(params: URLSearchParams): string[] {
  const values: string[] = [];
  for (const [key, value] of params) if (key.trim().toLowerCase() === "baseurl") values.push(value);
  return values;
}

/** Why a tenant-supplied `llm://` model URI names a destination this deployment refuses, or null. */
export function tenantModelEndpointProblem(modelUri: string, env: Env = process.env): TenantModelEndpointRefusal | null {
  const parsed = parseModelUri(modelUri);
  if (!parsed) return "tenant-model-uri-invalid";
  const baseUrls = baseUrlValues(parsed.params);
  if (!isLocalServerProvider(parsed.provider)) return baseUrls.length > 0 ? "tenant-base-url-not-allowed" : null;
  if (!tenantLocalModelEndpointsAllowed(env)) return "tenant-local-endpoints-disabled";
  for (const baseUrl of baseUrls) {
    const problem = tenantLoopbackBaseUrlProblem(baseUrl, env);
    if (problem) return problem;
  }
  return null;
}

/**
 * Why a stored tenant model URI names an endpoint the rule refuses for its own shape (a hosted provider with a
 * `baseUrl`, or a local server's base URL that is not loopback, has user info, a query or a fragment, or uses a port
 * the operator does not allow), or null. The deployment flag being off is not such a refusal: that row stays and is
 * refused before each request (`tenant-local-endpoints-disabled`). Stored-row readers drop a URI this refuses.
 */
export function storedModelEndpointRefusal(modelUri: unknown, env: Env = process.env): TenantModelEndpointRefusal | null {
  if (typeof modelUri !== "string" || modelUri === "") return null;
  const parsed = parseModelUri(modelUri);
  if (!parsed) return null;
  const baseUrls = baseUrlValues(parsed.params);
  if (!isLocalServerProvider(parsed.provider)) return baseUrls.length > 0 ? "tenant-base-url-not-allowed" : null;
  for (const baseUrl of baseUrls) {
    const problem = tenantLoopbackBaseUrlProblem(baseUrl, env);
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
  // No base URL: the caller has no local destination to send to and fails on its own.
  const problem = baseUrl ? tenantLoopbackBaseUrlProblem(baseUrl, env) : null;
  if (problem) throw new TenantModelEndpointRefusedError(problem);
}

/** The tenant model URIs a pipeline names, each refusal with its setting path. Unknown shapes are skipped. */
export function tenantPipelineEndpointProblems(pipeline: unknown, env: Env = process.env): Array<{ path: string; code: TenantModelEndpointRefusal }> {
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
    const code = tenantModelEndpointProblem(value, env);
    if (code) problems.push({ path, code });
  }
  return problems;
}
