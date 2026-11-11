/**
 * Chart & diagram export: what is billable and how many visuals an estimate expects.
 *
 * Deterministic sources (Office chart XML, embedded specs, SVG geometry) never call a model and are never charged.
 * Model reads are charged per visual a model read (whether or not it exported) through the pricing provider
 * (`visualExportCredits`); estimates count the same unit: candidates no deterministic source covered. How many model
 * calls one visual needs depends on the generation mode of each requested format: every `derived` format shares one
 * call that produces a `VisualSpec`; every `direct` format is its own call.
 */
import {
  CHART_EXPORT_FORMATS,
  chartExportConfigSchema,
  type ChartExportConfig,
  type ChartExportFormat,
  type VisualCandidateStats,
  type VisualSource,
} from "./chart-export.js";

/** Sources that never call a model. */
export const DETERMINISTIC_VISUAL_SOURCES: readonly VisualSource[] = ["office-chart-xml", "embedded-spec", "svg-geometry"];
/** Sources that call a generator model (billed per visual the model read). */
export const BILLABLE_VISUAL_SOURCES: readonly VisualSource[] = ["svg-assisted", "vision"];

export function isBillableVisualSource(source: VisualSource): boolean {
  return BILLABLE_VISUAL_SOURCES.includes(source);
}

/** How one format is generated: from a shared `VisualSpec` (derived) or by its own prompt (direct). */
export type VisualExportMode = "derived" | "direct";
export type VisualExportModes = Partial<Record<ChartExportFormat, VisualExportMode>>;

/** Generator calls one model-sourced visual needs for `formats` under `modes` (unlisted formats are derived). */
export function chartExportModelCallsPerVisual(formats: readonly ChartExportFormat[], modes: VisualExportModes = {}): number {
  const unique = [...new Set(formats)].filter((format) => CHART_EXPORT_FORMATS.includes(format));
  if (unique.length === 0) return 0;
  const direct = unique.filter((format) => modes[format] === "direct").length;
  return (direct < unique.length ? 1 : 0) + direct;
}

/**
 * Per-document bounds on chart export, shared by the worker (which enforces them) and estimates (which clamp to them).
 * - `maxModelReadsPerDocument`: visuals a model reads (each is charged, exported or not). Estimates clamp the billable
 *   visuals per document to it, so the clamp also bounds the charge. Free deterministic exports do not count.
 * - `maxVisualsPerDocument`: visuals exported per document, free or not: a bound on output size, not on spend.
 * - `maxGeneratorCallsPerDocument`: generator model calls of any outcome (failures and `none` answers count), so a
 *   document whose exports keep failing cannot spend without bound.
 * - `maxLegacyPageExportsPerDocument`: whole-page rasters sent to the generator (no router crop: the expensive path).
 */
export const CHART_EXPORT_DOCUMENT_CAPS = {
  maxModelReadsPerDocument: 200,
  maxVisualsPerDocument: 500,
  maxGeneratorCallsPerDocument: 400,
  maxLegacyPageExportsPerDocument: 50,
} as const;

/**
 * Expected visuals per page when a document's visual stats are unknown. A planning prior for estimates, not a
 * measurement: `low` is a prose-heavy corpus, `high` a deliberately conservative chart-dense one (slides, reports).
 */
export const CHART_EXPORT_VISUALS_PER_PAGE_PRIOR = { low: 0.02, high: 0.25 } as const;

/** Read `pipeline.features.chartExport` tolerantly; anything absent or invalid is "off". */
export function chartExportConfigOf(features: unknown): ChartExportConfig | null {
  const raw = features && typeof features === "object" ? (features as { chartExport?: unknown }).chartExport : undefined;
  if (raw === undefined || raw === null) return null;
  const parsed = chartExportConfigSchema.safeParse(raw);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}

/**
 * Visuals an estimate expects a model to read (the billing unit) over `pages` pages. With recorded stats, the candidates
 * (diagrams only when the option exports them; unknown-kind candidates count as charts) minus those a deterministic
 * source already produced; every one of them is charged when read, exported or not. Without stats, the per-page prior.
 */
export function expectedBillableVisuals(args: {
  config: Pick<ChartExportConfig, "diagrams">;
  pages: number;
  /** Documents the pages belong to: billable visuals are clamped to the per-document model-read cap. Unknown: no clamp. */
  documents?: number;
  stats?: Partial<VisualCandidateStats> | null;
}): { low: number; high: number; basis: "measured" | "prior" } {
  const pages = Math.max(0, Number.isFinite(args.pages) ? Math.round(args.pages) : 0);
  const documents = args.documents !== undefined && Number.isFinite(args.documents) ? Math.max(1, Math.round(args.documents)) : null;
  const cap = (visuals: number) => documents === null ? visuals : Math.min(visuals, documents * CHART_EXPORT_DOCUMENT_CAPS.maxModelReadsPerDocument);
  const stats = args.stats;
  if (stats && (Number.isFinite(stats.charts) || Number.isFinite(stats.diagrams))) {
    const candidates = count(stats.charts) + (args.config.diagrams ? count(stats.diagrams) : 0);
    const deterministic = DETERMINISTIC_VISUAL_SOURCES.reduce((sum, source) => sum + count(stats.bySource?.[source]), 0);
    const billable = Math.max(0, candidates - deterministic);
    return { low: cap(billable), high: cap(billable), basis: "measured" };
  }
  return {
    low: cap(Math.ceil(pages * CHART_EXPORT_VISUALS_PER_PAGE_PRIOR.low)),
    high: cap(Math.ceil(pages * CHART_EXPORT_VISUALS_PER_PAGE_PRIOR.high)),
    basis: "prior",
  };
}

function count(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
