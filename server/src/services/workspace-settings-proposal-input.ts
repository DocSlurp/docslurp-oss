import { z } from "zod";
import { updateWorkspaceSearchChatSettingsSchema, updateWorkspaceSearchRetrievalDefaultsSchema } from "@docslurp/shared";
export const workspaceSettingsPipelinePatchSchema = z.object({
  mediaVideo: z.object({ enabled: z.boolean() }).strict().optional(),
  chunkOverlap: z.boolean().optional(),
  summarize: z.boolean().optional(), embed: z.boolean().optional(), indexVectors: z.boolean().optional(),
  preserveTables: z.boolean().optional(), preserveCode: z.boolean().optional(), preserveImages: z.boolean().optional(),
  pdfRegionExtraction: z.boolean().optional(), visionFallback: z.boolean().optional(),
  /** Which pages vision reads: the pair the ingest report's vision recommendations change. */
  vision: z.object({
    forceAllPages: z.boolean().optional(),
    maxPagesPerDocument: z.number().int().min(1).max(32).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, { message: "Provide forceAllPages or maxPagesPerDocument" }).optional(),
}).strict();
export const workspaceSettingsProposalInputSchema = z.object({
  workspace: z.string().min(1).optional(),
  changes: z.object({
    pipeline: workspaceSettingsPipelinePatchSchema.optional(),
    chat: updateWorkspaceSearchChatSettingsSchema.strict().optional(),
    retrieval: updateWorkspaceSearchRetrievalDefaultsSchema.pick({ resultCount: true, useRerank: true, useMmr: true, mmrLambda: true, candidateDepth: true, resultOrder: true }).strict().optional(),
  }).strict(),
}).strict();
