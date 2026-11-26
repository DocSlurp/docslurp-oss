/**
 * Where a model request may go, and which platform credential it may carry.
 *
 * Two rules, shared by every caller that sends a model request:
 *
 * 1. A platform-held provider key is sent only to that provider's configured base URL: the same origin (scheme, host
 *    and port, after URL normalisation) and path. There is no fallback: an unknown, look-alike or tenant-named
 *    destination gets no key.
 * 2. A tenant setting (project pipeline, run override, per-request option) may name its own model server only for the
 *    local OpenAI-compatible providers (`ollama`, `vllm`, `lmstudio`), only on a literal loopback host, and only when
 *    the operator sets `DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS=true` (a trusted single-tenant host). Hosted and
 *    multi-tenant deployments leave it unset. Operator configuration from the environment (provider base URLs,
 *    private model endpoints) is trusted and is not judged here.
 *
 * Refusals carry a stable code; callers report the code to the tenant and keep any detail in server logs.
 */

/** Operator flag that lets tenant settings use loopback model servers. Off unless exactly "true". */
export const TENANT_LOCAL_MODEL_ENDPOINTS_ENV = "DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS";

/** Local providers reached over HTTP at a model server's address (the only ones a tenant `baseUrl` may set). */
export const LOCAL_SERVER_MODEL_PROVIDERS = ["ollama", "vllm", "lmstudio"] as const;

export type TenantModelEndpointRefusal =
  | "tenant-local-endpoints-disabled"
  | "tenant-base-url-not-allowed"
  | "tenant-base-url-not-loopback"
  | "tenant-model-uri-invalid";

const REFUSAL_MESSAGES: Record<TenantModelEndpointRefusal, string> = {
  "tenant-local-endpoints-disabled": "Tenant-selected local model endpoints are disabled",
  "tenant-base-url-not-allowed": "baseUrl overrides are only supported for local model providers",
  "tenant-base-url-not-loopback": "Local model baseUrl must use a loopback host",
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

/**
 * True when `value` is an http(s) URL on a canonical loopback host (`localhost`, `127.0.0.1`, `[::1]`, after WHATWG
 * normalisation), with no user info. Look-alike names, mapped IPv6 forms, `0.0.0.0` and other schemes are not.
 */
export function isLoopbackModelBaseUrl(value: string): boolean {
  if (modelEndpointOrigin(value) === null) return false;
  const host = new URL(value.trim()).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
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
  return baseUrls.every(isLoopbackModelBaseUrl) ? null : "tenant-base-url-not-loopback";
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
  if (baseUrl && !isLoopbackModelBaseUrl(baseUrl)) throw new TenantModelEndpointRefusedError("tenant-base-url-not-loopback");
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
