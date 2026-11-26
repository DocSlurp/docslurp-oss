import { z } from "zod";

import { QUALITY_RANK, qualityAllowsPageReading } from "./quality.js";
import { applyLadderLimits, effectiveLadder, ladderAllowsMore, ladderAllowsOffPlanReads, ladderChartExportTier, ladderEstimateMix, ladderShareBudget, pageReadingQuality } from "./auto-ladder.js";
import { estimateHighRichPagesPerRead, expectedVisualExportCredits, featureCredits, FIXED_OVERHEAD_SECONDS, estimateIngest, isBillingEnforced, pageCredits, pipelineProfileIdFor, workerSlotsFor, type PipelineProfileId } from "./billing.js";
import type { DocumentFeature } from "./pricing-provider.js";
import { pricing } from "./pricing-provider.js";
import type { VisualCandidateStats } from "./chart-export.js";
import { chartExportDefaults, chartExportModelsAvailable, CONSERVATIVE_CHART_EXPORT_DEFAULTS, effectiveTierFromDefaults, type ChartExportDefaults, type ChartExportTier, type RunOrigin } from "./chart-export.js";
import { chartExportConfigOf, expectedBillableVisuals, type VisualExportModes } from "./chart-export-estimate.js";
import { sha256Hex } from "./hash.js";
import { embeddingModelBaseUri,
  embeddingModelCatalogByUri, embeddingProfileCatalog } from "./embedding.js";
import { costEstimateSchema, type CostEstimate } from "./jobs.js";
import {
  affectedStages,
  compilePipelinePlan,
  fieldRebuildStages,
  pipelineFeatureOverridesSchema,
  pipelineStageOrder,
  pipelineValuesEqual,
  type PipelineFeatures,
  type PipelineRunStage,
} from "./pipeline.js";

export { configChangeKindSchema, type ConfigChangeKind } from "./config-change-kind.js";
import { configChangeKindSchema, type ConfigChangeKind } from "./config-change-kind.js";

export type ConfigChangeImpact = {
  kind: ConfigChangeKind;
  /** Minimal stage set for existing documents; empty unless the kind is a re-index. */
  stages: PipelineRunStage[];
  reasons: Array<{ field: string; effect: string }>;
  documents: number;
  pages: number;
};

export type ConfigChangeContext = {
  documents: number;
  pages: number;
  /**
   * The caller's surface, for settings whose unset value resolves per run origin (chart export's tier): the app's
   * settings page and chat are `app`, API keys and MCP tokens are `machine`. Default `app`.
   */
  origin?: RunOrigin;
  /**
   * The deployment's chart export defaults as the server reports them (`project.chartExportDefaults`). Clients pass
   * these; the server may pass `env` instead. Neither: the conservative defaults (nothing runs), never a code default.
   */
  chartExportDefaults?: ChartExportDefaults | null;
  /** The server's environment, read with `chartExportDefaults(env)` when no defaults are passed. */
  env?: Readonly<Record<string, string | undefined>>;
};

function contextChartExportDefaults(ctx?: ConfigChangeContext): ChartExportDefaults {
  if (ctx?.chartExportDefaults) return ctx.chartExportDefaults;
  return ctx?.env ? chartExportDefaults(ctx.env) : CONSERVATIVE_CHART_EXPORT_DEFAULTS;
}

const KIND_RANK: Record<ConfigChangeKind, number> = {
  none: 0,
  "search-only": 1,
  "new-uploads": 2,
  "reindex-recommended": 3,
  "reindex-required": 4,
};

/** What determines whether stored vectors are interchangeable; recorded per project in `index_configs`, keyed by `indexConfigHash`. */
export type IndexConfig = {
  embeddingModel: string;
  dims: number | null;
  /** Absent in legacy records; normalization cannot be reconstructed from those records. */
  normalize?: boolean;
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
    // A private route (llm://private/...) has no catalog size and records null, as before private model mode: its full
    // URI already keeps its identity apart from every hosted model.
    dims: embedding.dimensions ?? embeddingModelCatalogByUri[embeddingModelBaseUri(modelUri)]?.dimensions ?? null,
    normalize: embedding.normalize ?? embeddingProfileCatalog[embedding.profile].config.normalize,
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
    // Version the identity: legacy records did not record this material input.
    ["normalization-v1", config.normalize ?? null],
  ])).slice(0, 32);
}

/**
 * The identity documents were stamped with before normalization joined it. Read-only: it lets a backfill prove which
 * stored run configuration produced a legacy `documents.index_config_hash`. New documents never carry it.
 */
export function legacyIndexConfigHash(config: IndexConfig): string {
  const { chunking } = config;
  return sha256Hex(JSON.stringify([
    config.embeddingModel,
    config.dims,
    [chunking.chunkOverlap, chunking.contextualChunkPreambles, chunking.lateChunking, chunking.lateChunkingWindow],
    [...config.vectorBackends].sort(),
  ])).slice(0, 32);
}

type FieldImpact = ConfigChangeKind | ((before: PipelineFeatures, after: PipelineFeatures, ctx?: ConfigChangeContext) => ConfigChangeKind);

/** A feature switched on adds value to old documents; switched off only affects future ones. */
const TIER_RANK: Record<ChartExportTier, number> = { off: 0, free: 1, models: 2 };

const toggled = (key: "summarize" | "pageIndex" | "propositionIndex" | "graphRag" | "graphCommunitySummaries" | "entityIndex" |
  "htmlExtraction" | "markdownExtraction" | "preserveTables" | "preserveCode" | "preserveImages" | "pdfRegionExtraction" |
  "visionFallback" | "embed" | "indexVectors"): FieldImpact =>
  (before, after) => (after[key] && !before[key] ? "reindex-recommended" : "new-uploads");

const PII_ACTION_RANK = { flag_for_review: 1, redact_artifacts: 2, block_indexing: 3, block_document: 4 } as const;
const piiStrictness = (features: PipelineFeatures): number =>
  features.piiPolicy.enabled ? PII_ACTION_RANK[features.piiPolicy.action] : 0;

const PRIVACY_RANK = { standard: 0, "local-only": 1, "strict-privacy": 2 } as const;

/**
 * Impact of changing each pipeline feature field on already-ingested documents. The record is keyed by every
 * `PipelineFeatures` field, so adding a field without classifying it fails type-checking and the shared test.
 * A function classifies on the before/after values (direction matters for PII, privacy and toggles).
 */
export const PIPELINE_FIELD_IMPACT: Record<keyof PipelineFeatures, FieldImpact> = {
  speedBoost: "new-uploads",
  firstPass: "new-uploads",
  afterFirstPass: "new-uploads",
  // Resume scheduling only: no stored document is re-run.
  figureResume: "none",
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
  quality: (before, after) => (QUALITY_RANK[after.quality] > QUALITY_RANK[before.quality] ? "reindex-recommended" : "new-uploads"),
  // Raising a limit (a higher rung, a larger share) reads more pages of old documents; lowering one only saves on new uploads.
  ladder: (before, after) => (ladderAllowsMore(before, after) ? "reindex-recommended" : "new-uploads"),
  // Turning page images off keeps the images already stored; turning them on renders them only for documents processed again.
  pageImages: (before, after) => (after.pageImages !== false && before.pageImages === false ? "reindex-recommended" : "new-uploads"),
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
  // Compared as the tiers that run for the caller's surface (an unset tier resolves to its origin default). Moving up a
  // tier (off -> free, free -> models) or gaining formats or diagrams while on recommends a reindex: billed for
  // `models` (priced by chartExportCredits), free otherwise. Turning it down or off applies to new uploads only.
  chartExport: (before, after, ctx) => {
    const defaults = contextChartExportDefaults(ctx);
    const tierOf = (features: PipelineFeatures) => effectiveTierFromDefaults(features.chartExport?.tier, ctx?.origin ?? "app", defaults);
    const was = tierOf(before);
    const now = tierOf(after);
    if (now === "off") return "new-uploads";
    const gained = TIER_RANK[now] > TIER_RANK[was]
      || after.chartExport.formats.some((format) => !before.chartExport.formats.includes(format))
      || (after.chartExport.diagrams && !before.chartExport.diagrams);
    return gained ? "reindex-recommended" : "new-uploads";
  },
  // Figures switched on: existing documents gain them on reindex. Off: new uploads only (existing figures stay).
  figures: (before, after) => (after.figures && !before.figures ? "reindex-recommended" : "new-uploads"),
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
  // Changed only through its own endpoint, and never re-runs stored documents: existing documents get a tree from the
  // summary-tree job, with its own estimate and cap.
  summaryTree: "new-uploads",
};

const EFFECTS: Partial<Record<ConfigChangeKind, string>> = {
  "reindex-required": "Existing documents must be re-indexed so search stays consistent with this setting.",
  "reindex-recommended": "Existing documents gain this on re-index; they keep working without it.",
  "new-uploads": "Applies to new uploads only.",
};

/** Field-specific wording for the effect on stored data, where the generic text would mislead. */
const FIELD_EFFECTS: Partial<Record<keyof PipelineFeatures, Partial<Record<ConfigChangeKind, string>>>> = {
  vision: {
    "reindex-recommended": "New uploads use these vision model settings. Existing documents keep their current text until you reprocess them; reprocessing re-reads their pages with vision and is billed per page.",
  },
  quality: {
    "reindex-recommended": "New uploads use this processing quality. Existing documents keep their current text until you reprocess them; reprocessing re-reads their pages and is billed per page.",
    "new-uploads": "New uploads use this processing quality. Existing documents keep the text already extracted.",
  },
  chartExport: {
    "reindex-recommended": "New uploads export charts and diagrams in the chosen formats. Existing documents gain them when you reprocess them (charts that carry their own data at no charge; reading charts with AI is billed per chart).",
    "new-uploads": "Applies to new uploads only, at no charge for charts that carry their own data. Existing documents keep the chart and diagram exports they already have.",
  },
  figures: {
    "reindex-recommended": "New uploads extract figures from PDFs. Existing documents gain them when you reprocess them from extraction, which re-extracts and re-embeds each document (see the estimate).",
    "new-uploads": "New uploads skip figure extraction, which also turns off chart export for PDFs (PDF charts are read from their figures). Existing documents keep their figures until you reprocess them.",
  },
  visionFallback: {
    "reindex-recommended": "New uploads can read scanned or image-only pages with vision. Existing documents keep their current text until you reprocess them.",
    "new-uploads": "Future uploads stop reading pages with vision. Existing documents keep the text already extracted.",
  },
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
  // Identity fields whose change leaves `indexConfigHash` as it was (a reordered backend list, an explicit default,
  // a request option the vectors do not depend on) never re-index.
  const identityUnchanged = indexConfigHash(indexConfigOf(before)) === indexConfigHash(indexConfigOf(after));
  for (const field of Object.keys(PIPELINE_FIELD_IMPACT) as Array<keyof PipelineFeatures>) {
    if (pipelineValuesEqual(before[field], after[field])) continue;
    const rule = PIPELINE_FIELD_IMPACT[field];
    let fieldKind = typeof rule === "function" ? rule(before, after, ctx) : rule;
    let effect = FIELD_EFFECTS[field]?.[fieldKind] ?? EFFECTS[fieldKind] ?? "No effect on stored data.";
    if (identityUnchanged && isIndexIdentitySetting(field)) {
      fieldKind = "new-uploads";
      effect = "Does not change how existing vectors are built; no re-index.";
    }
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

// ---------------------------------------------------------------------------
// Index identity: settings locked once a project has ingested documents
// ---------------------------------------------------------------------------

/**
 * The pipeline settings that define a project's search index: the embedding (profile, model, dimensions,
 * normalization, task, late chunking), chunking (overlap, contextual preambles) and the vector backends. They are
 * exactly the inputs of `indexConfigOf`. Vectors built under one value are not comparable with queries or chunks built
 * under another, so once a project has ingested documents a plain settings update that changes any of them is refused
 * with 409 `reindex_required`; `POST /v1/projects/:id/reindex` (or a PATCH with `apply: "reindex"`) applies the change
 * and re-indexes the existing documents in one step.
 */
export const INDEX_IDENTITY_SETTINGS = ["embedding", "chunkOverlap", "contextualChunkPreambles", "vectorBackends"] as const satisfies readonly (keyof PipelineFeatures)[];
export type IndexIdentitySetting = (typeof INDEX_IDENTITY_SETTINGS)[number];

export function isIndexIdentitySetting(value: unknown): value is IndexIdentitySetting {
  return typeof value === "string" && (INDEX_IDENTITY_SETTINGS as readonly string[]).includes(value);
}

/**
 * The vector switches. Re-enabling either while existing vectors were built under another index config would leave the
 * project serving two embedding spaces, so that is locked like an identity change (see `vectorsReenabled`).
 */
export const VECTOR_SWITCH_SETTINGS = ["embed", "indexVectors"] as const satisfies readonly (keyof PipelineFeatures)[];

/** Every setting the reindex command takes and a `reindex_required` refusal may name. */
export const REINDEX_SETTINGS = [...INDEX_IDENTITY_SETTINGS, ...VECTOR_SWITCH_SETTINGS] as const;
export type ReindexSetting = (typeof REINDEX_SETTINGS)[number];

export function isReindexSetting(value: unknown): value is ReindexSetting {
  return typeof value === "string" && (REINDEX_SETTINGS as readonly string[]).includes(value);
}

/**
 * The index-identity settings `after` changes, when the change actually alters the index identity (`indexConfigHash`
 * differs): a reordered backend list, an explicit default or a field the vectors do not depend on changes nothing and is
 * not listed. Listed even when no enabled stage uses the setting (embedding off): re-enabling it later would otherwise
 * turn the change on silently. Pure; in `INDEX_IDENTITY_SETTINGS` order.
 */
export function changedIndexIdentitySettings(before: PipelineFeatures, after: PipelineFeatures): IndexIdentitySetting[] {
  if (indexConfigHash(indexConfigOf(before)) === indexConfigHash(indexConfigOf(after))) return [];
  return INDEX_IDENTITY_SETTINGS.filter((field) => !pipelineValuesEqual(before[field], after[field]));
}

/** The vector switches `after` turns back on. */
export function vectorsReenabled(before: PipelineFeatures, after: PipelineFeatures): Array<(typeof VECTOR_SWITCH_SETTINGS)[number]> {
  return VECTOR_SWITCH_SETTINGS.filter((field) => !before[field] && after[field]);
}

/**
 * Refuses a change that alters the index identity, for writers that must never do so (ingest recommendations, graph
 * settings). They change other settings only; a violation is a programming error, not a request to re-index.
 */
export function assertIndexIdentityUnchanged(before: PipelineFeatures, after: PipelineFeatures, writer: string): void {
  const changed = changedIndexIdentitySettings(before, after);
  if (changed.length > 0) throw new Error(`${writer} may not change index settings (${changed.join(", ")}); use the reindex command`);
}

/** The stages a plain index rebuild (no settings change) re-runs: those the index-identity settings feed, closed over data flow. */
export function indexRebuildStages(features: PipelineFeatures): PipelineRunStage[] {
  return fieldRebuildStages(features, INDEX_IDENTITY_SETTINGS);
}

/** An estimate signature: what `POST /v1/projects/:id/reindex` and a confirming PATCH accept as `confirmEstimate`. */
export const reindexEstimateSignatureSchema = z.string().regex(/^[a-f0-9]{64}$/, "confirmEstimate must be the signature an estimate returned");

/**
 * `POST /v1/projects/:id/reindex` (and its `/estimate` twin): applies index-identity setting changes and re-indexes the
 * project's existing documents in one step. `pipeline` takes only the index-identity settings (other settings change
 * through PATCH) and the vector switches; omitted or empty, the command rebuilds the index under the current settings,
 * re-running the embedding and indexing stages of every live document (billed like any re-index). `confirmEstimate` is the
 * `signature` an estimate (or a `reindex_required` refusal) returned: the command is refused with 409 `estimate_stale`
 * when the work or its price changed since.
 */
export const reindexProjectSchema = z.object({
  pipeline: pipelineFeatureOverridesSchema.optional().superRefine((value, ctx) => {
    for (const key of Object.keys(value ?? {})) {
      if (!isReindexSetting(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Only index settings (${REINDEX_SETTINGS.join(", ")}) change through reindex; change '${key}' with PATCH /v1/projects/:id` });
      }
    }
  }),
  /** Explicit opt-in to speed-boosted processing for the re-index runs, as on PATCH. */
  speedBoost: z.boolean().optional(),
  confirmEstimate: reindexEstimateSignatureSchema.optional(),
}).strict();
export type ReindexProjectInput = z.infer<typeof reindexProjectSchema>;

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
  "summary-tree": 0.08,
};


/**
 * Measured free-tier time (a before/after run of the free tier on a chart-dense slice): about 0.1 s of artifact reads per document
 * for the extra `vision-extract` pass, and about 1.4 s of parser-VM boot and staging per document with a chart signal.
 * The high end assumes the measured chart-dense share of signalled documents (35 of 75).
 */
export const FREE_CHART_TIER_PASS_SECONDS_PER_DOCUMENT = 0.1;
export const FREE_CHART_TIER_VM_SECONDS_PER_SIGNALLED_DOCUMENT = 1.4;
export const FREE_CHART_TIER_SIGNALLED_SHARE_HIGH = 35 / 75;

/** Weight of `vision-extract` when only the free chart tier runs there (no page read, no model): small, not zero. */
const FREE_CHART_TIER_STAGE_WEIGHT = 0.02;

/**
 * A stage's weight for these features. `vision-extract` is enabled for the free chart tier too; there it reads no page
 * and calls no model, so it weighs `FREE_CHART_TIER_STAGE_WEIGHT` unless vision fallback or the billed `models` tier
 * makes it full work, and nothing when chart export is off.
 */
function stageWeight(stage: PipelineRunStage, features: PipelineFeatures, tier?: ChartExportTier | null): number {
  if (stage === "vision-extract" && !features.visionFallback) {
    const resolved = tier ?? features.chartExport?.tier;
    if (resolved === "off") return 0;
    if (resolved !== "models") return FREE_CHART_TIER_STAGE_WEIGHT;
  }
  return STAGE_WEIGHT[stage];
}

/** Extra wall seconds the free chart tier adds to a run of `documents` (low: pass only; high: chart-dense VM share). */
export function freeChartTierSeconds(documents: number, workerSlots: number): { low: number; high: number } {
  const slots = Math.max(1, workerSlots);
  const pass = documents * FREE_CHART_TIER_PASS_SECONDS_PER_DOCUMENT;
  const vm = documents * FREE_CHART_TIER_SIGNALLED_SHARE_HIGH * FREE_CHART_TIER_VM_SECONDS_PER_SIGNALLED_DOCUMENT;
  return { low: pass / slots, high: (pass + vm) / slots };
}

/** The pricing profile the run reads pages with (pipelineProfileIdFor): Read scans off is estimated as Fast. */
const profileFor = (features: PipelineFeatures): PipelineProfileId => pipelineProfileIdFor(features);

/**
 * Stages that charge a page as it is read, OCR or Rich, in full, whatever share of the run the stage is (worker
 * pipeline/usage-ledger.ts `chargeOcrPage`, `chargeRichPage` and the OCR and Rich read metrics): `document-map` (its OCR of a
 * page without text), `page-embed` (every page it embeds), `extract-markdown` (the OCR route and its escalation) and
 * `vision-extract` (the vision model). Only the pages no read covered bill at completion (db/page-base-fee.ts), at the
 * provider's page charge share. The worker's tests check every stage that charges a read is listed here.
 */
export const PAGE_READ_CHARGING_STAGES: readonly PipelineRunStage[] = ["document-map", "page-embed", "extract-markdown", "vision-extract"];

/**
 * Of those, the stages that may charge every page they reach Rich, outside the document's ladder plan: the document map's
 * OCR of a page without text (only with no above-fast share) and page-image embedding (only with no ladder limit at all),
 * auto-ladder.ts `ladderAllowsOffPlanReads`.
 */
const OFF_PLAN_RICH_STAGES = { documentMap: "document-map", pageEmbed: "page-embed" } as const satisfies Record<string, PipelineRunStage>;

/** The stages that read the pages the document's ladder plans (the OCR route and its escalation, the vision model). */
const PLAN_READ_STAGES: readonly PipelineRunStage[] = ["extract-markdown", "vision-extract"];

/** The document map's vision reads of pages without text: at most min(60, ceil(0.05 x pages)) per document (worker siphon). */
export const DOCUMENT_MAP_MAX_READS_PER_DOCUMENT = 60;
export const DOCUMENT_MAP_READ_SHARE = 0.05;

/** The cheap end of a run's page mix: every page has a text layer. */
const RUN_LOW_MIX = { text: 1, complex: 0, scanned: 0 } as const;

/** The provider's share of the completion page charge for a run of `selected` out of `planned`, clamped as the worker clamps it. */
function completionShare(planned: ReadonlySet<PipelineRunStage>, selected: readonly PipelineRunStage[]): number {
  const reused = [...planned].filter((stage) => !selected.includes(stage));
  const share = pricing().pageChargeShare({ stageOrder: selected, reusedStages: reused });
  return Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 1;
}

/**
 * The most pages the ladder lets a run read above Fast (OCR or vision). The worker budgets each document on its own,
 * `ladderShareBudget`: floor(share x pages), and at least one page when the share is above 0. With each document's page
 * count that is the exact sum; with only totals, floor(share x pages) plus one page per document bounds it (each document's
 * floor adds less than one page). No above-fast share: every page.
 */
export function ladderReadPagesHigh(args: { features: PipelineFeatures; pages: number; documents: number; documentPages?: readonly number[] | null }): number {
  const ladder = effectiveLadder(args.features);
  const pages = Math.max(0, Math.floor(args.pages));
  if (ladder.maxRung === "fast") return 0;
  if (ladder.aboveFast === undefined) return pages;
  if (args.documentPages && args.documentPages.length > 0) {
    const exact = args.documentPages.reduce((sum, count) => sum + ladderShareBudget(ladder.aboveFast, count), 0);
    return Math.min(pages, exact);
  }
  return Math.min(pages, Math.floor(ladder.aboveFast * pages + 1e-9) + Math.max(0, Math.floor(args.documents)));
}

/**
 * The most an optional feature can charge over `documents` documents holding `pages` pages in all, however the pages are
 * spread: the provider prices each document on its own pages (worker pipeline/feature-charges.ts), so an even split can
 * undercount. The price of all the pages as one document plus one one-page price per document bounds per-document block
 * pricing. Priced on the page count: a feature that bills on text read can bill more when a document's text is denser
 * than its pages (see the estimate's basis).
 */
function featureCreditsHigh(feature: DocumentFeature, pages: number, documents: number): number {
  if (documents <= 0) return 0;
  const all = featureCredits(feature, Math.max(1, pages));
  const one = featureCredits(feature, 1);
  return (Number.isFinite(all) ? Math.max(0, all) : 0) + documents * (Number.isFinite(one) ? Math.max(0, one) : 0);
}

/** Stages whose run re-exports charts and diagrams: the generator runs at the end of vision-extract (worker chart-export/stage.ts). */
export const CHART_EXPORT_CHARGING_STAGES: readonly string[] = ["vision-extract"];

/**
 * Credits range for chart & diagram export over a run of `stages`: zero unless the option is on and a charging stage
 * runs. Expected model-sourced visuals come from recorded stats when known, else a conservative per-page prior; every
 * model-sourced visual is priced as `vision` (svg-assisted is billed the same way).
 */
function chartExportCredits(args: {
  features: PipelineFeatures;
  stages: readonly string[];
  pages: number;
  documents: number;
  env: Record<string, string | undefined>;
  visualStats?: Partial<VisualCandidateStats> | null;
  modes?: VisualExportModes;
  tier?: ChartExportTier | null;
}): { low: number; high: number; note: string | null } {
  // Only the billed `models` tier is priced, and only when the deployment kill switch (DOCSLURP_CHART_EXPORT) is `on`:
  // the free tier (and the switch on `free` or `off`) never calls a model, so it costs 0 credits. A per-request tier
  // wins over the project's.
  const project = chartExportConfigOf({ chartExport: { ...(args.features.chartExport ?? {}), ...(args.tier ? { tier: args.tier } : {}) } });
  const config = chartExportModelsAvailable(args.env) ? project : null;
  if (!config || !args.stages.some((stage) => CHART_EXPORT_CHARGING_STAGES.includes(stage))) return { low: 0, high: 0, note: null };
  const visuals = expectedBillableVisuals({ config, pages: args.pages, documents: args.documents, stats: args.visualStats ?? null });
  // First reads plus the expected billed second reads (repairs and cut-off retries).
  const price = (count: number) => expectedVisualExportCredits({ visuals: count, formats: config.formats, ...(args.modes ? { modes: args.modes } : {}) });
  const range = visuals.low === visuals.high ? `${visuals.low}` : `${visuals.low} to ${visuals.high}`;
  return {
    low: price(visuals.low),
    high: price(visuals.high),
    note: `; chart export: ${range} model-read visuals (${visuals.basis === "measured" ? "recorded counts" : "per-page planning prior"}), each billed as one read, or two when it needs a repair`,
  };
}

/**
 * Credits for chart export alone over a new upload of `pages` pages, at `tier` (a resolved tier: per-request override,
 * project tier or origin default). Only `models` with the deploy switch `on` is priced; everything else is 0.
 */
export function estimateChartExportCredits(args: {
  features: PipelineFeatures;
  tier: ChartExportTier;
  pages: number;
  documents: number;
  env: Record<string, string | undefined>;
}): { low: number; high: number; note: string | null } {
  return chartExportCredits({ ...args, stages: CHART_EXPORT_CHARGING_STAGES });
}

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
  /** Recorded visual stats summed over the documents, when known (chart export then prices measured candidates). */
  visualStats?: Partial<VisualCandidateStats> | null;
  /** Per-format generation mode for chart export (default: every format derived from one spec). */
  chartExportModes?: VisualExportModes;
  /**
   * The chart export tier this estimate's run would use when it differs from the project's stored one (a per-request
   * override). Unset and default tiers never resolve to `models`, so they price 0.
   */
  chartExportTier?: ChartExportTier | null;
  /**
   * The low end's page basis when it differs from `pages`: the pages and documents the completion charge will include (the
   * worker's coalesce(billing_pages, page_count) over measured, non-deduplicated, non-failed, non-media documents). `pages`
   * stays the high end's basis. Unset: `pages` and `documents`.
   */
  low?: { pages: number; documents: number; fastOnlyPages?: number };
  /** Each document's page count, when known: the high end then caps ladder reads per document exactly (ladderReadPagesHigh). */
  documentPages?: readonly number[] | null;
  /** Documents whose page count is not measured yet, counted in `pages` at the most their size allows (for the basis). */
  unmeasuredDocuments?: number;
  /**
   * Of `pages` (and of `low.pages` when `low` is set, as `low.fastOnlyPages`), the pages of formats no model reads in any
   * quality (FAST_ONLY_FORMATS: Word, slide, sheet and other Office files): priced Fast at both ends, measured or not.
   */
  fastOnlyPages?: number;
  /** Audio and video documents left out of `pages` (they bill their minutes during extraction): named in the basis. */
  mediaDocuments?: number;
}): CostEstimate {
  const pages = Math.max(0, Math.round(args.pages));
  const documents = Math.max(0, Math.round(args.documents));
  const lowPages = args.low ? Math.min(pages, Math.max(0, Math.round(args.low.pages))) : pages;
  const lowDocuments = args.low ? Math.min(documents, Math.max(0, Math.round(args.low.documents))) : documents;
  const fastOnlyPages = Math.min(pages, Math.max(0, Math.round(args.fastOnlyPages ?? 0)));
  const lowFastOnlyPages = args.low ? Math.min(lowPages, Math.max(0, Math.round(args.low.fastOnlyPages ?? 0))) : Math.min(lowPages, fastOnlyPages);
  /** Pages a model may read: everything but the fast-only formats. */
  const readable = pages - fastOnlyPages;
  const billing = isBillingEnforced(args.env) ? "enforced" : "disabled";
  const profile = profileFor(args.features);
  const planned = new Set<PipelineRunStage>(compilePipelinePlan(args.features).stageOrder);
  const selected = pipelineStageOrder.filter((stage) => args.stages.includes(stage));
  const selectedWeight = selected.reduce((sum, stage) => sum + stageWeight(stage, args.features, args.chartExportTier), 0);
  const plannedWeight = [...planned].reduce((sum, stage) => sum + stageWeight(stage, args.features, args.chartExportTier), 0);
  const share = selectedWeight <= 0 ? 0 : Math.min(1, selectedWeight / Math.max(plannedWeight, selectedWeight));

  // Optional per-document features are charged in full whenever their stage runs (not by stage share).
  const features = {
    documentSummary: selected.includes("document-summary"),
    structuredFields: selected.includes("structured-extract"),
    knowledgeGraph: selected.includes("graph-enrich") && Boolean(args.features.graphRag),
    propositions: selected.includes("proposition-index"),
  };
  const ingest = (input: { pages: number; documents: number; mix: { text: number; complex: number; scanned: number }; fastOnlyPages?: number }) =>
    estimateIngest({ pages: input.pages, documents: Math.max(1, input.documents), mix: input.mix, profile, features,
      ...(input.fastOnlyPages ? { fastOnlyPages: input.fastOnlyPages } : {}), ...(args.workerSlots ? { workerSlots: args.workerSlots } : {}) });
  const paged = (estimate: ReturnType<typeof ingest>) => estimate.credits.totalCredits - estimate.credits.breakdown.features;
  const offPlan = ladderAllowsOffPlanReads(args.features);
  const pageReading = qualityAllowsPageReading(args.features.quality);
  // A run that executes no stage charges nothing.
  const fullShare = selected.length === 0 ? 0 : completionShare(planned, selected);

  // Low end: every page has a text layer and is charged Fast at completion, at the smaller of the stage share and the
  // provider's completion share, over the pages the completion charge includes. Features as the provider models them.
  // A page beyond the ladder's above-fast share is never estimated as a read page (ladderEstimateMix).
  const low = ingest({ pages: lowPages, documents: lowDocuments, mix: ladderEstimateMix(RUN_LOW_MIX, args.features) });
  const lowPaged = paged(low) * Math.min(share, fullShare);
  // Visual mode: page embedding charges one Rich page for every page it embeds whatever the page holds, so that charge is in
  // the low end too (over the pages the low end counts, less the fast-only formats it never embeds).
  const lowEmbedded = pageReading && offPlan.pageEmbeddings && selected.includes(OFF_PLAN_RICH_STAGES.pageEmbed)
    ? pageCredits("rich", lowPages - lowFastOnlyPages) + pageCredits("fast", lowFastOnlyPages) * Math.min(share, fullShare)
    : 0;
  const lowCredits = Math.max(lowPaged, lowEmbedded) + low.credits.breakdown.features;
  // Time: the same all-text run over every page sent.
  const lowTime = ingest({ pages, documents, mix: ladderEstimateMix(RUN_LOW_MIX, args.features) });

  // High end: what the worker can charge for these pages. A stage that reads pages charges each read in full as the page is
  // read (PAGE_READ_CHARGING_STAGES); pages no read covered bill Fast at completion at the provider's completion share. Pages
  // of fast-only formats are never read: they are always among the unread pages.
  const readsPages = selected.some((stage) => PAGE_READ_CHARGING_STAGES.includes(stage));
  // Extraction reads the pages the ladder plans, priced by the profile's reader (OCR or vision).
  const planReads = selected.some((stage) => PLAN_READ_STAGES.includes(stage))
    ? ladderReadPagesHigh({ features: args.features, pages: readable, documents, documentPages: args.documentPages ?? null })
    : 0;
  // The document map's vision reads of pages without text, outside the ladder plan: at most min(60, ceil(0.05 x pages)) per
  // document (worker stages/document-map.ts siphon), so over totals at most that per document and 0.05 x pages + 1 each.
  const mapReads = pageReading && offPlan.pageReads && selected.includes(OFF_PLAN_RICH_STAGES.documentMap)
    ? Math.min(readable, DOCUMENT_MAP_MAX_READS_PER_DOCUMENT * documents, Math.ceil(DOCUMENT_MAP_READ_SHARE * readable) + documents)
    : 0;
  // Page-image embedding (the page-embed stage, or the document map's opt-in coarse fallback) bills exactly one Rich page for
  // each page it embeds, with no output tokens: never the planning figure.
  const embedsEveryPage = pageReading && offPlan.pageEmbeddings && selected.includes(OFF_PLAN_RICH_STAGES.pageEmbed);
  const embedPages = embedsEveryPage || (pageReading && offPlan.pageEmbeddings && selected.includes(OFF_PLAN_RICH_STAGES.documentMap)
    && args.features.visualPages?.coarseFallback === true) ? readable : 0;
  // Every page extraction may read is a scan, read by the profile's reader.
  const high = ingest({ pages: readable, documents, mix: { text: readable - planReads, complex: 0, scanned: planReads }, fastOnlyPages });
  const perRead = estimateHighRichPagesPerRead();
  // A page bills Rich once per run, more units only for a long answer: a page both embedded and read counts as one read.
  const extraEmbedded = Math.max(0, embedPages - planReads - mapReads);
  const readCredits = Math.min(
    high.credits.breakdown.ocr + high.credits.breakdown.rich * perRead + pageCredits("rich", mapReads) * perRead + pageCredits("rich", extraEmbedded),
    pageCredits("rich", readable) * perRead,
  );
  const covered = Math.min(readable, planReads + mapReads + embedPages);
  const unreadPages = pages - covered;
  const completion = Math.max(share, fullShare);
  // The provider's own price for the all-scan mix bounds it too: a provider may fold reads into its total rather than the
  // OCR and Rich lines, and a read is charged in full whatever the stage share.
  const highPaged = readsPages
    ? Math.max(readCredits + pageCredits("fast", unreadPages) * completion, pageCredits("fast", pages) * completion, paged(high))
    : Math.max(paged(high) * share, pageCredits("fast", pages) * completion);
  // Features: each document is priced on its own pages, so the high end allows one more block per document.
  const highFeatures = Math.max(
    high.credits.breakdown.features,
    (Object.entries(features) as [DocumentFeature, boolean][]).reduce((sum, [feature, on]) => sum + (on ? featureCreditsHigh(feature, pages, documents) : 0), 0),
  );
  // Chart & diagram export is charged per visual a model read whenever a charging stage runs (not by stage share).
  const visuals = chartExportCredits({
    // Below the intelligent rung no chart is read by a model (applyLadderLimits): the free tier prices nothing.
    features: applyLadderLimits(args.features),
    stages: selected,
    pages,
    documents: Math.max(1, documents),
    env: args.env,
    visualStats: args.visualStats ?? null,
    ...(args.chartExportModes ? { modes: args.chartExportModes } : {}),
    ...(args.chartExportTier ? { tier: ladderChartExportTier(args.features, args.chartExportTier) } : {}),
  });
  const scaleSeconds = (wall: number) => (share > 0 && pages > 0 ? Math.max(0, wall - FIXED_OVERHEAD_SECONDS) * share + FIXED_OVERHEAD_SECONDS : 0);
  // The free chart tier bills nothing but takes time: its pass and parser-VM runs (only when vision-extract runs at free).
  const freeTier = (args.chartExportTier ?? args.features.chartExport?.tier) === "free" && selected.includes("vision-extract") && pages > 0
    ? freeChartTierSeconds(Math.max(1, documents), args.workerSlots ?? workerSlotsFor(true))
    : { low: 0, high: 0 };
  const lowTotal = lowCredits + visuals.low;

  return costEstimateSchema.parse({
    pages,
    documents,
    billing,
    credits: billing === "disabled" ? null : {
      low: round(lowTotal),
      high: round(Math.max(lowTotal, highPaged + highFeatures + visuals.high)),
    },
    seconds: { low: round(scaleSeconds(lowTime.wallSeconds) + freeTier.low), high: round(Math.max(scaleSeconds(lowTime.wallSeconds), scaleSeconds(high.wallSeconds)) + freeTier.high) },
    basis: `${profile} profile, ${selected.length} of ${Math.max(planned.size, selected.length)} stages; `
      + "low: every page has a text layer and bills Fast, at the smaller of the stage's share and the completion share; "
      + "high: every page the run may read is a scan"
      + (readsPages ? ", each read charged in full as it is read whatever share of the run the stage is, at a planning size for a dense page's answer" : "")
      + (embedPages > 0 ? "; page-image embedding bills one Rich page per page it embeds" : "")
      + (fastOnlyPages > 0 ? `; ${fastOnlyPages} pages of Word, slide, sheet and other Office files bill Fast (no model reads them)` : "")
      + (args.unmeasuredDocuments ? `; ${args.unmeasuredDocuments} not yet measured counted at the most pages their size allows` : "")
      + (args.mediaDocuments ? `; ${args.mediaDocuments} audio or video documents are not included: they bill their minutes as they are transcribed` : "")
      + "; modeled averages, not measured for this corpus"
      + (readsPages ? ". Very dense pages (long tables) can bill more than the high end; the run's cost cap, when set, and the organization's credit balance, checked as the run spends (the run pauses when it runs out), limit it" : "")
      + (highFeatures > 0 ? ". Summaries, structured fields, graphs and propositions bill on the text they read, which can exceed the page count for text-dense documents" : "")
      + (visuals.note ?? ""),
  });
}

function round(value: number): number {
  return Math.ceil(value * 100_000) / 100_000;
}
