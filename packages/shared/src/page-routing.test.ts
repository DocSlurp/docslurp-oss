import { describe, expect, it } from "vitest";
import {
  DECISION_MODEL_SCHEMA_VERSION,
  PAGE_FEATURES_SCHEMA_VERSION,
  ESTIMATE_ERROR_REPORT_SCHEMA_VERSION,
  PAGE_INPUT_SCHEMA_VERSION,
  PLAN_VALIDATION_SCHEMA_VERSION,
  ROUTE_PLAN_SCHEMA_VERSION,
  assignmentSchema,
  estimateErrorReportSchema,
  pageInputSchema,
  planValidationSchema,
  routePlanSchema,
  type Router,
  POLICY_PACK_SCHEMA_VERSION,
  decisionModelSchema,
  pageFeaturesSchema,
  parsePolicyPack,
  policyPackSchema,
  questionCalibrationSchema,
  routingTargetSchema,
  targetEstimateSchema,
} from "./page-routing.js";
import {
  buildDecisionModelCatalog,
  buildRoutingTargetCatalog,
} from "./routing-targets.js";

const pass = { text: 0.9, math: 0.5, tables: 0.7, overall: 0.6 };
const estimate = {
  targetId: "native:kreuzberg",
  pPass: pass,
  qualityMean: 0.8,
  qualityCi: [0.7, 0.9] as [number, number],
  expectedCostUsd: 0,
  expectedLatencyMs: 120,
  calibrationBucket: "global",
};
const source = {
  decisionModel: "perplexity/pplx-decider-v1.1-27b",
  format: "grid" as const,
  pagesPerCall: 16,
  tilePx: 512,
};
const features = {
  schemaVersion: PAGE_FEATURES_SCHEMA_VERSION,
  pageNumber: 1,
  documentFormat: "pdf",
  pageCount: 3,
  native: {
    charCount: 100,
    wordCount: 20,
    textCoverage: 0.5,
    fontCount: 2,
    unmappedGlyphRatio: 0,
    mathGlyphRatio: 0.1,
    tableRuleScore: 0.2,
    garbled: false,
    plausibility: 0.9,
  },
  raster: {
    imageCoverage: 0,
    largestImageCoverage: 0,
    fullPageImage: false,
    vectorDrawingCount: 0,
    uncoveredVectorRatio: 0,
    smallestFontPt: 8,
  },
  geometry: { widthPt: 612, heightPt: 792, rotation: 0 },
  heuristic: {
    route: "straightforward-text",
    extractorHint: null,
    specializedKinds: [],
    ocrAuthorized: null,
    textDensityScore: 0.4,
  },
  decisions: {
    probabilities: { has_math: 0.8, native_text_faithful: 0.3 },
    choices: {
      image_kind: [
        { imageIndex: 0, probabilities: { "chart-graph": 0.7, logo: 0.1 } },
      ],
    },
    source,
  },
  provenance: { probe: "pymupdf-probe", probeMs: 4 },
};
const estimateA = { costUsd: 0.001, latencyMs: 300, pPass: 0.9 };
const assignments = [
  {
    pageNumber: 1,
    scope: { kind: "page" },
    targetId: "native:accept-text-layer",
    role: "accept-text",
    reason: "text layer ok",
    estimate: { costUsd: 0, latencyMs: 5, pPass: 0.95 },
    cascade: [],
  },
  {
    pageNumber: 1,
    scope: {
      kind: "image",
      imageIndex: 0,
      bbox: { x: 0, y: 0, width: 100, height: 80 },
    },
    targetId: "vlm:openrouter/google/gemini-3.5-flash",
    role: "chart-data",
    reason: "chart-graph image",
    estimate: estimateA,
    cascade: [
      { targetId: "vlm:openrouter/openai/gpt-6-luna", trigger: "empty-output" },
    ],
  },
  {
    pageNumber: 1,
    scope: { kind: "region", bbox: { x: 1, y: 2, width: 3, height: 4 } },
    targetId: "skip",
    role: "skip",
    reason: "decorative",
    estimate: { costUsd: 0, latencyMs: 0, pPass: 1 },
    cascade: [],
  },
];
const chunkEstimate = {
  routerCostUsd: 0.0001,
  extractionCostUsd: 0.001,
  totalCostUsd: 0.0011,
  latencyP50Ms: 300,
  latencyP95Ms: 900,
  budget: { limitUsd: 0.01, marginFloor: 0.6 },
  overBudgetActions: ["downgrade", "defer"],
};
const plan = {
  schemaVersion: ROUTE_PLAN_SCHEMA_VERSION,
  documentId: "d",
  runId: "r",
  routerId: "pplx-decider",
  routerKind: "decision-model",
  mode: "shadow",
  objective: "cost-quality",
  policyVersion: "p1",
  assignments,
  rejected: [{ pageNumber: 1, targetId: "x", reason: "capability" }],
  attention: [{ pageNumber: 1, outcome: "flagged", features: ["ocg-hidden"], reason: "needs-attention: hidden layer" }],
  decisionModelCalls: [
    {
      model: source.decisionModel,
      stage: "triage",
      questions: ["has_math", "trust_text_layer"],
      inputTokens: 1000,
      costUsd: 0.00002,
    },
  ],
  triage: {
    ran: true,
    decisionModel: source.decisionModel,
    format: "grid",
    pagesPerCall: 16,
    costUsd: 0.0001,
  },
  verifier: {
    decisionModel: source.decisionModel,
    calls: 1,
    escalations: 0,
    costUsd: 0.00002,
  },
  chunkEstimate,
};
const actual = { costUsd: 0.0012, latencyMs: 350, quality: 0.8, passed: true };
const error = {
  costErrorUsd: 0.0001,
  costAbsPctError: 0.08,
  latencyErrorMs: 50,
  latencyAbsPctError: 0.14,
  passBrier: 0.01,
};
const mapping = {
  intercept: -1,
  weights: { has_math: 1.5 },
  baseRate: 0.6,
};
const pack = {
  schemaVersion: POLICY_PACK_SCHEMA_VERSION,
  metadata: {
    policyVersion: "p1",
    trainingDataSha256: "a".repeat(64),
    fitDate: "2026-10-12",
    splitPolicy: "dev+calibration",
    passThreshold: 0.8,
  },
  decisionModels: [source.decisionModel],
  questions: ["has_math", "native_text_faithful"],
  calibrations: [
    {
      decisionModel: source.decisionModel,
      questionId: "has_math",
      method: "platt",
      params: { a: 1.2, b: -0.1 },
      n: 100,
      brier: 0.1,
      auroc: 0.9,
    },
    {
      decisionModel: source.decisionModel,
      questionId: "native_text_faithful",
      method: "isotonic",
      table: { xs: [0, 0.5], ys: [0.1, 0.9] },
      n: 100,
      brier: 0.2,
      auroc: null,
    },
  ],
  targets: [
    {
      targetId: "native:kreuzberg",
      pass: { text: mapping, math: mapping, tables: mapping, overall: mapping },
      cost: { meanUsd: 0, p90Usd: 0 },
      latency: { p50Ms: 100, p95Ms: 200 },
      n: 50,
    },
  ],
  baseline: {
    cells: [{ id: "global", parentId: null, predicates: [] }],
    stats: [],
  },
};

describe("page routing schemas", () => {
  it("round-trips PageFeatures", () => {
    expect(pageFeaturesSchema.parse(features)).toEqual(features);
    expect(
      pageFeaturesSchema.parse({ ...features, decisions: null }).decisions,
    ).toBeNull();
  });

  it("rejects unknown decision question ids and out-of-range probabilities", () => {
    expect(
      pageFeaturesSchema.safeParse({
        ...features,
        decisions: { probabilities: { has_math: 1.5 }, source },
      }).success,
    ).toBe(false);
  });

  it("round-trips DecisionModel", () => {
    const model = buildDecisionModelCatalog({
      env: { PERPLEXITYAI_API_KEY: true },
    }).models[0]!;
    expect(decisionModelSchema.parse(model)).toEqual(model);
    expect(model.schemaVersion).toBe(DECISION_MODEL_SCHEMA_VERSION);
    expect(
      decisionModelSchema.safeParse({
        ...model,
        pricing: { ...model.pricing, outputUsdPerMTok: 1 },
      }).success,
    ).toBe(false);
  });

  it("round-trips RoutingTarget", () => {
    const { targets } = buildRoutingTargetCatalog({});
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(routingTargetSchema.parse(t)).toEqual(t);
  });

  it("round-trips QuestionCalibration and TargetEstimate", () => {
    for (const c of pack.calibrations)
      expect(questionCalibrationSchema.parse(c)).toEqual(c);
    expect(targetEstimateSchema.parse(estimate)).toEqual(estimate);
  });

  it("round-trips PageInput", () => {
    const input = {
      schemaVersion: PAGE_INPUT_SCHEMA_VERSION,
      features,
      textFacts: {
        wordCount: 35,
        imageCount: 1,
        imageCoverage: 0.4,
        textLayerStatus: "suspect",
      },
      images: [
        { index: 0, bbox: { x: 0, y: 0, width: 10, height: 10 }, coverage: 0.4 },
      ],
      thumbnail: { uri: "s3://t/1.png", widthPx: 256, heightPx: 330 },
    };
    const parsed = pageInputSchema.parse(input);
    expect(parsed).toEqual({
      ...input,
      features: { ...features, decisions: { ...features.decisions, choices: features.decisions.choices } },
    });
    expect(
      pageInputSchema.safeParse({
        ...input,
        textFacts: { ...input.textFacts, textLayerStatus: "bad" },
      }).success,
    ).toBe(false);
  });

  it("round-trips RoutePlan with multiple assignments per page", () => {
    expect(routePlanSchema.parse(plan)).toEqual(plan);
    expect(
      routePlanSchema.safeParse({
        ...plan,
        schemaVersion: "route-plan@v1",
      }).success,
    ).toBe(false);
  });

  it("limits cascade to one escalation per assignment", () => {
    const c = assignments[1]!.cascade[0]!;
    expect(
      assignmentSchema.safeParse({ ...assignments[1], cascade: [c, c] })
        .success,
    ).toBe(false);
    expect(
      assignmentSchema.safeParse({ ...assignments[0], role: "bogus" }).success,
    ).toBe(false);
  });

  it("round-trips PlanValidation and EstimateErrorReport", () => {
    const validation = {
      schemaVersion: PLAN_VALIDATION_SCHEMA_VERSION,
      documentId: "d",
      runId: "r",
      routerId: "pplx-decider",
      assignments: [
        {
          assignmentIndex: 1,
          pageNumber: 1,
          targetId: assignments[1]!.targetId,
          estimate: estimateA,
          actual,
          error,
        },
      ],
      chunk: {
        estimate: {
          totalCostUsd: 0.0011,
          latencyP50Ms: 300,
          latencyP95Ms: 900,
        },
        actual: { ...actual, quality: null, passed: null },
        error: { ...error, passBrier: null },
        withinBudget: true,
      },
    };
    expect(planValidationSchema.parse(validation)).toEqual(validation);
    const report = {
      schemaVersion: ESTIMATE_ERROR_REPORT_SCHEMA_VERSION,
      routerId: "pplx-decider",
      nAssignments: 1,
      nChunks: 1,
      costMape: 0.08,
      latencyMape: 0.14,
      costBiasUsd: 0.0001,
      passBrier: 0.01,
      calibrationBins: [
        { lo: 0.8, hi: 1, n: 1, meanPredicted: 0.9, observedRate: 1 },
      ],
      budgetAdherence: { chunks: 1, withinBudget: 1, rate: 1 },
    };
    expect(estimateErrorReportSchema.parse(report)).toEqual(report);
  });

  it("allows a Router implementation to be typed against the contract", async () => {
    const router: Router = {
      id: "stub",
      kind: "baseline",
      plan: async () => routePlanSchema.parse(plan),
    };
    const out = await router.plan(
      [],
      buildRoutingTargetCatalog({}).targets,
      chunkEstimate.budget,
      "cost-quality",
    );
    expect(out.assignments).toHaveLength(3);
  });

  it("round-trips PolicyPack and rejects unknown schemaVersion", () => {
    expect(parsePolicyPack(pack)).toEqual(pack);
    const { baseline: _b, ...noBaseline } = pack;
    expect(policyPackSchema.parse(noBaseline).baseline).toBeUndefined();
    expect(() =>
      parsePolicyPack({ ...pack, schemaVersion: "policy-pack@v0" }),
    ).toThrow();
    expect(() =>
      parsePolicyPack({ ...pack, schemaVersion: "policy-pack@v2" }),
    ).toThrow();
  });
});
