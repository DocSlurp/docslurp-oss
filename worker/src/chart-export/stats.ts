/**
 * `VisualCandidateStats` from free signals (router labels, the legacy page classifier, image routing's pixel class,
 * deterministic presence counts) plus what was exported. Recorded whether or not chart export is on.
 */
import { visualCandidateStatsSchema, type ExportedVisual, type VisualCandidateStats, type VisualSource } from "@docslurp/shared";

import type { DeterministicVisualResult, VisualCandidate } from "./types.js";

export interface CandidateStatsInput {
  candidates: readonly VisualCandidate[];
  /** Presence counts from the deterministic extractor (Office chart parts, SVG figures) not tied to a candidate. */
  presence?: DeterministicVisualResult["presence"];
  exported: readonly ExportedVisual[];
  /** Visuals the deterministic extractor deferred to a later pass. */
  deferred?: DeterministicVisualResult["deferred"];
}

const key = (page: number | null, image: number | null, id: string) => (page === null ? `u:${id}` : image === null ? `p${page}:${id}` : `p${page}:i${image}`);

export function buildVisualCandidateStats(input: CandidateStatsInput): VisualCandidateStats {
  // Candidates arrive deduplicated (`ChartExportSession.addCandidates`: one per picture across the router, image routing
  // and placements); the key here only guards against a repeated id.
  const unique = new Map<string, VisualCandidate>();
  for (const candidate of input.candidates) {
    const k = key(candidate.pageNumber, candidate.imageIndex, candidate.id);
    const prior = unique.get(k);
    if (!prior || (prior.kind === null && candidate.kind !== null)) unique.set(k, candidate);
  }
  let charts = 0;
  let diagrams = 0;
  for (const candidate of unique.values()) {
    if (candidate.kind === "diagram") diagrams += 1;
    else charts += 1;
  }
  const exportedIds = new Set([...unique.values()].map((c) => c.id));
  // Exported visuals with no matching candidate (an Office chart part found only by the extractor) count too.
  const unmatched: Partial<Record<"office-chart-xml" | "embedded-spec", number>> = {};
  for (const visual of input.exported) {
    if (exportedIds.has(visual.id) || unique.has(key(visual.pageNumber, visual.imageIndex, visual.id))) continue;
    if (visual.kind === "diagram") diagrams += 1;
    else charts += 1;
    if (visual.source === "office-chart-xml" || visual.source === "embedded-spec") unmatched[visual.source] = (unmatched[visual.source] ?? 0) + 1;
  }
  const bySource: Partial<Record<VisualSource, number>> = {};
  for (const visual of input.exported) bySource[visual.source] = (bySource[visual.source] ?? 0) + 1;
  // Presence the extractor or quarantine saw but nothing exported (chart export off, or a part the guest could not
  // parse). These are free sources (no model reads them), so they go in their deterministic bucket as well: estimates
  // subtract that bucket and never price them as model-read visuals.
  const presence = input.presence ?? {};
  const surplus = {
    "office-chart-xml": Math.max(0, (presence.officeChartParts ?? 0) - (unmatched["office-chart-xml"] ?? 0)),
    "embedded-spec": Math.max(0, (presence.embeddedSpecs ?? 0) - (unmatched["embedded-spec"] ?? 0)),
  } as const;
  for (const [source, count] of Object.entries(surplus) as Array<[keyof typeof surplus, number]>) {
    if (count <= 0) continue;
    charts += count;
    bySource[source] = (bySource[source] ?? 0) + count;
  }

  const exportedPages = new Set(input.exported.map((v) => v.pageNumber));
  const unexported = [...new Set([...unique.values()].map((c) => c.pageNumber))]
    .filter((page) => !exportedPages.has(page))
    .sort((a, b) => a - b)
    .slice(0, 5000);
  return visualCandidateStatsSchema.parse({
    charts,
    diagrams,
    pagesWithUnexportedVisuals: unexported,
    exported: input.exported.length,
    bySource,
    // Only when something was deferred, so other stats keep their exact shape.
    ...(input.deferred?.length ? { deferred: input.deferred.slice(0, 1000) } : {}),
  });
}
