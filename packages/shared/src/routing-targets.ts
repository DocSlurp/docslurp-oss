import type { AssignmentRole, DecisionModel, RoutingTarget } from "./page-routing.js";
import {
  DECISION_MODEL_SCHEMA_VERSION,
  ROUTING_TARGET_SCHEMA_VERSION,
} from "./page-routing.js";
import { transcriptionTargets } from "./routing-targets-transcription.js";
import { resolveDecisionModelLicense, resolveTargetLicense } from "./model-license.js";

// Pure catalog builder for the page router. Callers pass every source
// explicitly (vision catalog, price map, private endpoints, env presence) so the
// function is deterministic and testable. Admission mirrors
// scripts/raster-eval/live.py admission().

/** Same pattern as scripts/raster-eval/live.py admission(). */
export const PROHIBITED_MODEL_ID_PATTERN =
  /(?:^|[/_:-])(pro|ultra)(?:$|[/_:-])/i;
export const MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE = 50;

export interface RoutingModelPrice {
  input: number;
  output: number;
  vision?: boolean;
  checked?: string;
}
export interface RoutingModelPriceMap {
  asOf?: string;
  models: Record<string, RoutingModelPrice>;
}
export interface RoutingVisionCatalogEntry {
  id: string;
  uri: string;
  target: string;
  runtime?: string;
  estimatedCostPerPageCents?: number;
}
export interface RoutingPrivateEndpointInput {
  /** Matches a private seed model id, e.g. "lightonocr-3". */
  modelId: string;
  hourlyUsd?: number;
  pagesPerMinuteObserved?: number;
}

export interface BuildRoutingTargetCatalogInput {
  visionCatalog?: readonly RoutingVisionCatalogEntry[];
  prices?: RoutingModelPriceMap;
  privateEndpoints?: readonly RoutingPrivateEndpointInput[];
  /** Env var name -> present. Values are never read. */
  env?: Readonly<Record<string, boolean>>;
  /** Extra candidates run through the same admission. */
  extraTargets?: readonly RoutingTarget[];
  checkedAt?: string;
  /**
   * DISABLE_NON_FREE_SOFTWARE: reject every target whose licence class is "non-free" (custom addenda,
   * non-commercial, research-only, undeclared). Proprietary hosted APIs are not affected; privacy modes govern those.
   */
  disableNonFree?: boolean;
}

export type RoutingAdmissionRejectionReason =
  | "non-free-disabled"
  | "prohibited-model"
  | "output-price-too-high"
  | "missing-price"
  | "no-image-input"
  | "unavailable";

export interface RoutingTargetRejection {
  targetId: string;
  reason: RoutingAdmissionRejectionReason;
  detail: string;
}
export interface RoutingTargetCatalog {
  targets: RoutingTarget[];
  rejected: RoutingTargetRejection[];
}

const FLASH_LITE_ROLES: AssignmentRole[] = [
  "extract-text",
  "ocr",
  "table",
  "image-label",
];
const STRONG_VLM_ROLES: AssignmentRole[] = [
  ...FLASH_LITE_ROLES,
  "chart-data",
  "math",
  "diagram",
];

export const NATIVE_PDF_MARKDOWN_TARGET_ID = "native:pdf-markdown";
export const NATIVE_PDF_TEXT_TARGET_ID = "native:pdf-text";
export const NATIVE_PDF_OCR_FILL_TARGET_ID = "ocr:pdf-ocr-fill";
export const NATIVE_PDF_OCR_TARGET_ID = "ocr:pdf-ocr";

/**
 * Measured per-page cost of the native-pdf targets (local CPU, no model). Source: the native-pdf engine bench
 * (internal research notes when published; run dirs under runs/page-router-20261012/native-pdf-bench), medians over
 * the dev/cal/test corpora. Markdown is the Node binding arm (the arm the executor really runs, n=38 documents);
 * plain text is the Python arm of the same engine (the Node text arm is unmeasured), so it is conservative.
 */
export const NATIVE_PDF_MEASURED = {
  markdown: { p50Ms: 10.6, p95Ms: 20.6, n: 38, source: "native-pdf-bench node md-lines 2026-10-12" },
  text: { p50Ms: 11.6, p95Ms: 47.9, n: 181, source: "native-pdf-bench python text arm 2026-10-12" },
} as const;

function measuredLocal(m: { p50Ms: number; p95Ms: number; n: number; source: string }) {
  return {
    latency: { p50Ms: m.p50Ms, p95Ms: m.p95Ms, source: m.source, n: m.n },
    pagesPerMinuteObserved: Math.round(60000 / m.p50Ms),
  };
}

/** Roles each target serves, keyed by target id (default: extract-text). */
function rolesFor(id: string, latex = false): AssignmentRole[] {
  if (id === "native:accept-text-layer") return ["accept-text"];
  if (id === "skip") return ["skip"];
  if (id === "local:florence-2-small") return ["image-label"];
  if (id === "native:kreuzberg") return ["extract-text", "table"];
  // Neutral native-pdf engine targets (the engine behind them is an internal detail).
  if (id === NATIVE_PDF_MARKDOWN_TARGET_ID) return ["extract-text", "table"];
  if (id === NATIVE_PDF_TEXT_TARGET_ID) return ["extract-text"];
  if (id === NATIVE_PDF_OCR_FILL_TARGET_ID || id === NATIVE_PDF_OCR_TARGET_ID) return ["ocr", "extract-text"];
  if (id === "ocr:tesseract") return ["ocr", "extract-text"];
  if (id.startsWith("vlm:private/")) {
    return latex
      ? ["ocr", "extract-text", "table", "math"]
      : ["ocr", "extract-text", "table"];
  }
  if (/gemini-3\.5-flash$|gpt-6-luna$/.test(id)) return STRONG_VLM_ROLES;
  return FLASH_LITE_ROLES;
}

const UNKNOWN_LATENCY = { p50Ms: 0, p95Ms: 0, source: "unmeasured", n: 0 };

function base(
  id: string,
  kind: RoutingTarget["kind"],
  ref: RoutingTarget["ref"],
  over: Partial<RoutingTarget["capabilities"]>,
  privacyClass: RoutingTarget["availability"]["privacyClass"],
  requiresEnv: string[] = [],
): RoutingTarget {
  return {
    schemaVersion: ROUTING_TARGET_SCHEMA_VERSION,
    id,
    kind,
    ref,
    roles: rolesFor(id, over.emitsLatex),
    capabilities: {
      imageInput: false,
      multiImagePerRequest: false,
      maxImagesPerRequest: 1,
      maxImageLongEdgePx: null,
      emitsLatex: false,
      emitsHtmlTables: false,
      usesNativeTextLayer: false,
      ...over,
    },
    pricing: { source: "local-compute", checkedAt: "" },
    latency: { ...UNKNOWN_LATENCY },
    availability: { requiresEnv, privacyClass },
  };
}

const HOSTED_SEED_MODELS = [
  "google/gemini-2.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.5-flash-lite",
  "z-ai/glm-5.3-flash",
  "google/gemini-3.5-flash",
  "openai/gpt-6-luna",
] as const;

const PRIVATE_SEEDS = [
  { id: "lightonocr-3", env: "LIGHTONOCR_3_ENDPOINT_URL", latex: true },
  { id: "mineru2.5", env: "MINERU_2_5_ENDPOINT_URL", latex: true },
  { id: "infinity-parser2", env: "INFINITY_PARSER2_ENDPOINT_URL", latex: false },
] as const;

function hostedTarget(model: string): RoutingTarget {
  return base(
    `vlm:openrouter/${model}`,
    "hosted-vlm",
    { modelUri: `llm://openrouter/${model}` },
    { imageInput: true, multiImagePerRequest: true, maxImagesPerRequest: 16 },
    "hosted",
    ["OPENROUTER_API_KEY"],
  );
}

function nativePdfTarget(
  id: string,
  mode: "markdown" | "text",
  over: Partial<RoutingTarget["capabilities"]>,
): RoutingTarget {
  const t = base(
    id,
    "native",
    { extractorId: "native-pdf" },
    { usesNativeTextLayer: true, ...over },
    "local",
  );
  const m = measuredLocal(NATIVE_PDF_MEASURED[mode]);
  return {
    ...t,
    pricing: { ...t.pricing, pagesPerMinuteObserved: m.pagesPerMinuteObserved },
    latency: m.latency,
  };
}

function seedTargets(): RoutingTarget[] {
  const seeds: RoutingTarget[] = [
    base(
      "native:accept-text-layer",
      "native",
      { extractorId: "accept-text-layer" },
      { usesNativeTextLayer: true },
      "local",
    ),
    base("skip", "skip", {}, {}, "local"),
    base(
      "local:florence-2-small",
      "local-labeler",
      { modelUri: "llm://local/florence-2-small" },
      { imageInput: true },
      "local",
    ),
    base(
      "native:kreuzberg",
      "native",
      { extractorId: "kreuzberg" },
      { usesNativeTextLayer: true, emitsHtmlTables: true },
      "local",
    ),
    nativePdfTarget(NATIVE_PDF_MARKDOWN_TARGET_ID, "markdown", { emitsHtmlTables: false }),
    nativePdfTarget(NATIVE_PDF_TEXT_TARGET_ID, "text", {}),
    // OCR tiers: unmeasured until the binding supports ocr-fill; the executor falls back to ocr:tesseract.
    base(
      NATIVE_PDF_OCR_FILL_TARGET_ID,
      "local-ocr",
      { extractorId: "native-pdf-ocr-fill" },
      { imageInput: true, usesNativeTextLayer: true },
      "local",
    ),
    base(
      NATIVE_PDF_OCR_TARGET_ID,
      "local-ocr",
      { extractorId: "native-pdf-ocr" },
      { imageInput: true },
      "local",
    ),
    base(
      "ocr:tesseract",
      "local-ocr",
      { extractorId: "tesseract" },
      { imageInput: true },
      "local",
    ),
    ...HOSTED_SEED_MODELS.map(hostedTarget),
    ...PRIVATE_SEEDS.map((p) =>
      base(
        `vlm:private/${p.id}`,
        "private-vlm",
        { modelUri: `llm://private/${p.id}` },
        { imageInput: true, emitsLatex: p.latex, emitsHtmlTables: true },
        "private",
        [p.env],
      ),
    ),
  ];
  return seeds;
}

function modelOf(target: RoutingTarget): string | null {
  const uri = target.ref.modelUri;
  if (!uri) return null;
  return uri.replace(/^llm:\/\/[^/]+\//, "");
}

function lookupPrice(
  prices: RoutingModelPriceMap | undefined,
  model: string,
): RoutingModelPrice | undefined {
  const map = prices?.models;
  if (!map) return undefined;
  return map[model] ?? map[`openai/${model}`];
}

export function isProhibitedRoutingModelId(id: string): boolean {
  return PROHIBITED_MODEL_ID_PATTERN.test(id);
}

export function buildRoutingTargetCatalog(
  input: BuildRoutingTargetCatalogInput = {},
): RoutingTargetCatalog {
  const env = input.env ?? {};
  const checkedAt = input.checkedAt ?? input.prices?.asOf ?? "unknown";
  const candidates = new Map<string, RoutingTarget>();
  for (const seed of seedTargets()) candidates.set(seed.id, seed);
  for (const entry of input.visionCatalog ?? []) {
    if (entry.target !== "hosted") continue;
    const model = entry.uri.replace(/^llm:\/\/[^/]+\//, "");
    const provider = entry.uri.match(/^llm:\/\/([^/]+)\//)?.[1] ?? "openrouter";
    const id = `vlm:${provider}/${model}`;
    if (candidates.has(id)) continue;
    candidates.set(id, {
      ...hostedTarget(model),
      id,
      ref: { modelUri: entry.uri },
    });
  }
  for (const extra of [...transcriptionTargets(), ...(input.extraTargets ?? [])]) candidates.set(extra.id, extra);

  const targets: RoutingTarget[] = [];
  const rejected: RoutingTargetRejection[] = [];
  const reject = (
    targetId: string,
    reason: RoutingAdmissionRejectionReason,
    detail: string,
  ) => rejected.push({ targetId, reason, detail });

  for (const stamped of candidates.values()) {
    const candidate: RoutingTarget = { ...stamped, ...resolveTargetLicense(stamped) };
    const model = modelOf(candidate);
    const idsToCheck = [candidate.id, model].filter((v): v is string => !!v);
    if (idsToCheck.some(isProhibitedRoutingModelId)) {
      reject(candidate.id, "prohibited-model", "Pro/Ultra models are prohibited");
      continue;
    }

    if (input.disableNonFree && candidate.licenseClass === "non-free") {
      reject(candidate.id, "non-free-disabled", `non-free licence (${candidate.license?.id ?? "undeclared"}); DISABLE_NON_FREE_SOFTWARE is on`);
      continue;
    }

    let target = candidate;
    if (candidate.kind === "private-vlm") {
      const seed = PRIVATE_SEEDS.find((p) => p.id === model);
      const endpoint = input.privateEndpoints?.find((e) => e.modelId === model);
      const envKey = candidate.availability.requiresEnv[0];
      if (!endpoint && !(envKey && env[envKey])) {
        reject(candidate.id, "unavailable", `${seed?.env ?? "endpoint"} not set`);
        continue;
      }
      target = {
        ...candidate,
        pricing: {
          source: "private-endpoint",
          checkedAt,
          ...(endpoint?.hourlyUsd !== undefined && { hourlyUsd: endpoint.hourlyUsd }),
          ...(endpoint?.pagesPerMinuteObserved !== undefined && {
            pagesPerMinuteObserved: endpoint.pagesPerMinuteObserved,
          }),
        },
      };
    } else if (candidate.kind === "hosted-vlm") {
      const price = model ? lookupPrice(input.prices, model) : undefined;
      if (
        !price ||
        !Number.isFinite(price.input) ||
        !Number.isFinite(price.output) ||
        price.input < 0 ||
        price.output <= 0
      ) {
        reject(candidate.id, "missing-price", "Missing or invalid hosted price");
        continue;
      }
      if (price.output >= MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE) {
        reject(
          candidate.id,
          "output-price-too-high",
          `Output $${price.output}/M >= $${MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE}/M`,
        );
        continue;
      }
      if (price.vision === false || !candidate.capabilities.imageInput) {
        reject(candidate.id, "no-image-input", "Image input unsupported");
        continue;
      }
      target = {
        ...candidate,
        pricing: {
          source: "model-prices.json",
          checkedAt: price.checked ?? checkedAt,
          inputUsdPerMTok: price.input,
          outputUsdPerMTok: price.output,
        },
      };
    }

    if (
      (target.kind === "hosted-vlm" ||
        target.kind === "private-vlm" ||
        target.kind === "local-labeler" ||
        target.kind === "local-ocr") &&
      !target.capabilities.imageInput
    ) {
      reject(target.id, "no-image-input", "VLM extract target needs image input");
      continue;
    }
    targets.push(
      target.pricing.checkedAt
        ? target
        : { ...target, pricing: { ...target.pricing, checkedAt } },
    );
  }
  return { targets, rejected };
}

// ---- Decision-model catalog ----------------------------------------------

export type DecisionModelAdmissionRejectionReason =
  | "non-free-disabled"
  | "prohibited-model"
  | "output-billed"
  | "missing-price"
  | "unavailable";

export interface DecisionModelRejection {
  modelId: string;
  reason: DecisionModelAdmissionRejectionReason;
  detail: string;
}
export interface DecisionModelCatalog {
  models: DecisionModel[];
  rejected: DecisionModelRejection[];
}
export interface BuildDecisionModelCatalogInput {
  /** Env var name -> present. Values are never read. */
  env?: Readonly<Record<string, boolean>>;
  /** Extra candidates run through the same admission. */
  extraModels?: readonly DecisionModel[];
  /** DISABLE_NON_FREE_SOFTWARE: reject decision models whose licence class is "non-free" (Liquid d1 under the LFM licence). */
  disableNonFree?: boolean;
}

function decisionModel(
  id: string,
  endpoint: DecisionModel["endpoint"],
  modalities: DecisionModel["modalities"],
  maxQuestionsPerRequest: number,
  inputUsdPerMTok: number,
  requiresEnv: string[],
  roles: DecisionModel["roles"],
  privacyClass: DecisionModel["availability"]["privacyClass"] = "hosted",
  billingMode: NonNullable<DecisionModel["billingMode"]> = "per-question",
): DecisionModel {
  return {
    schemaVersion: DECISION_MODEL_SCHEMA_VERSION,
    id,
    endpoint,
    modalities,
    maxQuestionsPerRequest,
    pricing: { inputUsdPerMTok, outputUsdPerMTok: 0, checkedAt: "2026-10-12" },
    billingMode,
    roles,
    availability: { requiresEnv, privacyClass },
  };
}

const ALL_ROLES: DecisionModel["roles"] = ["triage", "verify", "route"];

function seedDecisionModels(): DecisionModel[] {
  return [
    decisionModel(
      "perplexity/pplx-decider-v1.1-27b",
      "perplexity-decisions",
      { text: true, image: true, maxImagesPerRequest: 16 },
      128,
      0.02,
      ["PERPLEXITYAI_API_KEY"],
      ALL_ROLES,
    ),
    decisionModel(
      "typesafe/jev-1.13",
      "openrouter-systemone",
      { text: true, image: false, maxImagesPerRequest: 0 },
      64,
      0.042,
      ["OPENROUTER_API_KEY"],
      ["triage", "verify", "route"],
    ),
    decisionModel(
      "liquid/d1",
      "openrouter-systemone",
      { text: true, image: false, maxImagesPerRequest: 0 },
      64,
      0.04,
      ["OPENROUTER_API_KEY"],
      ALL_ROLES,
    ),
    decisionModel(
      "liquid/d1:direct",
      "liquid-systemone",
      { text: true, image: true, maxImagesPerRequest: 8 },
      64,
      0.04,
      ["LIQUID_API_KEY"],
      ALL_ROLES,
    ),
    decisionModel(
      "local/LiquidAI/d1-omni-600M",
      "local-transformers",
      { text: true, image: true, maxImagesPerRequest: 8 },
      64,
      0,
      [],
      ALL_ROLES,
      "local",
    ),
    // OpenRouter /api/v1/systemone routes. Verified 2026-10-12: Clef accepts at most 4 images and 64
    // questions per request and bills the state once per call, not once per question.
    decisionModel(
      "cloudflare/clef-flash",
      "openrouter-systemone",
      { text: true, image: true, maxImagesPerRequest: 4 },
      64,
      0.038,
      ["OPENROUTER_API_KEY"],
      ALL_ROLES,
      "hosted",
      "per-call",
    ),
    decisionModel(
      "cloudflare/clef-omni",
      "openrouter-systemone",
      { text: true, image: true, maxImagesPerRequest: 4 },
      64,
      0.15,
      ["OPENROUTER_API_KEY"],
      ALL_ROLES,
      "hosted",
      "per-call",
    ),
    decisionModel(
      "openai/gpt-6-luna-decisions",
      "openrouter-systemone",
      { text: true, image: true, maxImagesPerRequest: 16 },
      128,
      0.1,
      ["OPENROUTER_API_KEY"],
      ALL_ROLES,
      "hosted",
      "per-call",
    ),
  ];
}

/** A catalog decision model by id, ignoring env availability (for sizing and pricing). */
export function findDecisionModel(id: string): DecisionModel | undefined {
  return seedDecisionModels().find((m) => m.id === id);
}

export function buildDecisionModelCatalog(
  input: BuildDecisionModelCatalogInput = {},
): DecisionModelCatalog {
  const env = input.env ?? {};
  const candidates = new Map<string, DecisionModel>();
  for (const m of seedDecisionModels()) candidates.set(m.id, m);
  for (const m of input.extraModels ?? []) candidates.set(m.id, m);

  const models: DecisionModel[] = [];
  const rejected: DecisionModelRejection[] = [];
  for (const stamped of candidates.values()) {
    const m: DecisionModel = { ...stamped, ...resolveDecisionModelLicense(stamped) };
    const reject = (
      reason: DecisionModelAdmissionRejectionReason,
      detail: string,
    ) => rejected.push({ modelId: m.id, reason, detail });
    if (input.disableNonFree && m.licenseClass === "non-free") {
      reject("non-free-disabled", `non-free licence (${m.license?.id ?? "undeclared"}); DISABLE_NON_FREE_SOFTWARE is on`);
      continue;
    }
    if (isProhibitedRoutingModelId(m.id)) {
      reject("prohibited-model", "Pro/Ultra models are prohibited");
      continue;
    }
    const price = m.pricing as Partial<DecisionModel["pricing"]>;
    if (
      typeof price.inputUsdPerMTok !== "number" ||
      !Number.isFinite(price.inputUsdPerMTok) ||
      price.inputUsdPerMTok < 0
    ) {
      reject("missing-price", "Missing or invalid input price");
      continue;
    }
    if (price.outputUsdPerMTok !== 0) {
      reject("output-billed", "Decision models must be input-billed only");
      continue;
    }
    const missing = m.availability.requiresEnv.filter((k) => !env[k]);
    if (missing.length > 0) {
      reject("unavailable", `${missing.join(", ")} not set`);
      continue;
    }
    models.push(m);
  }
  return { models, rejected };
}
