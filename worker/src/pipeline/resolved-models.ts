import { embeddingRouteSpaceUri, modelClassLabel, modelRecordUri, resolveAllowedPipelineTextModel, resolveAllowedStructuredExtractionModel } from "@docslurp/shared";

import type { Config } from "../config.js";
import { resolveEmbeddingModel } from "../embeddings/resolver.js";
import { textUsageLabels } from "../lib/text-model-route.js";
import type { ProjectRun } from "../models.js";
import { configuredVisionServedRoute } from "../tools/vision-runtime.js";

/** One service's model for a run: the `llm://` URI and the level that selected it. */
export interface ResolvedRunModel {
  uri: string;
  class?: string;
}

/**
 * The models that serve a run, per service, as this deployment resolves the run's levels (the project's pipeline and
 * the environment's model settings) when the run starts: `project_runs.resolved_models`. A run that resumes on a
 * newer release keeps the map it started with; each call's usage row still names the model that actually ran.
 *
 * Services this run does not use are omitted, and so is one whose model cannot be resolved here (a missing route, a
 * model the automatic-selection policy refuses): the map says what would serve, it never fails the run.
 */
export function resolvedRunModels(config: Config, pipeline: ProjectRun["pipeline"]): Record<string, ResolvedRunModel> {
  const out: Record<string, ResolvedRunModel> = {};
  const add = (service: string, resolve: () => { uri: string | null; class?: Record<string, string | undefined> } | null) => {
    try {
      const resolved = resolve();
      if (!resolved?.uri) return;
      const label = modelClassLabel(resolved.class ?? null);
      out[service] = label ? { uri: resolved.uri, class: label } : { uri: resolved.uri };
    } catch {
      // Not resolvable on this deployment: the call that would use it fails or records its own model.
    }
  };
  const text = (model: string) => modelRecordUri(textUsageLabels(model));

  add("text", () => ({ uri: text(resolveAllowedPipelineTextModel(pipeline, "document-summary", config.textGenerationModel)) }));
  add("structuredExtraction", () => ({ uri: text(resolveAllowedStructuredExtractionModel(pipeline, config.textGenerationModel)) }));
  if (pipeline.vision) {
    add("vision", () => {
      const route = configuredVisionServedRoute(pipeline.vision!, config);
      return { uri: modelRecordUri({ provider: route.provider, model: route.model }), class: { visionProfile: pipeline.vision?.profile, quality: pipeline.quality } };
    });
  }
  if (pipeline.embedding) {
    add("embedding", () => {
      const profile = resolveEmbeddingModel(config, pipeline);
      return { uri: embeddingRouteSpaceUri(profile, profile.dimensions), class: { embeddingProfile: profile.profile } };
    });
  }
  return out;
}
