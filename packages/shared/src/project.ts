import { geoPredicateSchema } from "./geo.js";
import { chartExportTierSchema } from "./chart-export.js";
import { projectSettingsProposalSchema } from "./project-settings-proposal.js";
import { z } from "zod";
import { documentTagsSchema } from "./document-tags.js";
import { indexingModeSchema } from "./deferred-indexing.js";
import {
  defaultPipelineFeatures,
  mergePipelineFeatures,
  normalizePipelineFeatures,
  organizationRoleSchema,
  pipelineFeaturesSchema,
  pipelineRunStageSchema,
  runStatusSchema,
  projectMemberRoleSchema,
} from "./pipeline.js";
import {
  projectRunProgressSnapshotSchema,
  projectRunSchema,
} from "./run.js";

export const projectTemplateKeySchema = z.enum([
  "legal-contracts",
  "medical-records",
  "financial-reports",
  "engineering-docs",
  "meeting-notes",
]);
export type ProjectTemplateKey = z.infer<typeof projectTemplateKeySchema>;

export const projectTemplateLockedSettingSchema = z.enum([
  "quality",
  "visionFallback",
  "vision.benchmarkProfile",
  "preserveTables",
  "preserveCode",
  "preserveImages",
  "privacyMode",
  "piiPolicy.enabled",
  "piiPolicy.action",
  "summarize",
  "pageIndex",
  "propositionIndex",
  "chunkOverlap",
  "entityIndex",
  "embedding",
  "inferenceLane",
]);
export type ProjectTemplateLockedSetting = z.infer<
  typeof projectTemplateLockedSettingSchema
>;

/**
 * Reserved project ID: the caller's organization default project. Accepted
 * wherever a projectId is (bodies, query strings, `/v1/projects/default/...`)
 * and the SDK/CLI default when DOCSLURP_PROJECT_ID is unset. Real project
 * IDs are UUIDs, so the alias can never collide with one.
 */
export const DEFAULT_PROJECT_ALIAS = "default";

export function isDefaultProjectAlias(projectId: string | null | undefined): boolean {
  return projectId?.trim() === DEFAULT_PROJECT_ALIAS;
}

export const projectSchema = z.object({
  id: z.string(),
  /** Readable URL identifier (e.g. amber-falcon-ridge); prefer it over the UUID in links. */
  slug: z.string(),
  userId: z.string(),
  orgId: z.string(),
  name: z.string(),
  templateKey: projectTemplateKeySchema.nullable().default(null),
  systemPrompt: z.string().max(2000).nullable().default(null),
  /** Generate reusable document summaries for project overviews and titles. Off by default: a per-document generation and embedding cost, again on reprocessing. */
  summaries: z.boolean().default(false),
  pipeline: pipelineFeaturesSchema.default(defaultPipelineFeatures),
  monthlyBudgetCents: z.number().int().nonnegative().max(2_147_483_647).nullable().default(null),
  /** Days before a run's artifacts are purged; null keeps them. */
  artifactRetentionDays: z.number().int().positive().nullable().default(null),
  /** Days from ingestion before documents, artifacts and their run expire; null keeps them indefinitely. */
  runRetentionDays: z.number().int().positive().nullable().default(30),
  /**
   * Current corpus: completed documents that have not been superseded by a
   * newer version (what search serves). A re-ingest never double counts.
   */
  documentCount: z.number().int().nonnegative().default(0),
  /** Pages across the current corpus (see documentCount). */
  totalPageCount: z.number().int().nonnegative().default(0),
  /** Measured source bytes across the current corpus. */
  sourceBytes: z.number().int().nonnegative().default(0),
  /** In-flight ingest: documents still queued or processing (not yet in the corpus). */
  pendingDocumentCount: z.number().int().nonnegative().default(0),
  /** Known pages across in-flight documents; 0 until a parser reports page counts. */
  pendingPageCount: z.number().int().nonnegative().default(0),
  /** Mode new uploads use (`pipeline.indexingMode`; always `full` while deferred profiles are off). */
  indexingMode: indexingModeSchema.optional(),
  /** Searchable pages: indexed pages of deferred documents plus all pages of full-mode documents. */
  indexedPageCount: z.number().int().nonnegative().optional(),
  /** False when DOCSLURP_DEFERRED_PROFILES is off; clients hide indexing controls. */
  deferredIndexingAvailable: z.boolean().optional(),
  /** False on deployments that do not bill (self-hosted without Stripe): estimates are not prices. */
  billingEnforced: z.boolean().optional(),
  /**
   * This deployment's chart export defaults for a project with no tier: `app` (DocSlurp app uploads) and `machine`
   * (API, MCP, SDK, CLI), plus whether the billed `models` tier is offered (`DOCSLURP_CHART_EXPORT=on`).
   */
  chartExportDefaults: z.object({ app: chartExportTierSchema, machine: chartExportTierSchema, modelsAvailable: z.boolean() }).optional(),
  /** Retained versions per document for this project; null inherits the organization's setting. */
  retainDocumentVersions: z.number().int().min(1).max(100).nullable().default(null),
  /**
   * China-based model providers may serve this project's requests. Narrows the organization's
   * `allowChinaProviders`: requests use those providers only when both are true (docs/provider-regions.md).
   */
  allowChinaProviders: z.boolean().default(true),
  /** Skip the confirm dialog for re-index-queuing changes; recommended changes re-index when `apply` is omitted. */
  autoConfirmReindex: z.boolean().default(false),
  runCount: z.number().int().nonnegative().default(0),
  searchSessionCount: z.number().int().nonnegative().default(0),
  chatThreadCount: z.number().int().nonnegative().default(0),
  chatMessageCount: z.number().int().nonnegative().default(0),
  latestRunId: z.string().nullable().default(null),
  latestRunStatus: runStatusSchema.nullable().default(null),
  archivedAt: z.string().nullable().default(null),
  /** The organization's default project receives requests that omit a projectId. */
  isDefault: z.boolean().default(false),
  lastActivityAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectRecord = z.infer<typeof projectSchema>;

export const projectBoardSummarySchema = z.object({
  activity: z.array(z.object({ date: z.string(), tokens: z.number().nonnegative() })).optional(),
  activityMaxTokens: z.number().nonnegative().optional(),
  searchResultCount: z.number().int().nonnegative().optional(),
  zeroResultSearches: z.number().int().nonnegative().optional(),
  averageSearchMs: z.number().nonnegative().nullable().optional(),
  totalCostCents: z.number().nonnegative().optional(),
  recordedCostCents: z.number().nonnegative().optional(),
  computeCostCents: z.number().nonnegative().optional(),
  baseFeeCostCents: z.number().nonnegative().optional(),

  /** Current corpus documents (completed, not superseded). */
  totalDocuments: z.number().int().nonnegative().default(0),
  /** Current corpus pages (completed, not superseded). */
  totalPages: z.number().int().nonnegative().default(0),
  /** Current corpus source bytes. */
  sourceBytes: z.number().int().nonnegative().default(0),
  /** Ingest throughput: pages processed across all runs, including re-ingests. */
  processedPages: z.number().int().nonnegative().default(0),
  completedRuns: z.number().int().nonnegative().default(0),
  indexedBytes: z.number().int().nonnegative().default(0),
  /** Mean wall time of completed runs (failed and live runs excluded). */
  avgCompletedRunMs: z.number().int().nonnegative().default(0),
  /** Pages processed by completed runs, the numerator of pagesPerMinute. */
  completedRunPages: z.number().int().nonnegative().default(0),
  /** Summed wall time of completed runs, queue and start-up included. */
  completedRunMs: z.number().nonnegative().default(0),
  /** Ingest spend: recorded ingest charges (AI, fees, billed compute) plus estimated unbilled worker compute. Search and chat excluded. */
  ingestTotalCostCents: z.number().nonnegative().default(0),
  /** Full-pipeline pages per minute across completed runs (wall time, including queueing). Null until a run completes. */
  pagesPerMinute: z.number().nonnegative().nullable().default(null),
  /** Pages processed (all runs, re-ingests included) per $1 of ingest spend. Null with no spend yet. */
  pagesPerDollar: z.number().nonnegative().nullable().default(null),
  /** True when part of the spend is a worker-compute estimate rather than a billed charge. */
  computeEstimated: z.boolean().default(false),
  searchSessions: z.number().int().nonnegative().default(0),
  totalInputTokens: z.number().int().nonnegative().default(0),
  totalOutputTokens: z.number().int().nonnegative().default(0),
  totalEmbeddingTokens: z.number().int().nonnegative().default(0),
  totalLlmCostCents: z.number().nonnegative().default(0),
  ingestInputTokens: z.number().int().nonnegative().default(0),
  ingestOutputTokens: z.number().int().nonnegative().default(0),
  ingestEmbeddingTokens: z.number().int().nonnegative().default(0),
  ingestCostCents: z.number().nonnegative().default(0),
  searchInputTokens: z.number().int().nonnegative().default(0),
  searchOutputTokens: z.number().int().nonnegative().default(0),
  searchEmbeddingTokens: z.number().int().nonnegative().default(0),
  searchCostCents: z.number().nonnegative().default(0),
});
export type ProjectBoardSummary = z.infer<typeof projectBoardSummarySchema>;

export const projectBoardRecordSchema = z.object({
  project: projectSchema,
  run: projectRunSchema.nullable().default(null),
  snapshot: projectRunProgressSnapshotSchema.nullable().default(null),
  summary: projectBoardSummarySchema,
});
export type ProjectBoardRecord = z.infer<typeof projectBoardRecordSchema>;

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable().default(null),
  isPersonal: z.boolean().default(false),
  personalOwnerUserId: z.string().nullable().default(null),
  /** Null once the creating account is deleted; the org outlives its creator. */
  createdByUserId: z.string().nullable(),
  creditBalanceCents: z.number().default(0),
  memberRole: organizationRoleSchema,
  /** Has ever received a paid grant (top-up, auto top-up, adjustment, promo). */
  funded: z.boolean().default(false),
  /** Versions kept per document chain; null uses DEFAULT_RETAINED_VERSIONS. */
  retainDocumentVersions: z.number().int().min(1).max(100).nullable().default(null),
  /** China-based model providers may serve the org's requests (DeepSeek, GLM and similar open models often cost about half there). */
  allowChinaProviders: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrganizationRecord = z.infer<typeof organizationSchema>;

export const organizationMembershipSchema = z.object({
  orgId: z.string(),
  userId: z.string(),
  role: organizationRoleSchema,
  createdAt: z.string(),
});
export type OrganizationMembership = z.infer<
  typeof organizationMembershipSchema
>;

export const projectMemberSchema = z.object({
  projectId: z.string(),
  userId: z.string(),
  email: z.string().email().nullable().default(null),
  name: z.string().nullable().default(null),
  role: projectMemberRoleSchema,
  invitedByUserId: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type ProjectMemberRecord = z.infer<typeof projectMemberSchema>;

export const projectInviteStatusSchema = z.enum([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export type ProjectInviteStatus = z.infer<typeof projectInviteStatusSchema>;

export const projectInviteSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  orgId: z.string(),
  email: z.string().email(),
  role: projectMemberRoleSchema,
  token: z.string(),
  status: projectInviteStatusSchema,
  invitedByUserId: z.string(),
  acceptedByUserId: z.string().nullable().default(null),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type ProjectInviteRecord = z.infer<typeof projectInviteSchema>;

export const projectTemplateSchema = z.object({
  key: projectTemplateKeySchema,
  name: z.string(),
  description: z.string(),
  pipeline: pipelineFeaturesSchema,
  lockedSettings: z.array(projectTemplateLockedSettingSchema).default([]),
});
export type ProjectTemplate = z.infer<typeof projectTemplateSchema>;

export const projectChatRoleSchema = z.enum(["user", "assistant", "system"]);
export type ProjectChatRole = z.infer<typeof projectChatRoleSchema>;

export const projectChatModeSchema = z.enum(["retrieval", "whole-corpus"]);
export type ProjectChatMode = z.infer<typeof projectChatModeSchema>;

export const projectChatFallbackReasonSchema = z.enum([
  "empty-project",
  "document-limit-exceeded",
  "chunk-limit-exceeded",
  "token-limit-exceeded",
  "char-limit-exceeded",
  "load-failed",
  "model-unavailable",
  "generation-failed",
]);
export type ProjectChatFallbackReason = z.infer<
  typeof projectChatFallbackReasonSchema
>;

export const projectChatSessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  createdAt: z.string(),
});
export type ProjectChatSession = z.infer<typeof projectChatSessionSchema>;

export const projectChatTurnSchema = z.object({
  sessionId: z.string(),
  role: projectChatRoleSchema,
  content: z.string(),
  createdAt: z.string(),
});
export type ProjectChatTurn = z.infer<typeof projectChatTurnSchema>;

export const projectChatWholeCorpusDebugSchema = z.object({
  attempted: z.boolean().default(false),
  eligible: z.boolean().default(false),
  documentCount: z.number().int().nonnegative().nullable().default(null),
  chunkCount: z.number().int().nonnegative().nullable().default(null),
  tokenEstimate: z.number().int().nonnegative().nullable().default(null),
  charEstimate: z.number().int().nonnegative().nullable().default(null),
  maxDocuments: z.number().int().positive(),
  maxChunks: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxChars: z.number().int().positive(),
  fallbackReason: projectChatFallbackReasonSchema.nullable().default(null),
});
export type ProjectChatWholeCorpusDebug = z.infer<
  typeof projectChatWholeCorpusDebugSchema
>;

/** Search-agent budgets for one /v1/chat turn. Non-admin callers may only lower them. */
export const CHAT_AGENT_LIMIT_DEFAULTS = { maxSteps: 8, maxToolCalls: 16, searchConcurrency: 6 } as const;
export const CHAT_AGENT_LIMIT_MAXIMUMS = { maxSteps: 12, maxToolCalls: 24, searchConcurrency: 8 } as const;
/**
 * Dynamic step budget: a turn gets this many model steps (final answer
 * included). It continues past them, up to maxSteps, only while each tool step
 * adds new evidence and the turn's input tokens stay under
 * CHAT_AGENT_EXTENSION_INPUT_TOKENS. Every step resends the whole history, so
 * late steps cost the most (production 2026-10: 4-step turns averaged 142k
 * input tokens, 8-step turns 545k).
 */
export const CHAT_AGENT_BASE_STEPS = 4;
export const CHAT_AGENT_EXTENSION_INPUT_TOKENS = 150_000;
export type ChatAgentLimitName = keyof typeof CHAT_AGENT_LIMIT_DEFAULTS;

export const chatAgentLimitsInputSchema = z.object({
  /** Model steps (calls), including the final answer step. Default: CHAT_AGENT_BASE_STEPS, extended up to 8 while searches add evidence; a set value is a fixed budget. */
  maxSteps: z.number().int().min(1).max(CHAT_AGENT_LIMIT_MAXIMUMS.maxSteps).optional(),
  /** Tool calls across the turn; further calls are refused with `code: "tool_call_limit"`. Default 16. */
  maxToolCalls: z.number().int().min(1).max(CHAT_AGENT_LIMIT_MAXIMUMS.maxToolCalls).optional(),
  /** Upper bound for the search tool's parallel `queries` concurrency. Default 6. */
  searchConcurrency: z.number().int().min(1).max(CHAT_AGENT_LIMIT_MAXIMUMS.searchConcurrency).optional(),
  /**
   * false: answer directly from one retrieval and one model call, without the
   * agent's tool loop (no search, web or settings tools). Fastest and cheapest;
   * the step and tool-call limits then do not apply. Omitted or true: the
   * agent decides which tools to call.
   */
  tools: z.boolean().optional(),
  /**
   * Web tools (webSearch, webFetch) for this turn. false: never offered.
   * Omitted or true: offered when the deployment, the project's
   * `pipeline.webTools` and its privacy mode allow them; a request cannot
   * enable them past those policies.
   */
  web: z.boolean().optional(),
  /**
   * Suggestions mode (the agent flags ingestion and search problems and
   * proposes project-setting changes for a person to Apply) is a DocSlurp
   * app feature. The server honours it only for the first-party app's signed-in
   * session (isFirstPartyAppActor); for API keys, MCP and the OpenAI-compatible
   * route it is accepted and ignored, so existing callers keep working. Not part
   * of the public SDK.
   */
  suggestions: z.boolean().optional(),
}).strict();
export type ChatAgentLimitsInput = z.infer<typeof chatAgentLimitsInputSchema>;

export const chatAgentLimitsSchema = z.object({
  maxSteps: z.number().int().positive(),
  /** Steps before the turn must show progress to continue; equals maxSteps when the caller set maxSteps. */
  baseSteps: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive(),
  searchConcurrency: z.number().int().positive(),
  /** Requested limits lowered to the defaults because the caller is not an admin. */
  clamped: z.array(z.enum(["maxSteps", "maxToolCalls", "searchConcurrency"])).default([]),
});
export type ChatAgentLimits = z.infer<typeof chatAgentLimitsSchema>;

/**
 * Why the search agent stopped:
 * - `answered`: the final answer cites evidence (or no search was needed).
 * - `answered_without_citations`: the agent searched at least once but the answer has no [n] citation.
 * - `no_evidence`: every search the agent ran returned zero results.
 * - `step_limit`: the step budget ended the loop while the model was still calling tools.
 * - `tool_call_limit`: at least one tool call was refused by the tool-call budget.
 * - `deadline`: the turn's time budget ran low, so tools were disabled and the answer
 *   was forced from the evidence gathered so far (or cut off at the deadline). HTTP 200.
 * - `timeout` / `error`: the turn failed (traces only; the HTTP response is an error).
 */
export const CHAT_AGENT_STOP_REASONS = ["answered", "answered_without_citations", "no_evidence", "step_limit", "tool_call_limit", "deadline", "timeout", "error"] as const;
export const chatAgentStopReasonSchema = z.enum(CHAT_AGENT_STOP_REASONS);
export type ChatAgentStopReason = z.infer<typeof chatAgentStopReasonSchema>;

export const chatAgentStepUsageSchema = z.object({
  step: z.number().int().nonnegative(),
  /** Model/build that answered this step, as reported by the provider. */
  model: z.string().nullable(),
  finishReason: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costCents: z.number().nonnegative().optional(),
  toolCalls: z.array(z.string()),
});
export type ChatAgentStepUsage = z.infer<typeof chatAgentStepUsageSchema>;

/** Search-agent turns: the time budget that applied and how the answer was reached. */
export const chatAgentTimeBudgetDebugSchema = z.object({
  turnDeadlineMs: z.number().int().positive(),
  stepTimeoutMs: z.number().int().positive(),
  toolTimeoutMs: z.number().int().positive(),
  finalReserveMs: z.number().int().nonnegative(),
  /** Time from the request reaching chat to the answer. */
  elapsedMs: z.number().nonnegative(),
  /**
   * `loop`: the agent answered on its own. `forced`: the final-answer reserve
   * started, so tools were disabled for the last step. `from_evidence`: a model
   * step ran out of time and one extra no-tools call answered from the evidence.
   * `partial`: the deadline cut the final answer off; the text so far is returned.
   */
  finalAnswer: z.enum(["loop", "forced", "from_evidence", "partial"]),
  /** Model calls cancelled at their step budget. */
  stepTimeouts: z.number().int().nonnegative(),
  /** Tool calls cancelled at their tool budget (the model got a `tool_timeout` result). */
  toolTimeouts: z.number().int().nonnegative(),
  /** Tool calls refused because the final-answer reserve had started (`deadline` result). */
  toolCallsAfterDeadline: z.number().int().nonnegative(),
});
export type ChatAgentTimeBudgetDebug = z.infer<typeof chatAgentTimeBudgetDebugSchema>;

/**
 * Agent modes a turn ran with. `web`: "on" (web tools offered), "off" (the
 * request turned them off) or "unavailable" (requested, but the deployment,
 * project setting, privacy mode or key scope does not allow them).
 */
export const chatAgentModesSchema = z.object({
  web: z.enum(["on", "off", "unavailable"]),
  suggestions: z.boolean(),
});
export type ChatAgentModes = z.infer<typeof chatAgentModesSchema>;

export const projectChatDebugSchema = z.object({
  /** Search-agent turns only: the `model` the caller asked for (null when omitted). */
  requestedModel: z.string().nullable().optional(),
  /** Search-agent turns only: the provider's model/build id from the last response (aliases can resolve to dated builds). */
  resolvedModel: z.string().nullable().optional(),
  /** Search-agent turns only: the upstream provider OpenRouter routed to, when reported. */
  resolvedProvider: z.string().nullable().optional(),
  steps: z.number().int().nonnegative().optional(),
  /** Tool calls executed (refused calls over the budget are not counted). */
  toolCallCount: z.number().int().nonnegative().optional(),
  toolCallsRefused: z.number().int().nonnegative().optional(),
  searchCallCount: z.number().int().nonnegative().optional(),
  /** Retrieval queries, counting each item of a parallel `queries` batch. */
  searchQueryCount: z.number().int().nonnegative().optional(),
  zeroHitSearchCount: z.number().int().nonnegative().optional(),
  stopReason: chatAgentStopReasonSchema.optional(),
  stepUsage: z.array(chatAgentStepUsageSchema).optional(),
  limits: chatAgentLimitsSchema.optional(),
  timeBudget: chatAgentTimeBudgetDebugSchema.optional(),
  modes: chatAgentModesSchema.optional(),
  toolCalls: z.array(z.object({
    id: z.string(), name: z.string(), status: z.enum(["loading", "success", "error"]),
    runtimeMs: z.number().nonnegative().optional(),
    settingsProposal: projectSettingsProposalSchema.optional(),
    /** Search calls: the query strings the model sent (its own words, never document text). */
    queries: z.array(z.string()).optional(),
    resultCount: z.number().int().nonnegative().optional(),
    zeroHit: z.boolean().optional(),
    /** Distinct pages of the evidence this call returned. */
    evidencePages: z.array(z.object({ documentId: z.string(), pageNumber: z.number().int().nullable() })).optional(),
    /** Failed calls: `tool_call_limit`, `deadline`, `tool_timeout`, `invalid_arguments`, `aborted`, `exception`, the tool's error code or `http_<status>`. */
    errorCode: z.string().optional(),
    /** Provider cost (USD cents) the tool reported for its own work. */
    costCents: z.number().nonnegative().optional(),
  })).optional(),
  citations: z.number().int().nonnegative(),
  model: z.string().nullable().default(null),
  fallback: z.boolean().default(false),
  historyTurns: z.number().int().nonnegative(),
  mode: projectChatModeSchema.default("retrieval"),
  wholeCorpus: projectChatWholeCorpusDebugSchema,
});
export type ProjectChatDebug = z.infer<typeof projectChatDebugSchema>;

export const projectSearchPinnedResultSchema = z
  .object({
    queryPattern: z.string().trim().min(1).max(240),
    documentId: z.string().trim().min(1).optional(),
    chunkId: z.string().trim().min(1).optional(),
    rank: z.number().int().min(1).max(100).optional(),
  })
  .refine((value) => Boolean(value.documentId || value.chunkId), {
    path: ["documentId"],
    message: "A pinned result must reference a documentId or chunkId",
  });
export type ProjectSearchPinnedResult = z.infer<
  typeof projectSearchPinnedResultSchema
>;

/** Explicit retrieval windows are bounded independently of returned result count. */
/**
 * Search modes, cheapest first. `keyword`: keyword matching only, no model calls. `hybrid`: adds the query embedding
 * and vector retrieval. `deep`: adds graph and community expansion, the hosted reranker and LLM query strategies.
 * API keys hold one `search:<mode>` scope, the most a key may run; a request may ask for less with `mode`.
 */
export const SEARCH_MODES = ["keyword", "hybrid", "deep"] as const;
export const searchModeSchema = z.enum(SEARCH_MODES);
export type SearchMode = z.infer<typeof searchModeSchema>;
export const searchCandidateDepthSchema = z.number().int().min(1).max(200);
export const searchResultOrderSchema = z.enum(["relevance", "prompt"]);
export type SearchResultOrder = z.infer<typeof searchResultOrderSchema>;

export const projectSearchRetrievalDefaultsSchema = z.object({
  /** Explicit opt-in; omitted keeps local BM25 reranking. */
  rerankProvider: z.enum(["bm25", "deepinfra"]).optional(),
  rerankModel: z.literal("Qwen/Qwen3-Reranker-0.6B").optional(),
  /** Omitted: retain the historical rerank-dependent candidate window. */
  candidateDepth: searchCandidateDepthSchema.optional(),
  /** Omitted: retain historical ordering; prompt packs the selected set. */
  resultOrder: searchResultOrderSchema.optional(),
  resultCount: z.number().int().min(1).max(50).default(8),
  useHyDE: z.boolean().default(false),
  useRerank: z.boolean().default(true),
  useContextualCompression: z.boolean().default(false),
  useMmr: z.boolean().default(false),
  mmrLambda: z.number().min(0).max(1).default(0.4),
  queryRewrite: z.boolean().default(false),
  queryDecompose: z.boolean().default(false),
  stepback: z.boolean().default(false),
  parentRetrieval: z.boolean().default(true),
  summarySeed: z.boolean().default(false),
  selfQuery: z.boolean().default(false),
  iterativeMultiHop: z.boolean().default(false),
  // Graph controls stay unset unless the project chooses them, so retrieval
  // can derive them from the pipeline (graphRag / entityIndex / communities).
  enableGraphExpansion: z.boolean().optional(),
  enableCommunityExpansion: z.boolean().optional(),
  graphHops: z.number().int().min(1).max(3).optional(),
  // Relevance floor (0..1, 0 = off). Unset: the SEARCH_MIN_SCORE environment default applies.
  minScore: z.number().min(0).max(1).optional(),
});
export type ProjectSearchRetrievalDefaults = z.infer<
  typeof projectSearchRetrievalDefaultsSchema
>;

/**
 * Chat retrieves at most this many passages per answer (and cites the best 6),
 * even though search allows up to 50. Every retrieved passage goes into the
 * model prompt, so the cap bounds prompt size, latency and cost per answer;
 * use search (or the MCP search tools) to page through more results.
 */
export const CHAT_MAX_RETRIEVED_PASSAGES = 12;

/** Retrieval changes scoped to one chat thread; they never touch project defaults. */
export const chatRetrievalOverridesSchema = z.object({
  /** Omitted: retain the historical rerank-dependent candidate window. */
  candidateDepth: searchCandidateDepthSchema.optional(),
  /** Omitted: retain historical ordering; prompt packs the selected set. */
  resultOrder: searchResultOrderSchema.optional(),
  resultCount: z.number().int().min(1).max(CHAT_MAX_RETRIEVED_PASSAGES).optional(),
  useHyDE: z.boolean().optional(),
  useRerank: z.boolean().optional(),
  useMmr: z.boolean().optional(),
  mmrLambda: z.number().min(0).max(1).optional(),
  iterativeMultiHop: z.boolean().optional(),
  enableGraphExpansion: z.boolean().optional(),
  enableCommunityExpansion: z.boolean().optional(),
  graphHops: z.number().int().min(1).max(3).optional(),
  /** false: cite matched chunks only, without attaching each hit's whole parent page text. Smaller prompts and faster retrieval. */
  parentRetrieval: z.boolean().optional(),
}).strict();
export type ChatRetrievalOverrides = z.infer<typeof chatRetrievalOverridesSchema>;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Composer filters for one chat request, mapped onto the search filters. */
export const chatSearchFiltersSchema = z.object({
  geo: geoPredicateSchema.optional(),
  documentIds: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  mimeTypes: z.array(z.string().trim().min(1).max(200)).max(24).optional(),
  tags: documentTagsSchema.optional(),
  /** Indexed on or after this day (UTC). */
  dateFrom: isoDateSchema.optional(),
  /** Indexed on or before this day (UTC). */
  dateTo: isoDateSchema.optional(),
}).strict();
export type ChatSearchFilters = z.infer<typeof chatSearchFiltersSchema>;

/**
 * Longest project chat instructions, in characters (~1,000 tokens). The
 * composed system message adds ~600 tokens of fixed rules and defaults, which
 * stays small next to the chat's retrieved evidence (up to 32 passages).
 */
export const CHAT_INSTRUCTIONS_MAX_CHARS = 4000;

/**
 * Default threshold for the chat quick decline (`chat.scopeDeclineThreshold`):
 * the turn's best vector match, rescaled above the embedding pipeline's noise
 * baseline (0..1), must reach this for a first question to skip the model.
 * Conservative on purpose: the model declines unrelated questions itself.
 * Disabled until calibration exercises the real search session pipeline.
 */
export const DEFAULT_SCOPE_DECLINE_THRESHOLD = 0;

export const projectSearchChatSettingsSchema = z.object({
  /** Project chat on or off. Off rejects every chat surface (app, /v1/chat, chat/completions, MCP). */
  enabled: z.boolean().default(true),
  mode: projectChatModeSchema.default("retrieval"),
  answerStyle: z.enum(["concise", "balanced", "detailed"]).default("balanced"),
  citations: z.boolean().default(true),
  /**
   * Chat instructions: the project owner's text, added to the chat system
   * message for every answer in this project (app, /v1/chat,
   * /v1/chat/completions, MCP, SDK and embed). It may change citations,
   * answer style, tone and scope wording. The fixed core rules are always
   * composed first and the model is told they win. Null or empty uses the default
   * template built from the project name (never document content).
   */
  searchInstructions: z.string().trim().max(CHAT_INSTRUCTIONS_MAX_CHARS).nullable().default(null),
  /**
   * Quick decline (a UX shortcut, not a safety control): on a first, unfiltered,
   * non-web direct-answer turn whose best vector match (rescaled above the
   * embedding pipeline's noise baseline, 0..1) is below this, chat answers with
   * a templated polite decline and related questions instead of a model call.
   * Null uses DEFAULT_SCOPE_DECLINE_THRESHOLD; 0 turns it off.
   */
  scopeDeclineThreshold: z.number().min(0).max(1).nullable().default(null),
});
export type ProjectSearchChatSettings = z.infer<
  typeof projectSearchChatSettingsSchema
>;

export const updateProjectSearchRetrievalDefaultsSchema = z.object({
  rerankProvider: z.enum(["bm25", "deepinfra"]).optional(),
  rerankModel: z.literal("Qwen/Qwen3-Reranker-0.6B").optional(),
  /** Omitted: retain the historical rerank-dependent candidate window. */
  candidateDepth: searchCandidateDepthSchema.optional(),
  /** Omitted: retain historical ordering; prompt packs the selected set. */
  resultOrder: searchResultOrderSchema.optional(),
  resultCount: z.number().int().min(1).max(50).optional(),
  useHyDE: z.boolean().optional(),
  useRerank: z.boolean().optional(),
  useContextualCompression: z.boolean().optional(),
  useMmr: z.boolean().optional(),
  mmrLambda: z.number().min(0).max(1).optional(),
  queryRewrite: z.boolean().optional(),
  queryDecompose: z.boolean().optional(),
  stepback: z.boolean().optional(),
  parentRetrieval: z.boolean().optional(),
  summarySeed: z.boolean().optional(),
  selfQuery: z.boolean().optional(),
  iterativeMultiHop: z.boolean().optional(),
  // null clears an explicit choice so retrieval derives it from the pipeline again.
  enableGraphExpansion: z.boolean().nullable().optional(),
  enableCommunityExpansion: z.boolean().nullable().optional(),
  graphHops: z.number().int().min(1).max(3).nullable().optional(),
  // null clears the project choice so the environment default applies again.
  minScore: z.number().min(0).max(1).nullable().optional(),
});

export const updateProjectSearchChatSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  mode: projectChatModeSchema.optional(),
  answerStyle: z.enum(["concise", "balanced", "detailed"]).optional(),
  citations: z.boolean().optional(),
  searchInstructions: z.string().trim().max(CHAT_INSTRUCTIONS_MAX_CHARS).nullable().optional(),
  scopeDeclineThreshold: z.number().min(0).max(1).nullable().optional(),
});

export const updateProjectSearchBoostsSchema = z.object({
  any: z.number().optional(),
  byMime: z.record(z.string(), z.number()).optional(),
});

export const projectSearchSettingsSchema = z.object({
  projectId: z.string(),
  userId: z.string(),
  typoTolerance: z.boolean().default(true),
  dedupeByFilename: z.boolean().default(true),
  rankingRules: z.record(z.string(), z.unknown()).default({}),
  boosts: z
    .object({
      any: z.number().optional(),
      byMime: z.record(z.string(), z.number()).default({}),
    })
    .default({ byMime: {} }),
  pinnedResults: z.array(projectSearchPinnedResultSchema).default([]),
  synonyms: z.record(z.string(), z.array(z.string())).default({}),
  retrievalDefaults: projectSearchRetrievalDefaultsSchema.default({
    resultCount: 8,
    useHyDE: false,
    useRerank: true,
    useContextualCompression: false,
    useMmr: false,
    mmrLambda: 0.4,
    queryRewrite: false,
    queryDecompose: false,
    stepback: false,
    parentRetrieval: true,
    summarySeed: false,
    selfQuery: false,
    iterativeMultiHop: false,
  }),
  chat: projectSearchChatSettingsSchema.default({
    enabled: true,
    mode: "retrieval",
    answerStyle: "balanced",
    citations: true,
    searchInstructions: null,
    scopeDeclineThreshold: null,
  }),
  compatSettings: z.record(z.string(), z.unknown()).default({}),
  rules: z.array(z.record(z.string(), z.unknown())).default([]),
  compatMetadata: z.record(z.string(), z.unknown()).default({}),
});
export type ProjectSearchSettings = z.infer<
  typeof projectSearchSettingsSchema
>;

export const defaultProjectSearchSettings =
  projectSearchSettingsSchema.parse({
    projectId: "",
    userId: "",
  });

/** Largest rankingRules, pinnedResults or synonyms a search-settings update may store: entries and serialized bytes. */
export const SEARCH_SETTINGS_MAX_ENTRIES = 500;
export const SEARCH_SETTINGS_MAX_BYTES = 64 * 1024;

/** Bounds one free-form search-settings field, so an API key cannot store an unbounded blob read on every search. */
function boundedSearchSetting<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value, ctx) => {
    const entries = Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0;
    if (entries > SEARCH_SETTINGS_MAX_ENTRIES) {
      ctx.addIssue({ code: "custom", message: `At most ${SEARCH_SETTINGS_MAX_ENTRIES} entries` });
      return;
    }
    if (new TextEncoder().encode(JSON.stringify(value) ?? "").length > SEARCH_SETTINGS_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: `At most ${SEARCH_SETTINGS_MAX_BYTES / 1024} KB when serialized` });
    }
  });
}

export const updateProjectSearchSettingsSchema = z.object({
  typoTolerance: z.boolean().optional(),
  dedupeByFilename: z.boolean().optional(),
  rankingRules: boundedSearchSetting(z.record(z.string(), z.unknown())).optional(),
  boosts: updateProjectSearchBoostsSchema.optional(),
  pinnedResults: boundedSearchSetting(z.array(projectSearchPinnedResultSchema)).optional(),
  synonyms: boundedSearchSetting(z.record(z.string(), z.array(z.string()))).optional(),
  retrievalDefaults: updateProjectSearchRetrievalDefaultsSchema.optional(),
  chat: updateProjectSearchChatSettingsSchema.optional(),
});
export type UpdateProjectSearchSettingsInput = z.infer<
  typeof updateProjectSearchSettingsSchema
>;

export const createOrganizationSchema = z.object({
  userId: z.string().default("demo-user"),
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

/**
 * Organization membership starts with an email invite the invitee accepts
 * while signed in with that verified email. There is no add-by-user-ID path.
 */
export const organizationInviteSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  email: z.string().email(),
  role: organizationRoleSchema,
  status: projectInviteStatusSchema,
  invitedByUserId: z.string(),
  acceptedByUserId: z.string().nullable().default(null),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type OrganizationInviteRecord = z.infer<typeof organizationInviteSchema>;

export const createOrganizationInviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.string().email()),
  role: organizationRoleSchema.default("member"),
  expiresInDays: z.number().int().positive().max(30).default(7),
}).strict();
export type CreateOrganizationInviteInput = z.input<typeof createOrganizationInviteSchema>;

export const updateProjectMemberSchema = z.object({
  role: projectMemberRoleSchema,
});
export type UpdateProjectMemberInput = z.infer<
  typeof updateProjectMemberSchema
>;

export const createProjectInviteSchema = z.object({
  userId: z.string().default("demo-user"),
  email: z.string().email(),
  role: projectMemberRoleSchema.default("viewer"),
  expiresInDays: z.number().int().positive().max(30).default(7),
});
export type CreateProjectInviteInput = z.infer<
  typeof createProjectInviteSchema
>;

export const acceptProjectInviteSchema = z.object({
  userId: z.string().default("demo-user"),
});
export type AcceptProjectInviteInput = z.infer<
  typeof acceptProjectInviteSchema
>;

export const uploadRequestSchema = z.object({
  userId: z.string().min(1),
  filenames: z.array(z.string()).min(1),
  pipeline: pipelineFeaturesSchema.default(defaultPipelineFeatures),
  /** Per-upload indexing mode; stamps the documents (ignored as `full` while deferred profiles are off). */
  indexingMode: indexingModeSchema.optional(),
});
export type UploadRequest = z.infer<typeof uploadRequestSchema>;

/**
 * Reprocess a run into a new run. With neither field every enabled stage runs
 * again; `stageFrom` runs the stages from that one onward and `stages` runs
 * exactly those, reusing the other stages' outputs from the source documents.
 */
/**
 * Per-request chart export override (upload, URL ingest, reprocess, estimates): wins over the project's tier and the
 * origin default; the deploy switch stays the ceiling. `models` (reading charts with AI) is billed per chart read.
 */
export const chartExportOverrideSchema = z.object({ tier: chartExportTierSchema }).strict();
export type ChartExportOverride = z.infer<typeof chartExportOverrideSchema>;

/** One description for the override on every machine surface (MCP tools, SDK and CLI docs). */
export const CHART_EXPORT_OVERRIDE_DESCRIPTION =
  "Chart and diagram export for this request: { tier: \"off\" | \"free\" | \"models\" }. Omit for the project's setting; a project with no setting is off for API, MCP, SDK and CLI calls (on with the free steps in the DocSlurp app). free exports charts that carry their own data (Office charts, embedded chart specs, vector graphics) at no charge. models also reads other charts with AI, billed per chart read. The deployment can cap this; models is refused where it is unavailable.";

export const reprocessRunSchema = z
  .object({
    speedBoost: z.boolean().optional(),
    chartExport: chartExportOverrideSchema.optional(),
    stages: z.array(pipelineRunStageSchema).min(1).optional(),
    stageFrom: pipelineRunStageSchema.optional(),
  })
  .refine((value) => !(value.stages && value.stageFrom), {
    message: "Use either stages or stageFrom, not both",
    path: ["stages"],
  });
export type ReprocessRunInput = z.infer<typeof reprocessRunSchema>;

/** The name a project carries until DocSlurp titles it from its files, summaries or first chat question. */
export const UNTITLED_PROJECT_NAME = "Untitled project";

/** An omitted or blank name, or the placeholder itself, asks DocSlurp to title the project. */
export function isUntitledProjectName(name: string | null | undefined): boolean {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" || trimmed === UNTITLED_PROJECT_NAME;
}

export const createProjectSchema = z.object({
  userId: z.string().default("demo-user"),
  orgId: z.string().optional(),
  /**
   * Optional. Omitted, blank or "Untitled project": the project is created as
   * "Untitled project" and renamed automatically (first upload, then content,
   * then the first chat question) until someone renames it.
   */
  name: z.string().trim().max(120).optional(),
  /** Preferred slug. Invalid or reserved: a generated one; taken by another project: suffixed. */
  slug: z.string().trim().min(1).max(63).optional(),
  templateKey: projectTemplateKeySchema.optional(),
  systemPrompt: z.string().trim().max(2000).nullable().optional(),
  /** Off by default. Turning it on adds a per-document processing cost; privacy/template restrictions still apply. */
  summaries: z.boolean().default(false),
  pipeline: pipelineFeaturesSchema.optional(),
});
export type CreateProjectInput = z.input<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  speedBoost: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  /** Renaming keeps old slugs resolving to this project. */
  slug: z.string().trim().min(3).max(63).optional(),
  templateKey: projectTemplateKeySchema.nullable().optional(),
  systemPrompt: z.string().trim().max(2000).nullable().optional(),
  /** Generate and cache document summaries for better search. Backfill/reprocessing can incur generation and embedding costs; omission preserves the current setting. */
  summaries: z.boolean().optional(),
  pipeline: pipelineFeaturesSchema.optional(),
  monthlyBudgetCents: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
  /** Null (or 0) keeps artifacts indefinitely. */
  artifactRetentionDays: z.number().int().min(0).max(3650).nullable().optional(),
  /** Null (or 0) keeps runs indefinitely. */
  runRetentionDays: z.number().int().min(0).max(3650).nullable().optional(),
  /**
   * What to do with existing documents when the change affects them. A required re-index always queues;
   * a recommended one re-indexes on "reindex" (or when omitted and `autoConfirmReindex` is on).
   */
  apply: z.enum(["new-uploads", "reindex"]).optional(),
  /** Skip the confirm dialog for re-index-queuing changes; also the default `apply` for recommended changes. */
  autoConfirmReindex: z.boolean().optional(),
  /** Versions kept per document chain; null inherits the organization setting. */
  retainDocumentVersions: z.number().int().min(1).max(100).nullable().optional(),
  /** False keeps China-based model providers out of this project's requests; true cannot widen an org opt-out. */
  allowChinaProviders: z.boolean().optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

type TemplatePipelineOverrides = Omit<
  Partial<import("./pipeline.js").PipelineFeatures>,
  "vision" | "embedding" | "piiPolicy" | "documentExtraction" | "graph"
> & {
  graph?: Partial<import("./pipeline.js").PipelineFeatures["graph"]>;
  vision?: Partial<import("./pipeline.js").PipelineFeatures["vision"]>;
  embedding?: Partial<import("./pipeline.js").PipelineFeatures["embedding"]>;
  piiPolicy?: Partial<NonNullable<import("./pipeline.js").PipelineFeatures["piiPolicy"]>>;
  documentExtraction?: Partial<import("./pipeline.js").PipelineFeatures["documentExtraction"]>;
};

function buildTemplatePipeline(
  overrides: TemplatePipelineOverrides,
): import("./pipeline.js").PipelineFeatures {
  return normalizePipelineFeatures(overrides);
}

const projectTemplateLockedSettingPaths: Record<
  ProjectTemplateLockedSetting,
  string[]
> = {
  quality: ["quality"],
  visionFallback: ["visionFallback"],
  "vision.benchmarkProfile": ["vision", "benchmarkProfile"],
  preserveTables: ["preserveTables"],
  preserveCode: ["preserveCode"],
  preserveImages: ["preserveImages"],
  privacyMode: ["privacyMode"],
  "piiPolicy.enabled": ["piiPolicy", "enabled"],
  "piiPolicy.action": ["piiPolicy", "action"],
  summarize: ["summarize"],
  pageIndex: ["pageIndex"],
  propositionIndex: ["propositionIndex"],
  chunkOverlap: ["chunkOverlap"],
  entityIndex: ["entityIndex"],
  embedding: ["embedding"],
  inferenceLane: ["inferenceLane"],
};

function readNestedValue(source: unknown, path: string[]): unknown {
  let current = source;
  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      !(segment in current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writeNestedValue(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
) {
  let cursor = target;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const next = cursor[segment];

    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[segment] = {};
    }

    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[path[path.length - 1]] = JSON.parse(JSON.stringify(value));
}

export function getProjectTemplate(
  key: ProjectTemplateKey | null | undefined,
): ProjectTemplate | null {
  if (!key) {
    return null;
  }

  return projectTemplates.find((template) => template.key === key) ?? null;
}

export function applyProjectTemplateLocks(
  pipeline: import("./pipeline.js").PipelineFeatures,
  templateOrKey: ProjectTemplate | ProjectTemplateKey | null | undefined,
): import("./pipeline.js").PipelineFeatures {
  const template =
    typeof templateOrKey === "string"
      ? getProjectTemplate(templateOrKey)
      : templateOrKey;
  if (!template || template.lockedSettings.length === 0) {
    return pipelineFeaturesSchema.parse(pipeline);
  }

  const nextPipeline = JSON.parse(JSON.stringify(pipeline)) as Record<
    string,
    unknown
  >;

  for (const lockedSetting of template.lockedSettings) {
    const path = projectTemplateLockedSettingPaths[lockedSetting];
    const lockedValue = readNestedValue(template.pipeline, path);
    if (lockedValue !== undefined) {
      writeNestedValue(nextPipeline, path, lockedValue);
    }
  }

  return pipelineFeaturesSchema.parse(nextPipeline);
}

/**
 * The pipeline a run in this project uses: per-request overrides merged onto
 * the project pipeline, then the project template's locked settings
 * re-applied so an upload can never unlock them.
 */
export function applyProjectPipelineOverrides(
  base: import("./pipeline.js").PipelineFeatures | null | undefined,
  overrides: import("./pipeline.js").PipelineFeatureOverrides | null | undefined,
  templateOrKey: ProjectTemplate | ProjectTemplateKey | null | undefined,
): import("./pipeline.js").PipelineFeatures {
  return applyProjectTemplateLocks(mergePipelineFeatures(base, overrides), templateOrKey);
}

/** Settings a project template fixes; the settings UI shows them read-only. */
export function projectTemplateLockedSettings(
  templateKey: ProjectTemplateKey | null | undefined,
): ProjectTemplateLockedSetting[] {
  return getProjectTemplate(templateKey)?.lockedSettings ?? [];
}

export const projectTemplates: ProjectTemplate[] = [
  {
    key: "legal-contracts",
    name: "Legal Contracts",
    description:
      "High-fidelity extraction with page indexing and cost controls for long-form agreements.",
    pipeline: buildTemplatePipeline({
      // Vocabulary only; the graph stays off until the project enables it.
      graph: { entityTypes: ["party", "agreement", "clause", "obligation", "date", "amount", "jurisdiction"] },
      quality: "auto",
      preserveTables: true,
      preserveCode: true,
      pageIndex: true,
      // strict-privacy forbids hosted models. Summaries need a hosted text
      // model, so they stay off; vision and embeddings use local routes.
      summarize: false,
      privacyMode: "strict-privacy",
      piiPolicy: {
        enabled: true,
        action: "flag_for_review",
      },
      vision: {
        profile: "cheapest-local",
      },
      embedding: {
        profile: "good-fast-local",
      },
    }),
    lockedSettings: [
      "quality",
      "preserveTables",
      "preserveCode",
      "pageIndex",
      "summarize",
      "privacyMode",
      "piiPolicy.enabled",
      "piiPolicy.action",
      "embedding",
    ],
  },
  {
    key: "medical-records",
    name: "Medical Records",
    description:
      "OCR-friendly extraction with multilingual embeddings and structured capture for noisy scans.",
    pipeline: buildTemplatePipeline({
      // Vocabulary only; the graph stays off until the project enables it.
      graph: { entityTypes: ["patient", "clinician", "condition", "medication", "procedure", "facility", "date"] },
      quality: "auto",
      visionFallback: true,
      // strict-privacy forbids hosted models: local Florence OCR for vision,
      // and summaries/propositions (hosted text models only) stay off.
      vision: {
        profile: "cheapest-local",
        benchmarkProfile: "ocr-heavy",
      },
      preserveTables: true,
      pageIndex: true,
      summarize: false,
      propositionIndex: false,
      privacyMode: "strict-privacy",
      piiPolicy: {
        enabled: true,
        action: "redact_artifacts",
      },
      embedding: {
        profile: "multilingual-local",
      },
    }),
    lockedSettings: [
      "quality",
      "visionFallback",
      "vision.benchmarkProfile",
      "preserveTables",
      "pageIndex",
      "summarize",
      "propositionIndex",
      "privacyMode",
      "piiPolicy.enabled",
      "piiPolicy.action",
      "embedding",
    ],
  },
  {
    key: "financial-reports",
    name: "Financial Reports",
    description:
      "Table-preserving extraction with chunk overlap for dense filings and earnings decks.",
    pipeline: buildTemplatePipeline({
      // Vocabulary only; the graph stays off until the project enables it.
      graph: { entityTypes: ["company", "metric", "segment", "period", "amount", "person", "risk"] },
      quality: "auto",
      preserveTables: true,
      preserveImages: true,
      pageIndex: true,
      chunkOverlap: true,
      summarize: true,
      embedding: {
        profile: "cheapest-hosted",
      },
    }),
    lockedSettings: [
      "quality",
      "preserveTables",
      "preserveImages",
      "pageIndex",
      "chunkOverlap",
      "summarize",
      "embedding",
    ],
  },
  {
    key: "engineering-docs",
    name: "Engineering Docs",
    description:
      "Code- and diagram-friendly retrieval tuned for manuals, specs, and design docs.",
    pipeline: buildTemplatePipeline({
      // Vocabulary only; the graph stays off until the project enables it.
      graph: { entityTypes: ["component", "service", "api", "configuration", "team", "requirement", "version"] },
      quality: "auto",
      preserveCode: true,
      preserveImages: true,
      chunkOverlap: true,
      pageIndex: true,
      embedding: {
        profile: "code-local",
      },
    }),
    lockedSettings: [
      "quality",
      "preserveCode",
      "preserveImages",
      "chunkOverlap",
      "pageIndex",
      "embedding",
    ],
  },
  {
    key: "meeting-notes",
    name: "Meeting Notes",
    description:
      "Fast low-cost defaults for notes, transcripts, and recap-heavy corpora.",
    pipeline: buildTemplatePipeline({
      // Vocabulary only; the graph stays off until the project enables it.
      graph: { entityTypes: ["person", "team", "decision", "action_item", "project", "date"] },
      quality: "fast",
      visionFallback: false,
      summarize: true,
      propositionIndex: true,
      inferenceLane: "realtime",
    }),
    lockedSettings: [
      "quality",
      "visionFallback",
      "summarize",
      "propositionIndex",
      "inferenceLane",
    ],
  },
];
