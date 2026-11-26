import { z } from "zod";

export const jobKindSchema = z.enum(["reindex", "full-index", "backfill", "graph-rebuild", "summary-tree-backfill", "reprocess"]);
export type JobKind = z.infer<typeof jobKindSchema>;

export const jobStateSchema = z.enum(["queued", "blocked", "processing", "completed", "failed", "cancelled"]);

/**
 * Work estimate. With billing disabled (self-hosted) `credits` is null and nothing is ever priced;
 * pages and time still apply.
 */
export const costEstimateSchema = z.object({
  /** Pages priced: counted pages, or the middle of the range for files whose pages were not counted. */
  pages: z.number().nonnegative(),
  /** Present when some files' pages were not counted: the fewest and most pages their sizes allow. `pages` is not a ceiling then. */
  pagesRange: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }).optional(),
  /** How many files' page counts are unknown (priced over a range). */
  unmeasuredFiles: z.number().int().nonnegative().optional(),
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
  /**
   * Why a job is blocked. `unavailable`: the deployment has the feature switched off. `capacity`: the deployment's
   * model provider cannot take more work right now. Both clear on their own; the job resumes without a new request.
   */
  reason: z.enum(["credits", "budget", "policy", "unavailable", "capacity"]).optional(),
  queue: z.object({ position: z.number().int().nullable(), ahead: z.number().int().nullable() }),
  runIds: z.array(z.string()),
  /** The same estimate `estimateUrl` returns; null when the work has none. */
  estimate: costEstimateSchema.nullable(),
  estimateUrl: z.string().optional(),
  statusUrl: z.string(),
  /**
   * How a finished run job went, beside `status`: `succeeded`, `partial` (completed, some documents failed) or
   * `failed`; null while it runs or when cancelled. Absent: not reported (an older server, or a job that is not a run).
   */
  outcome: z.enum(["succeeded", "partial", "failed"]).nullable().optional(),
});
export type JobStatus = z.infer<typeof jobStatusSchema>;
