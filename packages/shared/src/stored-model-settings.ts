import { embeddingModelCatalogByUri, visionModelCatalog } from "./embedding.js";

const profileRenames: Record<string, string> = {
  balanced: "good-fast-local",
  multilingual: "multilingual-local",
  "high-recall": "cheapest-hosted",
  "code-search": "code-local",
  "cheap-fast": "cheapest-local",
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Convert known persisted settings; incoming API schemas remain strict. */
export function migrateStoredModelSettings<T>(source: T): T {
  const pipeline = record(source);
  if (!pipeline) return source;
  const result = { ...pipeline };
  const extraction = record(pipeline.documentExtraction);
  if (extraction?.pages === null) result.documentExtraction = { ...extraction, pages: [] };
  const embedding = record(pipeline.embedding);
  if (embedding) {
    const next = { ...embedding };
    if (typeof next.profile === "string" && Object.hasOwn(profileRenames, next.profile)) {
      next.profile = profileRenames[next.profile];
    }
    if ("model" in next) {
      const route = Object.entries(embeddingModelCatalogByUri).find(([, spec]) => spec.model === next.model);
      if (!route) throw new Error("Stored embedding model requires an explicit model route");
      next.modelUri ??= route[0];
      next.target ??= route[1].target;
      // Old settings stored native dimensions even for models that cannot resize.
      if (next.dimensions === route[1].dimensions) delete next.dimensions;
      delete next.model;
      delete next.runtime;
      delete next.provider;
      delete next.batchSize;
    }
    result.embedding = next;
  }
  const vision = record(pipeline.vision);
  if (vision && "model" in vision) {
    const next = { ...vision };
    const route = visionModelCatalog.find((spec) => spec.id === next.model);
    if (!route) throw new Error("Stored vision model requires an explicit model route");
    next.modelUri ??= route.uri;
    next.target ??= route.target;
    if (typeof next.baseUrl === "string" && next.baseUrl) {
      const baseUrl = new URL(next.baseUrl);
      if (route.target === "local") {
        const uri = new URL(String(next.modelUri));
        uri.searchParams.set("baseUrl", baseUrl.href);
        next.modelUri = uri.href;
      } else if (baseUrl.href.replace(/\/$/, "") !== "https://openrouter.ai/api/v1" || !route.uri.startsWith("llm://openrouter/")) {
        throw new Error("Stored hosted vision endpoint requires an explicit model route");
      }
    }
    if (next.remoteFallbackModel !== undefined && next.remoteFallbackModel !== null) {
      const fallback = visionModelCatalog.find((spec) => spec.id === next.remoteFallbackModel);
      if (!fallback) throw new Error("Stored vision fallback requires an explicit model route");
      next.remoteFallbackModelUri ??= fallback.uri;
    }
    delete next.model;
    delete next.runtime;
    delete next.baseUrl;
    delete next.remoteFallbackModel;
    result.vision = next;
  }
  return result as T;
}
