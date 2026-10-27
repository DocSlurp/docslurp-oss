import { z } from "zod";
import { parserPlaybookKeySchema } from "./embedding.js";
import { defaultPipelineFeatures, pipelineFeaturesSchema } from "./pipeline.js";
import { searchCitationSchema } from "./chunks.js";
import {
  workspaceChatDebugSchema,
  workspaceChatModeSchema,
} from "./workspace.js";
import { ingestReportSchema } from "./ingest-report.js";

export const searchResultSchema = z.object({
  text: z.string(),
  score: z.number(),
  /** Raw match strength, 0..1, independent of the other hits (the relevance floor compares against it). */
  relevance: z.number().min(0).max(1).optional(),
  citation: searchCitationSchema,
  parentText: z.string().optional(),
  confidence: z
    .object({
      band: z.enum(["high", "medium", "low"]),
      score: z.number().min(0).max(1),
      reasons: z.array(z.string()).default([]),
    })
    .optional(),
  retrieval: z
    .object({
      stage: z.enum(["chunk", "page-text", "map-node", "page-image"]),
      temperature: z.enum(["cold", "warm", "hot"]).optional(),
    })
    .optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const workspaceChatEvidenceSpanSchema = z.object({
  citationIndex: z.number().int().nonnegative(),
  answerStart: z.number().int().nonnegative(),
  answerEnd: z.number().int().positive(),
  answerText: z.string(),
  sourceText: z.string(),
  sourceStart: z.number().int().nonnegative(),
  sourceEnd: z.number().int().nonnegative(),
  citation: searchCitationSchema,
});
export type WorkspaceChatEvidenceSpan = z.infer<
  typeof workspaceChatEvidenceSpanSchema
>;

export const workspaceChatUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  /** Provider cost in USD cents (not customer credits). On agent turns: the agent's own model calls only. */
  costCents: z.number().nonnegative().optional(),
  costSource: z.string().optional(),
  /** Agent turns: provider cost (USD cents) the tools reported for their own work, such as query embeddings, rewrites and nested answers. */
  toolCostCents: z.number().nonnegative().optional(),
});
export type WorkspaceChatUsage = z.infer<typeof workspaceChatUsageSchema>;

export const workspaceChatRuntimeSchema = z.object({
  startedAt: z.string(),
  completedAt: z.string(),
  totalMs: z.number().int().nonnegative(),
});
export type WorkspaceChatRuntime = z.infer<typeof workspaceChatRuntimeSchema>;

export const searchAvailabilityCoverageSchema = z.object({
  totalDocuments: z.number().int().nonnegative(),
  indexedDocuments: z.number().int().nonnegative(),
  pageIndexedDocuments: z.number().int().nonnegative(),
  searchableDocuments: z.number().int().nonnegative(),
  pageOnlyDocuments: z.number().int().nonnegative(),
  /** Served by keyword search before vector indexing finishes (SEARCH_EARLY_LEXICAL). */
  keywordOnlyDocuments: z.number().int().nonnegative().default(0),
  /** Documents that failed during processing; search still covers the rest. */
  failedDocuments: z.number().int().nonnegative().default(0),
  inProgressDocuments: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  searchablePages: z.number().int().nonnegative(),
  indexedChunkCount: z.number().int().nonnegative(),
  queuedRuns: z.number().int().nonnegative(),
  processingRuns: z.number().int().nonnegative(),
});
export type SearchAvailabilityCoverage = z.infer<
  typeof searchAvailabilityCoverageSchema
>;

export const searchAvailabilitySchema = z.object({
  status: z.enum(["empty", "pending", "partial", "complete"]),
  isPartial: z.boolean(),
  /** True when some searchable documents have keyword results only (no vectors yet). */
  keywordOnly: z.boolean().default(false),
  scope: z.object({
    workspaceId: z.string(),
    runId: z.string().nullable(),
  }),
  coverage: searchAvailabilityCoverageSchema,
  resultBreakdown: z.object({
    indexedResultCount: z.number().int().nonnegative(),
    pageResultCount: z.number().int().nonnegative(),
  }),
  message: z.string().nullable().default(null),
});
export type SearchAvailability = z.infer<typeof searchAvailabilitySchema>;

export const workspaceChatResponseSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  /**
   * Browser (client) keys only: the sealed grant to continue this session
   * (bound to the key, workspace and session; expires after 24 hours). Send
   * it back as `sessionToken` with `sessionId`; a session id alone is refused.
   */
  sessionToken: z.string().optional(),
  searchSessionId: z.string().nullable().default(null),
  answer: z.string(),
  finishReason: z.enum(["stop", "length", "content-filter"]).optional(),
  citations: z.array(searchResultSchema),
  evidenceSpans: z.array(workspaceChatEvidenceSpanSchema).default([]),
  availability: searchAvailabilitySchema.nullable().default(null),
  usage: workspaceChatUsageSchema,
  runtime: workspaceChatRuntimeSchema,
  debug: workspaceChatDebugSchema,
  /** Present when the turn was answered with the ingest report ("/status"); no model was called. */
  ingestReport: ingestReportSchema.optional(),
  /**
   * Present when the turn took the quick decline (a UX shortcut, not a safety
   * control): a first, unfiltered, non-web direct-answer question whose best
   * vector match was below `chat.scopeDeclineThreshold` and that no keyword or
   * graph evidence supported. The answer is a short polite decline with no
   * citations, plus related questions to ask instead. No model was called.
   */
  scopeDecline: z.object({
    /** Best vector match, rescaled above the embedding pipeline's noise baseline, 0..1. */
    relevance: z.number().min(0).max(1),
    threshold: z.number().min(0).max(1),
    /** The workspace's scope as shown in the decline. */
    scope: z.string(),
    suggestions: z.array(z.string()).max(3),
  }).optional(),
});
export type WorkspaceChatResponse = z.infer<typeof workspaceChatResponseSchema>;

export const aggregateWorkspaceRagSearchRequestSchema = z
  .object({
    q: z.string().min(1).optional(),
    goal: z.string().min(1).optional(),
    /** Workspace IDs, slugs or names (see parseWorkspaceInput). Empty: every workspace the caller can search. */
    workspaces: z.array(z.string().trim().min(1).max(256)).default([]),
    limitPerWorkspace: z.number().int().positive().max(25).default(5),
    maxWorkspaces: z.number().int().positive().max(50).default(12),
    maxCitations: z.number().int().positive().max(50).default(12),
    generateAnswer: z.boolean().default(true),
    includePartial: z.boolean().default(true),
    hyde: z.boolean().default(false),
    rerank: z.boolean().default(true),
    mmr: z.boolean().default(false),
    mmrLambda: z.number().min(0).max(1).optional(),
    /** Relevance floor, 0..1; 0 disables it. Omitted: workspace default, else SEARCH_MIN_SCORE. */
    minScore: z.number().min(0).max(1).optional(),
    compression: z.boolean().default(false),
    queryRewrite: z.boolean().default(true),
    queryDecompose: z.boolean().default(false),
    stepback: z.boolean().default(false),
    parentRetrieval: z.boolean().default(true),
    selfQuery: z.boolean().default(true),
    iterativeMultiHop: z.boolean().default(false),
    graphExpansion: z.boolean().default(false),
    communityExpansion: z.boolean().default(false),
    graphHops: z.number().int().min(1).max(3).optional(),
  })
  .refine((value) => Boolean(value.q?.trim() || value.goal?.trim()), {
    path: ["q"],
    message: "Provide q or goal.",
  });
export type AggregateWorkspaceRagSearchRequest = z.infer<
  typeof aggregateWorkspaceRagSearchRequestSchema
>;

// Run processing preview schemas

export const runProcessingPreviewFileSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type RunProcessingPreviewFile = z.infer<
  typeof runProcessingPreviewFileSchema
>;

export const runProcessingPreviewUrlSchema = z.object({
  url: z.string().url(),
});
export type RunProcessingPreviewUrl = z.infer<
  typeof runProcessingPreviewUrlSchema
>;

export const runProcessingPreviewRequestSchema = z
  .object({
    /** Workspace ID, slug or name (see parseWorkspaceInput); omitted means the org's default workspace. */
    workspace: z.string().trim().min(1).max(256).optional(),
    pipeline: pipelineFeaturesSchema.default(defaultPipelineFeatures),
    files: z.array(runProcessingPreviewFileSchema).default([]),
    urls: z.array(runProcessingPreviewUrlSchema).default([]),
  })
  .refine((value) => value.files.length > 0 || value.urls.length > 0, {
    message: "Provide at least one file or URL for preview.",
    path: ["files"],
  });
export type RunProcessingPreviewRequest = z.infer<
  typeof runProcessingPreviewRequestSchema
>;

export const runProcessingPreviewQualityLabelSchema = z.enum([
  "strong",
  "good",
  "watch",
  "risky",
]);
export type RunProcessingPreviewQualityLabel = z.infer<
  typeof runProcessingPreviewQualityLabelSchema
>;

export const runProcessingPreviewScenarioSchema = z.object({
  parserPlaybook: parserPlaybookKeySchema,
  label: z.string(),
  estimatedCost: z.object({
    minCents: z.number(),
    maxCents: z.number(),
  }),
  estimatedLatencyMinutes: z.number(),
  estimatedQualityScore: z.number().min(0).max(1),
  estimatedQualityLabel: runProcessingPreviewQualityLabelSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.array(z.string()).default([]),
  recommended: z.boolean().default(false),
});
export type RunProcessingPreviewScenario = z.infer<
  typeof runProcessingPreviewScenarioSchema
>;

export const runProcessingPreviewSchema = z.object({
  documentCount: z.number().int().nonnegative(),
  estimatedPages: z.number().int().positive(),
  totalBytes: z.number().int().nonnegative(),
  topSignals: z.array(z.string()).default([]),
  history: z.object({
    completedRuns: z.number().int().nonnegative(),
    sampledDocuments: z.number().int().nonnegative(),
    averagePlausibilityScore: z.number().min(0).max(1).nullable().default(null),
    averageLatencyMinutes: z.number().nonnegative().nullable().default(null),
  }),
  current: runProcessingPreviewScenarioSchema,
  recommended: runProcessingPreviewScenarioSchema,
  options: z.array(runProcessingPreviewScenarioSchema).min(1),
});
export type RunProcessingPreview = z.infer<typeof runProcessingPreviewSchema>;
