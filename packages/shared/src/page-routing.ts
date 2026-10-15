import { z } from "zod";
import { adaptivePageRouteSchema } from "./embedding.js";
import { licenseClassSchema, modelLicenseSchema } from "./model-license.js";

// Page-level ingest router contracts. Every persisted/serialised shape carries a
// `schemaVersion` literal so policy packs and plans can be rejected when stale.

const probability = z.number().min(0).max(1);
const nonNegative = z.number().min(0);
const nonNegativeInt = z.number().int().min(0);

export const PAGE_FEATURES_SCHEMA_VERSION = "page-features@v1" as const;
export const ROUTING_TARGET_SCHEMA_VERSION = "routing-target@v1" as const;
export const PAGE_INPUT_SCHEMA_VERSION = "page-input@v1" as const;
export const ROUTE_PLAN_SCHEMA_VERSION = "route-plan@v2" as const;
export const PLAN_VALIDATION_SCHEMA_VERSION = "plan-validation@v1" as const;
export const ESTIMATE_ERROR_REPORT_SCHEMA_VERSION =
  "estimate-error-report@v1" as const;
export const DECISION_MODEL_SCHEMA_VERSION = "decision-model@v1" as const;
export const POLICY_PACK_SCHEMA_VERSION = "policy-pack@v1" as const;

export const routingObjectiveSchema = z.enum([
  "cost-quality",
  "cost-speed",
  "quality",
]);
export type RoutingObjective = z.infer<typeof routingObjectiveSchema>;

export const routingModeSchema = z.enum(["shadow", "active"]);
export type RoutingMode = z.infer<typeof routingModeSchema>;

export const routingDimensionSchema = z.enum([
  "text",
  "math",
  "tables",
  "overall",
]);
export type RoutingDimension = z.infer<typeof routingDimensionSchema>;

// ---- Decision-model questions --------------------------------------------

export const decisionAttributeQuestionIds = [
  "has_math",
  "has_table",
  "degraded",
  "low_resolution",
  "handwriting",
  "multi_column",
  "figure_heavy",
  "text_layer_ok",
] as const;
export const decisionCapabilityQuestionIds = [
  "native_text_faithful",
  "plain_ocr_sufficient",
  "needs_math_extraction",
  "needs_table_structure",
  "trust_text_layer",
] as const;
export const decisionQuestionIds = [
  ...decisionAttributeQuestionIds,
  ...decisionCapabilityQuestionIds,
] as const;
export const decisionQuestionIdSchema = z.enum(decisionQuestionIds);
export type DecisionQuestionId = z.infer<typeof decisionQuestionIdSchema>;

export const decisionFormatSchema = z.enum([
  "grid",
  "named-images",
  "per-page",
  "text-state",
]);
export type DecisionFormat = z.infer<typeof decisionFormatSchema>;

/** Raw (uncalibrated) per-question probabilities. A model may answer a subset. */
export const decisionProbabilitiesSchema = z.object(
  Object.fromEntries(
    decisionQuestionIds.map((id) => [id, probability.optional()]),
  ) as Record<DecisionQuestionId, z.ZodOptional<typeof probability>>,
);
export type DecisionProbabilities = z.infer<typeof decisionProbabilitiesSchema>;

export const imageKinds = [
  "none",
  "decorative-photo",
  "logo",
  "chart-graph",
  "diagram",
  "table-as-image",
  "equation-image",
  "scanned-text",
  "handwriting",
] as const;
export const imageKindSchema = z.enum(imageKinds);
export type ImageKind = z.infer<typeof imageKindSchema>;

/** Choice-question answer: a probability per option (need not be exhaustive). */
export const imageKindProbabilitiesSchema = z.partialRecord(
  imageKindSchema,
  probability,
);
export type ImageKindProbabilities = z.infer<
  typeof imageKindProbabilitiesSchema
>;

export const decisionAnswersSchema = z.object({
  probabilities: decisionProbabilitiesSchema,
  /**
   * Choice-type questions. `image_kind` has one entry per image on the page;
   * imageIndex null is a page-level answer (no per-image facts available).
   */
  choices: z
    .object({
      image_kind: z
        .array(
          z.object({
            imageIndex: nonNegativeInt.nullable(),
            probabilities: imageKindProbabilitiesSchema,
          }),
        )
        .optional(),
    })
    .default({}),
  source: z.object({
    decisionModel: z.string().min(1),
    format: decisionFormatSchema,
    pagesPerCall: z.number().int().min(1),
    tilePx: z.number().int().min(1).nullable(),
  }),
});
export type DecisionAnswers = z.infer<typeof decisionAnswersSchema>;

// ---- DecisionModel --------------------------------------------------------

export const decisionEndpointKindSchema = z.enum([
  "perplexity-decisions",
  "openrouter-systemone",
  "liquid-systemone",
  "typesafe-systemone",
  "local-transformers",
]);
export type DecisionEndpointKind = z.infer<typeof decisionEndpointKindSchema>;

export const decisionModelRoleSchema = z.enum(["triage", "verify", "route"]);
export type DecisionModelRole = z.infer<typeof decisionModelRoleSchema>;

export const decisionModelSchema = z.object({
  schemaVersion: z.literal(DECISION_MODEL_SCHEMA_VERSION),
  id: z.string().min(1),
  endpoint: decisionEndpointKindSchema,
  modalities: z.object({
    text: z.boolean(),
    image: z.boolean(),
    maxImagesPerRequest: nonNegativeInt,
  }),
  maxQuestionsPerRequest: z.number().int().min(1),
  /** Decision models bill input tokens only. */
  pricing: z.object({
    inputUsdPerMTok: nonNegative,
    outputUsdPerMTok: z.literal(0),
    checkedAt: z.string().min(1),
  }),
  /**
   * How input tokens scale with the question count. `per-call`: the state is billed once however many
   * questions are asked (Cloudflare Clef, OpenAI Decisions, Jev). `per-question`: the state tokens are
   * billed again for every question (pplx-decider, Liquid d1). Absent means `per-call`.
   */
  billingMode: z.enum(["per-call", "per-question"]).optional(),
  roles: z.array(decisionModelRoleSchema).min(1),
  availability: z.object({
    requiresEnv: z.array(z.string()),
    privacyClass: z.enum(["local", "hosted"]),
  }),
  /** Licence class (model-license.ts); absent means resolved from the model table, then fail closed. */
  licenseClass: licenseClassSchema.optional(),
  license: modelLicenseSchema.optional(),
});
export type DecisionModel = z.infer<typeof decisionModelSchema>;

export const assignmentRoleSchema = z.enum([
  "accept-text",
  "extract-text",
  "ocr",
  "chart-data",
  "diagram",
  "math",
  "table",
  /** One detected table region scoped to a bbox (table gate: candidate choice or region transcription). */
  "table-region",
  "image-label",
  "skip",
]);
export type AssignmentRole = z.infer<typeof assignmentRoleSchema>;

// ---- RoutingTarget --------------------------------------------------------
// Extraction destinations only. Generative models appear here as targets the
// router routes to, never as routers.

export const routingTargetKindSchema = z.enum([
  "native",
  "local-ocr",
  "private-vlm",
  "hosted-vlm",
  "local-labeler",
  "skip",
]);
export type RoutingTargetKind = z.infer<typeof routingTargetKindSchema>;

export const routingTargetSchema = z.object({
  schemaVersion: z.literal(ROUTING_TARGET_SCHEMA_VERSION),
  id: z.string().min(1),
  kind: routingTargetKindSchema,
  ref: z.object({
    extractorId: z.string().min(1).optional(),
    modelUri: z.string().min(1).optional(),
  }),
  /** Assignment roles this target can serve. */
  roles: z.array(assignmentRoleSchema).min(1),
  /**
   * The planner never picks this target as an assignment's primary; it can only be a cascade
   * (escalation) leg. Used for strong but expensive review models (Claude Sonnet 5.5).
   */
  escalationOnly: z.boolean().optional(),
  capabilities: z.object({
    imageInput: z.boolean(),
    multiImagePerRequest: z.boolean(),
    maxImagesPerRequest: z.number().int().min(1),
    maxImageLongEdgePx: z.number().int().min(1).nullable(),
    emitsLatex: z.boolean(),
    emitsHtmlTables: z.boolean(),
    usesNativeTextLayer: z.boolean(),
  }),
  pricing: z.object({
    source: z.enum([
      "openrouter-live",
      "model-prices.json",
      "private-endpoint",
      "local-compute",
    ]),
    checkedAt: z.string().min(1),
    inputUsdPerMTok: nonNegative.optional(),
    outputUsdPerMTok: nonNegative.optional(),
    imageTokensPerImage: nonNegative.optional(),
    hourlyUsd: nonNegative.optional(),
    pagesPerMinuteObserved: nonNegative.optional(),
  }),
  latency: z.object({
    p50Ms: nonNegative,
    p95Ms: nonNegative,
    source: z.string().min(1),
    n: nonNegativeInt,
  }),
  availability: z.object({
    requiresEnv: z.array(z.string()),
    privacyClass: z.enum(["local", "private", "hosted"]),
  }),
  /** Licence class (model-license.ts); absent means resolved from the model table, then fail closed. */
  licenseClass: licenseClassSchema.optional(),
  license: modelLicenseSchema.optional(),
});
export type RoutingTarget = z.infer<typeof routingTargetSchema>;

// ---- PageFeatures ---------------------------------------------------------

export const pageFeaturesSchema = z.object({
  schemaVersion: z.literal(PAGE_FEATURES_SCHEMA_VERSION),
  pageNumber: z.number().int().min(1),
  documentFormat: z.string().min(1),
  pageCount: z.number().int().min(1),
  native: z.object({
    charCount: nonNegativeInt,
    wordCount: nonNegativeInt,
    textCoverage: probability,
    fontCount: nonNegativeInt,
    unmappedGlyphRatio: probability,
    mathGlyphRatio: probability,
    tableRuleScore: nonNegative,
    garbled: z.boolean(),
    plausibility: probability,
  }),
  raster: z.object({
    imageCoverage: probability,
    largestImageCoverage: probability,
    fullPageImage: z.boolean(),
    vectorDrawingCount: nonNegativeInt,
    uncoveredVectorRatio: probability,
    smallestFontPt: nonNegative.nullable(),
  }),
  geometry: z.object({
    widthPt: nonNegative,
    heightPt: nonNegative,
    rotation: z.number().int(),
  }),
  heuristic: z.object({
    route: adaptivePageRouteSchema,
    extractorHint: z.string().nullable(),
    specializedKinds: z.array(z.string()),
    ocrAuthorized: z.boolean().nullable(),
    textDensityScore: z.number(),
  }),
  /** Decision-model answers; null = triage not run. */
  decisions: decisionAnswersSchema.nullable(),
  provenance: z.object({
    probe: z.enum(["pymupdf-probe", "native-pdf-probe", "liteparse"]),
    probeMs: nonNegative,
  }),
});
export type PageFeatures = z.infer<typeof pageFeaturesSchema>;

// ---- Estimates and decisions ---------------------------------------------

export const passProbabilitiesSchema = z.object({
  text: probability,
  math: probability,
  tables: probability,
  overall: probability,
});
export type PassProbabilities = z.infer<typeof passProbabilitiesSchema>;

export const targetEstimateSchema = z.object({
  targetId: z.string().min(1),
  pPass: passProbabilitiesSchema,
  /** Pessimistic lower bound on P(pass) per dimension used for selection. */
  pPassLowerBound: passProbabilitiesSchema.optional(),
  qualityMean: probability,
  qualityCi: z.tuple([probability, probability]),
  expectedCostUsd: nonNegative,
  expectedLatencyMs: nonNegative,
  calibrationBucket: z.string().min(1),
});
export type TargetEstimate = z.infer<typeof targetEstimateSchema>;

export const routeRejectionReasonSchema = z.enum([
  "capability",
  "privacy",
  "budget",
  "unavailable",
  "prohibited-model",
]);
export type RouteRejectionReason = z.infer<typeof routeRejectionReasonSchema>;

export const verifierTriggerSchema = z.enum([
  "non-stop-finish",
  "empty-output",
  "truncated-output",
  "native-length-ratio",
  "invalid-latex",
  "ragged-table",
  "low-resolution-math",
  "native-disagreement",
  "decision-model-verifier",
]);
export type VerifierTrigger = z.infer<typeof verifierTriggerSchema>;

// ---- PageInput ------------------------------------------------------------

export const bboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: nonNegative,
  height: nonNegative,
});
export type BBox = z.infer<typeof bboxSchema>;

export const textLayerStatusSchema = z.enum([
  "ok",
  "suspect",
  "absent",
  "unknown",
  /** Text laid over a page-sized image (a scan's OCR layer) whose agreement with the image has not been verified. */
  "ocr-layer",
]);
export type TextLayerStatus = z.infer<typeof textLayerStatusSchema>;

/** Cheap native-pass facts, e.g. "P03: 412 words, 0 images, text layer ok". */
export const textFactsSchema = z.object({
  wordCount: nonNegativeInt.nullable(),
  imageCount: nonNegativeInt.nullable(),
  imageCoverage: probability.nullable(),
  textLayerStatus: textLayerStatusSchema,
  /** Share of the text drawn invisibly (render mode 3); ~1 for a scan's hidden OCR layer. */
  invisibleTextRatio: probability.optional(),
  /** Share of the text lying over a page-sized image. */
  textOverImageRatio: probability.optional(),
  /** Agreement (0..1) of an OCR layer with a fresh OCR of part of the page; null when the check could not run. */
  ocrLayerAgreement: probability.nullable().optional(),
  /** Wall time of the band re-OCR behind `ocrLayerAgreement`, ms (overhead accounting). */
  ocrLayerMs: nonNegative.optional(),
});
export type TextFacts = z.infer<typeof textFactsSchema>;

export const imageFactSchema = z.object({
  index: nonNegativeInt,
  bbox: bboxSchema,
  coverage: probability,
});
export type ImageFact = z.infer<typeof imageFactSchema>;

export const pageInputSchema = z.object({
  schemaVersion: z.literal(PAGE_INPUT_SCHEMA_VERSION),
  features: pageFeaturesSchema,
  textFacts: textFactsSchema,
  images: z.array(imageFactSchema),
  /** Unusual/unsupported features the probe saw (H9), e.g. "acroform-filled", "ocg-hidden". */
  unusualFeatures: z.array(z.string().min(1)).optional(),
  thumbnail: z
    .object({
      uri: z.string().min(1),
      widthPx: z.number().int().min(1),
      heightPx: z.number().int().min(1),
    })
    .optional(),
});
export type PageInput = z.infer<typeof pageInputSchema>;

// ---- RoutePlan (set of assignments) --------------------------------------

export const assignmentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page") }),
  z.object({ kind: z.literal("region"), bbox: bboxSchema }),
  z.object({
    kind: z.literal("image"),
    imageIndex: nonNegativeInt,
    bbox: bboxSchema.optional(),
  }),
]);
export type AssignmentScope = z.infer<typeof assignmentScopeSchema>;

export const assignmentEstimateSchema = z.object({
  costUsd: nonNegative,
  latencyMs: nonNegative,
  pPass: probability,
});
export type AssignmentEstimate = z.infer<typeof assignmentEstimateSchema>;

export const assignmentSchema = z.object({
  pageNumber: z.number().int().min(1),
  scope: assignmentScopeSchema,
  targetId: z.string().min(1),
  role: assignmentRoleSchema,
  reason: z.string().min(1),
  estimate: assignmentEstimateSchema,
  /** At most one escalation per assignment. */
  cascade: z
    .array(
      z.object({
        targetId: z.string().min(1),
        trigger: verifierTriggerSchema,
      }),
    )
    .max(1)
    .default([]),
});
export type Assignment = z.infer<typeof assignmentSchema>;

export const overBudgetActionSchema = z.enum(["downgrade", "skip", "defer"]);
export type OverBudgetAction = z.infer<typeof overBudgetActionSchema>;

export const routingBudgetSchema = z.object({
  limitUsd: nonNegative,
  /** Minimum gross margin fraction the org must retain. */
  marginFloor: probability,
});
export type RoutingBudget = z.infer<typeof routingBudgetSchema>;

export const chunkEstimateSchema = z.object({
  routerCostUsd: nonNegative,
  extractionCostUsd: nonNegative,
  totalCostUsd: nonNegative,
  latencyP50Ms: nonNegative,
  latencyP95Ms: nonNegative,
  budget: routingBudgetSchema,
  overBudgetActions: z.array(overBudgetActionSchema),
});
export type ChunkEstimate = z.infer<typeof chunkEstimateSchema>;

export const decisionModelCallSchema = z.object({
  model: z.string().min(1),
  stage: z.enum(["triage", "verify"]),
  questions: z.array(z.string().min(1)),
  inputTokens: nonNegativeInt,
  costUsd: nonNegative,
});
export type DecisionModelCall = z.infer<typeof decisionModelCallSchema>;

export const routerKindSchema = z.enum([
  "heuristic",
  "baseline",
  "decision-model",
  "llm-json",
  "embedding",
]);
export type RouterKind = z.infer<typeof routerKindSchema>;

/** A page carrying unusual content: never silently dropped; either flagged or explicitly skipped. */
export const pageAttentionSchema = z.object({
  pageNumber: z.number().int().min(1),
  outcome: z.enum(["flagged", "skipped"]),
  features: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
});
export type PageAttention = z.infer<typeof pageAttentionSchema>;

export const routePlanSchema = z.object({
  schemaVersion: z.literal(ROUTE_PLAN_SCHEMA_VERSION),
  documentId: z.string().min(1),
  runId: z.string().min(1),
  routerId: z.string().min(1),
  routerKind: routerKindSchema,
  mode: routingModeSchema,
  objective: routingObjectiveSchema,
  policyVersion: z.string().min(1),
  assignments: z.array(assignmentSchema),
  rejected: z.array(
    z.object({
      pageNumber: z.number().int().min(1),
      targetId: z.string().min(1),
      reason: routeRejectionReasonSchema,
    }),
  ),
  decisionModelCalls: z.array(decisionModelCallSchema),
  /** Pages with unusual features (H9) and what the planner did about them. */
  attention: z.array(pageAttentionSchema).default([]),
  triage: z.object({
    ran: z.boolean(),
    skippedReason: z.string().optional(),
    decisionModel: z.string().min(1).nullable(),
    format: decisionFormatSchema.nullable(),
    pagesPerCall: z.number().int().min(1).nullable(),
    costUsd: nonNegative,
  }),
  verifier: z.object({
    decisionModel: z.string().min(1).nullable(),
    calls: nonNegativeInt,
    escalations: nonNegativeInt,
    costUsd: nonNegative,
  }),
  chunkEstimate: chunkEstimateSchema,
});
export type RoutePlan = z.infer<typeof routePlanSchema>;

/** Universal router: every method shares the target catalog and RoutePlan. */
export interface Router {
  id: string;
  kind: RouterKind;
  plan(
    pages: PageInput[],
    catalog: RoutingTarget[],
    budget: RoutingBudget,
    objective: RoutingObjective,
  ): Promise<RoutePlan>;
}

// ---- PlanValidation -------------------------------------------------------

export const actualOutcomeSchema = z.object({
  costUsd: nonNegative,
  latencyMs: nonNegative,
  quality: probability.nullable(),
  passed: z.boolean().nullable(),
  /**
   * How quality/passed were derived when they are not ground-truth labels, e.g.
   * `output-plausibility@v1` (a free proxy: output looks like text, passes cascade checks).
   */
  qualityMethod: z.string().min(1).optional(),
});
export type ActualOutcome = z.infer<typeof actualOutcomeSchema>;

export const estimateErrorSchema = z.object({
  /** actual - estimate. */
  costErrorUsd: z.number(),
  /** |actual - estimate| / actual; null when actual is 0. */
  costAbsPctError: nonNegative.nullable(),
  latencyErrorMs: z.number(),
  latencyAbsPctError: nonNegative.nullable(),
  /** (pPass - passed)^2; null when passed is unknown. */
  passBrier: probability.nullable(),
});
export type EstimateError = z.infer<typeof estimateErrorSchema>;

export const planValidationSchema = z.object({
  schemaVersion: z.literal(PLAN_VALIDATION_SCHEMA_VERSION),
  documentId: z.string().min(1),
  runId: z.string().min(1),
  routerId: z.string().min(1),
  assignments: z.array(
    z.object({
      assignmentIndex: nonNegativeInt,
      pageNumber: z.number().int().min(1),
      targetId: z.string().min(1),
      estimate: assignmentEstimateSchema,
      actual: actualOutcomeSchema,
      error: estimateErrorSchema,
    }),
  ),
  chunk: z.object({
    estimate: z.object({
      totalCostUsd: nonNegative,
      latencyP50Ms: nonNegative,
      latencyP95Ms: nonNegative,
    }),
    actual: actualOutcomeSchema,
    error: estimateErrorSchema,
    withinBudget: z.boolean(),
  }),
});
export type PlanValidation = z.infer<typeof planValidationSchema>;

export const estimateErrorReportSchema = z.object({
  schemaVersion: z.literal(ESTIMATE_ERROR_REPORT_SCHEMA_VERSION),
  routerId: z.string().min(1),
  nAssignments: nonNegativeInt,
  nChunks: nonNegativeInt,
  costMape: nonNegative.nullable(),
  latencyMape: nonNegative.nullable(),
  /** Mean signed cost error (actual - estimate), USD. */
  costBiasUsd: z.number().nullable(),
  passBrier: probability.nullable(),
  calibrationBins: z.array(
    z.object({
      lo: probability,
      hi: probability,
      n: nonNegativeInt,
      meanPredicted: probability.nullable(),
      observedRate: probability.nullable(),
    }),
  ),
  budgetAdherence: z.object({
    chunks: nonNegativeInt,
    withinBudget: nonNegativeInt,
    rate: probability.nullable(),
  }),
});
export type EstimateErrorReport = z.infer<typeof estimateErrorReportSchema>;

// ---- Calibration and PolicyPack ------------------------------------------

export const questionCalibrationSchema = z
  .object({
    decisionModel: z.string().min(1),
    questionId: decisionQuestionIdSchema,
    n: nonNegativeInt,
    brier: probability.nullable(),
    auroc: probability.nullable(),
  })
  .and(
    z.discriminatedUnion("method", [
      z.object({
        method: z.literal("platt"),
        params: z.object({ a: z.number(), b: z.number() }),
      }),
      z.object({
        method: z.literal("isotonic"),
        /** Monotone step table: calibrated y for raw x >= xs[i]. */
        table: z.object({
          xs: z.array(probability).min(1),
          ys: z.array(probability).min(1),
        }),
      }),
    ]),
  );
export type QuestionCalibration = z.infer<typeof questionCalibrationSchema>;

/** Logistic map from calibrated question probabilities to P(pass) for one dimension. */
export const passMappingSchema = z.object({
  intercept: z.number(),
  weights: z.partialRecord(decisionQuestionIdSchema, z.number()),
  /** Prior pass rate used when no decision answers are available. */
  baseRate: probability,
});
export type PassMapping = z.infer<typeof passMappingSchema>;

export const policyTargetMappingSchema = z.object({
  targetId: z.string().min(1),
  /**
   * The decision model whose calibrated answers this mapping was fit on. Absent: the default mapping (fit on the
   * pack's primary model), used for any serving model without its own mapping for the target.
   */
  decisionModel: z.string().min(1).optional(),
  pass: z.object({
    text: passMappingSchema,
    math: passMappingSchema,
    tables: passMappingSchema,
    overall: passMappingSchema,
  }),
  cost: z.object({ meanUsd: nonNegative, p90Usd: nonNegative }),
  latency: z.object({ p50Ms: nonNegative, p95Ms: nonNegative }),
  n: nonNegativeInt,
});
export type PolicyTargetMapping = z.infer<typeof policyTargetMappingSchema>;

/**
 * A cell is a set of generic feature predicates (baseline only): never case
 * ids, filenames or expected content.
 */
export const policyFeaturePredicateSchema = z.object({
  feature: z.string().min(1),
  op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in"]),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
  ]),
});
export type PolicyFeaturePredicate = z.infer<
  typeof policyFeaturePredicateSchema
>;

export const policyCellSchema = z.object({
  id: z.string().min(1),
  /** Parent cell id for hierarchical back-off; null for the global cell. */
  parentId: z.string().min(1).nullable(),
  predicates: z.array(policyFeaturePredicateSchema),
});
export type PolicyCell = z.infer<typeof policyCellSchema>;

export const betaPosteriorSchema = z.object({
  alpha: z.number().positive(),
  beta: z.number().positive(),
});
export type BetaPosterior = z.infer<typeof betaPosteriorSchema>;

export const policyCellTargetStatsSchema = z.object({
  cellId: z.string().min(1),
  targetId: z.string().min(1),
  pass: z.object({
    text: betaPosteriorSchema,
    math: betaPosteriorSchema,
    tables: betaPosteriorSchema,
    overall: betaPosteriorSchema,
  }),
  cost: z.object({ meanUsd: nonNegative, p90Usd: nonNegative }),
  latency: z.object({ p50Ms: nonNegative, p95Ms: nonNegative }),
  n: nonNegativeInt,
});
export type PolicyCellTargetStats = z.infer<typeof policyCellTargetStatsSchema>;

/** No-model Beta-cell table kept only as the baseline to beat. */
export const policyBaselineSchema = z.object({
  cells: z.array(policyCellSchema).min(1),
  stats: z.array(policyCellTargetStatsSchema),
});
export type PolicyBaseline = z.infer<typeof policyBaselineSchema>;

export const policyPackSchema = z.object({
  schemaVersion: z.literal(POLICY_PACK_SCHEMA_VERSION),
  metadata: z.object({
    policyVersion: z.string().min(1),
    trainingDataSha256: z.string().regex(/^[a-f0-9]{64}$/),
    fitDate: z.string().min(1),
    splitPolicy: z.string().min(1),
    passThreshold: probability,
  }),
  decisionModels: z.array(z.string().min(1)).min(1),
  questions: z.array(decisionQuestionIdSchema).min(1),
  calibrations: z.array(questionCalibrationSchema),
  targets: z.array(policyTargetMappingSchema),
  baseline: policyBaselineSchema.optional(),
});
export type PolicyPack = z.infer<typeof policyPackSchema>;

export function parsePolicyPack(input: unknown): PolicyPack {
  return policyPackSchema.parse(input);
}
