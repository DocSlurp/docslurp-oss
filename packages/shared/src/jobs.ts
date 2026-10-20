import { z } from "zod";

export const jobKindSchema = z.enum(["reindex", "full-index", "backfill", "graph-rebuild", "reprocess"]);
export type JobKind = z.infer<typeof jobKindSchema>;

export const jobStateSchema = z.enum(["queued", "blocked", "processing", "completed", "failed", "cancelled"]);

/**
 * Work estimate. With billing disabled (self-hosted) `credits` is null and nothing is ever priced;
 * pages and time still apply.
 */
export const costEstimateSchema = z.object({
  pages: z.number().nonnegative(),
  documents: z.number().nonnegative(),
  billing: z.enum(["enforced", "disabled"]),
  credits: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }).nullable(),
  seconds: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }).nullable(),
  basis: z.string(),
}).refine((value) => (value.billing === "disabled") === (value.credits === null), {
  message: "credits must be null exactly when billing is disabled",
  path: ["credits"],
});
export type CostEstimate = z.infer<typeof costEstimateSchema>;

export const jobStatusSchema = z.object({
  id: z.string(),
  kind: jobKindSchema,
  status: jobStateSchema,
  reason: z.enum(["credits", "budget", "policy"]).optional(),
  queue: z.object({ position: z.number().int().nullable(), ahead: z.number().int().nullable() }),
  runIds: z.array(z.string()),
  /** Null when not computable within 150 ms; then `estimateUrl` is set. */
  estimate: costEstimateSchema.nullable(),
  estimateUrl: z.string().optional(),
  statusUrl: z.string(),
});
export type JobStatus = z.infer<typeof jobStatusSchema>;
