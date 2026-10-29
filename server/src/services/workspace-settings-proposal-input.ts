import { z } from "zod";
import { migrateLegacyQualitySettings, qualityModeSchema, updateWorkspaceSearchChatSettingsSchema, updateWorkspaceSearchRetrievalDefaultsSchema } from "@docslurp/shared";

/** A retired `vision: { forceAllPages }` patch (older ingest-report recommendations) arrives as `quality`. */
function migrateLegacyPatch(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const vision = (value as { vision?: unknown }).vision;
  const hadLegacyVision = !!vision && typeof vision === "object" && "forceAllPages" in vision;
  const migrated = migrateLegacyQualitySettings(value) as Record<string, unknown>;
  if (!hadLegacyVision) return migrated;
  const { vision: rest, ...others } = migrated;
  return rest && typeof rest === "object" && Object.keys(rest).length === 0 ? others : migrated;
}

const workspaceSettingsPipelinePatchObjectSchema = z.object({
  mediaVideo: z.object({ enabled: z.boolean() }).strict().optional(),
  chunkOverlap: z.boolean().optional(),
  summarize: z.boolean().optional(), embed: z.boolean().optional(), indexVectors: z.boolean().optional(),
  preserveTables: z.boolean().optional(), preserveCode: z.boolean().optional(), preserveImages: z.boolean().optional(),
  pdfRegionExtraction: z.boolean().optional(), visionFallback: z.boolean().optional(),
  /** Processing quality (fast / auto / good): the setting the ingest report's vision recommendations change. */
  quality: qualityModeSchema.optional(),
}).strict();
export const workspaceSettingsPipelinePatchSchema = Object.assign(
  z.preprocess(migrateLegacyPatch, workspaceSettingsPipelinePatchObjectSchema),
  { shape: workspaceSettingsPipelinePatchObjectSchema.shape },
);
export const workspaceSettingsProposalInputSchema = z.object({
  workspace: z.string().min(1).optional(),
  changes: z.object({
    pipeline: workspaceSettingsPipelinePatchSchema.optional(),
    chat: updateWorkspaceSearchChatSettingsSchema.strict().optional(),
    retrieval: updateWorkspaceSearchRetrievalDefaultsSchema.pick({ resultCount: true, useRerank: true, useMmr: true, mmrLambda: true, candidateDepth: true, resultOrder: true }).strict().optional(),
  }).strict(),
}).strict();
