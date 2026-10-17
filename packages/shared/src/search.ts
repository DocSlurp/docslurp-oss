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
  costCents: z.number().nonnegative().optional(),
  costSource: z.string().optional(),
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
});
export type WorkspaceChatResponse = z.infer<typeof workspaceChatResponseSchema>;

export const aiLatencyClassSchema = z.enum([
  "interactive",
  "standard",
  "batch",
]);
export type AiLatencyClass = z.infer<typeof aiLatencyClassSchema>;

export const aiOutputFormatSchema = z.enum([
  "answer",
  "json",
  "grounded-summary",
]);
export type AiOutputFormat = z.infer<typeof aiOutputFormatSchema>;

export const aiOperationStatusSchema = z.enum([
  "queued",
  "running",
  "needs-approval",
  "completed",
  "failed",
  "cancelled",
]);
export type AiOperationStatus = z.infer<typeof aiOperationStatusSchema>;

export const searchFilterInputSchema = z.object({
  documentId: z.string().optional(),
  documentIds: z.array(z.string()).optional(),
  runId: z.string().optional(),
  workspaceId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  pageFrom: z.number().int().positive().optional(),
  pageTo: z.number().int().positive().optional(),
  language: z.string().optional(),
  heading: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  filenameContains: z.string().optional(),
  mimeTypes: z.array(z.string()).optional(),
});
export type SearchFilterInput = z.infer<typeof searchFilterInputSchema>;

export const groundedSummaryClaimSchema = z.object({
  claim: z.string(),
  citationIndices: z.array(z.number().int().nonnegative()).min(1),
  citations: z.array(searchCitationSchema).min(1),
  sourceSpans: z.array(workspaceChatEvidenceSpanSchema).default([]),
});
export type GroundedSummaryClaim = z.infer<typeof groundedSummaryClaimSchema>;

export const groundedSummarySchema = z.object({
  id: z.string(),
  documentId: z.string().nullable().default(null),
  runId: z.string().nullable().default(null),
  scope: z.enum(["document", "workspace", "section"]).default("workspace"),
  sectionKey: z.string().nullable().default(null),
  summary: z.string(),
  claims: z.array(groundedSummaryClaimSchema).default([]),
  citations: z.array(searchResultSchema).default([]),
  evidenceSpans: z.array(workspaceChatEvidenceSpanSchema).default([]),
  sourceFingerprint: z.string(),
  createdAt: z.string(),
});
export type GroundedSummary = z.infer<typeof groundedSummarySchema>;

export const aiCostEstimateSchema = z.object({
  currency: z.literal("USD"),
  estimatedCostCents: z.number().int().nonnegative(),
  maxCostCents: z.number().int().nonnegative().nullable().default(null),
  requiresApproval: z.boolean().default(false),
  reason: z.string().nullable().default(null),
  breakdown: z
    .array(
      z.object({
        label: z.string(),
        estimatedCostCents: z.number().int().nonnegative(),
        detail: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
export type AiCostEstimate = z.infer<typeof aiCostEstimateSchema>;

export const aiOperationResultSchema = z.object({
  answer: z.string().nullable().default(null),
  citations: z.array(searchResultSchema).default([]),
  evidenceSpans: z.array(workspaceChatEvidenceSpanSchema).default([]),
  groundedSummary: groundedSummarySchema.nullable().default(null),
  searchSessionId: z.string().nullable().default(null),
  chatSessionId: z.string().nullable().default(null),
  output: z.unknown().nullable().default(null),
  partial: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
});
export type AiOperationResult = z.infer<typeof aiOperationResultSchema>;

export const aiOperationEventSchema = z.object({
  id: z.string(),
  operationId: z.string(),
  sequence: z.number().int().nonnegative(),
  type: z.enum([
    "queued",
    "preflight",
    "approval-required",
    "ingest-started",
    "ingest-completed",
    "retrieval-started",
    "retrieval-completed",
    "summary-started",
    "summary-completed",
    "answer-started",
    "answer-completed",
    "webhook-dispatched",
    "completed",
    "failed",
  ]),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type AiOperationEvent = z.infer<typeof aiOperationEventSchema>;

export const aiOperationSchema = z.object({
  id: z.string(),
  kind: z.enum(["simple", "advanced", "mcp-tool"]),
  status: aiOperationStatusSchema,
  latencyClass: aiLatencyClassSchema,
  outputFormat: aiOutputFormatSchema,
  userId: z.string(),
  orgId: z.string(),
  workspaceId: z.string().nullable().default(null),
  apiKeyId: z.string().nullable().default(null),
  goal: z.string(),
  costEstimate: aiCostEstimateSchema,
  maxCostCents: z.number().int().nonnegative().nullable().default(null),
  result: aiOperationResultSchema.nullable().default(null),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  request: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});
export type AiOperation = z.infer<typeof aiOperationSchema>;

export const aiWebhookConfigSchema = z.object({
  webhookId: z.string().optional(),
  events: z
    .array(z.enum(["progress", "completed", "failed"]))
    .default(["completed", "failed"]),
});
export type AiWebhookConfig = z.infer<typeof aiWebhookConfigSchema>;

export const aiSimpleRequestSchema = z.object({
  userId: z.string().default("demo-user"),
  workspaceId: z.string(),
  goal: z.string().min(1),
  sourceUrls: z.array(z.string().url()).default([]),
  waitForIndex: z.boolean().default(true),
  stream: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  maxCostCents: z.number().int().nonnegative().optional(),
  requireExplicitApprovalAboveCents: z.number().int().nonnegative().optional(),
  // No approveCostEstimate: a request that needs cost approval waits in
  // needs-approval until a human calls POST /v1/ai/operations/:id/approve.
  // Callers (including MCP, WebMCP and chat models) cannot pre-approve it.
  webhook: aiWebhookConfigSchema.optional(),
});
export type AiSimpleRequest = z.infer<typeof aiSimpleRequestSchema>;

export const aiAdvancedRequestSchema = aiSimpleRequestSchema.extend({
  outputFormat: aiOutputFormatSchema.default("answer"),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  latencyClass: aiLatencyClassSchema.default("standard"),
  filters: searchFilterInputSchema.optional(),
  limit: z.number().int().positive().max(50).default(8),
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
  summarySeed: z.boolean().default(false),
  parentRetrieval: z.boolean().default(true),
  citationDepth: z.enum(["compact", "full"]).default("full"),
  partialResults: z.boolean().default(true),
  selfQuery: z.boolean().default(true),
  documentId: z.string().optional(),
  sectionKey: z.string().optional(),
});
export type AiAdvancedRequest = z.infer<typeof aiAdvancedRequestSchema>;

export const aggregateWorkspaceRagSearchRequestSchema = z
  .object({
    q: z.string().min(1).optional(),
    goal: z.string().min(1).optional(),
    workspaceIds: z.array(z.string().min(1)).default([]),
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

export const aiSubmitResponseSchema = z.object({
  operation: aiOperationSchema,
  events: z.array(aiOperationEventSchema).default([]),
  streamUrl: z.string().nullable().default(null),
  pollUrl: z.string(),
  replayed: z.boolean().default(false),
});
export type AiSubmitResponse = z.infer<typeof aiSubmitResponseSchema>;

export const capabilityAnnotationsSchema = z.object({
  /** Does not modify stored data; safe to call without confirmation. */
  readOnly: z.boolean().default(false),
  /** Can delete or overwrite data. */
  destructive: z.boolean().default(false),
  /** Repeating the same call has the same effect as calling it once. */
  idempotent: z.boolean().default(false),
  /** Interacts with resources outside the account. */
  openWorld: z.boolean().default(false),
}).default({ readOnly: false, destructive: false, idempotent: false, openWorld: false });
export type CapabilityAnnotations = z.infer<typeof capabilityAnnotationsSchema>;

export const aiCapabilitySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.enum(["tool", "resource", "prompt", "endpoint"]),
  endpoint: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  streaming: z.boolean().default(false),
  auth: z.object({
    type: z.enum(["apiKey", "session"]),
    scopes: z.array(z.string()).default([]),
    workspaceScoped: z.boolean().default(false),
    orgScoped: z.boolean().default(false),
  }),
  idempotent: z.boolean().default(false),
  costHints: z
    .object({
      baselineCostCents: z.number().int().nonnegative().default(0),
      billableMetrics: z.array(z.string()).default([]),
    })
    .default({ baselineCostCents: 0, billableMetrics: [] }),
  featureGates: z.array(z.string()).default([]),
  /** Agent-safety hints. Declared here once so every surface (MCP, WebMCP, chat) agrees. */
  annotations: capabilityAnnotationsSchema,
});
export type AiCapability = z.infer<typeof aiCapabilitySchema>;

export const aiCapabilityManifestSchema = z.object({
  server: z.object({
    id: z.string(),
    title: z.string(),
    version: z.string(),
    transports: z
      .array(z.enum(["http", "streamable-http", "sse", "stdio"]))
      .default(["http", "sse"]),
    auth: z.object({
      type: z.enum(["apiKey", "session"]),
      scopes: z.array(z.string()).default([]),
    }),
  }),
  capabilities: z.array(aiCapabilitySchema).default([]),
  resources: z.array(aiCapabilitySchema).default([]),
  prompts: z.array(aiCapabilitySchema).default([]),
});
export type AiCapabilityManifest = z.infer<typeof aiCapabilityManifestSchema>;

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
    /** UUID, slug, former slug or `default`; omitted means the org's default workspace. */
    workspaceId: z.string().min(1).optional(),
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
