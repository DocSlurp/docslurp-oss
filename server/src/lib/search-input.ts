import { z } from "zod";
import { CHAT_REASONING_LEVELS, CHAT_TIERS } from "@docslurp/shared/project-chat-models";
import { geoPredicateSchema, searchModeSchema, chatAgentLimitsInputSchema, chatRetrievalOverridesSchema, chatSearchFiltersSchema, searchCandidateDepthSchema, searchResultOrderSchema } from "@docslurp/shared";
import { parseFilters } from "../search/filters.js";

const id = z.string().trim().min(1).max(256);
const filter = z.string().max(4096).optional();
// A date filter is cast to timestamptz in SQL, so validate it here: an
// unparseable value would otherwise reach Postgres and surface as a 500.
const dateFilter = z.string().trim().max(64).optional()
  .refine((value) => value === undefined || value === "" || !Number.isNaN(Date.parse(value)), {
    message: "Expected an ISO-8601 date",
  });
// A query of only NUL bytes is empty once they are stripped before the Postgres lookups.
const query = z.string().trim().min(1).max(16000).refine((value) => value.replaceAll("\u0000", "").trim().length > 0);
const projectRef = id.optional().describe("Project ID, slug or name (names match by slug, so \"Legal Contracts\" finds legal-contracts). Omitted: the organization default project.");

export const searchInputSchema = z.object({
  geo: geoPredicateSchema.optional(),
  q: query,
  /** Omitted: the organization's default project. */
  project: projectRef,
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
  dateFrom: dateFilter,
  dateTo: dateFilter,
  mode: searchModeSchema.optional().describe("keyword (keyword matching, no model calls), hybrid (adds vector search) or deep (adds graph expansion, hosted rerank and AI query strategies). Omitted: the most your key allows. A mode above your key's search scope runs at the key's mode."),
  hyde: z.boolean().optional(),
  rerank: z.boolean().optional(),
  candidateDepth: searchCandidateDepthSchema.optional(),
  resultOrder: searchResultOrderSchema.optional(),
  mmr: z.boolean().optional(),
  mmrLambda: z.number().min(0).max(1).optional(),
  /** Relevance floor, 0..1; 0 disables it. Omitted: project default, else SEARCH_MIN_SCORE. */
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
/**
 * Search takes exactly one form, and tool schemas cannot say so with a top-level
 * oneOf (Anthropic rejects it). This explains a mixed call so a model can fix it.
 */
export function searchFormError(input: Record<string, unknown>): string | undefined {
  if (!("queries" in input)) return "concurrency" in input ? "concurrency applies only to a queries batch; remove it or send queries instead of q." : undefined;
  const stray = Object.keys(input).filter(key => key !== "queries" && key !== "concurrency");
  if (!stray.length) return undefined;
  return "q" in input
    ? "Send either q for one query or queries for a batch, not both."
    : `With queries, put ${stray.join(", ")} inside each queries item; only concurrency may accompany queries.`;
}
export const projectChatInputSchema = z.object({
  speedBoost: z.boolean().optional(),
  q: query,
  project: projectRef,
  orgId: id.optional(),
  sessionId: id.optional(),
  /** Browser (client) keys: the `sessionToken` returned with the previous answer, required to continue `sessionId`. */
  sessionToken: z.string().min(1).max(4096).optional(),
  tier: z.enum(CHAT_TIERS).optional().describe("Chat tier for this request: fastest, balanced or smart. Omitted: the project default (fastest). DocSlurp manages the model behind each tier; backend model ids are not accepted."),
  reasoning: z.enum(CHAT_REASONING_LEVELS).optional().describe("How much the answering model reasons: none (default, fastest), minimal, low, medium or high. Use more for long multi-part questions."),
  /** Retrieval overrides for this request only. */
  retrieval: chatRetrievalOverridesSchema.optional(),
  /** Documents, types, tags and indexed-date filters. */
  filters: chatSearchFiltersSchema.optional(),
  /** Search-agent budgets for this turn; non-admins may only lower the defaults. */
  agent: chatAgentLimitsInputSchema.optional(),
}).strict();

/**
 * What the chat routes parse: the public input plus `model`, a backend model id that only operator evaluation access
 * may use (chat-model-policy.ts). Everyone else naming a model gets 400 model_not_allowed naming the tiers. Kept out
 * of the public schema, so OpenAPI, MCP and the SDK never offer it.
 */
export const projectChatRequestSchema = projectChatInputSchema.extend({
  model: z.string().trim().min(1).max(256).optional(),
}).strict();

/**
 * Omitted retrieval flags stay undefined so the project's Retrieval Controls
 * decide. Provider-backed enhancements remain opt-in: they default off in the
 * project settings unless the project owner enables them.
 */
export function searchOptions(body: SearchInput & { projectId: string }) {
  return {
    runId: body.runId,
    limit: body.limit,
    variant: body.variant,
    filters: { ...parseFilters({
      documentId: body.documentId ?? "", runId: body.runId ?? "",
      projectId: body.projectId, filenameContains: body.filenameContains ?? "",
      mimeTypes: body.mimeTypes ?? "", tags: body.tags ?? "",
      pageFrom: body.pageFrom ?? "", pageTo: body.pageTo ?? "",
      language: body.language ?? "", heading: body.heading ?? "",
      dateFrom: body.dateFrom ?? "", dateTo: body.dateTo ?? "",
    }), ...(body.geo ? {geo:body.geo} : {}) },
    searchMode: body.mode,
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
