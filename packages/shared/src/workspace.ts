import { workspaceSettingsProposalSchema } from "./workspace-settings-proposal.js";
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
  workspaceMemberRoleSchema,
} from "./pipeline.js";
import {
  workspaceRunProgressSnapshotSchema,
  workspaceRunSchema,
} from "./run.js";

export const workspaceTemplateKeySchema = z.enum([
  "legal-contracts",
  "medical-records",
  "financial-reports",
  "engineering-docs",
  "meeting-notes",
]);
export type WorkspaceTemplateKey = z.infer<typeof workspaceTemplateKeySchema>;

export const workspaceTemplateLockedSettingSchema = z.enum([
  "parserPlaybook",
  "visionFallback",
  "vision.benchmarkProfile",
  "vision.maxPagesPerDocument",
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
export type WorkspaceTemplateLockedSetting = z.infer<
  typeof workspaceTemplateLockedSettingSchema
>;

/**
 * Reserved workspace ID: the caller's organization default workspace. Accepted
 * wherever a workspaceId is (bodies, query strings, `/v1/workspaces/default/...`)
 * and the SDK/CLI default when DOCSLURP_WORKSPACE_ID is unset. Real workspace
 * IDs are UUIDs, so the alias can never collide with one.
 */
export const DEFAULT_WORKSPACE_ALIAS = "default";

export function isDefaultWorkspaceAlias(workspaceId: string | null | undefined): boolean {
  return workspaceId?.trim() === DEFAULT_WORKSPACE_ALIAS;
}

export const workspaceSchema = z.object({
  id: z.string(),
  /** Readable URL identifier (e.g. amber-falcon-ridge); prefer it over the UUID in links. */
  slug: z.string(),
  userId: z.string(),
  orgId: z.string(),
  name: z.string(),
  templateKey: workspaceTemplateKeySchema.nullable().default(null),
  systemPrompt: z.string().max(2000).nullable().default(null),
  /** Generate reusable document summaries to improve search results. One-time generation and embedding cost per processed document version; reprocessing can incur it again. */
  summaries: z.boolean().default(true),
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
  /** Retained versions per document for this workspace; null inherits the organization's setting. */
  retainDocumentVersions: z.number().int().min(1).max(100).nullable().default(null),
  /** Skip the confirm dialog for re-index-queuing changes; recommended changes re-index when `apply` is omitted. */
  autoConfirmReindex: z.boolean().default(false),
  runCount: z.number().int().nonnegative().default(0),
  searchSessionCount: z.number().int().nonnegative().default(0),
  chatThreadCount: z.number().int().nonnegative().default(0),
  chatMessageCount: z.number().int().nonnegative().default(0),
  latestRunId: z.string().nullable().default(null),
  latestRunStatus: runStatusSchema.nullable().default(null),
  archivedAt: z.string().nullable().default(null),
  /** The organization's default workspace receives requests that omit a workspaceId. */
  isDefault: z.boolean().default(false),
  lastActivityAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceRecord = z.infer<typeof workspaceSchema>;

export const workspaceBoardSummarySchema = z.object({
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
export type WorkspaceBoardSummary = z.infer<typeof workspaceBoardSummarySchema>;

export const workspaceBoardRecordSchema = z.object({
  workspace: workspaceSchema,
  run: workspaceRunSchema.nullable().default(null),
  snapshot: workspaceRunProgressSnapshotSchema.nullable().default(null),
  summary: workspaceBoardSummarySchema,
});
export type WorkspaceBoardRecord = z.infer<typeof workspaceBoardRecordSchema>;

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

export const workspaceMemberSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
  email: z.string().email().nullable().default(null),
  name: z.string().nullable().default(null),
  role: workspaceMemberRoleSchema,
  invitedByUserId: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type WorkspaceMemberRecord = z.infer<typeof workspaceMemberSchema>;

export const workspaceInviteStatusSchema = z.enum([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export type WorkspaceInviteStatus = z.infer<typeof workspaceInviteStatusSchema>;

export const workspaceInviteSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  orgId: z.string(),
  email: z.string().email(),
  role: workspaceMemberRoleSchema,
  token: z.string(),
  status: workspaceInviteStatusSchema,
  invitedByUserId: z.string(),
  acceptedByUserId: z.string().nullable().default(null),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type WorkspaceInviteRecord = z.infer<typeof workspaceInviteSchema>;

export const workspaceTemplateSchema = z.object({
  key: workspaceTemplateKeySchema,
  name: z.string(),
  description: z.string(),
  pipeline: pipelineFeaturesSchema,
  lockedSettings: z.array(workspaceTemplateLockedSettingSchema).default([]),
});
export type WorkspaceTemplate = z.infer<typeof workspaceTemplateSchema>;

export const workspaceChatRoleSchema = z.enum(["user", "assistant", "system"]);
export type WorkspaceChatRole = z.infer<typeof workspaceChatRoleSchema>;

export const workspaceChatModeSchema = z.enum(["retrieval", "whole-corpus"]);
export type WorkspaceChatMode = z.infer<typeof workspaceChatModeSchema>;

export const workspaceChatFallbackReasonSchema = z.enum([
  "empty-workspace",
  "document-limit-exceeded",
  "chunk-limit-exceeded",
  "token-limit-exceeded",
  "char-limit-exceeded",
  "load-failed",
  "model-unavailable",
  "generation-failed",
]);
export type WorkspaceChatFallbackReason = z.infer<
  typeof workspaceChatFallbackReasonSchema
>;

export const workspaceChatSessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  createdAt: z.string(),
});
export type WorkspaceChatSession = z.infer<typeof workspaceChatSessionSchema>;

export const workspaceChatTurnSchema = z.object({
  sessionId: z.string(),
  role: workspaceChatRoleSchema,
  content: z.string(),
  createdAt: z.string(),
});
export type WorkspaceChatTurn = z.infer<typeof workspaceChatTurnSchema>;

export const workspaceChatWholeCorpusDebugSchema = z.object({
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
  fallbackReason: workspaceChatFallbackReasonSchema.nullable().default(null),
});
export type WorkspaceChatWholeCorpusDebug = z.infer<
  typeof workspaceChatWholeCorpusDebugSchema
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
   * Omitted or true: offered when the deployment, the workspace's
   * `pipeline.webTools` and its privacy mode allow them; a request cannot
   * enable them past those policies.
   */
  web: z.boolean().optional(),
  /**
   * Suggestions mode (the agent flags ingestion and search problems and
   * proposes workspace-setting changes for a person to Apply) is a DocSlurp
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
 * workspace setting, privacy mode or key scope does not allow them).
 */
export const chatAgentModesSchema = z.object({
  web: z.enum(["on", "off", "unavailable"]),
  suggestions: z.boolean(),
});
export type ChatAgentModes = z.infer<typeof chatAgentModesSchema>;

export const workspaceChatDebugSchema = z.object({
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
    settingsProposal: workspaceSettingsProposalSchema.optional(),
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
  mode: workspaceChatModeSchema.default("retrieval"),
  wholeCorpus: workspaceChatWholeCorpusDebugSchema,
});
export type WorkspaceChatDebug = z.infer<typeof workspaceChatDebugSchema>;

export const workspaceSearchPinnedResultSchema = z
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
export type WorkspaceSearchPinnedResult = z.infer<
  typeof workspaceSearchPinnedResultSchema
>;

/** Explicit retrieval windows are bounded independently of returned result count. */
export const searchCandidateDepthSchema = z.number().int().min(1).max(200);
export const searchResultOrderSchema = z.enum(["relevance", "prompt"]);
export type SearchResultOrder = z.infer<typeof searchResultOrderSchema>;

export const workspaceSearchRetrievalDefaultsSchema = z.object({
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
  // Graph controls stay unset unless the workspace chooses them, so retrieval
  // can derive them from the pipeline (graphRag / entityIndex / communities).
  enableGraphExpansion: z.boolean().optional(),
  enableCommunityExpansion: z.boolean().optional(),
  graphHops: z.number().int().min(1).max(3).optional(),
  // Relevance floor (0..1, 0 = off). Unset: the SEARCH_MIN_SCORE environment default applies.
  minScore: z.number().min(0).max(1).optional(),
});
export type WorkspaceSearchRetrievalDefaults = z.infer<
  typeof workspaceSearchRetrievalDefaultsSchema
>;

/**
 * Chat retrieves at most this many passages per answer (and cites the best 6),
 * even though search allows up to 50. Every retrieved passage goes into the
 * model prompt, so the cap bounds prompt size, latency and cost per answer;
 * use search (or the MCP search tools) to page through more results.
 */
export const CHAT_MAX_RETRIEVED_PASSAGES = 12;

/** Retrieval changes scoped to one chat thread; they never touch workspace defaults. */
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
  documentIds: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  mimeTypes: z.array(z.string().trim().min(1).max(200)).max(24).optional(),
  tags: documentTagsSchema.optional(),
  /** Indexed on or after this day (UTC). */
  dateFrom: isoDateSchema.optional(),
  /** Indexed on or before this day (UTC). */
  dateTo: isoDateSchema.optional(),
}).strict();
export type ChatSearchFilters = z.infer<typeof chatSearchFiltersSchema>;

export const workspaceSearchChatSettingsSchema = z.object({
  /** Workspace chat on or off. Off rejects every chat surface (app, /v1/chat, chat/completions, MCP). */
  enabled: z.boolean().default(true),
  mode: workspaceChatModeSchema.default("retrieval"),
  answerStyle: z.enum(["concise", "balanced", "detailed"]).default("balanced"),
  citations: z.boolean().default(true),
  searchInstructions: z.string().trim().max(2000).nullable().default(null),
});
export type WorkspaceSearchChatSettings = z.infer<
  typeof workspaceSearchChatSettingsSchema
>;

export const updateWorkspaceSearchRetrievalDefaultsSchema = z.object({
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
  // null clears the workspace choice so the environment default applies again.
  minScore: z.number().min(0).max(1).nullable().optional(),
});

export const updateWorkspaceSearchChatSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  mode: workspaceChatModeSchema.optional(),
  answerStyle: z.enum(["concise", "balanced", "detailed"]).optional(),
  citations: z.boolean().optional(),
  searchInstructions: z.string().trim().max(2000).nullable().optional(),
});

export const updateWorkspaceSearchBoostsSchema = z.object({
  any: z.number().optional(),
  byMime: z.record(z.string(), z.number()).optional(),
});

export const workspaceSearchSettingsSchema = z.object({
  workspaceId: z.string(),
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
  pinnedResults: z.array(workspaceSearchPinnedResultSchema).default([]),
  synonyms: z.record(z.string(), z.array(z.string())).default({}),
  retrievalDefaults: workspaceSearchRetrievalDefaultsSchema.default({
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
  chat: workspaceSearchChatSettingsSchema.default({
    enabled: true,
    mode: "retrieval",
    answerStyle: "balanced",
    citations: true,
    searchInstructions: null,
  }),
  compatSettings: z.record(z.string(), z.unknown()).default({}),
  rules: z.array(z.record(z.string(), z.unknown())).default([]),
  compatMetadata: z.record(z.string(), z.unknown()).default({}),
});
export type WorkspaceSearchSettings = z.infer<
  typeof workspaceSearchSettingsSchema
>;

export const defaultWorkspaceSearchSettings =
  workspaceSearchSettingsSchema.parse({
    workspaceId: "",
    userId: "",
  });

export const updateWorkspaceSearchSettingsSchema = z.object({
  typoTolerance: z.boolean().optional(),
  dedupeByFilename: z.boolean().optional(),
  rankingRules: z.record(z.string(), z.unknown()).optional(),
  boosts: updateWorkspaceSearchBoostsSchema.optional(),
  pinnedResults: z.array(workspaceSearchPinnedResultSchema).optional(),
  synonyms: z.record(z.string(), z.array(z.string())).optional(),
  retrievalDefaults: updateWorkspaceSearchRetrievalDefaultsSchema.optional(),
  chat: updateWorkspaceSearchChatSettingsSchema.optional(),
});
export type UpdateWorkspaceSearchSettingsInput = z.infer<
  typeof updateWorkspaceSearchSettingsSchema
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
  status: workspaceInviteStatusSchema,
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

export const updateWorkspaceMemberSchema = z.object({
  role: workspaceMemberRoleSchema,
});
export type UpdateWorkspaceMemberInput = z.infer<
  typeof updateWorkspaceMemberSchema
>;

export const createWorkspaceInviteSchema = z.object({
  userId: z.string().default("demo-user"),
  email: z.string().email(),
  role: workspaceMemberRoleSchema.default("viewer"),
  expiresInDays: z.number().int().positive().max(30).default(7),
});
export type CreateWorkspaceInviteInput = z.infer<
  typeof createWorkspaceInviteSchema
>;

export const acceptWorkspaceInviteSchema = z.object({
  userId: z.string().default("demo-user"),
});
export type AcceptWorkspaceInviteInput = z.infer<
  typeof acceptWorkspaceInviteSchema
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
export const reprocessRunSchema = z
  .object({
    stages: z.array(pipelineRunStageSchema).min(1).optional(),
    stageFrom: pipelineRunStageSchema.optional(),
  })
  .refine((value) => !(value.stages && value.stageFrom), {
    message: "Use either stages or stageFrom, not both",
    path: ["stages"],
  });
export type ReprocessRunInput = z.infer<typeof reprocessRunSchema>;

export const createWorkspaceSchema = z.object({
  userId: z.string().default("demo-user"),
  orgId: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  /** Preferred slug. Invalid or reserved: a generated one; taken by another workspace: suffixed. */
  slug: z.string().trim().min(1).max(63).optional(),
  templateKey: workspaceTemplateKeySchema.optional(),
  systemPrompt: z.string().trim().max(2000).nullable().optional(),
  /** Enabled by default. Adds a one-time per-document processing cost to improve search results; privacy/template restrictions still apply. */
  summaries: z.boolean().default(true),
  pipeline: pipelineFeaturesSchema.optional(),
});
export type CreateWorkspaceInput = z.input<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  /** Renaming keeps old slugs resolving to this workspace. */
  slug: z.string().trim().min(3).max(63).optional(),
  templateKey: workspaceTemplateKeySchema.nullable().optional(),
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
});
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

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

const workspaceTemplateLockedSettingPaths: Record<
  WorkspaceTemplateLockedSetting,
  string[]
> = {
  parserPlaybook: ["parserPlaybook"],
  visionFallback: ["visionFallback"],
  "vision.benchmarkProfile": ["vision", "benchmarkProfile"],
  "vision.maxPagesPerDocument": ["vision", "maxPagesPerDocument"],
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

export function getWorkspaceTemplate(
  key: WorkspaceTemplateKey | null | undefined,
): WorkspaceTemplate | null {
  if (!key) {
    return null;
  }

  return workspaceTemplates.find((template) => template.key === key) ?? null;
}

export function applyWorkspaceTemplateLocks(
  pipeline: import("./pipeline.js").PipelineFeatures,
  templateOrKey: WorkspaceTemplate | WorkspaceTemplateKey | null | undefined,
): import("./pipeline.js").PipelineFeatures {
  const template =
    typeof templateOrKey === "string"
      ? getWorkspaceTemplate(templateOrKey)
      : templateOrKey;
  if (!template || template.lockedSettings.length === 0) {
    return pipelineFeaturesSchema.parse(pipeline);
  }

  const nextPipeline = JSON.parse(JSON.stringify(pipeline)) as Record<
    string,
    unknown
  >;

  for (const lockedSetting of template.lockedSettings) {
    const path = workspaceTemplateLockedSettingPaths[lockedSetting];
    const lockedValue = readNestedValue(template.pipeline, path);
    if (lockedValue !== undefined) {
      writeNestedValue(nextPipeline, path, lockedValue);
    }
  }

  return pipelineFeaturesSchema.parse(nextPipeline);
}

/**
 * The pipeline a run in this workspace uses: per-request overrides merged onto
 * the workspace pipeline, then the workspace template's locked settings
 * re-applied so an upload can never unlock them.
 */
export function applyWorkspacePipelineOverrides(
  base: import("./pipeline.js").PipelineFeatures | null | undefined,
  overrides: import("./pipeline.js").PipelineFeatureOverrides | null | undefined,
  templateOrKey: WorkspaceTemplate | WorkspaceTemplateKey | null | undefined,
): import("./pipeline.js").PipelineFeatures {
  return applyWorkspaceTemplateLocks(mergePipelineFeatures(base, overrides), templateOrKey);
}

/** Settings a workspace template fixes; the settings UI shows them read-only. */
export function workspaceTemplateLockedSettings(
  templateKey: WorkspaceTemplateKey | null | undefined,
): WorkspaceTemplateLockedSetting[] {
  return getWorkspaceTemplate(templateKey)?.lockedSettings ?? [];
}

export const workspaceTemplates: WorkspaceTemplate[] = [
  {
    key: "legal-contracts",
    name: "Legal Contracts",
    description:
      "High-fidelity extraction with page indexing and cost controls for long-form agreements.",
    pipeline: buildTemplatePipeline({
      // Vocabulary only; the graph stays off until the workspace enables it.
      graph: { entityTypes: ["party", "agreement", "clause", "obligation", "date", "amount", "jurisdiction"] },
      parserPlaybook: "review-grade",
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
      "parserPlaybook",
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
      // Vocabulary only; the graph stays off until the workspace enables it.
      graph: { entityTypes: ["patient", "clinician", "condition", "medication", "procedure", "facility", "date"] },
      parserPlaybook: "review-grade",
      visionFallback: true,
      // strict-privacy forbids hosted models: local Florence OCR for vision,
      // and summaries/propositions (hosted text models only) stay off.
      vision: {
        profile: "cheapest-local",
        benchmarkProfile: "ocr-heavy",
        maxPagesPerDocument: 8,
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
      "parserPlaybook",
      "visionFallback",
      "vision.benchmarkProfile",
      "vision.maxPagesPerDocument",
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
      // Vocabulary only; the graph stays off until the workspace enables it.
      graph: { entityTypes: ["company", "metric", "segment", "period", "amount", "person", "risk"] },
      parserPlaybook: "layout-aware",
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
      "parserPlaybook",
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
      // Vocabulary only; the graph stays off until the workspace enables it.
      graph: { entityTypes: ["component", "service", "api", "configuration", "team", "requirement", "version"] },
      parserPlaybook: "layout-aware",
      preserveCode: true,
      preserveImages: true,
      chunkOverlap: true,
      pageIndex: true,
      embedding: {
        profile: "code-local",
      },
    }),
    lockedSettings: [
      "parserPlaybook",
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
      // Vocabulary only; the graph stays off until the workspace enables it.
      graph: { entityTypes: ["person", "team", "decision", "action_item", "project", "date"] },
      parserPlaybook: "fast",
      visionFallback: false,
      summarize: true,
      propositionIndex: true,
      inferenceLane: "realtime",
    }),
    lockedSettings: [
      "parserPlaybook",
      "visionFallback",
      "summarize",
      "propositionIndex",
      "inferenceLane",
    ],
  },
];
