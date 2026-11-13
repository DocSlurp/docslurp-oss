import { z } from "zod";
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
/** Keyword queries one search may run in parallel when `q` is an array (keyword mode only). */
export const KEYWORD_FANOUT_MAX = 100;
/** Array terms that need the Postgres keyword path ("quoted phrases", -negation): each is a full-text query there. */
export const KEYWORD_FANOUT_POSTGRES_MAX = 8;
const keywordTerm = z.string().trim().min(1).max(1000).refine((value) => value.replaceAll("\u0000", "").trim().length > 0);
const searchQuery = z.union([
  query,
  z.array(keywordTerm).min(1).max(KEYWORD_FANOUT_MAX),
]).describe(`Query text, or an array of up to ${KEYWORD_FANOUT_MAX} keyword queries run in parallel in keyword mode and fused into one ranked list (each result lists the queries it matched in matchedQueries).`);
/** True for terms BM25 cannot honour natively: "quoted phrases" and -negation (services/search.ts nativeLexicalQuerySupported). */
function needsPostgresKeywordPath(term: string): boolean {
  return /"[^"]*[^"\s][^"]*"/.test(term) || /(?:^|\s)-[\p{L}\p{N}"]/u.test(term);
}
const projectRef = id.optional().describe("Project ID, slug or name (names match by slug, so \"Legal Contracts\" finds legal-contracts). Omitted: the organization default project.");

export const searchInputSchema = z.object({
  geo: geoPredicateSchema.optional(),
  q: searchQuery,
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
}).strict().superRefine((value, ctx) => {
  if (!Array.isArray(value.q)) return;
  if (value.mode && value.mode !== "keyword") {
    ctx.addIssue({ code: "custom", path: ["mode"], message: "An array q runs keyword queries; use mode keyword or omit mode." });
  }
  if (value.q.join(" ").length > 16000) {
    ctx.addIssue({ code: "custom", path: ["q"], message: "The keyword queries together exceed 16000 characters." });
  }
  if (value.q.filter(needsPostgresKeywordPath).length > KEYWORD_FANOUT_POSTGRES_MAX) {
    ctx.addIssue({ code: "custom", path: ["q"], message: `At most ${KEYWORD_FANOUT_POSTGRES_MAX} keyword queries may use "quoted phrases" or -negation.` });
  }
});
export type SearchInput = z.infer<typeof searchInputSchema>;

/** The queries an input runs: one for a string q, each array item for a keyword fan-out. */
export function searchQueryTerms(q: SearchInput["q"]): string[] {
  return Array.isArray(q) ? q : [q];
}

/** The text a search is logged, cached and reranked under: the query, or the keyword queries joined. */
export function searchQueryText(q: SearchInput["q"]): string {
  return Array.isArray(q) ? q.join(" ") : q;
}
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
  model: id.optional().describe("Chat model for this request: an llm://openrouter/<vendor>/<model> URI such as llm://openrouter/anthropic/claude-haiku-5.5, or the bare OpenRouter id. Omitted: the default. Optional `?reasoning=` option: none (default, fastest), minimal, low, medium or high. A model you may not use is refused with 400 model_not_allowed, never swapped for the default."),
  /** Retrieval overrides for this request only. */
  retrieval: chatRetrievalOverridesSchema.optional(),
  /** Documents, types, tags and indexed-date filters. */
  filters: chatSearchFiltersSchema.optional(),
  /** Search-agent budgets for this turn; non-admins may only lower the defaults. */
  agent: chatAgentLimitsInputSchema.optional(),
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
    // An array q is a keyword fan-out: keyword mode, one BM25 query per item (services/search.ts).
    searchMode: Array.isArray(body.q) ? "keyword" as const : body.mode,
    ...(Array.isArray(body.q) ? { keywordQueries: body.q } : {}),
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
