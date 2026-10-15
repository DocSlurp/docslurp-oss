/**
 * Table gate in shadow (PAGE_ROUTER_TABLE_GATE=shadow): on pages with a table signal, reads the native-pdf
 * engine's ruled (lines) and borderless (text) table candidates, applies the ruled-grid-or-crop rule and estimates
 * what the crops would cost on the region target. Nothing is executed and the plan is not changed; route-pages
 * records one `page-route-table-gate` row per examined page so the rule can be compared with what the plan did.
 */
import type { AssignmentScope, PageInput, RoutePlan, RoutingTarget } from "@docslurp/shared";

import type { NativePdfDocument } from "../../native-pdf/types.js";
import { estimateTargetCost } from "../estimate.js";
import { runTableGate, type TableGateVia } from "./gate.js";

export const PAGE_ROUTE_TABLE_GATE_METRIC = "page-route-table-gate";
/** Region-scoped transcription target for every region without a validated ruled grid (E4: Haiku 5.5 crops). */
export const TABLE_GATE_CROP_TARGET_ID = "vlm:openrouter/anthropic/claude-haiku-5.5";
/** Upper bound on pages examined per document (each costs a few native table passes). */
export const TABLE_GATE_MAX_PAGES = 64;

export interface TableGateShadowPage {
  pageNumber: number;
  regions: Array<{ regionId: string; via: TableGateVia; bbox: [number, number, number, number]; candidates: number; survivors: number }>;
  accepted: number;
  escalated: number;
  refusedOverlaps: number;
  /** Roles the stored plan gave this page, for comparison. */
  plannedRoles: string[];
  /** Estimate for the crops; null when the crop target is not in the catalog (no key, privacy mode). */
  cropEstimate: { targetId: string; costUsd: number; latencyMs: number } | null;
  ms: number;
}

/** Pages worth a table pass: the plan asked for table structure, or the free features show ruled tables. */
export function tableGatePages(pages: readonly PageInput[], plan: RoutePlan): number[] {
  const planned = new Set(plan.assignments.filter((a) => a.role === "table" || a.role === "table-region").map((a) => a.pageNumber));
  return pages
    .filter((p) => planned.has(p.features.pageNumber) || p.features.native.tableRuleScore >= 1 || p.features.heuristic.route === "table-heavy")
    .map((p) => p.features.pageNumber)
    .slice(0, TABLE_GATE_MAX_PAGES);
}

const toScope = (bbox: [number, number, number, number]): AssignmentScope => ({
  kind: "region",
  bbox: { x: bbox[0], y: bbox[1], width: Math.max(0, bbox[2] - bbox[0]), height: Math.max(0, bbox[3] - bbox[1]) },
});

export async function runTableGateShadow(args: {
  document: NativePdfDocument;
  pages: readonly PageInput[];
  plan: RoutePlan;
  catalog: readonly RoutingTarget[];
  signal?: AbortSignal;
}): Promise<TableGateShadowPage[]> {
  const byNumber = new Map(args.pages.map((p) => [p.features.pageNumber, p]));
  const crop = args.catalog.find((t) => t.id === TABLE_GATE_CROP_TARGET_ID);
  const out: TableGateShadowPage[] = [];
  for (const pageNumber of tableGatePages(args.pages, args.plan)) {
    if (args.signal?.aborted) break;
    const started = performance.now();
    const page = args.document.page(pageNumber - 1);
    const [lines, text, spans] = await Promise.all([page.tables({ strategy: "lines" }), page.tables({ strategy: "text" }), page.spans()]);
    const result = runTableGate({ lines, text }, { spans });
    if (result.regions.length === 0) continue;
    let cropEstimate: TableGateShadowPage["cropEstimate"] = null;
    if (crop && result.escalations.length > 0) {
      const costs = result.escalations.map((e) => estimateTargetCost(crop, "table-region", toScope(e.bbox), byNumber.get(pageNumber)));
      cropEstimate = {
        targetId: crop.id,
        costUsd: costs.reduce((sum, c) => sum + c.costUsd, 0),
        latencyMs: Math.max(...costs.map((c) => c.latencyP50Ms)),
      };
    }
    out.push({
      pageNumber,
      regions: result.regions.map((r) => ({
        regionId: r.regionId,
        via: r.via,
        bbox: r.bbox,
        candidates: r.report.candidates.length,
        survivors: r.report.survivors.length,
      })),
      accepted: result.regions.length - result.escalations.length,
      escalated: result.escalations.length,
      refusedOverlaps: result.refusedOverlaps.length,
      plannedRoles: [...new Set(args.plan.assignments.filter((a) => a.pageNumber === pageNumber).map((a) => a.role))],
      cropEstimate,
      ms: performance.now() - started,
    });
  }
  return out;
}
