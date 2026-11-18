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
 * Hosted model-provider credentials. A private-mode deployment refuses to start while any is set (unless it is a
 * registered endpoint's own `auth.tokenEnv`), so no hosted call can authenticate even where a code path forgot the
 * privacy guard.
 */
export const HOSTED_MODEL_PROVIDER_KEY_ENVS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPINFRA_API_KEY",
  "DEEPINFRA_TOKEN",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "JINA_API_KEY",
  "PERPLEXITYAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "LIQUID_API_KEY",
] as const;

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

/** Log line for a call refused because its service has no private mapping. */
export function formatUnmappedServiceRefusal(service: PrivateModelService, operation: string, privacyMode: string | null | undefined): string {
  return `[private-model-mode] refused operation=${operation} service=${service} mode=${modelMode()} privacy_mode=${privacyMode ?? "standard"} reason=${JSON.stringify(`${PRIVATE_SERVICE_MODEL_ENV[service]} is not set`)}`;
}

/**
 * Startup validation for the API and the worker. Throws on an invalid mode, an invalid mapping (unknown alias, model
 * not registered with the service's capability, not a private URI) or, in private mode, a hosted model-provider key
 * that is set. Returns log lines; unmapped services in private mode are returned as warnings.
 */
export function validatePrivateModelModeAtStartup(env: EnvLike = processEnv(), registry?: PrivateModelEndpointRegistry): { info: string[]; warnings: string[] } {
  const mode = parseModelMode(env[MODEL_MODE_ENV]);
  const resolvedRegistry = registry ?? privateModelEndpointRegistryFor(env);
  const problems: string[] = [];
  const mapped: string[] = [];
  const unmapped: PrivateModelService[] = [];
  for (const service of PRIVATE_MODEL_SERVICES) {
    const lookup = lookupPrivateServiceModel(service, { env, registry: resolvedRegistry });
    if (lookup.ok) mapped.push(`${service}=${lookup.model.modelUri}`);
    else if (lookup.unmapped) unmapped.push(service);
    else problems.push(lookup.reason);
  }
  if (mode === "private") {
    const tokenEnvs = new Set(resolvedRegistry.endpoints.map((endpoint) => endpoint.auth.tokenEnv));
    const hostedKeys = HOSTED_MODEL_PROVIDER_KEY_ENVS.filter((name) => Boolean(env[name]?.trim()) && !tokenEnvs.has(name));
    if (hostedKeys.length) problems.push(`${MODEL_MODE_ENV}=private refuses hosted model-provider credentials; unset ${hostedKeys.join(", ")}`);
  }
  if (problems.length) throw new PrivateModelModeConfigError(`private model configuration is invalid: ${problems.join("; ")}`);
  const info = [`[private-model-mode] mode=${mode} mapped=${mapped.join(",") || "-"}`];
  const warnings = mode === "private" && unmapped.length
    ? [`[private-model-mode] mode=private unmapped services are unavailable (refused, never sent to a hosted model): ${unmapped.map((service) => `${service} (${PRIVATE_SERVICE_MODEL_ENV[service]})`).join(", ")}`]
    : [];
  return { info, warnings };
}

/** Tests only: forget which invalid mappings were already logged. */
export function resetPrivateModelModeReportsForTests(): void {
  reportedInvalid.clear();
}
