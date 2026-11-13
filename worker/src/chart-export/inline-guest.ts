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
  /** The extractor's own deadline, as a share of the hard one: it returns partial, counted results before terminate(). */
  softDeadlineShare: 0.8,
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
  /**
   * Output budget of the inline answer's visuals (#364 `outputBudget`): their serialized bytes, inside maxResultBytes with
   * room for up to 1,000 refusals and deferral entries. Past it a visual is counted (output-limit), never thrown.
   */
  outputBudget: 4 * 1024 * 1024 - 512 * 1024,
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
  archive: { kind: string; suspicious: boolean; inspectable: boolean; chartParts?: number; svgParts?: number } | null;
}

export type InlinePlan = { run: true; packaged: boolean } | { run: false; reason: (typeof INLINE_SKIP_REASONS)[number] };

/*
 * Prefilters, each exact against embedded-spec.ts `findEmbeddedSpecs` and `classify` (a skipped file returns no visual):
 * - A JSON value (a whole document starting with `{`, or a JSON-typed script) can only hit through a `$schema` member, or
 *   a `data` member with `mark`, `layer`, `encoding`, `type`, `y` or `values` beside or inside it. Those keys are ASCII, so
 *   an escape can only spell them with an escaped ASCII character (`\u00XX`, XX below 0x80).
 * - A non-JSON script region needs the literal `"$schema"`, `"mark"` or `"data"`, or a Plotly call.
 * - A script typed plotly (its array is read as traces), an XML/XHTML-typed script or a `<metadata>` block (their bodies
 *   are entity-decoded first) and an inline `<svg>` always run.
 */
const SCHEMA_KEY = /"\$schema"\s*:/;
const DATA_KEY = /"data"\s*:/;
const DATA_COMPANION = /"(?:mark|layer|encoding|type|y|values)"\s*:/;
const ESCAPED_ASCII = /\\u00[0-7][0-9a-fA-F]/;
const LITERAL_SPEC_KEY = /"\$schema"|"mark"|"data"/;
const PLOTLY_CALL = /\bPlotly\.(?:newPlot|react|plot)\s*\(/;
const ALWAYS = /<(?:svg|metadata)\b/i;
interface ScriptTypes { any: boolean; plotly: boolean; xml: boolean; json: boolean }

/**
 * What the file's `<script>` start tags could be typed as, in one linear pass (council r3 H1: the old
 * `<script\b[^>]*\btype…` regexes backtracked quadratically, 160 KB of `<script ` took 7.9 s on the quarantine main thread,
 * outside the worker's deadline). A superset of those regexes, so a skip still means the extractor finds nothing:
 * - Only the first `<script` of each `>`-free span is measured. A later one in the same span is a suffix of it, and the
 *   old `[^>]*` could reach anything the suffix reaches.
 * - A tag counts as typed X when it mentions `type` and X anywhere (case-insensitive), whether or not that is the type
 *   attribute's value. A tag with no `>` runs to the end of the text, as `[^>]*` did.
 * Linear: the measured spans are disjoint and each is read a fixed number of times (find, slice, lower-case, search).
 */
export function scriptTypes(t: string): ScriptTypes {
  const out: ScriptTypes = { any: false, plotly: false, xml: false, json: false };
  const start = /<script\b/gi;
  let match: RegExpExecArray | null;
  while ((match = start.exec(t)) !== null) {
    out.any = true;
    const found = t.indexOf(">", match.index);
    const end = found < 0 ? t.length : found;
    const tag = t.slice(match.index + 7, end).toLowerCase();
    if (tag.includes("type")) {
      if (tag.includes("plotly")) out.plotly = true;
      if (tag.includes("+xml") || tag.includes("xhtml")) out.xml = true;
      if (tag.includes("json")) out.json = true;
    }
    if (found < 0) break;
    start.lastIndex = end + 1;
  }
  return out;
}

/** Whether parsed JSON in `t` could be a spec `classify` reads (see above). */
function jsonCouldHit(t: string): boolean {
  return SCHEMA_KEY.test(t) || (DATA_KEY.test(t) && DATA_COMPANION.test(t)) || ESCAPED_ASCII.test(t);
}

/** Whether `findEmbeddedSpecs` could find anything in HTML/XHTML text, or in JSON text. Linear in the text's length. */
export function markupCouldHit(t: string): boolean {
  if (t.trimStart().startsWith("{") && jsonCouldHit(t)) return true;
  if (ALWAYS.test(t)) return true;
  const types = scriptTypes(t);
  if (!types.any) return false;
  if (types.plotly || types.xml || PLOTLY_CALL.test(t) || LITERAL_SPEC_KEY.test(t)) return true;
  return types.json && jsonCouldHit(t);
}

/** The UTF-16 length of UTF-8 bytes is at least a third of the byte count: past this, the decoded text is over the limit. */
const MAX_TEXT_INPUT_BYTES = 3 * CHART_EXTRACT_LIMITS.maxTextBytes;

/**
 * Whether the inline rungs run for this file. `text` decodes the bytes as UTF-8 (text kinds only, called at most once).
 *
 * What a skip may leave out, case by case (each covered by an equivalence test):
 * - HTML and JSON: nothing (markupCouldHit).
 * - Text kinds over the size limit: nothing exported. The limit is checked on the decoded length, as the extractor does;
 *   the extractor would return a size refusal, the plan returns `input-too-large`.
 * - Office without chart parts: SVG pictures under media/ are not read. This is #363's host rule for Office sources
 *   (chart parts are the signal), kept here on purpose: a picture-only deck is not a chart signal.
 * - EPUB: never skipped for content. Every inspectable EPUB runs (council r3 M3): charts drawn inline in XHTML chapters
 *   have no cheaper signal than reading them, and the worker costs ~50-80 ms per EPUB, a few ms per page.
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
  if ((kind === "html" || kind === "json") && !markupCouldHit(t)) return { run: false, reason: "no-signal" };
  return { run: true, packaged };
}
