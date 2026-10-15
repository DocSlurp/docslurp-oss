/**
 * Table gate: code-generated candidates per table region and conservation validators, then one rule (E4): a
 * validated ruled-grid (vector lines) reading is accepted; every other region is cropped and sent to a
 * region-scoped transcription target. There is no model chooser: E4 measured it -17 exact regions against this
 * rule on test, and its answers were driven by the candidate text rather than the image.
 *
 * Composition follows P002: only fully contained words are superseded, and a page whose table regions
 * overlap is refused atomically (every region of it goes to the crop target).
 */
import type { NativePdfSpan } from "../../native-pdf/types.js";
import { buildRegions, type RawTableCandidates, type RegionOptions } from "./candidates.js";
import type { OverlapIssue, RegionReport } from "./types.js";
import { findOverlaps, validateRegion, type ValidatorOptions } from "./validators.js";

export type TableGateAction = "accept" | "escalate";
/** `ruled-grid`: a validated vector-lines reading; the rest name why the region goes to the crop target. */
export type TableGateVia = "ruled-grid" | "unconfirmed" | "no-survivor" | "page-refused";

export interface RegionDecision {
  regionId: string;
  bbox: [number, number, number, number];
  action: TableGateAction;
  via: TableGateVia;
  candidateId?: string;
  rows?: string[][];
  report: RegionReport;
}

export interface TableGateEscalation {
  regionId: string;
  bbox: [number, number, number, number];
  role: "table-region";
  reason: Exclude<TableGateVia, "ruled-grid">;
}

export interface TableGateResult {
  refusedOverlaps: OverlapIssue[];
  regions: RegionDecision[];
  /** Regions for a region-scoped transcription (crop), in reading order. */
  escalations: TableGateEscalation[];
}

export interface TableGateOptions {
  spans: readonly NativePdfSpan[];
  validators?: Partial<ValidatorOptions>;
  regions?: Partial<RegionOptions>;
}

/** Applies the ruled-grid-or-crop rule to one page's raw table candidates. Pure, no model calls. */
export function runTableGate(raw: RawTableCandidates, options: TableGateOptions): TableGateResult {
  const regions = buildRegions(raw, options.spans, options.regions);
  const refusedOverlaps = findOverlaps(regions, options.validators);
  const result: TableGateResult = { refusedOverlaps, regions: [], escalations: [] };
  for (const region of regions) {
    const report = validateRegion(region, options.validators);
    const base = { regionId: region.id, bbox: region.bbox, report };
    const ruled = region.candidates.find((c) => report.survivors.includes(c.id) && c.sources.includes("native-lines"));
    let decision: RegionDecision;
    if (refusedOverlaps.length > 0) decision = { ...base, action: "escalate", via: "page-refused" };
    else if (report.survivors.length === 0) decision = { ...base, action: "escalate", via: "no-survivor" };
    else if (ruled) decision = { ...base, action: "accept", via: "ruled-grid", candidateId: ruled.id, rows: ruled.rows };
    else decision = { ...base, action: "escalate", via: "unconfirmed" };
    if (decision.via !== "ruled-grid") {
      result.escalations.push({ regionId: region.id, bbox: region.bbox, role: "table-region", reason: decision.via });
    }
    result.regions.push(decision);
  }
  return result;
}
