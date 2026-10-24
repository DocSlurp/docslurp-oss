import { z } from "zod";
import { costEstimateSchema } from "./jobs.js";
import { configChangeKindSchema } from "./config-change-kind.js";

/** Server-authenticated proposal data; never infer an apply action from assistant prose. */
export const workspaceSettingsProposalSchema = z.object({
  token: z.string().min(1).max(32768),
  workspaceId: z.string(),
  expiresAt: z.string().datetime(),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  changes: z.array(z.object({ key: z.string(), label: z.string(), before: z.unknown(), after: z.unknown() })),
  impact: z.object({ kind: configChangeKindSchema, stages: z.array(z.string()),
    reasons: z.array(z.object({ field: z.string(), effect: z.string() })),
    documents: z.number().int().nonnegative(), pages: z.number().int().nonnegative() }),
  estimate: costEstimateSchema.nullable(),
  reprocessAvailable: z.boolean(),
  reprocessRequired: z.boolean(),
});
export type WorkspaceSettingsProposal = z.infer<typeof workspaceSettingsProposalSchema>;

export const applyWorkspaceSettingsProposalSchema = z.object({
  token: z.string().min(1).max(32768), reprocessExisting: z.boolean().default(false),
}).strict();

