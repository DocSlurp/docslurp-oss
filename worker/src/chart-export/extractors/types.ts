import type { VisualSpec } from "@docslurp/shared/chart-export";

export type DeterministicSource = "office-chart-xml" | "embedded-spec" | "svg-geometry";

/**
 * One visual found by a deterministic extractor: an `ExportedVisual`-compatible partial (S3 adds id, page, bbox and
 * outputs). `spec` is null when the visual was recognised but could not be resolved exactly; `digest` then carries the
 * geometry summary for the `svg-assisted` rung.
 */
export interface DeterministicVisual {
  source: DeterministicSource;
  kind: "chart" | "diagram";
  /** 0..1: how completely axes, series and marks resolved. */
  confidence: number;
  spec: VisualSpec | null;
  /** Compact text summary (labels, scale, mark values) for the svg-assisted rung; null when not useful. */
  digest: string | null;
  /** Where in the input it came from: a package part (`ppt/charts/chart2.xml`), `svg[0]`, `script[3]`, ... */
  locator: string;
  /** Slide number (PPTX) when known. */
  slide: number | null;
  /** Worksheet name (XLSX) when known. */
  sheet: string | null;
  /** Detected producer (`matplotlib`, `plotly`, `vega-lite`, `excel`, ...) when recognisable. */
  generator: string | null;
  /** Short machine reason when spec is null or confidence was lowered. */
  reason: string | null;
}

export interface DeterministicRefusal { locator: string; reason: string }

export interface DeterministicVisualResult {
  schemaVersion: "chart-export-deterministic@v1";
  visuals: DeterministicVisual[];
  /** Parts that were skipped because a limit or parser refused them. */
  refusals: DeterministicRefusal[];
}

export function emptyVisual(source: DeterministicSource, locator: string): DeterministicVisual {
  return { source, kind: "chart", confidence: 0, spec: null, digest: null, locator, slide: null, sheet: null, generator: null, reason: null };
}
