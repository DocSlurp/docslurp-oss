import { z } from "zod";
import { migrateStoredModelSettings } from "./stored-model-settings.js";
import {
  defaultDocumentExtractionConfig,
  documentExtractionConfigSchema,
} from "./extraction.js";
import {
  defaultEmbeddingConfig,
  defaultVisionConfig,
  embeddingConfigSchema,
  embeddingProfileCatalog,
  visionProfileCatalog,
  inferenceLaneSchema,
  vectorBackendSchema,
  visionConfigSchema,
  parseLlmModelUri,
} from "./embedding.js";
import { isProviderCallAllowed } from "./privacy.js";
import { decisionFormatSchema, routingObjectiveSchema } from "./page-routing.js";
import {
  indexingModeSchema,
  materializationPolicyOverridesSchema,
} from "./deferred-indexing.js";
import { isPrivateModelUri, parsePrivateModelUri } from "./private-endpoints.js";

export const organizationRoleSchema = z.enum([
  "owner",
  "admin",
  "member",
  "billing",
]);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const workspaceMemberRoleSchema = z.enum(["viewer", "editor", "admin"]);
export type WorkspaceMemberRole = z.infer<typeof workspaceMemberRoleSchema>;

export const runStatusSchema = z.enum([
  "queued",
  /** Saved but not admitted (no credits or budget); starts by itself when spend is available. */
  "blocked",
  "processing",
  "completed",
  "failed",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const stageExecutionStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);
export type StageExecutionStatus = z.infer<typeof stageExecutionStatusSchema>;

export const runStageSchema = z.enum([
  "queued",
  "quarantine",
  "format-detect",
  "to-canonical",
  "format-tooling",
  "normalize",
  "pdf-tooling",
  "split-pages",
  "render-images",
  "classify-route",
  "route-pages",
  "extract-markdown",
  "extract-html",
  "pii-detect",
  "vision-extract",
  "document-summary",
  "structured-extract",
  "embed",
  "graph-enrich",
  "page-index",
  "index",
  "proposition-index",
  "document-map",
  "page-embed",
  "completed",
]);
export type RunStage = z.infer<typeof runStageSchema>;
export type PipelineRunStage = Exclude<RunStage, "queued" | "completed">;
export const pipelineRunStageSchema = runStageSchema.exclude(["queued", "completed"]);
export type PipelineStagePhaseKey = "intake" | "prep" | "extract" | "index";

export type PipelineStagePlanItem = {
  stage: PipelineRunStage;
  label: string;
  phase: PipelineStagePhaseKey;
  phaseLabel: string;
  isEnabled: (features: PipelineFeatures) => boolean;
};

export interface CompiledPipelinePlanPhase {
  key: PipelineStagePhaseKey;
  label: string;
  stages: PipelineRunStage[];
}

export interface CompiledPipelinePlan {
  features: PipelineFeatures;
  /** Stages this run executes, in pipeline order. */
  stages: PipelineStagePlanItem[];
  stageOrder: PipelineRunStage[];
  phases: CompiledPipelinePlanPhase[];
  stagesByName: Record<PipelineRunStage, PipelineStagePlanItem>;
  /**
   * Enabled stages a partial run (restartFromStage / stageSubset) does not
   * execute: their outputs are reused from the source document. Empty for
   * full runs.
   */
  reusedStages: PipelineRunStage[];
  /** Stages a partial run executes although they were not selected, and why. */
  addedStages: Array<{ stage: PipelineRunStage; reason: string }>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOutputSchemaDefinition(
  schema: Record<string, unknown>,
  ctx: z.RefinementCtx,
) {
  if ((schema.type ?? null) !== "object") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outputSchema", "type"],
      message: "outputSchema.type must be 'object'",
    });
  }

  const properties = schema.properties;
  if (!isPlainRecord(properties) || Object.keys(properties).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outputSchema", "properties"],
      message: "outputSchema.properties must declare at least one field",
    });
  }

  const required = schema.required;
  if (required === undefined) {
    return;
  }

  if (!Array.isArray(required)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outputSchema", "required"],
      message: "outputSchema.required must be an array when provided",
    });
    return;
  }

  required.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputSchema", "required", index],
        message: "outputSchema.required entries must be non-empty strings",
      });
      return;
    }

    if (isPlainRecord(properties) && !(entry in properties)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputSchema", "required", index],
        message: `outputSchema.required references missing property '${entry}'`,
      });
    }
  });
}

/**
 * Workspace privacy execution mode. Enforced by the guard in `./privacy.ts`:
 * - `standard`: hosted AI providers may receive workspace content.
 * - `local-only`: no hosted/remote LLM, vision, embedding, rerank or STT calls;
 *   optional hosted-only stages are skipped, required ones fail closed.
 * - `strict-privacy`: same call policy as `local-only`, plus every blocked hosted
 *   attempt is recorded in `privacy_audit_log`.
 * Non-standard modes reject configs whose required routes are hosted-only (see
 * the superRefine on `pipelineFeaturesSchema`).
 */
export const privacyModeSchema = z.enum([
  "standard",
  "local-only",
  "strict-privacy",
]);
export type PrivacyMode = z.infer<typeof privacyModeSchema>;

// Model IDs belong in defaults/catalogs; runtime stages resolve workspace settings.
export const DEFAULT_PIPELINE_TEXT_MODEL = "qwen/qwen3.5-flash-02-23";
export const pipelineTextOperationSchema = z.enum([
  "document-summary", "document-map", "proposition-extraction", "structured-extraction",
  "graph-extraction", "community-summary", "contextual-chunk-preamble",
]);
export type PipelineTextOperation = z.infer<typeof pipelineTextOperationSchema>;
// OpenRouter model id, or an operator-registered private endpoint route
// (`llm://private/<alias>/<model>`); no other llm:// providers serve text stages.
const configuredTextModelSchema = z.string().trim().min(1).max(200).refine(
  (value) => !value.startsWith("llm://") || parsePrivateModelUri(value) !== null,
  "Text model routes must be OpenRouter ids or llm://private/<alias>/<model>",
);
export const textGenerationProfileSchema = z.enum(["provider-default", "grounded-low"]);
export type TextGenerationProfile = z.infer<typeof textGenerationProfileSchema>;
export const textReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "max"]);
export const textGenerationConfigSchema = z.object({
  model: configuredTextModelSchema.nullable().default(null),
  models: z.partialRecord(pipelineTextOperationSchema, configuredTextModelSchema).default({}),
  profile: textGenerationProfileSchema.nullable().optional(),
  reasoningEffort: textReasoningEffortSchema.nullable().optional(),
  reasoningEfforts: z.partialRecord(pipelineTextOperationSchema, textReasoningEffortSchema).optional(),
  maxOutputTokens: z.partialRecord(pipelineTextOperationSchema, z.number().int().min(1).max(16_384)).optional(),
});
export type TextGenerationConfig = z.infer<typeof textGenerationConfigSchema>;
export const defaultTextGenerationConfig: TextGenerationConfig = { model: null, models: {} };

// General source-faithful transformation policy; no model or fixture recognition.
export const groundedTextInstruction = "Use only facts explicitly supported by the supplied source. Do not invent contact roles, responsibilities, dates, causal ordering, or other claims absent from the source. Do not recommend actions or assign roles beyond what is stated. Preserve explicit negation and distinguish current terms from superseded terms. When evidence is missing, omit unsupported claims or use null where requested. Return a complete, concise response in the requested format.";
export const groundedTextTaskInstructions: Partial<Record<PipelineTextOperation, string>> = {
  "contextual-chunk-preamble": "Write a single complete plain-text sentence of at most 300 characters naming the main entities, document scope, and purpose. Omit detailed numbers, schedules, historical comparisons, and commentary about embedded instructions.",
  "community-summary": "Use at most 80 words in one plain-text paragraph. State the central entities and supported relationships; omit instructions to contact people and commentary about missing information.",
};
const groundedTextTokenLimits: Partial<Record<PipelineTextOperation, number>> = {
  "contextual-chunk-preamble": 128, "community-summary": 256,
};

export function resolvePipelineTextGenerationOptions(args: {
  operation: PipelineTextOperation;
  config?: TextGenerationConfig;
  deploymentProfile?: TextGenerationProfile;
  maxOutputTokens: number;
}) {
  const profile = args.config?.profile ?? args.deploymentProfile ?? "provider-default";
  const grounded = profile === "grounded-low";
  return {
    profile,
    reasoningEffort: args.config?.reasoningEfforts?.[args.operation] ?? args.config?.reasoningEffort ?? (grounded ? "low" as const : undefined),
    maxOutputTokens: args.config?.maxOutputTokens?.[args.operation] ?? (grounded ? groundedTextTokenLimits[args.operation] : undefined) ?? args.maxOutputTokens,
    systemSuffix: grounded ? [groundedTextInstruction, groundedTextTaskInstructions[args.operation]].filter(Boolean).join("\n\n") : undefined,
  };
}

/** Task override → workspace default → deployment default → built-in default. */
export function resolvePipelineTextModel(
  pipeline: { textGeneration?: TextGenerationConfig },
  operation: PipelineTextOperation,
  deploymentModel?: string,
): string {
  return pipeline.textGeneration?.models[operation]
    ?? pipeline.textGeneration?.model
    ?? deploymentModel
    ?? DEFAULT_PIPELINE_TEXT_MODEL;
}

export const structuredExtractionConfigSchema = z.object({
  model: configuredTextModelSchema.nullable().default(null),
  supportingPrompt: z.string().trim().max(2000).nullable().default(null),
  maxOutputTokens: z.number().int().min(256).max(16_384).default(4096),
});
export type StructuredExtractionConfig = z.infer<
  typeof structuredExtractionConfigSchema
>;

export const defaultStructuredExtractionConfig: StructuredExtractionConfig = {
  model: null,
  supportingPrompt: null,
  maxOutputTokens: 4096,
};

/** Entity types graph extraction uses when a workspace does not name its own. */
export const defaultGraphEntityTypes = [
  "person",
  "organization",
  "concept",
  "date",
  "location",
  "product",
] as const;

export const graphEntityTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/[\s-]+/g, "_"))
  .pipe(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "Entity types use letters, digits, and underscores"));

/**
 * Per-workspace knowledge-graph tuning. Every lever is optional: the defaults
 * extract a generic people/organization/concept graph that suits most corpora.
 *
 * - `domain`: plain-language description of the business, project, or scope so
 *   extraction favors the subjects and relationships that matter here.
 * - `entityTypes`: the node vocabulary. Empty uses the generic defaults.
 * - `depth`: how much of each document is read and how many facts are kept.
 */
export const graphConfigSchema = z.object({
  domain: z.string().trim().max(2000).nullable().default(null),
  entityTypes: z.array(graphEntityTypeSchema).max(16).default([]),
  depth: z.enum(["lean", "standard", "deep"]).default("standard"),
});
export type GraphConfig = z.infer<typeof graphConfigSchema>;
export type GraphDepth = GraphConfig["depth"];

export const defaultGraphConfig: GraphConfig = {
  domain: null,
  entityTypes: [],
  depth: "standard",
};

export const workspaceWebhookSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  events: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
});
export type WorkspaceWebhookSettings = z.infer<typeof workspaceWebhookSettingsSchema>;
export const defaultWorkspaceWebhookSettings: WorkspaceWebhookSettings = { enabled: true, events: [] };

/** True when this workspace lets `eventType` through to its users' webhooks. */
export function workspaceAllowsWebhookEvent(
  pipeline: { webhooks?: Partial<WorkspaceWebhookSettings> | null } | null | undefined,
  eventType: string,
): boolean {
  const settings = pipeline?.webhooks;
  if (!settings) return true;
  if (settings.enabled === false) return false;
  return !settings.events?.length || settings.events.includes(eventType);
}

/**
 * Default fallback chain (E3 requalification, 2026-10-12): Luna first, then Clef Flash and Jev. The Perplexity
 * decider stays last and is quarantined by the worker's health history until its noul and choice canaries have
 * both passed on three distinct UTC days; it also needs a calibration in the policy pack to serve. Liquid d1 is
 * opt-in only (list it explicitly): its calibrated answers are near chance on two of the three content questions
 * (calibration AUROC 0.52 plain_ocr / 0.81 math / 0.50 table) and E3 ranked it in the lowest band (pairwise AUROC
 * -0.06 vs Clef Flash).
 */
export const DEFAULT_PAGE_ROUTER_DECISION_MODELS: readonly string[] = [
  "openai/gpt-6-luna-decisions",
  "cloudflare/clef-flash",
  "typesafe/jev-1.13",
  "perplexity/pplx-decider-v1.1-27b",
];

export const pageRouterModeSchema = z.enum(["off", "shadow", "active"]);
export type PageRouterMode = z.infer<typeof pageRouterModeSchema>;

/**
 * Workspace page-router settings. `mode` is the opt-in: unset (or "off") leaves
 * the pipeline without a route-pages stage, so existing workspaces keep today's
 * behavior. The worker's PAGE_ROUTER_MODE env is a ceiling on top of this (see
 * resolvePageRouterMode). Routing decisions are made by decision models, never
 * by a generative LLM.
 */
export const pageRouterConfigSchema = z.object({
  mode: pageRouterModeSchema.optional(),
  objective: routingObjectiveSchema.default("cost-quality"),
  // Free feature routing by default; paid decision-model triage remains opt-in.
  router: z.enum(["heuristic", "baseline", "decision-model"]).default("baseline"),
  /**
   * One decision model id, or an ordered fallback chain. Each entry is used only while it is healthy
   * (known-answer canary + runtime degeneracy checks) and the policy pack has calibrations for it;
   * when none qualifies the no-model baseline router plans the document.
   */
  decisionModel: z
    .union([z.string().trim().min(1).max(200), z.array(z.string().trim().min(1).max(200)).min(1).max(8)])
    .default(() => [...DEFAULT_PAGE_ROUTER_DECISION_MODELS]),
  /** One page per call (W4: single-page 384px with facts + excerpt beats grids; Clef bills the state once per call). */
  triageFormat: decisionFormatSchema.default("per-page"),
  pagesPerCall: z.number().int().min(1).max(16).default(1),
  tilePx: z.number().int().min(128).max(1024).default(384),
  /** Chunk (per-document) budget for the router's own calls plus extraction, USD. */
  budgetPerDocumentUsd: z.number().min(0).max(100).default(1),
  /** Minimum gross margin fraction the org must retain on the chunk. */
  marginFloor: z.number().min(0).max(1).default(0.5),
  /**
   * USD the workspace gets from one unit (0..1) of page-content quality. The decision-model verifier
   * (TL3) only runs at or above 0.5: below that the free cascade checks capture the gain. Null/unset: no verifier.
   */
  valueUsdPerQualityUnit: z.number().min(0).max(1000).nullable().optional(),
});
export type PageRouterConfig = z.infer<typeof pageRouterConfigSchema>;
export const defaultPageRouterConfig: PageRouterConfig = pageRouterConfigSchema.parse({});

/** Normalizes `pageRouter.decisionModel` (single string or list) to an ordered, de-duplicated list. */
export function pageRouterDecisionModels(config: Pick<PageRouterConfig, "decisionModel">): string[] {
  const raw = Array.isArray(config.decisionModel) ? config.decisionModel : [config.decisionModel];
  return [...new Set(raw.map((id) => id.trim()).filter((id) => id.length > 0))];
}

const PAGE_ROUTER_MODE_RANK: Record<PageRouterMode, number> = { off: 0, shadow: 1, active: 2 };

/**
 * Effective page-router mode: the workspace setting capped by the worker env
 * ceiling. A missing value on either side means off, so nothing runs until both
 * the operator (env) and the workspace opt in.
 */
export function resolvePageRouterMode(
  workspaceMode: PageRouterMode | null | undefined,
  envMode: PageRouterMode | null | undefined,
): PageRouterMode {
  const w = workspaceMode ?? "off";
  const e = envMode ?? "off";
  return PAGE_ROUTER_MODE_RANK[w] <= PAGE_ROUTER_MODE_RANK[e] ? w : e;
}

/**
 * Platform default for a new run's `pageRouter.mode`, from the deployment's PAGE_ROUTER_MODE. A workspace that
 * sets a mode keeps it (the worker ceiling still applies). A workspace that leaves it unset gets `shadow` when the
 * platform runs shadow or active, so the route-pages stage is planned (the plan is compiled without the worker env)
 * and telemetry is gathered with no workspace setup. `active` is never a default: it stays an explicit workspace opt-in.
 */
export function withPlatformPageRouterMode<T extends { pageRouter?: Partial<PageRouterConfig> | null }>(
  features: T,
  platformMode: PageRouterMode | null | undefined,
): T {
  if (features.pageRouter?.mode !== undefined) return features;
  if (platformMode !== "shadow" && platformMode !== "active") return features;
  return { ...features, pageRouter: { ...(features.pageRouter ?? {}), mode: "shadow" } };
}

export const pipelineFeaturesSchema = z
  .object({
    // Deferred indexing: `full` indexes eagerly; `map`/`visual` defer parsing until a query needs pages.
    indexingMode: indexingModeSchema.default("full"),
    materialization: materializationPolicyOverridesSchema.default({}),
    visualPages: z
      .object({
        route: z.enum(["auto", "jina-private", "gemini"]).default("auto"),
        // Map mode only: embed uncovered pages of scanned documents at index time. Costs per page; off unless chosen.
        coarseFallback: z.boolean().default(false),
      })
      .default({ route: "auto", coarseFallback: false }),
    inferenceLane: inferenceLaneSchema.default("standard"),
    textGeneration: textGenerationConfigSchema.default(defaultTextGenerationConfig),
    // Named parser playbook selection controls which extraction/vision strategies to prefer.
    // Exposed as a coarse, opinionated knob rather than a dozen low-level flags.
    parserPlaybook: z
      .enum(["fast", "balanced", "layout-aware", "agentic", "review-grade"])
      .default("balanced"),
    documentExtraction: documentExtractionConfigSchema.default(
      defaultDocumentExtractionConfig,
    ),
    visionFallback: z.boolean().default(true),
    vision: visionConfigSchema.default(defaultVisionConfig),
    htmlExtraction: z.boolean().default(false),
    markdownExtraction: z.boolean().default(true),
    embed: z.boolean().default(true),
    indexVectors: z.boolean().default(true),
    embedding: embeddingConfigSchema.default(defaultEmbeddingConfig),
    vectorBackends: z.array(vectorBackendSchema).min(1).default(["lancedb"]),
    preserveTables: z.boolean().default(true),
    preserveCode: z.boolean().default(true),
    preserveImages: z.boolean().default(true),
    maxCostCents: z.number().int().nonnegative().nullable().default(null),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    structuredExtraction: structuredExtractionConfigSchema.default(
      defaultStructuredExtractionConfig,
    ),
    pageIndex: z.boolean().default(false),
    summarize: z.boolean().default(false),
    chunkOverlap: z.boolean().default(false),
    contextualChunkPreambles: z.boolean().default(true),
    propositionIndex: z.boolean().default(false),
    graphRag: z.boolean().default(false),
    graphCommunitySummaries: z.boolean().default(false),
    entityIndex: z.boolean().default(false),
    graph: graphConfigSchema.default(defaultGraphConfig),
    // Partial reprocess (set only by run reprocess): execute the enabled stages
    // from restartFromStage onward, or exactly stageSubset, and reuse the
    // other stages' outputs from the source document. See compilePipelinePlan.
    restartFromStage: z.string().optional(),
    stageSubset: z.array(z.string()).min(1).optional(),
    // PII detection policy (Feature 2)
    piiPolicy: z
      .object({
        enabled: z.boolean().default(false),
        patterns: z
          .array(z.string())
          .default([
            "ssn",
            "credit-card",
            "openai-api-key",
            "anthropic-api-key",
            "github-token",
            "generic-api-key",
          ]),
        action: z
          .enum(["flag_for_review", "redact_artifacts", "block_indexing"])
          .default("flag_for_review"),
        allowlistPatterns: z.array(z.string()).default([]),
      })
      .default({
        enabled: false,
        patterns: [],
        action: "flag_for_review",
        allowlistPatterns: [],
      }),
    // Privacy execution mode (Feature 3)
    privacyMode: privacyModeSchema.default("standard"),
    // Optional PDF region extraction: extracts text blocks with bounding boxes
    // per semantic region (header/body/footer/sidebar) for richer chunking and citations.
    pdfRegionExtraction: z.boolean().default(false),
    /**
     * Webhook notifications for this workspace. Subscriptions belong to users;
     * this decides whether the workspace's events reach them. `events` narrows
     * delivery to a subset (empty means every subscribed event).
     */
    webhooks: workspaceWebhookSettingsSchema.default(defaultWorkspaceWebhookSettings),
    /**
     * Web tools (web search, page fetch, site map, crawl, website ingest) for
     * this workspace's REST, MCP and chat calls. On by default and written
     * explicitly into every workspace's pipeline (migration 0079); set false to
     * opt the workspace out. Queries go to a hosted web provider, so privacy
     * modes that forbid hosted calls block web tools regardless.
     */
    webTools: z.boolean().default(true),
    /** Per-page decision-model router (shadow/active); off unless `mode` is set. */
    pageRouter: pageRouterConfigSchema.default(defaultPageRouterConfig),
    /**
     * Read sampled video frames with a vision model (needs MEDIA_VIDEO_ENABLED on the worker).
     * A video without an audio track is always read from frames, since there is nothing to transcribe.
     */
    mediaVideo: z.object({
      enabled: z.boolean().default(false),
      scanFps: z.number().min(.1).max(10).optional(),
      maxSelectedFps: z.number().min(.1).max(10).optional(),
      maxFrames: z.number().int().min(1).max(1200).optional(),
      imagesPerCall: z.number().int().min(1).max(32).optional(),
      maxVisualTokensPerCall: z.number().int().min(2048).max(24576).optional(),
      maxClipSeconds: z.number().min(1).max(120).optional(),
      maxCostCents: z.number().positive().max(10000).optional(),
    }).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.privacyMode !== "standard") {
      if (value.embed && value.embedding.target === "hosted") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["embedding"],
          message: `privacyMode '${value.privacyMode}' requires a local embedding profile`,
        });
      }
      // Syntactic check: a private fallback is allowed here and resolved against
      // the operator registry (fail closed) when the worker calls it.
      if (
        value.vision.remoteFallbackModelUri &&
        !(isPrivateModelUri(value.vision.remoteFallbackModelUri) || isProviderCallAllowed(value.privacyMode, {
          provider: parseLlmModelUri(value.vision.remoteFallbackModelUri).provider,
          modelUri: value.vision.remoteFallbackModelUri,
        }))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["vision", "remoteFallbackModelUri"],
          message: `privacyMode '${value.privacyMode}' does not allow a hosted vision fallback`,
        });
      }
    }

    if (value.indexVectors && !value.embed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["indexVectors"],
        message: "indexVectors requires embed to stay enabled",
      });
    }

    if (
      (value.graphRag || value.graphCommunitySummaries || value.entityIndex) &&
      !value.embed
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embed"],
        message:
          "GraphRAG, graph communities, and entity indexing require embed to stay enabled",
      });
    }

    if (value.outputSchema !== undefined) {
      if (Array.isArray(value.outputSchema) || value.outputSchema === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputSchema"],
          message: "outputSchema must be a JSON object",
        });
      } else {
        validateOutputSchemaDefinition(value.outputSchema, ctx);
      }
    }

    if (value.restartFromStage !== undefined) {
      const parsedStage = runStageSchema.safeParse(value.restartFromStage);
      if (
        !parsedStage.success ||
        parsedStage.data === "queued" ||
        parsedStage.data === "completed"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["restartFromStage"],
          message: "restartFromStage must be a runnable pipeline stage",
        });
      }
    }

    value.stageSubset?.forEach((stage, index) => {
      if (!pipelineRunStageSchema.safeParse(stage).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stageSubset", index],
          message: `stageSubset entry '${stage}' is not a runnable pipeline stage`,
        });
      }
    });

    if (value.restartFromStage !== undefined && value.stageSubset !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stageSubset"],
        message: "Use either restartFromStage or stageSubset, not both",
      });
    }
  });
export type PipelineFeatures = z.infer<typeof pipelineFeaturesSchema>;

export const defaultPipelineFeatures: PipelineFeatures = {
  indexingMode: "full",
  materialization: {},
  visualPages: { route: "auto", coarseFallback: false },
  inferenceLane: "standard",
  textGeneration: defaultTextGenerationConfig,
  parserPlaybook: "balanced",
  documentExtraction: defaultDocumentExtractionConfig,
  visionFallback: true,
  vision: defaultVisionConfig,
  htmlExtraction: false,
  markdownExtraction: true,
  embed: true,
  indexVectors: true,
  embedding: defaultEmbeddingConfig,
  vectorBackends: ["lancedb"],
  preserveTables: true,
  preserveCode: true,
  preserveImages: true,
  maxCostCents: null,
  structuredExtraction: defaultStructuredExtractionConfig,
  pageIndex: false,
  summarize: false,
  chunkOverlap: false,
  contextualChunkPreambles: true,
  propositionIndex: false,
  graphRag: false,
  graphCommunitySummaries: false,
  entityIndex: false,
  graph: defaultGraphConfig,
  piiPolicy: {
    enabled: false,
    patterns: [
      "ssn",
      "credit-card",
      "openai-api-key",
      "anthropic-api-key",
      "github-token",
      "generic-api-key",
    ],
    action: "flag_for_review",
    allowlistPatterns: [],
  },
  privacyMode: "standard",
  pdfRegionExtraction: false,
  webhooks: defaultWorkspaceWebhookSettings,
  webTools: true,
  pageRouter: defaultPageRouterConfig,
};

const alwaysEnabled = () => true;

export function isDeferredMode(features: Pick<PipelineFeatures, "indexingMode">): boolean {
  return features.indexingMode !== "full";
}

const basePipelineStagePlan: readonly PipelineStagePlanItem[] = [
  {
    stage: "quarantine",
    label: "Quarantine",
    phase: "intake",
    phaseLabel: "Intake",
    isEnabled: alwaysEnabled,
  },
  {
    stage: "format-detect",
    label: "Format detect",
    phase: "intake",
    phaseLabel: "Intake",
    isEnabled: alwaysEnabled,
  },
  {
    stage: "to-canonical",
    label: "To canonical",
    phase: "intake",
    phaseLabel: "Intake",
    isEnabled: alwaysEnabled,
  },
  {
    stage: "format-tooling",
    label: "Format tooling",
    phase: "prep",
    phaseLabel: "Prep",
    isEnabled: alwaysEnabled,
  },
  {
    stage: "normalize",
    label: "Normalize",
    phase: "prep",
    phaseLabel: "Prep",
    isEnabled: alwaysEnabled,
  },
  {
    stage: "pdf-tooling",
    label: "PDF tooling",
    phase: "prep",
    phaseLabel: "Prep",
    isEnabled: alwaysEnabled,
  },
  {
    stage: "split-pages",
    label: "Split pages",
    phase: "prep",
    phaseLabel: "Prep",
    isEnabled: alwaysEnabled,
  },
  {
    stage: "document-map",
    label: "Document map",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: (features) => features.indexingMode === "map",
  },
  {
    stage: "page-embed",
    label: "Page embed",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: (features) => features.indexingMode === "visual",
  },
  {
    stage: "extract-markdown",
    label: "Markdown",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: (features) => features.markdownExtraction,
  },
  {
    stage: "extract-html",
    label: "HTML",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: (features) => features.htmlExtraction,
  },
  {
    stage: "classify-route",
    label: "Classify",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: (features) => features.markdownExtraction,
  },
  {
    stage: "route-pages",
    label: "Route pages",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: (features) =>
      features.markdownExtraction &&
      features.pageRouter?.mode !== undefined &&
      features.pageRouter.mode !== "off",
  },
  {
    stage: "render-images",
    label: "Render images",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: alwaysEnabled,
  },
  {
    stage: "vision-extract",
    label: "Vision",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: (features) => features.visionFallback,
  },
  {
    stage: "pii-detect",
    label: "PII",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: (features) =>
      features.piiPolicy.enabled && (features.piiPolicy.patterns?.length ?? 0) > 0,
  },
  {
    stage: "document-summary",
    label: "Summary",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: (features) => features.summarize,
  },
  {
    stage: "structured-extract",
    label: "Structured extract",
    phase: "extract",
    phaseLabel: "Extract",
    isEnabled: (features) =>
      features.outputSchema !== undefined && Object.keys(features.outputSchema).length > 0,
  },
  {
    stage: "embed",
    label: "Embed",
    phase: "index",
    phaseLabel: "Index",
    isEnabled: (features) => features.embed,
  },
  {
    stage: "graph-enrich",
    label: "Graph enrich",
    phase: "index",
    phaseLabel: "Index",
    isEnabled: (features) =>
      features.graphRag || features.entityIndex || features.graphCommunitySummaries,
  },
  {
    stage: "page-index",
    label: "Page index",
    phase: "index",
    phaseLabel: "Index",
    isEnabled: (features) => features.pageIndex,
  },
  {
    stage: "proposition-index",
    label: "Propositions",
    phase: "index",
    phaseLabel: "Index",
    isEnabled: (features) => features.propositionIndex,
  },
  {
    stage: "index",
    label: "Index",
    phase: "index",
    phaseLabel: "Index",
    isEnabled: (features) => features.indexVectors,
  },
];

const deferredLocatorStages: ReadonlySet<PipelineRunStage> = new Set(["document-map", "page-embed"]);
const eagerStartIndex = basePipelineStagePlan.findIndex((item) => item.stage === "extract-markdown");

/** Deferred modes skip every eager extract/index stage: wrap their predicates. */
export const pipelineStagePlan: readonly PipelineStagePlanItem[] = basePipelineStagePlan.map(
  (item, position) =>
    position < eagerStartIndex || deferredLocatorStages.has(item.stage)
      ? item
      : { ...item, isEnabled: (features) => !isDeferredMode(features) && item.isEnabled(features) },
);

export const pipelineStageOrder: PipelineRunStage[] = pipelineStagePlan.map(
  (item) => item.stage,
);

export const runStageOrder: RunStage[] = [
  "queued",
  ...pipelineStageOrder,
  "completed",
];

export const pipelineStageLabels: Record<RunStage, string> = {
  queued: "Queued",
  ...(Object.fromEntries(
    pipelineStagePlan.map((item) => [item.stage, item.label]),
  ) as Record<PipelineRunStage, string>),
  completed: "Completed",
};

export type PipelineFeatureOverrides = Omit<
  Partial<PipelineFeatures>,
  "vision" | "embedding" | "piiPolicy" | "documentExtraction" | "textGeneration" | "graph" | "structuredExtraction" | "webhooks"
> & {
  structuredExtraction?: Partial<PipelineFeatures["structuredExtraction"]> | null;
  webhooks?: Partial<WorkspaceWebhookSettings> | null;
  graph?: Partial<GraphConfig> | null;
  textGeneration?: Partial<TextGenerationConfig> | null;
  vision?: Partial<PipelineFeatures["vision"]> | null;
  embedding?: Partial<PipelineFeatures["embedding"]> | null;
  piiPolicy?: Partial<NonNullable<PipelineFeatures["piiPolicy"]>> | null;
  documentExtraction?: Partial<PipelineFeatures["documentExtraction"]> | null;
};

export function normalizePipelineFeatures(
  source?: PipelineFeatureOverrides | PipelineFeatures | null,
): PipelineFeatures {
  source = migrateStoredModelSettings(source);
  // Privacy-only configuration must never opt into a hosted embedding call.
  // Explicit model/profile selections still pass through the privacy validator.
  const fallbackEmbedding = source?.privacyMode && source.privacyMode !== "standard"
    ? { ...defaultPipelineFeatures.embedding, ...embeddingProfileCatalog["good-fast-local"].config }
    : defaultPipelineFeatures.embedding;
  const embeddingBase =
    source?.embedding?.profile &&
    source.embedding.profile in embeddingProfileCatalog
      ? {
          ...embeddingProfileCatalog[source.embedding.profile].config,
          lateChunking: defaultPipelineFeatures.embedding.lateChunking,
          lateChunkingWindow:
            defaultPipelineFeatures.embedding.lateChunkingWindow,
        }
      : fallbackEmbedding;
  const visionBase =
    source?.vision?.profile && source.vision.profile in visionProfileCatalog
      ? {
          ...defaultPipelineFeatures.vision,
          ...visionProfileCatalog[source.vision.profile].config,
        }
      : defaultPipelineFeatures.vision;

  return pipelineFeaturesSchema.parse({
    ...defaultPipelineFeatures,
    ...(source ?? {}),
    textGeneration: {
      ...defaultTextGenerationConfig,
      ...(source?.textGeneration ?? {}),
    },
    vision: {
      ...visionBase,
      ...(source?.vision ?? {}),
    },
    documentExtraction: {
      ...defaultPipelineFeatures.documentExtraction,
      ...(source?.documentExtraction ?? {}),
      order: {
        ...defaultPipelineFeatures.documentExtraction.order,
        ...(source?.documentExtraction?.order ?? {}),
      },
      components: {
        ...defaultPipelineFeatures.documentExtraction.components,
        ...(source?.documentExtraction?.components ?? {}),
      },
      voting: {
        ...defaultPipelineFeatures.documentExtraction.voting,
        ...(source?.documentExtraction?.voting ?? {}),
      },
      options: {
        ...defaultPipelineFeatures.documentExtraction.options,
        ...(source?.documentExtraction?.options ?? {}),
      },
      ocr: {
        ...defaultPipelineFeatures.documentExtraction.ocr,
        ...(source?.documentExtraction?.ocr ?? {}),
      },
    },
    embedding: {
      ...embeddingBase,
      ...(source?.embedding ?? {}),
    },
    indexVectors:
      source?.embed === false && source.indexVectors === undefined
        ? false
        : source?.indexVectors ?? defaultPipelineFeatures.indexVectors,
    vectorBackends: source?.vectorBackends?.length
      ? [...source.vectorBackends]
      : [...defaultPipelineFeatures.vectorBackends],
    piiPolicy: {
      ...defaultPipelineFeatures.piiPolicy,
      ...(source?.piiPolicy ?? {}),
    },
    graph: {
      ...defaultGraphConfig,
      ...(source?.graph ?? {}),
    },
    structuredExtraction: {
      ...defaultStructuredExtractionConfig,
      ...(source?.structuredExtraction ?? {}),
    },
    webhooks: {
      ...defaultWorkspaceWebhookSettings,
      ...(source?.webhooks ?? {}),
    },
  });
}

/** Keys whose override value replaces the base value instead of merging into it. */
const replacedPipelineKeys = new Set(["outputSchema", "vectorBackends"]);

function mergeOverrideRecord(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const current = next[key];
    next[key] =
      !(depth === 0 && replacedPipelineKeys.has(key)) && isPlainRecord(value) && isPlainRecord(current)
        ? mergeOverrideRecord(current, value, depth + 1)
        : value;
  }
  return next;
}

/**
 * Deep-merges partial per-request overrides onto a full pipeline (usually a
 * workspace's stored pipeline). Nested settings merge key by key; arrays,
 * `outputSchema` and `vectorBackends` replace. The result is normalized.
 */
export function mergePipelineFeatures(
  base: PipelineFeatures | PipelineFeatureOverrides | null | undefined,
  overrides?: PipelineFeatureOverrides | null,
): PipelineFeatures {
  const normalizedBase = normalizePipelineFeatures(base ?? defaultPipelineFeatures);
  if (!overrides || Object.keys(overrides).length === 0) return normalizedBase;
  return normalizePipelineFeatures(
    mergeOverrideRecord(
      normalizedBase as unknown as Record<string, unknown>,
      overrides as Record<string, unknown>,
      0,
    ) as PipelineFeatureOverrides,
  );
}

const pipelineFeatureKeys = new Set(Object.keys(defaultPipelineFeatures).concat(["outputSchema", "restartFromStage"]));

/**
 * Validates partial pipeline overrides (as sent with an upload) without
 * filling in defaults, so they can be merged onto the workspace pipeline.
 */
export const pipelineFeatureOverridesSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    const unknownKeys = Object.keys(value).filter((key) => !pipelineFeatureKeys.has(key));
    for (const key of unknownKeys) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Unknown pipeline setting '${key}'` });
    }
    if (unknownKeys.length) return;
    const merged = mergeOverrideRecord(defaultPipelineFeatures as unknown as Record<string, unknown>, value, 0);
    const parsed = pipelineFeaturesSchema.safeParse(merged);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
      }
    }
  })
  .transform((value) => value as PipelineFeatureOverrides);

export function getPipelineStagePlan(
  source?: PipelineFeatureOverrides | PipelineFeatures | null,
): PipelineStagePlanItem[] {
  return compilePipelinePlan(source).stages;
}

export function getPipelineStageOrder(
  source?: PipelineFeatureOverrides | PipelineFeatures | null,
): PipelineRunStage[] {
  return compilePipelinePlan(source).stageOrder;
}

/**
 * Stages search does not need. A document is searchable once `index` marks
 * it completed; summaries, structured fields, graph evidence, page rows and
 * propositions add to it later. None of them produces an output that `embed`
 * or `index` consumes (see `stageDataFlow`).
 */
export const postIndexStages: readonly PipelineRunStage[] = [
  "document-summary",
  "structured-extract",
  "graph-enrich",
  "page-index",
  "proposition-index",
];

/**
 * The order a run executes its stages in. With `indexBeforeEnrich`, the
 * stages in `postIndexStages` move after `index` (keeping their relative
 * order), so the critical path to searchable is ... pii-detect, embed, index.
 * The run still completes only after every stage. Without `index` in the
 * order nothing moves. Canonical order (`pipelineStageOrder`) stays the
 * reference for partial-run planning and display.
 */
export function executionStageOrder(
  stageOrder: readonly PipelineRunStage[],
  options: { indexBeforeEnrich?: boolean } = {},
): PipelineRunStage[] {
  const indexAt = stageOrder.indexOf("index");
  if (!options.indexBeforeEnrich || indexAt < 0) return [...stageOrder];
  const deferred = stageOrder.filter(
    (stage, position) => position < indexAt && postIndexStages.includes(stage),
  );
  if (deferred.length === 0) return [...stageOrder];
  const kept = stageOrder.filter((stage) => !deferred.includes(stage));
  const keptIndexAt = kept.indexOf("index");
  return [...kept.slice(0, keptIndexAt + 1), ...deferred, ...kept.slice(keptIndexAt + 1)];
}

/**
 * The order a run is executing `stageOrder` in, for progress views. Whether
 * the run moved its enrichment stages after `index` is recorded only in the
 * workflow input, so it is inferred from stage state rows: every stage that
 * starts writes one, so an enrichment stage without rows while a stage it
 * canonically precedes (`embed`, `index`) has started or is current means the
 * run executes `executionStageOrder(..., { indexBeforeEnrich: true })`.
 * Without that, positional inference would show the moved stages completed.
 */
export function inferExecutionStageOrder<T extends string>(
  stageOrder: readonly T[],
  evidence: { hasState: (stage: string) => boolean; currentStage?: string | null },
): T[] {
  const stages = stageOrder as readonly string[];
  for (const reached of ["index", "embed"] as const) {
    if (!stages.includes(reached)) continue;
    if (!evidence.hasState(reached) && evidence.currentStage !== reached) continue;
    const reachedAt = pipelineStageOrder.indexOf(reached);
    const moved = postIndexStages.some((stage) =>
      stages.includes(stage) && pipelineStageOrder.indexOf(stage) < reachedAt && !evidence.hasState(stage));
    if (moved) return executionStageOrder(stageOrder as unknown as PipelineRunStage[], { indexBeforeEnrich: true }) as unknown as T[];
  }
  return [...stageOrder];
}

export function getPipelineStageLabel(stage: RunStage): string {
  return pipelineStageLabels[stage];
}

/**
 * Data flow of one stage: the outputs (document artifacts and derived rows)
 * it reads and writes. This one graph drives partial runs: which stages a
 * re-run stage invalidates, which stages must run together, and which inputs a
 * source document must supply.
 */
export interface StageDataFlow {
  /** Outputs the stage reads when present. A changed one makes the stage re-run. */
  consumes?: readonly string[];
  /**
   * Inputs the stage cannot run without: one of each group must come from an
   * earlier stage of the same run or from the source document.
   */
  requires?: readonly (readonly string[])[];
  /** Inputs that must be produced by this same run (they are keyed to its run or documents). */
  sameRun?: readonly string[];
  /** Outputs the stage writes, given the run's features. */
  produces?: readonly string[] | ((features: PipelineFeatures) => readonly string[]);
  /** Why a partial run cannot copy this stage's outputs and must always re-run it. */
  alwaysRerun?: string;
}

const extractedText = ["markdown", "canonical-document", "extraction-contract"] as const;

export const stageDataFlow: Record<PipelineRunStage, StageDataFlow> = {
  quarantine: { produces: ["quarantine"] },
  "format-detect": { produces: ["normalizedFormat"] },
  "to-canonical": { consumes: ["normalizedFormat"], produces: ["to-canonical"] },
  "format-tooling": { consumes: ["normalizedFormat"], produces: ["format-tooling"] },
  normalize: { consumes: ["normalizedFormat"], produces: ["normalize"] },
  "pdf-tooling": { produces: ["pdf-tooling"] },
  "split-pages": { produces: ["pages"] },
  "document-map": {
    consumes: ["pages", "normalizedFormat"],
    produces: ["document-map", "page-labels"],
  },
  "page-embed": { consumes: ["pages"], produces: ["page-image-vectors"] },
  "extract-markdown": {
    consumes: ["normalizedFormat", "parser-playbook", "hasTablePages", "images"],
    produces: [
      ...extractedText,
      "markdown-manifest",
      "liteparse-structured",
      "artifact-graph",
      "heatmap",
      "markdown-critique",
      "parser-eval",
      "pdf-regions",
      "page-image-evidence",
    ],
  },
  "extract-html": { produces: ["html", "html-manifest"] },
  "classify-route": {
    consumes: ["canonical-document", "markdown-manifest", "extraction-contract", "liteparse-structured", "page-image-evidence"],
    produces: ["classification", "parser-playbook"],
  },
  "route-pages": {
    consumes: ["classification", "canonical-document", "liteparse-structured", "parser-playbook"],
    produces: ["page-route-plan"],
  },
  "render-images": { consumes: ["classification", "page-route-plan"], produces: ["images", "page-images"] },
  "vision-extract": {
    consumes: ["canonical-document", "extraction-contract", "parser-playbook", "classification", "images", "page-route-plan"],
    produces: [...extractedText, "canonical-reconciliation", "page-images"],
  },
  "pii-detect": {
    consumes: [...extractedText, "html"],
    // Redaction rewrites the extracted text in place.
    produces: (features) =>
      features.piiPolicy.action === "redact_artifacts"
        ? ["pii-decision", ...extractedText, "html"]
        : ["pii-decision"],
    alwaysRerun: "PII policy decisions gate indexing of each document and are not copied",
  },
  "document-summary": { consumes: ["markdown"], requires: [["markdown"]], produces: ["summary"] },
  "structured-extract": {
    consumes: ["markdown", "canonical-document"],
    requires: [["markdown", "canonical-document"]],
    produces: ["structured"],
  },
  embed: {
    consumes: ["markdown", "canonical-document"],
    requires: [["markdown", "canonical-document"]],
    produces: ["embeddings", "chunks", "json-schema"],
  },
  "graph-enrich": {
    consumes: ["embeddings", "chunks"],
    sameRun: ["embeddings"],
    produces: ["knowledge-graph"],
    alwaysRerun: "graph evidence is keyed to the new document's chunks",
  },
  // page-index also links this run's chunks to their pages.
  "page-index": { consumes: ["markdown", "chunks"], requires: [["markdown"]], produces: ["page-text"] },
  "proposition-index": { consumes: ["markdown"], requires: [["markdown"]], produces: ["propositions"] },
  index: {
    consumes: ["embeddings", "pii-decision"],
    sameRun: ["embeddings"],
    produces: ["vectors"],
    alwaysRerun: "vector rows are keyed to the new document",
  },
};

export function stageOutputs(stage: PipelineRunStage, features: PipelineFeatures): readonly string[] {
  const produces = stageDataFlow[stage].produces ?? [];
  return typeof produces === "function" ? produces(features) : produces;
}

/** Enabled stages before `stage` that write `output`, in pipeline order. */
function earlierProducers(
  stage: PipelineRunStage,
  output: string,
  enabled: readonly PipelineRunStage[],
  features: PipelineFeatures,
): PipelineRunStage[] {
  const position = pipelineStageOrder.indexOf(stage);
  return enabled.filter(
    (candidate) =>
      pipelineStageOrder.indexOf(candidate) < position && stageOutputs(candidate, features).includes(output),
  );
}

/**
 * Executed stages of a partial plan whose required inputs are produced by no
 * earlier executed stage and are missing on the source document. `available`
 * holds the source document's artifact names (`markdown`, ...).
 */
export function findMissingReuseInputs(
  plan: Pick<CompiledPipelinePlan, "stageOrder" | "reusedStages" | "features">,
  available: ReadonlySet<string>,
): Array<{ stage: PipelineRunStage; anyOf: string[] }> {
  if (plan.reusedStages.length === 0) return [];
  const missing: Array<{ stage: PipelineRunStage; anyOf: string[] }> = [];
  for (const stage of plan.stageOrder) {
    for (const group of stageDataFlow[stage].requires ?? []) {
      const satisfied = group.some(
        (input) =>
          available.has(input) || earlierProducers(stage, input, plan.stageOrder, plan.features).length > 0,
      );
      if (!satisfied) missing.push({ stage, anyOf: [...group] });
    }
  }
  return missing;
}

/**
 * Pipeline feature keys that select a partial run's stages rather than
 * describe its output. SQL comparisons drop them with `pipeline - keys`.
 */
export const stageSelectionKeys = ["restartFromStage", "stageSubset"] as const;

/** Pipeline features without the per-run stage selection (for copying, version hashes and dedup keys). */
export function withoutStageSelection<T extends { restartFromStage?: unknown; stageSubset?: unknown }>(
  features: T,
): Omit<T, "restartFromStage" | "stageSubset"> {
  const { restartFromStage: _restart, stageSubset: _subset, ...rest } = features;
  return rest;
}

/**
 * Pipeline features for version hashes: drops stage selection plus
 * `indexingMode`/`materialization`/`visualPages`, so switching modes (or the
 * new `visualPages` default appearing on stored pipelines) never marks chunks stale.
 * The stored pipeline keeps those fields (use `withoutStageSelection` there).
 */
export function pipelineVersionFeatures<T extends object>(
  features: T,
): Omit<T, "restartFromStage" | "stageSubset" | "indexingMode" | "materialization" | "visualPages"> {
  const {
    restartFromStage: _restart,
    stageSubset: _subset,
    indexingMode: _mode,
    materialization: _materialization,
    visualPages: _visualPages,
    ...rest
  } = features as T & Record<string, unknown>;
  return rest as Omit<T, "restartFromStage" | "stageSubset" | "indexingMode" | "materialization" | "visualPages">;
}

function selectStages(
  features: PipelineFeatures,
  enabled: PipelineStagePlanItem[],
): { selected: Set<PipelineRunStage>; addedStages: CompiledPipelinePlan["addedStages"] } | null {
  let selected: Set<PipelineRunStage>;
  if (features.stageSubset) {
    const subset = new Set<string>(features.stageSubset);
    selected = new Set(enabled.filter((item) => subset.has(item.stage)).map((item) => item.stage));
  } else if (features.restartFromStage) {
    const start = pipelineStageOrder.indexOf(features.restartFromStage as PipelineRunStage);
    selected = new Set(
      enabled
        .filter((item) => pipelineStageOrder.indexOf(item.stage) >= start)
        .map((item) => item.stage),
    );
  } else {
    return null;
  }

  return closeStageSelection(selected, enabled.map((item) => item.stage), features, true);
}

/**
 * Grow `selected` to the stages `stageDataFlow` forces. With `forceAlwaysRerun`, stages marked `alwaysRerun`
 * join whenever anything runs (partial reprocess); without it only data dependencies pull stages in
 * (impact analysis: a summary change must not re-run `index`).
 */
function closeStageSelection(
  selected: Set<PipelineRunStage>,
  enabledStages: PipelineRunStage[],
  features: PipelineFeatures,
  forceAlwaysRerun: boolean,
): { selected: Set<PipelineRunStage>; addedStages: CompiledPipelinePlan["addedStages"] } {
  const addedStages: CompiledPipelinePlan["addedStages"] = [];
  // Nothing requested is enabled: run nothing rather than only the forced stages.
  if (selected.size === 0) return { selected, addedStages };
  const add = (stage: PipelineRunStage, reason: string): boolean => {
    if (!enabledStages.includes(stage) || selected.has(stage)) return false;
    selected.add(stage);
    addedStages.push({ stage, reason });
    return true;
  };
  if (forceAlwaysRerun) {
    for (const stage of enabledStages) {
      const reason = stageDataFlow[stage].alwaysRerun;
      if (reason) add(stage, reason);
    }
  }
  // Fixed point: same-run inputs pull in their producers, and every output a
  // re-run stage writes re-runs the later stages that consume it.
  for (let changed = true; changed; ) {
    changed = false;
    for (const stage of enabledStages.filter((candidate) => selected.has(candidate))) {
      for (const input of stageDataFlow[stage].sameRun ?? []) {
        for (const producer of earlierProducers(stage, input, enabledStages, features)) {
          if (add(producer, `${stage} reads ${input} produced in the same run`)) changed = true;
        }
      }
      const outputs = stageOutputs(stage, features);
      const position = pipelineStageOrder.indexOf(stage);
      for (const consumer of enabledStages) {
        if (pipelineStageOrder.indexOf(consumer) <= position) continue;
        const input = (stageDataFlow[consumer].consumes ?? []).find((name) => outputs.includes(name));
        if (input && add(consumer, `input changed: ${input} (from ${stage})`)) changed = true;
      }
    }
  }
  return { selected, addedStages };
}

/**
 * The stages a run executes. Full runs execute every enabled stage. Partial
 * runs (restartFromStage / stageSubset) execute the selected enabled stages
 * plus the stages `stageDataFlow` forces, listed in `addedStages`; the other
 * enabled stages are `reusedStages`, whose outputs the worker seeds from the
 * source document before the first stage runs.
 */
export function compilePipelinePlan(
  source?: PipelineFeatureOverrides | PipelineFeatures | null,
): CompiledPipelinePlan {
  const features = normalizePipelineFeatures(source);
  const enabled = pipelineStagePlan.filter((item) => item.isEnabled(features));
  const selection = selectStages(features, enabled);
  const stages = selection ? enabled.filter((item) => selection.selected.has(item.stage)) : enabled;
  const reusedStages = selection
    ? enabled.filter((item) => !selection.selected.has(item.stage)).map((item) => item.stage)
    : [];
  const phases = Array.from(
    stages.reduce((byKey, item) => {
      const phase = byKey.get(item.phase) ?? {
        key: item.phase,
        label: item.phaseLabel,
        stages: [] as PipelineRunStage[],
      };
      phase.stages.push(item.stage);
      byKey.set(item.phase, phase);
      return byKey;
    }, new Map<PipelineStagePhaseKey, CompiledPipelinePlanPhase>()),
    ([, phase]) => phase,
  );

  return {
    features,
    stages,
    stageOrder: stages.map((item) => item.stage),
    phases,
    stagesByName: Object.fromEntries(
      pipelineStagePlan.map((item) => [item.stage, item]),
    ) as Record<PipelineRunStage, PipelineStagePlanItem>,
    reusedStages,
    addedStages: selection?.addedStages ?? [],
  };
}

/**
 * Read a stored pipeline snapshot (a run's, or an old workspace row) that may
 * predate the current schema: retired keys and nulls where values are now
 * required. Each validation pass drops exactly the fields the schema reports
 * so defaults fill them; a list of historical runs never fails on one row.
 */
export function parseStoredPipelineFeatures(stored: unknown): PipelineFeatures {
  let source = structuredClone((stored ?? null) as Record<string, unknown> | null);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return normalizePipelineFeatures(source as PipelineFeatureOverrides | null);
    } catch (error) {
      const issues = (error as { issues?: Array<{ code: string; path: PropertyKey[]; keys?: string[] }> }).issues;
      if (!issues?.length || !source) break;
      for (const issue of issues) {
        let node: unknown = source;
        for (const segment of issue.path.slice(0, -1)) node = (node as Record<PropertyKey, unknown> | undefined)?.[segment];
        if (!node || typeof node !== "object") continue;
        const target = issue.code === "unrecognized_keys"
          ? (issue.path.length ? (node as Record<PropertyKey, unknown>)[issue.path.at(-1)!] : node)
          : node;
        if (issue.code === "unrecognized_keys") {
          if (target && typeof target === "object") for (const key of issue.keys ?? []) delete (target as Record<string, unknown>)[key];
        } else if (issue.path.length) {
          delete (node as Record<PropertyKey, unknown>)[issue.path.at(-1)!];
        }
      }
    }
  }
  return normalizePipelineFeatures(null);
}

/**
 * Stage of the pipeline each feature field feeds. A change to the field re-runs these stages (when enabled in
 * the new config) plus whatever consumes their outputs. `[]` means the field never changes stored data.
 */
const FIELD_SEED_STAGES: Record<keyof PipelineFeatures, readonly PipelineRunStage[]> = {
  indexingMode: [],
  materialization: [],
  visualPages: [],
  inferenceLane: [],
  textGeneration: [],
  parserPlaybook: ["extract-markdown"],
  documentExtraction: ["extract-markdown"],
  visionFallback: ["vision-extract"],
  vision: ["vision-extract"],
  htmlExtraction: ["extract-html"],
  markdownExtraction: ["extract-markdown"],
  embed: ["embed"],
  indexVectors: ["index"],
  embedding: ["embed"],
  vectorBackends: ["index"],
  preserveTables: ["extract-markdown"],
  preserveCode: ["extract-markdown"],
  preserveImages: ["extract-markdown"],
  maxCostCents: [],
  outputSchema: ["structured-extract"],
  structuredExtraction: ["structured-extract"],
  pageIndex: ["page-index"],
  summarize: ["document-summary"],
  chunkOverlap: ["embed"],
  contextualChunkPreambles: ["embed"],
  propositionIndex: ["proposition-index"],
  graphRag: ["graph-enrich"],
  graphCommunitySummaries: ["graph-enrich"],
  entityIndex: ["graph-enrich"],
  graph: ["graph-enrich"],
  restartFromStage: [],
  stageSubset: [],
  piiPolicy: ["pii-detect"],
  privacyMode: ["pii-detect", "index"],
  pdfRegionExtraction: ["extract-markdown"],
  webhooks: [],
  webTools: [],
  pageRouter: ["route-pages"],
  mediaVideo: ["extract-markdown"],
};

/**
 * Minimal stage set that brings an already-ingested document in line with `after`: the stages fed by changed
 * fields that are enabled in `after`, plus the later stages that consume their outputs (`stageDataFlow`).
 * Unlike a partial reprocess it does not force `alwaysRerun` stages, so a summary-only change is
 * `["document-summary"]`. Pure; order follows the pipeline.
 */
export function affectedStages(before: PipelineFeatures, after: PipelineFeatures): PipelineRunStage[] {
  const enabledItems = pipelineStagePlan.filter((item) => item.isEnabled(after));
  const enabled = enabledItems.map((item) => item.stage);
  const seeds = new Set<PipelineRunStage>();
  for (const key of Object.keys(FIELD_SEED_STAGES) as Array<keyof PipelineFeatures>) {
    if (pipelineValuesEqual(before[key], after[key])) continue;
    for (const stage of FIELD_SEED_STAGES[key]) if (enabled.includes(stage)) seeds.add(stage);
  }
  if (seeds.size === 0) return [];
  const { selected } = closeStageSelection(seeds, enabled, after, false);
  return enabled.filter((stage) => selected.has(stage));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v);
}

/** Deep equality for pipeline feature values, independent of object key order. */
export function pipelineValuesEqual(a: unknown, b: unknown): boolean {
  return a === b || stableJson(a) === stableJson(b);
}
