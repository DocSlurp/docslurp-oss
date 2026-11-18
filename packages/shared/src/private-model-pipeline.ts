import { embeddingProfileCatalog, parseLlmModelUri, visionProfileCatalog } from "./embedding.js";
import { resolveProviderTarget } from "./privacy.js";
import type { PrivateModelCapability } from "./private-endpoints.js";
import { hostedModelsAllowed, privateServiceModel } from "./private-model-mode.js";

type EnvLike = Record<string, string | undefined>;

/** The pipeline sections a model service reads its model from; other fields pass through untouched. */
export interface PrivateModelModePipeline {
  privacyMode?: string | null;
  textGeneration?: { model?: string | null; models?: Record<string, unknown> } | null;
  structuredExtraction?: { model?: string | null } | null;
  vision?: { profile?: string; modelUri?: string | null; target?: string | null; remoteFallbackModelUri?: string | null } | null;
  embedding?: { profile?: string; modelUri?: string | null; target?: string | null; dimensions?: number | null } | null;
}

/** True when a configured route would be blocked as hosted: not local, and not a registered private route. */
function routeIsHosted(modelUri: string | null | undefined, capability: PrivateModelCapability): boolean {
  if (!modelUri) return true;
  try {
    return resolveProviderTarget({ provider: parseLlmModelUri(modelUri).provider, modelUri, model: parseLlmModelUri(modelUri).model, capability }) === "hosted";
  } catch {
    return true;
  }
}

/**
 * The pipeline a run or search uses under the deployment's model mode (private-model-mode.ts). Where hosted models are
 * allowed it is returned unchanged. Otherwise each service's model comes from the operator's env map, never from the
 * project:
 *
 * - text (`DOCSLURP_PRIVATE_TEXT_MODEL`) replaces the text and structured-extraction models;
 * - vision (`DOCSLURP_PRIVATE_VISION_MODEL`) replaces a vision route that would be hosted, and drops a hosted fallback;
 * - embedding (`DOCSLURP_PRIVATE_EMBEDDING_MODEL`) replaces an embedding route that would be hosted. The registry's
 *   declared dimensions decide the vector size, and the index config identity names the private model, so an index
 *   built with another model is never mixed with it (config-change.ts).
 *
 * A local route (local embeddings, a local vision CLI or loopback server) is kept: it already sends nothing out, and
 * swapping it for a remote endpoint would widen egress. An unmapped service is left as configured: the privacy guard
 * refuses its hosted calls (fail closed). Apply where a run or search consumes a pipeline, never before persisting
 * one, so a project row keeps only its level.
 */
export function applyPrivateModelMode<T extends PrivateModelModePipeline>(pipeline: T, env?: EnvLike): T {
  if (hostedModelsAllowed(pipeline.privacyMode, env)) return pipeline;
  let next: T = pipeline;
  const text = privateServiceModel("text", env);
  if (text) {
    next = {
      ...next,
      ...(next.textGeneration ? { textGeneration: { ...next.textGeneration, model: text.modelUri, models: {} } } : {}),
      ...(next.structuredExtraction ? { structuredExtraction: { ...next.structuredExtraction, model: text.modelUri } } : {}),
    };
  }
  const vision = privateServiceModel("vision", env);
  if (vision && next.vision) {
    const profileUri = (visionProfileCatalog as Record<string, { config?: { modelUri?: string } } | undefined>)[next.vision.profile ?? ""]?.config?.modelUri;
    const replaceMain = routeIsHosted(next.vision.modelUri ?? profileUri, "vision");
    const fallback = next.vision.remoteFallbackModelUri;
    const dropFallback = Boolean(fallback) && routeIsHosted(fallback, "vision");
    if (replaceMain || dropFallback) {
      next = {
        ...next,
        vision: {
          ...next.vision,
          ...(replaceMain ? { modelUri: vision.modelUri, target: "private" } : {}),
          ...(dropFallback ? { remoteFallbackModelUri: null } : {}),
        },
      };
    }
  }
  const embedding = privateServiceModel("embedding", env);
  const embeddingProfileUri = (embeddingProfileCatalog as Record<string, { config?: { modelUri?: string } } | undefined>)[next.embedding?.profile ?? ""]?.config?.modelUri;
  if (embedding && next.embedding && routeIsHosted(next.embedding.modelUri ?? embeddingProfileUri, "embedding")) {
    const { dimensions: _registryDecides, ...rest } = next.embedding;
    next = { ...next, embedding: { ...rest, modelUri: embedding.modelUri, target: "private" } };
  }
  return next;
}
