/** Provider-neutral, count-only evidence. Identities are document-local ordinals, never content or hashes. */
export interface PageCostEvidence {
  vectorPaths: number | null;
  vectorClusters: number | null;
  /** Observable nominations, never semantic confirmation. */
  chartCandidates: number | null;
  confirmedCharts: number | null;
  /** Complete placement identities only; null for partial/truncated listings. */
  imageObjects: number[] | null;
  copyClasses: { copy: number; decode: number; render: number } | null;
  /** Result of the production lexical predicate, not a token-count approximation. */
  lexicalText: boolean | null;
}

/** Reject whole malformed families. Never truncate a list and call the remainder complete. */
export function parsePageCostEvidence(value: unknown): PageCostEvidence {
  const p = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000 ? v : null;
  const c = p.copyClasses as Record<string, unknown> | null;
  const copy = c && count(c.copy), decode = c && count(c.decode), render = c && count(c.render);
  return {
    vectorPaths: count(p.vectorPaths), vectorClusters: count(p.vectorClusters),
    chartCandidates: count(p.chartCandidates), confirmedCharts: count(p.confirmedCharts),
    imageObjects: Array.isArray(p.imageObjects) && p.imageObjects.length <= 64 && p.imageObjects.every(v => count(v) !== null) ? [...p.imageObjects] : null,
    copyClasses: copy !== null && copy !== undefined && decode !== null && decode !== undefined && render !== null && render !== undefined ? { copy, decode, render } : null,
    lexicalText: typeof p.lexicalText === "boolean" ? p.lexicalText : null,
  };
}
