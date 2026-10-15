import type { Bbox } from "../../native-pdf/types.js";

export type TableCandidateSource = "native-lines" | "native-text" | "vlm";

/** One way of reading a table region. `id` is a short letter, stable within a region. */
export interface TableCandidate {
  id: string;
  /** Every source that produced exactly these rows (identical candidates are merged). */
  sources: TableCandidateSource[];
  bbox: Bbox;
  rows: string[][];
}

export interface TableRegion {
  id: string;
  /** Union of the candidate boxes. */
  bbox: Bbox;
  candidates: TableCandidate[];
  /** Whitespace tokens of the native (visible) words that fall in the region; empty when there is no text layer. */
  sourceTokens: string[];
}

export type ValidationIssueKind =
  | "degenerate"
  | "ragged-rows"
  | "dropped-words"
  | "duplicated-values"
  | "foreign-values"
  | "numeric-mismatch"
  | "total-mismatch";

export interface ValidationIssue {
  kind: ValidationIssueKind;
  detail: string;
  /** Number of offending tokens / rows / cells. */
  count: number;
}

export interface CandidateReport {
  candidateId: string;
  valid: boolean;
  issues: ValidationIssue[];
  /** Numeric total rows verified / contradicted (both 0 when no total row is detectable). */
  totals: { checked: number; mismatched: number };
}

export interface RegionReport {
  regionId: string;
  candidates: CandidateReport[];
  survivors: string[];
}

export interface OverlapIssue {
  a: string;
  b: string;
  /** Intersection area over the smaller region's area. */
  fraction: number;
}
