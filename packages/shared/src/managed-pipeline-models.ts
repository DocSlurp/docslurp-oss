/**
 * Managed pipeline model fields. Customers configure categories (pipeline.quality, embedding.profile,
 * vision.profile, inferenceLane, pageRouter.router, retrieval `reranker`); the backend model, host or provider behind
 * a category is a managed setting. The public API refuses these fields on write and omits them on read. Usage
 * events, traces and logs keep the concrete ids.
 *
 * Explicit overrides only: a backend model a platform admin chose lives in `projects.managed_models.pipeline`
 * (ManagedPipelineOverrides), written only by the admin route. Every other stored model value is legacy or a former
 * default and is dropped (resolveManagedPipeline), so the current profile and deployment defaults always apply and a
 * future default change reaches every project. Nothing is inferred from "differs from today's default".
 */
import { z } from "zod";

import { DEFAULT_VISION_PROFILE, embeddingProfileCatalog, visionProfileCatalog } from "./embedding.js";
import {
  DEFAULT_PAGE_ROUTER_DECISION_MODELS,
  normalizeStoredPipelineFeatures,
  pipelineFeatureOverridesSchema,
  type PipelineFeatures,
} from "./pipeline.js";

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
  "pageRouter.decisionModel",
  // Removed by the chart-export free tier change (#363); managed here until then so neither PR leaves it open.
  "chartExport.generatorModel",
] as const;
export type ManagedPipelineModelPath = (typeof MANAGED_PIPELINE_MODEL_PATHS)[number];

/** The categories a refusal points callers to. */
export const MANAGED_PIPELINE_CATEGORY_HINT = "pipeline.quality (fast, auto, good), pipeline.embedding.profile, pipeline.vision.profile, pipeline.pageRouter.router and pipeline.inferenceLane";

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

function sameList(value: unknown, list: readonly string[]): boolean {
  return Array.isArray(value) && value.length === list.length && value.every((item, index) => item === list[index]);
}

/**
 * True when a raw field value actually chooses something. Null, `{}`, the `auto` route, the default decision-model
 * list, and a model URI or target equal to what the section's profile already implies (a normalized pipeline read
 * back and saved) choose nothing.
 */
function chooses(rawPipeline: unknown, path: ManagedPipelineModelPath, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (path === "textGeneration.models") return Object.keys(record(value) ?? {}).length > 0;
  if (path === "visualPages.route") return value !== "auto";
  if (path === "pageRouter.decisionModel") return !sameList(value, DEFAULT_PAGE_ROUTER_DECISION_MODELS);
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

/** A pipeline without any managed field: what is left is the customer's categories and settings. */
export function stripManagedPipelineFields<T>(pipeline: T): T {
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

/** A pipeline as customers read it: managed model, provider and route fields removed. */
export const customerPipelineView = stripManagedPipelineFields;

const overrideModelRef = z.string().trim().min(1).max(220);

/**
 * Backend models a platform admin chose for one project (projects.managed_models.pipeline). The only source of a
 * managed pipeline value; written only by the admin route, which vets each model (server managed-models.ts).
 */
export const managedPipelineOverridesSchema = z.object({
  textGeneration: z.object({ model: overrideModelRef.optional(), models: z.record(z.string(), overrideModelRef).optional() }).strict().optional(),
  structuredExtraction: z.object({ model: overrideModelRef.optional() }).strict().optional(),
  vision: z.object({ modelUri: overrideModelRef.optional(), remoteFallbackModelUri: overrideModelRef.optional() }).strict().optional(),
  embedding: z.object({ modelUri: overrideModelRef.optional() }).strict().optional(),
  pageRouter: z.object({ decisionModel: z.array(overrideModelRef).min(1).max(8).optional() }).strict().optional(),
}).strict();
export type ManagedPipelineOverrides = z.infer<typeof managedPipelineOverridesSchema>;

type OverrideEntry = { section: string; key: string; value: unknown };

function overrideEntries(overrides: ManagedPipelineOverrides | null | undefined): OverrideEntry[] {
  const entries: OverrideEntry[] = [];
  for (const [section, fields] of Object.entries(overrides ?? {})) {
    for (const [key, value] of Object.entries(record(fields) ?? {})) {
      if (value !== undefined) entries.push({ section, key, value });
    }
  }
  return entries;
}

function overlay(base: PipelineLike, entries: readonly OverrideEntry[]): PipelineLike {
  const out: PipelineLike = { ...base };
  for (const { section, key, value } of entries) out[section] = { ...(record(out[section]) ?? {}), [key]: value };
  return out;
}

/** Parses stored overrides; an unreadable value counts as none (logged), never as a model choice. */
export function parseManagedPipelineOverrides(value: unknown, source: string): ManagedPipelineOverrides | null {
  if (value === null || value === undefined) return null;
  const parsed = managedPipelineOverridesSchema.safeParse(value);
  if (parsed.success) return Object.keys(parsed.data).length ? parsed.data : null;
  console.error(`[managed-models] unreadable managed pipeline overrides for ${source}; ignored`);
  return null;
}

export type ResolvedManagedPipeline = {
  /** The effective, validated pipeline: stored categories + explicit overrides + current defaults. */
  pipeline: PipelineFeatures;
  /** The overrides that survived validation, as dotted paths. */
  applied: string[];
  /** Overrides that conflict with the rest of the pipeline (a hosted fallback under local-only, say), dropped. */
  dropped: string[];
};

/**
 * The effective pipeline for a stored project or run pipeline: every managed field it holds is dropped, the explicit
 * overrides are applied, and the result is validated. An override that makes the pipeline invalid (privacy mode,
 * template, catalog) is dropped and logged, failing closed toward the stricter customer setting.
 */
export function resolveManagedPipeline(
  stored: unknown,
  overrides: ManagedPipelineOverrides | null | undefined,
  source: string,
): ResolvedManagedPipeline {
  const base = stripManagedPipelineFields(record(stored) ?? {}) as PipelineLike;
  const entries = overrideEntries(overrides);
  const attempt = (kept: readonly OverrideEntry[]) => normalizeStoredPipelineFeatures(overlay(base, kept) as never, source);
  const label = (entry: OverrideEntry) => `${entry.section}.${entry.key}`;
  if (entries.length === 0) return { pipeline: attempt([]), applied: [], dropped: [] };
  try {
    return { pipeline: attempt(entries), applied: entries.map(label), dropped: [] };
  } catch {
    const kept: OverrideEntry[] = [];
    const dropped: string[] = [];
    for (const entry of entries) {
      try {
        attempt([...kept, entry]);
        kept.push(entry);
      } catch {
        dropped.push(label(entry));
      }
    }
    console.warn(`[managed-models] dropped overrides for ${source} that conflict with its pipeline: ${dropped.join(", ")}`);
    return { pipeline: attempt(kept), applied: kept.map(label), dropped };
  }
}

/**
 * What a project row stores: the effective pipeline without any managed field, plus the overrides that applied. Readers
 * that query `projects.pipeline` directly then see the overrides, and the schema fills current defaults for the rest.
 */
export function storedManagedPipeline(
  effective: PipelineFeatures,
  overrides: ManagedPipelineOverrides | null | undefined,
  applied: readonly string[],
): PipelineLike {
  const keep = new Set(applied);
  const entries = overrideEntries(overrides).filter(entry => keep.has(`${entry.section}.${entry.key}`));
  return overlay(stripManagedPipelineFields(JSON.parse(JSON.stringify(effective)) as PipelineLike), entries);
}

/**
 * Pipeline overrides as public requests send them (uploads, extracts): a managed model, provider or route field is
 * refused with the categories to use instead, before the overrides are parsed.
 */
export const publicPipelineFeatureOverridesSchema = z.unknown().superRefine((value, ctx) => {
  const paths = managedPipelineModelPaths(value);
  if (paths.length) ctx.addIssue({ code: "custom", message: managedPipelineFieldMessage(paths), params: { code: "model_not_allowed", paths } });
}).pipe(pipelineFeatureOverridesSchema);
