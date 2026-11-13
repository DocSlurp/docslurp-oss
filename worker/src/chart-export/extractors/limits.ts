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
   * svg-geometry marker/vertex de-duplication (`withoutVertexMarkers`), scheduled across all SVGs of one guest input (an
   * HTML, Office or EPUB input, or a whole SVG batch) by `index.ts`. Measured on the parser VM's shape (2 vCPU, Node 24):
   * about 3 ns per pair test and about 1.2 µs per scene primitive (parse and scene building included)
   * (performance/chart-export-free-rungs/marker-cap-bench.mjs). Spread-out charts need a few pair tests per marker; only
   * vertices packed into a few 3-unit cells approach these (a hostile input). Over its share an SVG is approximated, past
   * the scene ceiling it is deferred, never refused.
   */
  /** Most pair tests one SVG may use (~0.15 s). */
  maxMarkerPairTests: 50_000_000,
  /** Pair tests for an input with no page count (HTML, DOCX, EPUB, a standalone SVG): about four SVGs' worth. */
  markerPairTestsBase: 200_000_000,
  /** Pair tests per page when the input has a page count (PPTX slides, a PDF's Doppler figures): three SVGs' worth. */
  markerPairTestsPerPage: 150_000_000,
  /** Hard ceiling on pair tests per input (~3 s), whatever its page count. */
  maxMarkerPairTestsPerInput: 1_000_000_000,
  /** An SVG whose pair-test estimate is at most this (and within what remains) is de-duplicated exactly, in place. */
  cheapMarkerPairTests: 1_000_000,
  /** Polyline vertices one SVG may index for de-duplication (typed buffers of at most 2 MiB); above it, approximated. */
  maxMarkerVertices: 131_072,
  /** Markers + vertices held across an input's SVGs waiting for their share; above it an SVG is approximated at once. */
  maxPendingMarkerPrimitives: 500_000,
  /** Scene primitives built across one input (~7 s); SVGs after it are deferred to a later pass, not parsed. */
  maxSvgScenePrimitivesPerInput: 6_000_000,
  /** Highest confidence an approximated SVG chart keeps: below the 0.85 "use as is" threshold. */
  approximateMaxConfidence: 0.8,
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

export function refusalReason(error: unknown): string {
  if (error instanceof ExtractLimitError) return error.reason;
  if (error instanceof RangeError) return "resource-limit";
  return "parse-failed";
}
