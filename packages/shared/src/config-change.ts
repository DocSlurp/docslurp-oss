import { z } from "zod";

import { FIXED_OVERHEAD_SECONDS, estimateIngest, isBillingEnforced, type PipelineProfileId } from "./billing.js";
import { sha256Hex } from "./hash.js";
import { embeddingModelCatalogByUri, embeddingProfileCatalog } from "./embedding.js";
import { costEstimateSchema, type CostEstimate } from "./jobs.js";
import {
  affectedStages,
  compilePipelinePlan,
  pipelineStageOrder,
  pipelineValuesEqual,
  type PipelineFeatures,
  type PipelineRunStage,
} from "./pipeline.js";

export const configChangeKindSchema = z.enum(["none", "search-only", "new-uploads", "reindex-recommended", "reindex-required"]);
export type ConfigChangeKind = z.infer<typeof configChangeKindSchema>;

export type ConfigChangeImpact = {
  kind: ConfigChangeKind;
  /** Minimal stage set for existing documents; empty unless the kind is a re-index. */
  stages: PipelineRunStage[];
  reasons: Array<{ field: string; effect: string }>;
  documents: number;
  pages: number;
};

export type ConfigChangeContext = { documents: number; pages: number };

const KIND_RANK: Record<ConfigChangeKind, number> = {
  none: 0,
  "search-only": 1,
  "new-uploads": 2,
  "reindex-recommended": 3,
  "reindex-required": 4,
};

/** What determines whether stored vectors are interchangeable; recorded per workspace in `index_configs`, keyed by `indexConfigHash`. */
export type IndexConfig = {
  embeddingModel: string;
  dims: number | null;
  chunking: {
    chunkOverlap: boolean;
    contextualChunkPreambles: boolean;
    lateChunking: boolean;
    lateChunkingWindow: number;
  };
  vectorBackends: string[];
};

export function indexConfigOf(features: PipelineFeatures): IndexConfig {
  const embedding = features.embedding;
  const modelUri = embedding.modelUri ?? embeddingProfileCatalog[embedding.profile].config.modelUri;
  return {
    embeddingModel: modelUri,
    dims: embedding.dimensions ?? embeddingModelCatalogByUri[modelUri]?.dimensions ?? null,
    chunking: {
      chunkOverlap: features.chunkOverlap,
      contextualChunkPreambles: features.contextualChunkPreambles,
      lateChunking: embedding.lateChunking,
      lateChunkingWindow: embedding.lateChunkingWindow,
    },
    vectorBackends: [...features.vectorBackends],
  };
}

/** Stable identity of an index config, stored per document as `documents.index_config_hash`. */
export function indexConfigHash(config: IndexConfig): string {
  const { chunking } = config;
  return sha256Hex(JSON.stringify([
    config.embeddingModel,
    config.dims,
    [chunking.chunkOverlap, chunking.contextualChunkPreambles, chunking.lateChunking, chunking.lateChunkingWindow],
    [...config.vectorBackends].sort(),
  ])).slice(0, 32);
}

type FieldImpact = ConfigChangeKind | ((before: PipelineFeatures, after: PipelineFeatures) => ConfigChangeKind);

/** A feature switched on adds value to old documents; switched off only affects future ones. */
const toggled = (key: "summarize" | "pageIndex" | "propositionIndex" | "graphRag" | "graphCommunitySummaries" | "entityIndex" |
  "htmlExtraction" | "markdownExtraction" | "preserveTables" | "preserveCode" | "preserveImages" | "pdfRegionExtraction" |
  "visionFallback" | "embed" | "indexVectors"): FieldImpact =>
  (before, after) => (after[key] && !before[key] ? "reindex-recommended" : "new-uploads");

const PII_ACTION_RANK = { flag_for_review: 1, redact_artifacts: 2, block_indexing: 3 } as const;
const piiStrictness = (features: PipelineFeatures): number =>
  features.piiPolicy.enabled ? PII_ACTION_RANK[features.piiPolicy.action] : 0;

const PRIVACY_RANK = { standard: 0, "local-only": 1, "strict-privacy": 2 } as const;
const PLAYBOOK_RANK = { fast: 0, balanced: 1, "layout-aware": 2, agentic: 3, "review-grade": 4 } as const;

/**
 * Impact of changing each pipeline feature field on already-ingested documents. The record is keyed by every
 * `PipelineFeatures` field, so adding a field without classifying it fails type-checking and the shared test.
 * A function classifies on the before/after values (direction matters for PII, privacy and toggles).
 */
export const PIPELINE_FIELD_IMPACT: Record<keyof PipelineFeatures, FieldImpact> = {
  // Existing vectors would be incompatible with new queries/chunks.
  embedding: "reindex-required",
  chunkOverlap: "reindex-required",
  contextualChunkPreambles: "reindex-required",
  vectorBackends: "reindex-required",
  piiPolicy: (before, after) => {
    const added = after.piiPolicy.patterns.some((pattern) => !before.piiPolicy.patterns.includes(pattern));
    // Dropping allowlist entries makes detection stricter; adding entries loosens it.
    const allowlistShrunk = before.piiPolicy.allowlistPatterns.some((pattern) => !after.piiPolicy.allowlistPatterns.includes(pattern));
    const stricter = piiStrictness(after) > piiStrictness(before) || (after.piiPolicy.enabled && (added || allowlistShrunk));
    return stricter ? "reindex-required" : "new-uploads";
  },
  privacyMode: (before, after) => (PRIVACY_RANK[after.privacyMode] > PRIVACY_RANK[before.privacyMode] ? "reindex-required" : "new-uploads"),
  // Adds value to old documents; nothing breaks without it.
  summarize: toggled("summarize"),
  pageIndex: toggled("pageIndex"),
  propositionIndex: toggled("propositionIndex"),
  graphRag: toggled("graphRag"),
  graphCommunitySummaries: toggled("graphCommunitySummaries"),
  entityIndex: toggled("entityIndex"),
  graph: "reindex-recommended",
  structuredExtraction: "reindex-recommended",
  outputSchema: "reindex-recommended",
  parserPlaybook: (before, after) => (PLAYBOOK_RANK[after.parserPlaybook] > PLAYBOOK_RANK[before.parserPlaybook] ? "reindex-recommended" : "new-uploads"),
  documentExtraction: "reindex-recommended",
  vision: "reindex-recommended",
  visionFallback: toggled("visionFallback"),
  htmlExtraction: toggled("htmlExtraction"),
  markdownExtraction: toggled("markdownExtraction"),
  preserveTables: toggled("preserveTables"),
  preserveCode: toggled("preserveCode"),
  preserveImages: toggled("preserveImages"),
  pdfRegionExtraction: toggled("pdfRegionExtraction"),
  embed: toggled("embed"),
  indexVectors: toggled("indexVectors"),
  // Future ingestion only.
  maxCostCents: "new-uploads",
  inferenceLane: "new-uploads",
  textGeneration: "new-uploads",
  pageRouter: "new-uploads",
  mediaVideo: "new-uploads",
  webhooks: "new-uploads",
  // Query-time only: web tools never touch stored documents.
  webTools: "none",
  // Indexing-mode switching has its own flow (#199); these never re-run stored documents here.
  indexingMode: "new-uploads",
  materialization: "new-uploads",
  visualPages: "new-uploads",
  restartFromStage: "new-uploads",
  stageSubset: "new-uploads",
};

const EFFECTS: Partial<Record<ConfigChangeKind, string>> = {
  "reindex-required": "Existing documents must be re-indexed so search stays consistent with this setting.",
  "reindex-recommended": "Existing documents gain this on re-index; they keep working without it.",
  "new-uploads": "Applies to new uploads only.",
};

/** Classify a pipeline config change. Pure and synchronous (well under 5 ms). */
export function analyzePipelineChange(
  before: PipelineFeatures,
  after: PipelineFeatures,
  ctx: ConfigChangeContext,
): ConfigChangeImpact {
  let kind: ConfigChangeKind = "none";
  const reasons: ConfigChangeImpact["reasons"] = [];
  let reindexFields = 0;
  for (const field of Object.keys(PIPELINE_FIELD_IMPACT) as Array<keyof PipelineFeatures>) {
    if (pipelineValuesEqual(before[field], after[field])) continue;
    const rule = PIPELINE_FIELD_IMPACT[field];
    let fieldKind = typeof rule === "function" ? rule(before, after) : rule;
    let effect = EFFECTS[fieldKind] ?? "No effect on stored data.";
    if (KIND_RANK[fieldKind] >= KIND_RANK["reindex-recommended"]) {
      // Only a field with an effective seed stage in the new config can re-index anything. Otherwise (e.g. the
      // embedding model changes while embedding is off) existing data is left as is and the field applies to
      // future ingestion: old vectors remain until the feature is re-enabled.
      if (affectedStages({ ...after, [field]: before[field] }, after).length === 0) {
        fieldKind = "new-uploads";
        effect = "No enabled stage uses this setting; existing data remains until the feature is re-enabled.";
      } else {
        reindexFields += 1;
      }
    }
    reasons.push({ field, effect });
    if (KIND_RANK[fieldKind] > KIND_RANK[kind]) kind = fieldKind;
  }
  const stages: PipelineRunStage[] = reindexFields > 0 ? affectedStages(before, after) : [];
  return { kind, stages, reasons, documents: ctx.documents, pages: ctx.pages };
}

/** Search and chat settings apply immediately; there is never a job. */
export function analyzeSearchSettingsChange(
  before: unknown,
  after: unknown,
  ctx: ConfigChangeContext = { documents: 0, pages: 0 },
): ConfigChangeImpact {
  const changed = !pipelineValuesEqual(before, after);
  return {
    kind: changed ? "search-only" : "none",
    stages: [],
    reasons: changed ? [{ field: "searchSettings", effect: "Takes effect immediately; no re-index." }] : [],
    documents: ctx.documents,
    pages: ctx.pages,
  };
}

// ---------------------------------------------------------------------------
// Work estimates
// ---------------------------------------------------------------------------

/** Share of a document's processing each stage represents (relative; normalized per estimate). */
const STAGE_WEIGHT: Record<PipelineRunStage, number> = {
  quarantine: 0.01,
  "format-detect": 0.01,
  "to-canonical": 0.02,
  "format-tooling": 0.02,
  normalize: 0.02,
  "pdf-tooling": 0.03,
  "split-pages": 0.03,
  "document-map": 0.03,
  "page-embed": 0.05,
  "extract-markdown": 0.25,
  "extract-html": 0.03,
  "classify-route": 0.03,
  "route-pages": 0.02,
  "render-images": 0.08,
  "vision-extract": 0.2,
  "pii-detect": 0.03,
  "document-summary": 0.08,
  "structured-extract": 0.08,
  embed: 0.12,
  "graph-enrich": 0.1,
  "page-index": 0.02,
  "proposition-index": 0.06,
  index: 0.04,
};


const profileFor = (features: PipelineFeatures): PipelineProfileId =>
  features.parserPlaybook === "fast" ? "fast" : features.parserPlaybook === "agentic" || features.parserPlaybook === "review-grade" ? "deep" : "standard";

/**
 * Price and time a set of stages over `pages` pages. Ported from the worker's `forecastRunCost` (per-document
 * overhead) and `estimateIngest` (rate card, page-class profiles, parallelism); the range runs from a text-only
 * corpus to a scan-heavy one. When billing is not enforced on the deployment (self-hosted), `credits` is null
 * and `billing` is "disabled": time and page counts only, never a price.
 */
export function estimatePipelineWork(args: {
  features: PipelineFeatures;
  stages: readonly PipelineRunStage[];
  pages: number;
  documents: number;
  /** Org concurrent worker ceiling (default FUNDED_WORKER_SLOTS). */
  workerSlots?: number;
  /** Required: the caller decides which environment decides billing. Browsers pass their server-reported env. */
  env: Record<string, string | undefined>;
}): CostEstimate {
  const pages = Math.max(0, Math.round(args.pages));
  const documents = Math.max(0, Math.round(args.documents));
  const billing = isBillingEnforced(args.env) ? "enforced" : "disabled";
  const profile = profileFor(args.features);
  const planned = new Set<PipelineRunStage>(compilePipelinePlan(args.features).stageOrder);
  const selected = pipelineStageOrder.filter((stage) => args.stages.includes(stage));
  const selectedWeight = selected.reduce((sum, stage) => sum + STAGE_WEIGHT[stage], 0);
  const plannedWeight = [...planned].reduce((sum, stage) => sum + STAGE_WEIGHT[stage], 0);
  const share = selectedWeight <= 0 ? 0 : Math.min(1, selectedWeight / Math.max(plannedWeight, selectedWeight));

  // Optional per-document features are charged in full whenever their stage runs (not by stage share).
  const features = {
    documentSummary: selected.includes("document-summary"),
    structuredFields: selected.includes("structured-extract"),
    knowledgeGraph: selected.includes("graph-enrich") && Boolean(args.features.graphRag),
    propositions: selected.includes("proposition-index"),
  };
  const run = (mix: { text: number; complex: number; scanned: number }) =>
    estimateIngest({ pages, documents: Math.max(1, documents), mix, profile, features, ...(args.workerSlots ? { workerSlots: args.workerSlots } : {}) });
  const priced = (estimate: ReturnType<typeof run>) =>
    (estimate.credits.totalCredits - estimate.credits.breakdown.features) * share + estimate.credits.breakdown.features;
  const low = run({ text: 1, complex: 0, scanned: 0 });
  const high = run({ text: 0.2, complex: 0.3, scanned: 0.5 });
  const scaleSeconds = (wall: number) => (share > 0 && pages > 0 ? Math.max(0, wall - FIXED_OVERHEAD_SECONDS) * share + FIXED_OVERHEAD_SECONDS : 0);

  return costEstimateSchema.parse({
    pages,
    documents,
    billing,
    credits: billing === "disabled" ? null : {
      low: round(priced(low)),
      high: round(priced(high)),
    },
    seconds: { low: round(scaleSeconds(low.wallSeconds)), high: round(scaleSeconds(high.wallSeconds)) },
    basis: `${profile} profile, ${selected.length} of ${Math.max(planned.size, selected.length)} stages; `
      + "range from all-text to scan-heavy pages; modeled averages, not measured for this corpus",
  });
}

function round(value: number): number {
  return Math.ceil(value * 100_000) / 100_000;
}
