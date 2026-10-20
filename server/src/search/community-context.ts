import type { SearchFilters } from "./filters.js";

/** Broad workspace context remains available, explicitly distinct from scoped evidence. */
export function qualifyCommunitySummary(summary: string, filters: SearchFilters = {}): string {
  const active = Object.fromEntries(Object.entries(filters).filter(([key, value]) =>
    key !== "workspaceId" && value !== undefined && (!Array.isArray(value) || value.length > 0)));
  if (Object.keys(active).length === 0) return summary;
  const qualification = `[Broader workspace context: this community summary is not restricted to the selected document scope ${JSON.stringify(active)}. It may include documents outside that selection; do not treat it as evidence that a selected document contains these claims.]`;
  return summary.startsWith(qualification) ? summary : `${qualification}\n\n${summary}`;
}
