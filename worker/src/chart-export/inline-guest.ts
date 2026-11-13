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
  /** Start-up of the worker thread and the bundle import (our code, not the file's): ~50 ms on an idle VM. */
  startupMs: 5_000,
  /** V8 heap of the extraction worker thread. Inflated ZIP entries are bounded by the extractor's own zip limits. */
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
  /**
   * The whole guest process's RSS may grow by at most this much while the worker runs (polled every `rssPollMs`): the
   * heap limit does not cover Buffers and ArrayBuffers (zip inflate), so this is the real memory bound. Over it, the
   * worker is terminated and the answer is `refused memory-limit`; the inspection is unaffected.
   */
  maxRssGrowthMb: 512,
  rssPollMs: 5,
  /** The inspection's own JSON, without the chart answer (unchanged from before inline charts). */
  maxInspectionBytes: 2 * 1024 * 1024,
} as const;

/** Fixed slugs a guest may report (the host refuses any other). */
export const INLINE_SKIP_REASONS = ["no-chart-parts", "no-signal", "archive-refused", "not-text", "input-too-large", "kind-unsupported"] as const;
export const INLINE_REFUSE_REASONS = ["deadline", "worker-failed", "result-too-large", "result-invalid", "memory-limit"] as const;

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

const MARKUP_SIGNAL = /<(?:script|metadata|svg)\b/i;
const SCRIPT_SIGNAL = /<(?:script|metadata)\b/i;
/**
 * A document that is one JSON object yields a visual only through a `$schema` (Vega/Vega-Lite) or a `data` member
 * (Vega-Lite without a schema, Plotly): `classify` in embedded-spec.ts needs one of them. A `\u` escape could spell
 * either key, so any escape counts too.
 */
const SPEC_KEY = /"(?:\$schema|data)"\s*:|\\u/;

/** The UTF-16 length of UTF-8 bytes is at least a third of the byte count: past this, the decoded text is over the limit. */
const MAX_TEXT_INPUT_BYTES = 3 * CHART_EXTRACT_LIMITS.maxTextBytes;

/**
 * Whether the inline rungs run for this file. `text` decodes the bytes as UTF-8 (text kinds only, called at most once).
 *
 * What a skip may leave out, case by case (each covered by an equivalence test):
 * - HTML and JSON: nothing. `findEmbeddedSpecs` reads only `<script>`/`<metadata>` blocks, or a whole document that starts
 *   with `{` and has a `$schema` or `data` member; inline SVG needs `<svg`.
 * - Text kinds over the size limit: nothing exported. The limit is checked on the decoded length, as the extractor does;
 *   the extractor would return a size refusal, the plan returns `input-too-large`.
 * - Office without chart parts: SVG pictures under media/ are not read. This is #363's host rule for Office sources
 *   (chart parts are the signal), kept here on purpose: a picture-only deck is not a chart signal.
 */
export function inlineChartPlan(kind: string, inspection: InlineInspectionView, sizeBytes: number, text: () => string): InlinePlan {
  if (!(INLINE_CHART_KINDS as readonly string[]).includes(kind)) return { run: false, reason: "kind-unsupported" };
  const packaged = kind === "office" || kind === "epub";
  if (packaged) {
    if (sizeBytes > CHART_EXTRACT_LIMITS.maxPackageBytes) return { run: false, reason: "input-too-large" };
    const archive = inspection.archive;
    if (!archive || archive.kind !== "zip" || archive.suspicious || !archive.inspectable) return { run: false, reason: "archive-refused" };
    if (kind === "office" && !((archive.chartParts ?? 0) > 0)) return { run: false, reason: "no-chart-parts" };
    return { run: true, packaged };
  }
  if (inspection.archive !== null || inspection.sniffed.container !== null || inspection.sniffed.encoding === null) return { run: false, reason: "not-text" };
  if (sizeBytes > MAX_TEXT_INPUT_BYTES) return { run: false, reason: "input-too-large" };
  const t = text();
  if (t.length > CHART_EXTRACT_LIMITS.maxTextBytes) return { run: false, reason: "input-too-large" };
  const specDocument = t.trimStart().startsWith("{") && SPEC_KEY.test(t);
  if (kind === "html" && !specDocument && !MARKUP_SIGNAL.test(t)) return { run: false, reason: "no-signal" };
  if (kind === "json" && !specDocument && !SCRIPT_SIGNAL.test(t)) return { run: false, reason: "no-signal" };
  return { run: true, packaged };
}
