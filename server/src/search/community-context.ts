/** Preserve broad GraphRAG context while distinguishing it from tag-scoped evidence. */
export function qualifyCommunitySummary(summary: string, tags?: string[]): string {
  if (!tags?.length) return summary;
  const qualification = `[Broader workspace context: this community summary is not restricted to the selected document tags ${JSON.stringify(tags)}. It may include documents outside that selection; do not treat it as evidence that a selected document contains these claims.]`;
  return summary.startsWith(qualification) ? summary : `${qualification}\n\n${summary}`;
}
