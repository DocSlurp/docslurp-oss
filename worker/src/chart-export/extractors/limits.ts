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
   * svg-geometry marker/vertex de-duplication: point-to-vertex pair tests per SVG. Spread-out charts need a few per
   * marker; only vertices packed into a few 3-unit cells come near this (a hostile input), and it stops them well inside
   * the guest's timeout.
   */
  maxMarkerPairTests: 50_000_000,
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
  /** Words placed beside one SVG figure (a PDF figure's own text). */
  maxSvgWords: 4000,
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
