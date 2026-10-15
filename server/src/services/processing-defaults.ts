/**
 * A user's "Processing defaults" (Settings > General) seed the workspaces that
 * Workspace Intake creates for them. They never change existing workspaces:
 * once a workspace exists its own pipeline and search settings win.
 *
 * Applied keys and their meaning:
 * - enableGraphRag      -> pipeline.graphRag (knowledge graph built at ingest)
 * - enableSummarization -> pipeline.summarize
 * - contextualChunking  -> pipeline.contextualChunkPreambles
 * - piiReviewMode       -> pipeline.piiPolicy enabled with flag_for_review
 * - defaultAnswerStyle  -> searchSettings.chat.answerStyle
 *
 * Opt-in toggles only switch a feature on; a template or upload override that
 * already enables it is left alone. Template locks are re-applied afterwards.
 */
import {
  type PipelineFeatures,
  type WorkspaceSearchSettings,
} from "@docslurp/shared";

import type { UserGeneralSettings } from "./user-settings.js";

export type ProcessingDefaults = Partial<UserGeneralSettings> | null | undefined;

export function seedPipelineFromProcessingDefaults(
  base: PipelineFeatures,
  defaults: ProcessingDefaults,
): PipelineFeatures {
  if (!defaults) return base;
  const next: PipelineFeatures = { ...base, piiPolicy: { ...base.piiPolicy } };
  if (defaults.enableGraphRag && next.embed) next.graphRag = true;
  if (defaults.enableSummarization) next.summarize = true;
  if (defaults.contextualChunking === false) next.contextualChunkPreambles = false;
  if (defaults.piiReviewMode && !next.piiPolicy.enabled) {
    next.piiPolicy = { ...next.piiPolicy, enabled: true, action: "flag_for_review" };
  }
  return next;
}

/** The search-settings patch a new workspace gets, or null when nothing differs from the defaults. */
export function seedSearchSettingsFromProcessingDefaults(
  defaults: ProcessingDefaults,
): { chat: Partial<WorkspaceSearchSettings["chat"]> } | null {
  const answerStyle = defaults?.defaultAnswerStyle;
  if (!answerStyle || answerStyle === "balanced") return null;
  return { chat: { answerStyle } };
}
