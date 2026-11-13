import { upgradeStoredPipelineChartExport } from "@docslurp/shared";
import { z } from "zod";
import { chartExportFormatSchema, chartExportTierSchema, CHART_EXPORT_FORMATS, migrateLegacyQualitySettings, qualityModeSchema, type QualityMode, updateProjectSearchChatSettingsSchema, updateProjectSearchRetrievalDefaultsSchema } from "@docslurp/shared";

/**
 * A retired `vision: { forceAllPages }` patch (older ingest-report recommendations) arrives as `quality`:
 * `true` is good. `false` alone carries no quality here, because what it means depends on the project;
 * resolveLegacyQualityPatch maps it once the project's quality is known.
 */
function migrateLegacyPatch(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  // Patches saved in chat history or an ingest report before migration 0145 carry chartExport.enabled/generatorModel.
  value = upgradeStoredPipelineChartExport(value);
  const vision = (value as { vision?: unknown }).vision;
  const hadLegacyVision = !!vision && typeof vision === "object" && "forceAllPages" in vision;
  const migrated = migrateLegacyQualitySettings(value) as Record<string, unknown>;
  if (!hadLegacyVision) return migrated;
  const { vision: rest, ...others } = migrated;
  return rest && typeof rest === "object" && Object.keys(rest).length === 0 ? others : migrated;
}

/** True when a raw pipeline patch turns the retired `vision.forceAllPages` off without naming a quality. */
export function legacyForceAllPagesOff(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const patch = raw as { quality?: unknown; parserPlaybook?: unknown; vision?: unknown };
  if (patch.quality !== undefined || patch.parserPlaybook !== undefined) return false;
  const vision = patch.vision;
  return !!vision && typeof vision === "object" && (vision as { forceAllPages?: unknown }).forceAllPages === false;
}

/**
 * Applies a retired `vision: { forceAllPages: false }` to a parsed patch: on a Good project (vision on every page,
 * what forceAllPages: true used to mean) it means Auto; on any other project it changes nothing.
 */
export function resolveLegacyQualityPatch<T extends { quality?: QualityMode }>(
  patch: T,
  raw: unknown,
  currentQuality: QualityMode,
): T {
  if (!legacyForceAllPagesOff(raw) || patch.quality !== undefined || currentQuality !== "good") return patch;
  return { ...patch, quality: "auto" };
}

const projectSettingsPipelinePatchObjectSchema = z.object({
  mediaVideo: z.object({ enabled: z.boolean() }).strict().optional(),
  chunkOverlap: z.boolean().optional(),
  summarize: z.boolean().optional(), embed: z.boolean().optional(), indexVectors: z.boolean().optional(),
  preserveTables: z.boolean().optional(), preserveCode: z.boolean().optional(), preserveImages: z.boolean().optional(),
  pdfRegionExtraction: z.boolean().optional(), visionFallback: z.boolean().optional(),
  /** Figure extraction from PDFs (on by default); off keeps existing figures until reprocess. */
  figures: z.boolean().optional(),
  /** Processing quality (fast / auto / good): the setting the ingest report's vision recommendations change. */
  quality: qualityModeSchema.optional(),
  /**
   * Chart and diagram export. Bounded: tier (off, free, models), formats and diagrams only. The generator model is an operator and
   * settings-page choice that chat can never propose (it would route customer pages to another model).
   */
  chartExport: z.object({
    tier: chartExportTierSchema.optional(),
    formats: z.array(chartExportFormatSchema).min(1).max(CHART_EXPORT_FORMATS.length)
      .refine((formats) => new Set(formats).size === formats.length, "formats must not repeat").optional(),
    diagrams: z.boolean().optional(),
  }).strict().optional(),
}).strict();
export const projectSettingsPipelinePatchSchema = Object.assign(
  z.preprocess(migrateLegacyPatch, projectSettingsPipelinePatchObjectSchema),
  { shape: projectSettingsPipelinePatchObjectSchema.shape },
);
export const projectSettingsProposalInputSchema = z.object({
  project: z.string().min(1).optional(),
  changes: z.object({
    pipeline: projectSettingsPipelinePatchSchema.optional(),
    chat: updateProjectSearchChatSettingsSchema.strict().optional(),
    retrieval: updateProjectSearchRetrievalDefaultsSchema.pick({ resultCount: true, useRerank: true, useMmr: true, mmrLambda: true, candidateDepth: true, resultOrder: true }).strict().optional(),
  }).strict(),
}).strict();
