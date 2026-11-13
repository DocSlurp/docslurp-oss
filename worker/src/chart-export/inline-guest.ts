import { CHART_EXTRACT_LIMITS } from "./extractors/limits.js";

/*
 * Inline chart extraction: the guest half (`DOCSLURP_CHART_EXPORT_INLINE=1`). The free chart rungs run inside the
 * quarantine inspection process the document already starts in the parser VM (scripts/quarantine-inspect.mjs), so the
 * free tier adds no VM boot, no exec and no Node start. This module holds only the guest's own decisions: pure, no I/O,
 * no imports beyond the extractor limits, so the guest script can load it without the shared package index.
 *
 * The guest decides from what it measured itself (the sniff and ZIP inspection it just made), never from the host's
 * word: an Office file runs only with chart parts counted in its own central directory, an HTML or JSON file only when it
 * holds a construct the extractor can read (an exact prefilter: the extractor finds nothing without one).
 */

export const INLINE_CHART_KINDS = ["office", "epub", "svg", "html", "json"] as const;
export type InlineChartKind = (typeof INLINE_CHART_KINDS)[number];

export const INLINE_CHART_LIMITS = {
  /** Result JSON the guest returns inside the inspection (the standalone guest allows 16 MiB; bigger falls back to it). */
  maxResultBytes: 4 * 1024 * 1024,
  /** Wall-clock budget: a base plus a per-KiB allowance, capped. A 1 KiB SVG gets ~0.5 s, a 4 MiB package ~8.7 s. */
  deadlineBaseMs: 500,
  deadlinePerKibMs: 2,
  deadlineMaxMs: 10_000,
  /** V8 heap of the extraction worker thread. Inflated ZIP entries are bounded by the extractor's own zip limits. */
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
} as const;

/** Fixed slugs a guest may report (the host refuses any other). */
export const INLINE_SKIP_REASONS = ["no-chart-parts", "no-signal", "archive-refused", "not-text", "input-too-large", "kind-unsupported"] as const;
export const INLINE_REFUSE_REASONS = ["deadline", "worker-failed", "result-too-large", "result-invalid"] as const;

export function inlineDeadlineMs(sizeBytes: number): number {
  const kib = Math.ceil(Math.max(0, sizeBytes) / 1024);
  return Math.min(INLINE_CHART_LIMITS.deadlineMaxMs, INLINE_CHART_LIMITS.deadlineBaseMs + kib * INLINE_CHART_LIMITS.deadlinePerKibMs);
}

/** The parts of the guest's own inspection the plan reads. */
export interface InlineInspectionView {
  sniffed: { encoding: string | null; container: string | null };
  archive: { kind: string; suspicious: boolean; inspectable: boolean; chartParts?: number } | null;
}

export type InlinePlan = { run: true; packaged: boolean } | { run: false; reason: (typeof INLINE_SKIP_REASONS)[number] };

const HTML_SIGNAL = /<(?:script|metadata|svg)\b/i;
const JSON_SCRIPT_SIGNAL = /<(?:script|metadata)\b/i;

/**
 * Whether the inline rungs run for this file. `head` is the decoded text (text kinds only). Exact for HTML and JSON:
 * `findEmbeddedSpecs` reads only `<script>`/`<metadata>` blocks or a document that starts with `{`, and inline SVG needs
 * `<svg`, so a skipped file would have returned no visual.
 */
export function inlineChartPlan(kind: string, inspection: InlineInspectionView, sizeBytes: number, text: () => string): InlinePlan {
  if (!(INLINE_CHART_KINDS as readonly string[]).includes(kind)) return { run: false, reason: "kind-unsupported" };
  const packaged = kind === "office" || kind === "epub";
  if (sizeBytes > (packaged ? CHART_EXTRACT_LIMITS.maxPackageBytes : CHART_EXTRACT_LIMITS.maxTextBytes)) return { run: false, reason: "input-too-large" };
  if (packaged) {
    const archive = inspection.archive;
    if (!archive || archive.kind !== "zip" || archive.suspicious || !archive.inspectable) return { run: false, reason: "archive-refused" };
    if (kind === "office" && !((archive.chartParts ?? 0) > 0)) return { run: false, reason: "no-chart-parts" };
    return { run: true, packaged };
  }
  if (inspection.archive !== null || inspection.sniffed.container !== null || inspection.sniffed.encoding === null) return { run: false, reason: "not-text" };
  if (kind === "html" && !HTML_SIGNAL.test(text())) return { run: false, reason: "no-signal" };
  if (kind === "json") {
    const t = text();
    if (!t.trimStart().startsWith("{") && !JSON_SCRIPT_SIGNAL.test(t)) return { run: false, reason: "no-signal" };
  }
  return { run: true, packaged };
}
