import { z } from "zod";
import { embeddingProfileKeySchema, reindexEstimateSignatureSchema, vectorBackendSchema } from "@docslurp/shared";

/**
 * The MCP reindex pair: `reindexEstimate` (read-only, an estimate tool forwarding to `POST /v1/projects/:id/reindex/estimate`)
 * and `reindex` (forwards to `POST /v1/projects/:id/reindex`). Both take the same flat inputs, mapped to the route body;
 * `reindex` also requires `confirmEstimate`, the `signature` `reindexEstimate` returned, so an agent cannot spend credits
 * without first fetching (and showing) an estimate. The route's own gates decide access (editor; a server API key with
 * projects:manage bound to the organization and project, never a delegated OAuth token) and refuse a stale signature before anything is saved.
 */

export const reindexEstimateToolInput = z.object({
  project: z.string().min(1).max(256).optional()
    .describe("Optional project ID, slug or name (names match by slug). Omit for the organization default project."),
  embeddingProfile: embeddingProfileKeySchema.optional().describe("Embedding profile to switch to."),
  lateChunking: z.boolean().optional().describe("Turn late chunking on or off."),
  lateChunkingWindow: z.number().int().min(1).max(6).optional().describe("Late chunking window, 1 to 6."),
  chunkOverlap: z.boolean().optional().describe("Turn chunk overlap on or off."),
  contextualChunkPreambles: z.boolean().optional().describe("Turn contextual chunk preambles on or off."),
  vectorBackends: z.array(vectorBackendSchema).min(1).max(8).optional().describe("Vector backends to index into."),
  embed: z.boolean().optional().describe("Vector switch: build embeddings."),
  indexVectors: z.boolean().optional().describe("Vector switch: write vectors to the index."),
  speedBoost: z.boolean().optional().describe("Explicit opt-in to speed-boosted processing for the re-index runs."),
}).strict();

export const reindexToolInput = reindexEstimateToolInput.extend({
  confirmEstimate: reindexEstimateSignatureSchema.describe("Required: the signature reindexEstimate returned for exactly these inputs. A changed estimate is refused (estimate_stale) and nothing is saved or queued."),
}).strict();

export type ReindexEstimateToolInput = z.infer<typeof reindexEstimateToolInput>;

/** The route body for the inputs: only the index settings named (none: a plain rebuild), speedBoost, and the signature. */
export function reindexRouteBody(input: ReindexEstimateToolInput & { confirmEstimate?: string }): Record<string, unknown> {
  const embedding: Record<string, unknown> = {};
  if (input.embeddingProfile !== undefined) embedding.profile = input.embeddingProfile;
  if (input.lateChunking !== undefined) embedding.lateChunking = input.lateChunking;
  if (input.lateChunkingWindow !== undefined) embedding.lateChunkingWindow = input.lateChunkingWindow;
  const pipeline: Record<string, unknown> = {};
  if (Object.keys(embedding).length) pipeline.embedding = embedding;
  for (const key of ["chunkOverlap", "contextualChunkPreambles", "vectorBackends", "embed", "indexVectors"] as const) {
    if (input[key] !== undefined) pipeline[key] = input[key];
  }
  return {
    ...(Object.keys(pipeline).length ? { pipeline } : {}),
    ...(input.speedBoost !== undefined ? { speedBoost: input.speedBoost } : {}),
    ...(input.confirmEstimate !== undefined ? { confirmEstimate: input.confirmEstimate } : {}),
  };
}

type Estimate = { documents?: number; pages?: number; credits?: { low: number; high: number } | null } | null | undefined;
type Impact = { kind?: unknown; stages?: unknown; reasons?: unknown; documents?: number; pages?: number } | null | undefined;

/** `reindexEstimate` output: what is locked, the work and its price, and the signature to confirm with. No model ids. */
export function shapeReindexEstimate(body: Record<string, unknown>): Record<string, unknown> {
  const estimate = body.estimate as Estimate;
  const impact = body.impact as Impact;
  return {
    lockedSettings: Array.isArray(body.lockedSettings) ? body.lockedSettings : [],
    documents: estimate?.documents ?? impact?.documents ?? 0,
    pages: estimate?.pages ?? impact?.pages ?? 0,
    credits: estimate?.credits ?? null,
    signature: body.signature,
    estimate: estimate ?? null,
    impact: impact ? { kind: impact.kind, stages: impact.stages, reasons: impact.reasons } : null,
    billing: body.billing,
    next: "To start it, call reindex with the same inputs and confirmEstimate set to signature. This spends credits; get the user's approval first.",
  };
}

/** `reindex` output: the outcome and the queued work; the project by reference only (its record carries resolved models). */
export function shapeReindexResult(body: Record<string, unknown>): Record<string, unknown> {
  const project = body.project as { id?: unknown; slug?: unknown; name?: unknown } | undefined;
  const impact = body.impact as Impact;
  return {
    outcome: body.outcome,
    changedSettings: Array.isArray(body.changedSettings) ? body.changedSettings : [],
    project: project ? { id: project.id, slug: project.slug, name: project.name } : null,
    runIds: Array.isArray(body.runIds) ? body.runIds : [],
    job: body.job ?? null,
    estimate: body.estimate ?? null,
    impact: impact ? { kind: impact.kind, stages: impact.stages, reasons: impact.reasons, documents: impact.documents, pages: impact.pages } : null,
  };
}

export const REINDEX_TOOL_DESCRIPTION = "Apply index settings (embedding profile, late chunking, chunk overlap, contextual chunk preambles, vector backends, the embed/indexVectors switches) and re-index the project's existing documents, or rebuild the index as is when no setting is given. Spends credits. Requires confirmEstimate: call reindexEstimate with the same inputs first, show the user the documents, pages and credits, and pass its signature only after they approve. A changed estimate is refused (estimate_stale) and nothing is saved or queued. Needs project edit access (keys: a server API key with projects:manage; OAuth tokens cannot). Returns outcome (queued, blocked, saved, unchanged), changedSettings, runIds and job; poll with getJob.";
export const REINDEX_ESTIMATE_TOOL_DESCRIPTION = "Price a re-index before starting it: the index settings it changes (lockedSettings), documents, pages, credits and the signature reindex needs as confirmEstimate. Takes the same inputs as reindex; omit every setting to price a plain rebuild. Read-only; nothing is saved or queued.";
