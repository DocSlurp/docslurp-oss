import { z } from "zod";
import { chatAgentLimitsInputSchema, chatRetrievalOverridesSchema, chatSearchFiltersSchema, searchCandidateDepthSchema, searchResultOrderSchema } from "@docslurp/shared";
import { parseFilters } from "../search/filters.js";

const id = z.string().trim().min(1).max(256);
const filter = z.string().max(4096).optional();
// A query of only NUL bytes is empty once they are stripped before the Postgres lookups.
const query = z.string().trim().min(1).max(16000).refine((value) => value.replaceAll("\u0000", "").trim().length > 0);
const workspaceRef = id.optional().describe("Workspace slug, former slug, UUID, or \"default\". Omitted: the organization default workspace.");

export const searchInputSchema = z.object({
  q: query,
  /** Omitted: the organization's default workspace. */
  workspaceId: workspaceRef,
  orgId: id.optional(),
  runId: id.optional(),
  documentId: id.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  variant: id.optional(),
  filenameContains: filter,
  mimeTypes: filter,
  tags: filter.describe("Comma-separated tags."),
  pageFrom: filter,
  pageTo: filter,
  language: filter,
  heading: filter,
  dateFrom: filter,
  dateTo: filter,
  hyde: z.boolean().optional(),
  rerank: z.boolean().optional(),
  candidateDepth: searchCandidateDepthSchema.optional(),
  resultOrder: searchResultOrderSchema.optional(),
  mmr: z.boolean().optional(),
  mmrLambda: z.number().min(0).max(1).optional(),
  /** Relevance floor, 0..1; 0 disables it. Omitted: workspace default, else SEARCH_MIN_SCORE. */
  minScore: z.number().min(0).max(1).optional().describe("Relevance floor: drop weaker matches (0 disables). The response reports noMatch when nothing relevant remains."),
  parentRetrieval: z.boolean().optional(),
  summarySeed: z.boolean().optional(),
  compression: z.boolean().optional(),
  queryRewrite: z.boolean().optional(),
  queryDecompose: z.boolean().optional(),
  stepback: z.boolean().optional(),
  selfQuery: z.boolean().optional(),
  iterativeMultiHop: z.boolean().optional(),
  graphExpansion: z.boolean().optional(),
  communityExpansion: z.boolean().optional(),
  graphHops: z.number().int().min(1).max(4).optional(),
  glossary: z.record(z.string().max(256), z.array(z.string().max(256)).max(20)).optional(),
}).strict();
export type SearchInput = z.infer<typeof searchInputSchema>;
export const batchSearchInputSchema = z.object({
  queries: z.array(searchInputSchema).min(1).max(20),
  /** Parallel retrievals; the chat search agent clamps it to the turn's `agent.searchConcurrency`. */
  concurrency: z.number().int().min(1).max(8).default(4),
}).strict();
export const workspaceChatInputSchema = z.object({
  q: query,
  workspaceId: workspaceRef,
  orgId: id.optional(),
  sessionId: id.optional(),
  model: id.optional(),
  /** Retrieval overrides for this request only. */
  retrieval: chatRetrievalOverridesSchema.optional(),
  /** Documents, types, tags and indexed-date filters. */
  filters: chatSearchFiltersSchema.optional(),
  /** Search-agent budgets for this turn; non-admins may only lower the defaults. */
  agent: chatAgentLimitsInputSchema.optional(),
}).strict();

/**
 * Omitted retrieval flags stay undefined so the workspace's Retrieval Controls
 * decide. Provider-backed enhancements remain opt-in: they default off in the
 * workspace settings unless the workspace owner enables them.
 */
export function searchOptions(body: SearchInput & { workspaceId: string }) {
  return {
    runId: body.runId,
    limit: body.limit,
    variant: body.variant,
    filters: parseFilters({
      documentId: body.documentId ?? "", runId: body.runId ?? "",
      workspaceId: body.workspaceId, filenameContains: body.filenameContains ?? "",
      mimeTypes: body.mimeTypes ?? "", tags: body.tags ?? "",
      pageFrom: body.pageFrom ?? "", pageTo: body.pageTo ?? "",
      language: body.language ?? "", heading: body.heading ?? "",
      dateFrom: body.dateFrom ?? "", dateTo: body.dateTo ?? "",
    }),
    useHyDE: body.hyde, useRerank: body.rerank,
    candidateDepth: body.candidateDepth, resultOrder: body.resultOrder,
    useMmr: body.mmr, mmrLambda: body.mmrLambda,
    parentRetrieval: body.parentRetrieval, summarySeed: body.summarySeed,
    glossary: body.glossary, useContextualCompression: body.compression,
    queryRewrite: body.queryRewrite, queryDecompose: body.queryDecompose,
    stepback: body.stepback, selfQuery: body.selfQuery,
    iterativeMultiHop: body.iterativeMultiHop,
    enableGraphExpansion: body.graphExpansion,
    enableCommunityExpansion: body.communityExpansion,
    graphHops: body.graphHops,
    minScore: body.minScore,
  };
}
