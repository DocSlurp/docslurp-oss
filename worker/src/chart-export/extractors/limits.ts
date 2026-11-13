/**
 * Bounds for the deterministic chart extractors. Every input is customer bytes, so each parser counts its work and stops
 * with an `ExtractLimitError` (a short machine reason, never raw content) instead of running unbounded.
 */
export const CHART_EXTRACT_LIMITS = {
  /** One SVG / HTML / XHTML / JSON text input. */
  maxTextBytes: 5 * 1024 * 1024,
  /** One Office or EPUB package. */
  maxPackageBytes: 64 * 1024 * 1024,
  /** XML parser: elements, nesting depth, attributes per element, comment/text nodes. */
  maxXmlElements: 200_000,
  maxXmlDepth: 256,
  maxXmlAttributes: 256,
  maxXmlNodes: 400_000,
  /** SVG path data: commands across one document; vertices kept per path. */
  maxPathCommands: 200_000,
  maxPathVertices: 20_000,
  /**
   * Density gate for one SVG, checked before and while its scene is built: raw bytes; parsed elements (before the
   * diagram and geometry paths); then, while walking, frames visited, `<use>` expansions, expanded primitives (rects,
   * points, texts, polylines) and path segments. Over any of them the SVG is
   * skipped (`svg-too-large`, `svg-use-bomb`, `svg-too-dense`): O(bytes), nothing kept, and the rest of the input carries
   * on. Set at about 2× the p99 of 551 legitimate chart SVGs (real Doppler figures from public PDFs, arXiv figures,
   * #369's slice, matplotlib / Vega / Plotly / Recharts / Highcharts), counted exactly as the gate counts (after `<use>`
   * expansion; every parsed path vertex, glyph outlines included): p99 / max were 313 / 415 KB, 372 / 483 expansions,
   * 1,782 / 2,113 primitives, 23,966 / 32,880 segments, 1,357 / 1,753 walked frames, 1,447 / 2,043 elements, so every
   * one of them passes (`performance/chart-export-free-rungs/svg-density-stats.mjs` reruns the measurement).
   */
  maxSvgBytes: 640 * 1024,
  maxSvgUseExpansions: 1_000,
  maxSvgPrimitives: 4_000,
  maxSvgPathSegments: 50_000,
  /** Frames one SVG's scene walk may pop, every `<use>` re-walk and skipped, hidden or ill-transformed child included. */
  maxSvgWalkedElements: 3_000,
  /** Elements in one parsed SVG, checked before the diagram (Mermaid / Graphviz) and geometry paths. */
  maxSvgElements: 3_000,
  /**
   * Per-frame work is O(attribute and text bytes), so these bound it (council r6 H1). Checked once after parsing, before
   * the diagram and geometry paths: `d` / `points` attributes (p99 10.6 KB, max 42 KB), every other attribute except
   * `href` (p99 166 B, max 16.2 KB), and the text directly under one element outside `<script>`, `<style>`,
   * `<metadata>`, `<desc>` and `<title>` (p99 47 B, max 753 B). Then, while walking, every frame's attribute and text
   * bytes are charged to `maxSvgTouchedBytes`, re-walks included.
   */
  maxSvgGeometryAttrBytes: 64 * 1024,
  maxSvgAttrBytes: 32 * 1024,
  maxSvgTextBytes: 4 * 1024,
  /** Attribute + text bytes one SVG's walk may read, every re-walk included (legitimate p99 332 KB, max 1.03 MB). */
  maxSvgTouchedBytes: 2 * 1024 * 1024,
  /**
   * Marker/vertex pair tests one SVG may run (`withoutVertexMarkers`); over it the de-duplication is approximated
   * (`approximate-marker-dedup`, confidence capped below 0.85). Legitimate SVGs needed at most 466 (p99 18). This keeps a
   * packed hostile SVG (up to 4,000 markers × 50,000 vertices under the gate) to ~0.3 ms of pair tests.
   */
  maxMarkerPairTests: 100_000,
  /** Highest confidence an approximated SVG chart keeps: below the 0.85 "use as is" threshold. */
  approximateMaxConfidence: 0.8,
  /** SVGs analysed per input (an EPUB holds up to 200 parts × 200 inline SVGs); later ones are deferred, not parsed. */
  maxSvgsPerInput: 400,
  /** `<use>` expansion: references followed per document and nesting. */
  maxUseExpansions: 20_000,
  maxUseDepth: 8,
  /** Zip packages: entries, one inflated entry, all inflated entries, expansion ratio. */
  maxZipEntries: 10_000,
  maxZipEntryBytes: 16 * 1024 * 1024,
  maxZipTotalBytes: 128 * 1024 * 1024,
  maxZipRatio: 200,
  maxZipDepth: 16,
  /** Chart parts / SVG files / HTML documents read from one package. */
  maxPartsPerPackage: 200,
  /** Embedded JSON: one candidate blob, candidates per input, nesting depth. */
  maxJsonBytes: 2 * 1024 * 1024,
  maxJsonCandidates: 200,
  maxJsonDepth: 64,
  /** Visuals returned from one input. */
  maxVisuals: 256,
  /** Geometry digest for the svg-assisted rung (~800 tokens). */
  maxDigestChars: 3200,
} as const;

export type ChartExtractLimits = typeof CHART_EXTRACT_LIMITS;

/** A bounded parser gave up. `reason` is a short machine string safe to log and return. */
export class ExtractLimitError extends Error {
  constructor(readonly reason: string) {
    super(`chart extract refused: ${reason}`);
    this.name = "ExtractLimitError";
  }
}

/**
 * Guest deadline: a wall-clock backstop below the host's timeout, so a slow input returns what it has (and records the
 * rest as deferred) instead of being killed and losing everything. Unset (tests, in-process runs) it never fires. It
 * only fires on inputs far past every gate's measured legitimate range, so ordinary output stays deterministic.
 */
let guestDeadline = Infinity;
export function setGuestDeadline(epochMs: number): void {
  guestDeadline = Number.isFinite(epochMs) ? epochMs : Infinity;
}
export function pastGuestDeadline(): boolean {
  return guestDeadline !== Infinity && Date.now() > guestDeadline;
}

export function refusalReason(error: unknown): string {
  if (error instanceof ExtractLimitError) return error.reason;
  if (error instanceof RangeError) return "resource-limit";
  return "parse-failed";
}
