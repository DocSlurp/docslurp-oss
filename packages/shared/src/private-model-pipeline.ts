import { DEFAULT_VISION_PROFILE, embeddingProfileCatalog, inferModelTarget, parseLlmModelUri, visionProfileCatalog } from "./embedding.js";
import { resolveProviderTarget } from "./privacy.js";
import { isPrivateModelUri, type PrivateModelCapability } from "./private-endpoints.js";
import { hostedModelsAllowed, MODEL_MODE_ENV, modelMode, privateServiceModel, type PrivateModelService } from "./private-model-mode.js";

type EnvLike = Record<string, string | undefined>;

function processEnv(): EnvLike {
  return (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {};
}

/** The pipeline sections a model service reads its model from; other fields pass through untouched. */
export interface PrivateModelModePipeline {
  privacyMode?: string | null;
  /** Stamped on a run's pipeline snapshot when it was created in private mode (stampRunModelMode). */
  modelMode?: string | null;
  textGeneration?: { model?: string | null; models?: Record<string, unknown> } | null;
  structuredExtraction?: { model?: string | null } | null;
  vision?: { profile?: string; modelUri?: string | null; target?: string | null; remoteFallbackModelUri?: string | null } | null;
  embedding?: {
    profile?: string; modelUri?: string | null; target?: string | null; dimensions?: number | null;
    normalize?: boolean | null; lateChunking?: boolean; task?: string | null;
  } | null;
}

type RouteKind = "hosted" | "local" | "private";

/** How a configured route would be called: local, a private route, or hosted (anything else, failing closed). */
function routeKind(modelUri: string | null | undefined, capability: PrivateModelCapability): RouteKind {
  if (!modelUri) return "hosted";
  if (isPrivateModelUri(modelUri)) return "private";
  try {
    const parsed = parseLlmModelUri(modelUri);
    return resolveProviderTarget({ provider: parsed.provider, modelUri, model: parsed.model, capability }) === "local" ? "local" : "hosted";
  } catch {
    return "hosted";
  }
}

const reportedDrops = new Set<string>();

function reportDrop(service: PrivateModelService, path: string, value: string, mapped: string | undefined): void {
  const key = `${service}\u0000${path}\u0000${value}\u0000${mapped ?? ""}`;
  if (reportedDrops.has(key)) return;
  reportedDrops.add(key);
  console.warn(`[private-model-mode] dropped ${path}=${value}: only the operator's ${service} mapping (${mapped ?? "unmapped"}) may name a private route`);
}

/**
 * What one configured route becomes where hosted models are not allowed: a local route is kept; a private route is
 * kept only when it is the service's mapped URI, else replaced by the mapping or dropped (`undefined`); a hosted
 * route is replaced by the mapping, else kept for the guard to refuse.
 */
function resolveRoute(service: PrivateModelService, path: string, value: string | null | undefined, capability: PrivateModelCapability, mapped: string | undefined): string | null | undefined {
  const kind = routeKind(value, capability);
  if (kind === "local") return value;
  if (kind === "private") {
    if (value === mapped) return value;
    reportDrop(service, path, value!, mapped);
    return mapped;
  }
  return mapped ?? value;
}

function targetOf(modelUri: string): "hosted" | "local" | "private" {
  try {
    return inferModelTarget(modelUri);
  } catch {
    return "hosted";
  }
}

function profileModelUri(catalog: Record<string, { config?: { modelUri?: string } } | undefined>, profile: string | undefined, fallbackProfile: string): string | undefined {
  return catalog[profile ?? ""]?.config?.modelUri ?? catalog[fallbackProfile]?.config?.modelUri;
}

/**
 * The effective model mode of a pipeline: `private` when the deployment runs in private mode, or when the pipeline is
 * a run snapshot stamped private at creation (so a worker whose own env says hosted still treats it as private).
 */
export function effectiveModelMode(pipeline: { modelMode?: string | null } | object | null | undefined, env: EnvLike = processEnv()): "hosted" | "private" {
  return (pipeline as { modelMode?: unknown } | null | undefined)?.modelMode === "private" ? "private" : modelMode(env);
}

/** The private-mode stamp of a stored run snapshot (raw jsonb), to carry past normalization: `{ modelMode: "private" }` or `{}`. */
export function runModelModeStamp(stored: unknown): { modelMode?: "private" } {
  return stored && typeof stored === "object" && (stored as { modelMode?: unknown }).modelMode === "private" ? { modelMode: "private" } : {};
}

/** The run snapshot to store: stamped `modelMode: "private"` when the deployment runs in private mode. */
export function stampRunModelMode<T extends object>(pipeline: T, env: EnvLike = processEnv()): T & { modelMode?: "private" } {
  return modelMode(env) === "private" ? { ...pipeline, modelMode: "private" as const } : pipeline;
}

/**
 * The pipeline a run or search uses under the effective model mode (private-model-mode.ts). Where hosted models are
 * allowed it is returned unchanged. Otherwise each service's model comes from the operator's env map, never from the
 * project, an admin override or an old run snapshot:
 *
 * - text (`DOCSLURP_PRIVATE_TEXT_MODEL`) replaces the text and structured-extraction models;
 * - vision (`DOCSLURP_PRIVATE_VISION_MODEL`) replaces the vision route; a hosted fallback is dropped;
 * - embedding (`DOCSLURP_PRIVATE_EMBEDDING_MODEL`) replaces the embedding route, with the registry's dimensions and
 *   none of the hosted profile's settings (normalized vectors, no late chunking). The index config identity names the
 *   private model, so an index built with another model is never mixed with it (config-change.ts).
 *
 * A local route is kept: it sends nothing out, and swapping it for a remote endpoint would widen egress. A stored
 * private route that is not the service's mapped URI is dropped (logged), so no other alias is reachable. An unmapped
 * service keeps its hosted route, which the privacy guard refuses (fail closed). A run snapshot stamped private is
 * treated as private whatever this process's env says: its `standard` privacy mode reads as `local-only`, so every
 * guard refuses hosted calls.
 *
 * Apply where a run or search consumes a pipeline, never before persisting one, so a project row keeps only its level.
 */
export function applyPrivateModelMode<T extends PrivateModelModePipeline>(pipeline: T, env: EnvLike = processEnv()): T {
  const stampedPrivate = pipeline.modelMode === "private" && modelMode(env) !== "private";
  const effectiveEnv = stampedPrivate ? { ...env, [MODEL_MODE_ENV]: "private" } : env;
  if (hostedModelsAllowed(pipeline.privacyMode, effectiveEnv)) return pipeline;
  let next: T = stampedPrivate && (pipeline.privacyMode ?? "standard") === "standard" ? { ...pipeline, privacyMode: "local-only" } : pipeline;

  const text = privateServiceModel("text", effectiveEnv)?.modelUri;
  if (next.textGeneration) {
    const models = Object.fromEntries(Object.entries(next.textGeneration.models ?? {}).flatMap(([operation, value]) => {
      const resolved = resolveRoute("text", `textGeneration.models.${operation}`, typeof value === "string" ? value : null, "text", text);
      // A per-task override yields to the default once the mapped model replaces it.
      return resolved && resolved !== text ? [[operation, resolved]] : [];
    }));
    const stored = next.textGeneration.model;
    const model = stored || text ? resolveRoute("text", "textGeneration.model", stored, "text", text) ?? null : stored ?? null;
    next = { ...next, textGeneration: { ...next.textGeneration, model, models } };
  }
  if (next.structuredExtraction && (next.structuredExtraction.model || text)) {
    next = { ...next, structuredExtraction: { ...next.structuredExtraction, model: resolveRoute("text", "structuredExtraction.model", next.structuredExtraction.model, "text", text) ?? null } };
  }

  const vision = privateServiceModel("vision", effectiveEnv)?.modelUri;
  if (next.vision) {
    const profileUri = profileModelUri(visionProfileCatalog as never, next.vision.profile, DEFAULT_VISION_PROFILE);
    const current = next.vision.modelUri ?? profileUri;
    const modelUri = resolveRoute("vision", "vision.modelUri", current, "vision", vision) ?? profileUri;
    const fallback = next.vision.remoteFallbackModelUri;
    const fallbackKind = fallback ? routeKind(fallback, "vision") : null;
    const keepFallback = !fallback || fallbackKind === "local" || (fallbackKind === "private" && fallback === vision);
    if (fallback && !keepFallback && fallbackKind === "private") reportDrop("vision", "vision.remoteFallbackModelUri", fallback, vision);
    if ((modelUri && modelUri !== next.vision.modelUri) || !keepFallback) {
      next = {
        ...next,
        vision: {
          ...next.vision,
          ...(modelUri ? { modelUri, target: targetOf(modelUri) } : {}),
          ...(!keepFallback ? { remoteFallbackModelUri: null } : {}),
        },
      };
    }
  }

  const embedding = privateServiceModel("embedding", effectiveEnv)?.modelUri;
  if (next.embedding) {
    const profileUri = profileModelUri(embeddingProfileCatalog as never, next.embedding.profile, "cheapest-hosted");
    const current = next.embedding.modelUri ?? profileUri;
    const resolved = resolveRoute("embedding", "embedding.modelUri", current, "embedding", embedding);
    if (embedding && resolved === embedding && current !== embedding) {
      const { dimensions: _registryDecides, task: _task, ...rest } = next.embedding;
      next = { ...next, embedding: { ...rest, modelUri: embedding, target: "private", normalize: true, lateChunking: false } };
    } else if (resolved === undefined && profileUri) {
      // A private route other than the mapped one, with no mapping to replace it: back to the profile's own route.
      const { dimensions: _dropped, ...rest } = next.embedding;
      next = { ...next, embedding: { ...rest, modelUri: profileUri, target: targetOf(profileUri) } };
    }
  }
  return next;
}

/** Tests only. */
export function resetPrivateModelPipelineReportsForTests(): void {
  reportedDrops.clear();
}
