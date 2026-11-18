import {
  isPrivateModelUri,
  lookupPrivateModelRoute,
  privateModelEndpointRegistryFor,
  type PrivateModelCapability,
  type PrivateModelEndpointRegistry,
  type PrivateModelRoute,
} from "./private-endpoints.js";

/**
 * Deployment model mode and the operator's service → private endpoint map.
 *
 * `DOCSLURP_MODEL_MODE` decides where model calls may go for the whole deployment:
 *
 * - `hosted` (default): hosted model providers serve `standard` projects. Projects whose privacy mode forbids hosted
 *   models (`local-only`, `strict-privacy`) use the operator's mapped private model for each service.
 * - `private`: every project, whatever its level, uses the mapped private model for each service, and no hosted model
 *   provider is ever called. A service without a mapping is unavailable: its calls are refused (logged), never sent
 *   to a hosted model. Local steps that call no remote model (local embeddings, the heuristic or baseline page
 *   router, a local OCR CLI) stay allowed.
 *
 * One variable per service maps it to an `llm://private/<alias>/<model>` registered in
 * `DOCSLURP_PRIVATE_MODEL_ENDPOINTS` with the matching capability. Projects never choose these: base URLs,
 * credentials and model ids come only from operator environment.
 *
 * This module is browser-safe: without `process.env` the mode is `hosted` and nothing is mapped.
 */

export const MODEL_MODE_ENV = "DOCSLURP_MODEL_MODE";
export const MODEL_MODES = ["hosted", "private"] as const;
export type ModelMode = (typeof MODEL_MODES)[number];

export const PRIVATE_MODEL_SERVICES = ["text", "vision", "embedding", "rerank", "router", "stt"] as const;
export type PrivateModelService = (typeof PRIVATE_MODEL_SERVICES)[number];

/** The environment variable that maps each service. */
export const PRIVATE_SERVICE_MODEL_ENV: Readonly<Record<PrivateModelService, string>> = {
  text: "DOCSLURP_PRIVATE_TEXT_MODEL",
  vision: "DOCSLURP_PRIVATE_VISION_MODEL",
  embedding: "DOCSLURP_PRIVATE_EMBEDDING_MODEL",
  rerank: "DOCSLURP_PRIVATE_RERANK_MODEL",
  router: "DOCSLURP_PRIVATE_ROUTER_MODEL",
  stt: "DOCSLURP_PRIVATE_STT_MODEL",
};

/** Registry capabilities a service's model may have, in preference order. The page router reads text or page images. */
const SERVICE_CAPABILITIES: Readonly<Record<PrivateModelService, readonly PrivateModelCapability[]>> = {
  text: ["text"],
  vision: ["vision"],
  embedding: ["embedding"],
  rerank: ["rerank"],
  router: ["text", "vision"],
  stt: ["stt"],
};

/**
 * Credentials of hosted model providers and other hosted services that receive content or queries. A private-mode
 * deployment refuses to start while any is set, so no hosted call can authenticate even where a code path forgot the
 * privacy guard. A registered endpoint may not use one of these names as its `auth.tokenEnv`. An operator who needs
 * one for a non-model consumer (for example the DeepInfra capacity provider or vendor balance alerts) names it in
 * `DOCSLURP_PRIVATE_MODE_ALLOW_KEYS`; startup then warns instead of refusing.
 */
export const HOSTED_MODEL_PROVIDER_KEY_ENVS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPINFRA_API_KEY",
  "DEEPINFRA_TOKEN",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "JINA_API_KEY",
  "PERPLEXITYAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "LIQUID_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "VOYAGE_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "HUGGINGFACE_API_KEY",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "FIRECRAWL_API_KEY",
] as const;

/** Comma-separated hosted key names a private-mode deployment may keep (logged as a warning at startup). */
export const PRIVATE_MODE_ALLOW_KEYS_ENV = "DOCSLURP_PRIVATE_MODE_ALLOW_KEYS";

type EnvLike = Record<string, string | undefined>;

function processEnv(): EnvLike {
  return (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {};
}

export class PrivateModelModeConfigError extends Error {
  readonly code = "PRIVATE_MODEL_MODE_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "PrivateModelModeConfigError";
  }
}

/** Parses the mode. Unset or empty is `hosted`; anything else that is not a known mode throws. */
export function parseModelMode(raw: string | null | undefined): ModelMode {
  const value = raw?.trim().toLowerCase();
  if (!value) return "hosted";
  if ((MODEL_MODES as readonly string[]).includes(value)) return value as ModelMode;
  throw new PrivateModelModeConfigError(`${MODEL_MODE_ENV}=${JSON.stringify(raw)} is not a model mode; use hosted or private`);
}

/**
 * The deployment's model mode. An unreadable value counts as `private` (fail closed: no hosted call); startup
 * validation refuses to start with one.
 */
export function modelMode(env: EnvLike = processEnv()): ModelMode {
  try {
    return parseModelMode(env[MODEL_MODE_ENV]);
  } catch {
    return "private";
  }
}

/**
 * Whether hosted model providers may receive a project's content: only in `hosted` mode, and only for a `standard`
 * (or unset) project privacy mode. Unknown privacy modes fail closed.
 */
export function hostedModelsAllowed(privacyMode: string | null | undefined, env: EnvLike = processEnv()): boolean {
  if (modelMode(env) !== "hosted") return false;
  return privacyMode === undefined || privacyMode === null || privacyMode === "standard";
}

export interface PrivateServiceModel {
  service: PrivateModelService;
  /** Canonical `llm://private/<alias>/<model>`. */
  modelUri: string;
  capability: PrivateModelCapability;
  route: PrivateModelRoute;
}

export type PrivateServiceModelLookup =
  | { ok: true; model: PrivateServiceModel }
  | { ok: false; unmapped: true; reason: string }
  | { ok: false; unmapped: false; reason: string };

/** Resolves one service's mapping against the registry. Never throws. */
export function lookupPrivateServiceModel(
  service: PrivateModelService,
  options: { env?: EnvLike; registry?: PrivateModelEndpointRegistry } = {},
): PrivateServiceModelLookup {
  const env = options.env ?? processEnv();
  const name = PRIVATE_SERVICE_MODEL_ENV[service];
  const raw = env[name]?.trim();
  if (!raw) return { ok: false, unmapped: true, reason: `${name} is not set` };
  if (!isPrivateModelUri(raw)) return { ok: false, unmapped: false, reason: `${name} must be an llm://private/<alias>/<model> URI` };
  const reasons: string[] = [];
  for (const capability of SERVICE_CAPABILITIES[service]) {
    const lookup = lookupPrivateModelRoute({ ref: raw, capability, registry: options.registry });
    if (lookup.ok) {
      if (service === "embedding" && !lookup.route.model.dimensions) {
        return { ok: false, unmapped: false, reason: `${name}: embedding model '${lookup.route.model.id}' declares no dimensions` };
      }
      return { ok: true, model: { service, modelUri: lookup.route.modelUri, capability, route: lookup.route } };
    }
    reasons.push(lookup.reason);
  }
  return { ok: false, unmapped: false, reason: `${name}: ${[...new Set(reasons)].join("; ")}` };
}

const reportedInvalid = new Set<string>();

/**
 * The operator's private model for a service, or undefined when the service is unmapped. An invalid mapping (startup
 * refuses it) also reads as undefined, logged once, so the service is refused rather than routed anywhere else.
 */
export function privateServiceModel(service: PrivateModelService, env: EnvLike = processEnv()): PrivateServiceModel | undefined {
  const lookup = lookupPrivateServiceModel(service, { env });
  if (lookup.ok) return lookup.model;
  if (!lookup.unmapped && !reportedInvalid.has(lookup.reason)) {
    reportedInvalid.add(lookup.reason);
    console.error(`[private-model-mode] service=${service} mapping is invalid and refused: ${lookup.reason}`);
  }
  return undefined;
}

/**
 * The private model a call for `service` must use for a project with `privacyMode`: the mapped model whenever hosted
 * models are not allowed (a restricted project, or private mode), else undefined (the hosted route applies).
 * Undefined while hosted is not allowed means the service is unavailable: callers refuse, never fall back to hosted.
 */
export function privateServiceModelFor(
  service: PrivateModelService,
  privacyMode: string | null | undefined,
  env: EnvLike = processEnv(),
): string | undefined {
  if (hostedModelsAllowed(privacyMode, env)) return undefined;
  return privateServiceModel(service, env)?.modelUri;
}

/** Short, stable digest of the effective mode and map, logged by the API and the worker so a mismatch is visible. */
export function privateModelMapDigest(mode: ModelMode, mapped: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const char of `${mode}|${[...mapped].sort().join(",")}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Startup validation for the API and the worker. Throws on an invalid mode. In private mode it also throws on an
 * invalid mapping (unknown alias, model not registered with the service's capability, not a private URI, an embedding
 * model without dimensions), on a hosted provider key that is set and not allowed by `DOCSLURP_PRIVATE_MODE_ALLOW_KEYS`,
 * and on a registered endpoint whose `tokenEnv` is a hosted provider key name. In hosted mode an invalid mapping is a
 * warning and the service reads as unmapped, so a deployment that never used the map keeps starting. Returns log lines.
 */
export function validatePrivateModelModeAtStartup(env: EnvLike = processEnv(), registry?: PrivateModelEndpointRegistry): { info: string[]; warnings: string[] } {
  const mode = parseModelMode(env[MODEL_MODE_ENV]);
  const resolvedRegistry = registry ?? privateModelEndpointRegistryFor(env);
  const problems: string[] = [];
  const warnings: string[] = [];
  const mapped: string[] = [];
  const unmapped: PrivateModelService[] = [];
  for (const service of PRIVATE_MODEL_SERVICES) {
    const lookup = lookupPrivateServiceModel(service, { env, registry: resolvedRegistry });
    if (lookup.ok) mapped.push(`${service}=${lookup.model.modelUri}`);
    else if (lookup.unmapped) unmapped.push(service);
    else if (mode === "private") problems.push(lookup.reason);
    else warnings.push(`[private-model-mode] mode=hosted invalid mapping ignored (service unmapped): ${lookup.reason}`);
  }
  if (mode === "private") {
    const hostedNames = new Set<string>(HOSTED_MODEL_PROVIDER_KEY_ENVS);
    const colliding = resolvedRegistry.endpoints.filter((endpoint) => hostedNames.has(endpoint.auth.tokenEnv));
    if (colliding.length) {
      problems.push(`private endpoint token variables must not reuse a hosted provider key name: ${colliding.map((endpoint) => `${endpoint.alias} (${endpoint.auth.tokenEnv})`).join(", ")}`);
    }
    const allowed = new Set((env[PRIVATE_MODE_ALLOW_KEYS_ENV] ?? "").split(",").map((name) => name.trim()).filter(Boolean));
    const set = HOSTED_MODEL_PROVIDER_KEY_ENVS.filter((name) => Boolean(env[name]?.trim()));
    const refused = set.filter((name) => !allowed.has(name));
    const kept = set.filter((name) => allowed.has(name));
    if (refused.length) problems.push(`${MODEL_MODE_ENV}=private refuses hosted provider credentials; unset ${refused.join(", ")} (or name them in ${PRIVATE_MODE_ALLOW_KEYS_ENV} for a non-model use)`);
    if (kept.length) warnings.push(`[private-model-mode] mode=private keeps hosted credentials ${kept.join(", ")} (${PRIVATE_MODE_ALLOW_KEYS_ENV}); model calls stay refused by the privacy guard`);
  }
  if (problems.length) throw new PrivateModelModeConfigError(`private model configuration is invalid: ${problems.join("; ")}`);
  const labels = mapped.map((entry) => (entry.startsWith("router=") ? `${entry} (reserved: no private decision adapter yet)` : entry));
  const info = [`[private-model-mode] mode=${mode} map_digest=${privateModelMapDigest(mode, mapped)} mapped=${labels.join(",") || "-"}`];
  if (mode === "private") {
    const unavailable = unmapped.filter((service) => service !== "router");
    if (unavailable.length) {
      warnings.push(`[private-model-mode] mode=private unmapped services are unavailable (refused, never sent to a hosted model): ${unavailable.map((service) => `${service} (${PRIVATE_SERVICE_MODEL_ENV[service]})`).join(", ")}`);
    }
    warnings.push("[private-model-mode] mode=private page-router decisions use the heuristic or baseline router (DOCSLURP_PRIVATE_ROUTER_MODEL is reserved)");
  }
  return { info, warnings };
}

/** Tests only: forget which invalid mappings were already logged. */
export function resetPrivateModelModeReportsForTests(): void {
  reportedInvalid.clear();
}
