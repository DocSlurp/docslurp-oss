import { z } from "zod";

const count = z.number().nonnegative().finite();
export const workspaceStateDistributionSchema = z.object({
  sampleCount: count,
  p50: count.nullable(),
  p95: count.nullable(),
  max: count.nullable(),
});
export const workspaceStateQuerySchema = z.object({
  recentWindowHours: z.coerce.number().int().min(1).max(720).default(24),
});
/**
 * Current persisted corpus coverage; recent ingestion work may include reruns.
 * documents.total/completed, pages.* and storage.* describe the current corpus
 * (completed documents not superseded by a newer version). documents.queued and
 * documents.processing count in-flight ingest; documents.failed counts failed
 * documents. runs.* and performance.* are run-based ingest history.
 */
export const workspaceStateSchema = z.object({
  workspaceId: z.string(),
  orgId: z.string(),
  observedAt: z.string(),
  recentWindow: z.object({ from: z.string(), to: z.string(), hours: count }),
  documents: z.object({ total: count, queued: count, processing: count, completed: count, failed: count, unknownPageCount: count }),
  pages: z.object({ total: count, indexed: count, notIndexed: count, basis: z.literal("text-searchable-unique-pages") }),
  storage: z.object({
    sourceBytes: count, sourceMb: count, textBytes: count, textMb: count,
    documentsWithUnknownSize: count, vectorBytes: z.null(), artifactBytes: z.null(),
    mbDivisor: z.literal(1_000_000),
  }),
  runs: z.object({ total: count, queued: count, processing: count, completed: count, failed: count }),
  searches: z.object({ total: count, recentCount: count, recentZeroResultCount: count, latencyMs: workspaceStateDistributionSchema }),
  performance: z.object({
    completedRuns: count, failedRuns: count, completedPages: count,
    durationMs: workspaceStateDistributionSchema,
    pagesPerMinute: count.nullable(), minutesPer100Pages: count.nullable(),
    basis: z.literal("run-wall-time-including-queue"),
  }),
  usage: z.object({ inputTokens: count, outputTokens: count, costCents: count }),
});
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
