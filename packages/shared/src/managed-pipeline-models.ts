/**
 * Managed pipeline model fields. Customers configure categories (pipeline.quality, embedding.profile,
 * vision.profile, inferenceLane, retrieval `reranker`); the backend model, host or provider behind a category is a
 * managed setting. Platform admins may still set these fields (an internal path); the public API refuses them on write
 * and omits them on read. Usage events, traces and logs keep the concrete ids.
 */
import { z } from "zod";

import { DEFAULT_VISION_PROFILE, embeddingProfileCatalog, visionProfileCatalog } from "./embedding.js";
import { pipelineFeatureOverridesSchema } from "./pipeline.js";

/** Dotted paths under `pipeline` that name a backend model, provider or route. */
export const MANAGED_PIPELINE_MODEL_PATHS = [
  "textGeneration.model",
  "textGeneration.models",
  "structuredExtraction.model",
  "embedding.modelUri",
  "embedding.target",
  "vision.modelUri",
  "vision.target",
  "vision.remoteFallbackModelUri",
  "visualPages.route",
] as const;
export type ManagedPipelineModelPath = (typeof MANAGED_PIPELINE_MODEL_PATHS)[number];

/** The categories a refusal points callers to. */
export const MANAGED_PIPELINE_CATEGORY_HINT = "pipeline.quality (fast, auto, good), pipeline.embedding.profile, pipeline.vision.profile and pipeline.inferenceLane";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readPath(root: unknown, path: string): { present: boolean; value: unknown } {
  const [head, key] = path.split(".") as [string, string];
  const parent = record(record(root)?.[head]);
  return parent && Object.hasOwn(parent, key) ? { present: true, value: parent[key] } : { present: false, value: undefined };
}

/** The model URI and target a profile already implies (the schema fills them in), for the raw section's profile. */
function profileDefaults(rawPipeline: unknown, head: string): { modelUri?: string; target?: string } | undefined {
  const section = record(record(rawPipeline)?.[head]);
  if (head === "embedding") {
    const profile = typeof section?.profile === "string" ? section.profile : "cheapest-hosted";
    return embeddingProfileCatalog[profile as keyof typeof embeddingProfileCatalog]?.config;
  }
  if (head === "vision") {
    const profile = typeof section?.profile === "string" ? section.profile : DEFAULT_VISION_PROFILE;
    return visionProfileCatalog[profile as keyof typeof visionProfileCatalog]?.config;
  }
  return undefined;
}

/**
 * True when a raw field value actually chooses something. Null, `{}`, the `auto` route, and a model URI or target
 * equal to what the section's profile already implies (a normalized pipeline read back and saved) choose nothing.
 */
function chooses(rawPipeline: unknown, path: ManagedPipelineModelPath, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (path === "textGeneration.models") return Object.keys(record(value) ?? {}).length > 0;
  if (path === "visualPages.route") return value !== "auto";
  const [head, key] = path.split(".") as [string, string];
  const defaults = profileDefaults(rawPipeline, head);
  if (defaults && (key === "modelUri" || key === "target") && defaults[key] === value) return false;
  return true;
}

/**
 * The managed fields a raw (unparsed) pipeline input sets, as `pipeline.<path>`. Read from the request body before
 * schema defaults fill model URIs in from the profile, so a profile-only change is never mistaken for a model choice.
 */
export function managedPipelineModelPaths(rawPipeline: unknown): string[] {
  return MANAGED_PIPELINE_MODEL_PATHS
    .filter(path => { const { present, value } = readPath(rawPipeline, path); return present && chooses(rawPipeline, path, value); })
    .map(path => `pipeline.${path}`);
}

export function managedPipelineFieldMessage(paths: readonly string[]): string {
  return `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} managed by DocSlurp. Choose a category instead: ${MANAGED_PIPELINE_CATEGORY_HINT}.`;
}

type PipelineLike = Record<string, unknown>;

/**
 * Copy the stored managed fields onto a pipeline a customer just saved (whose schema defaults refilled them from the
 * profiles), except the paths in `explicit` (set by a platform admin in this request). An embedding or vision model
 * URI is carried only when it was an explicit override of the stored profile's default and the profile is unchanged:
 * otherwise the new profile's default applies.
 */
export function carryManagedPipelineFields<T extends PipelineLike>(next: T, stored: PipelineLike | null | undefined, explicit: ReadonlySet<string> = new Set()): T {
  if (!stored) return next;
  const out: PipelineLike = { ...next };
  const section = (name: string) => { const value = { ...(record(out[name]) ?? {}) }; out[name] = value; return value; };
  const keep = (path: ManagedPipelineModelPath) => !explicit.has(`pipeline.${path}`);
  const storedText = record(stored.textGeneration);
  if (storedText && (keep("textGeneration.model") || keep("textGeneration.models"))) {
    const text = section("textGeneration");
    if (keep("textGeneration.model")) text.model = storedText.model ?? null;
    if (keep("textGeneration.models")) text.models = storedText.models ?? {};
  }
  const storedStructured = record(stored.structuredExtraction);
  if (storedStructured && keep("structuredExtraction.model")) section("structuredExtraction").model = storedStructured.model ?? null;
  const storedVisual = record(stored.visualPages);
  if (storedVisual && keep("visualPages.route") && typeof storedVisual.route === "string") section("visualPages").route = storedVisual.route;
  const storedEmbedding = record(stored.embedding);
  const nextEmbedding = record(out.embedding);
  if (storedEmbedding && nextEmbedding && keep("embedding.modelUri") && nextEmbedding.profile === storedEmbedding.profile) {
    const defaults = embeddingProfileCatalog[storedEmbedding.profile as keyof typeof embeddingProfileCatalog]?.config;
    if (typeof storedEmbedding.modelUri === "string" && storedEmbedding.modelUri !== defaults?.modelUri) {
      const embedding = section("embedding");
      embedding.modelUri = storedEmbedding.modelUri;
      if (storedEmbedding.target !== undefined) embedding.target = storedEmbedding.target;
    }
  }
  const storedVision = record(stored.vision);
  const nextVision = record(out.vision);
  if (storedVision && nextVision) {
    const vision = section("vision");
    if (keep("vision.modelUri") && nextVision.profile === storedVision.profile) {
      const defaults = visionProfileCatalog[storedVision.profile as keyof typeof visionProfileCatalog]?.config;
      if (typeof storedVision.modelUri === "string" && storedVision.modelUri !== defaults?.modelUri) {
        vision.modelUri = storedVision.modelUri;
        if (storedVision.target !== undefined) vision.target = storedVision.target;
      }
    }
    if (keep("vision.remoteFallbackModelUri")) vision.remoteFallbackModelUri = storedVision.remoteFallbackModelUri ?? null;
  }
  return out as T;
}

/** A pipeline as customers read it: managed model, provider and route fields removed. */
export function customerPipelineView<T>(pipeline: T): T {
  const source = record(pipeline);
  if (!source) return pipeline;
  const out: PipelineLike = { ...source };
  for (const path of MANAGED_PIPELINE_MODEL_PATHS) {
    const [head, key] = path.split(".") as [string, string];
    const parent = record(out[head]);
    if (!parent || !Object.hasOwn(parent, key)) continue;
    const { [key]: _removed, ...rest } = parent;
    out[head] = rest;
  }
  return out as T;
}

/**
 * Pipeline overrides as public requests send them (uploads, extracts): a managed model, provider or route field is
 * refused with the categories to use instead, before the overrides are parsed.
 */
export const publicPipelineFeatureOverridesSchema = z.unknown().superRefine((value, ctx) => {
  const paths = managedPipelineModelPaths(value);
  if (paths.length) ctx.addIssue({ code: "custom", message: managedPipelineFieldMessage(paths), params: { code: "model_not_allowed", paths } });
}).pipe(pipelineFeatureOverridesSchema);
